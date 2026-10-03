import type { Env } from "../index";
import { sendMessage } from "../telegram";
import { listAdminRecipients } from "../db/reminders";
import { getSettingNumber, getSettingText, setSettingText } from "../db/settings";
import { logEvent } from "../db/eventLog";
import type { LocalDateTime } from "../utils/localTime";

/**
 * Проверки работоспособности системы, не связанные напрямую с бизнес-
 * логикой сбора показаний: доступность webhook'а Telegram и соблюдение
 * расписания автоматического бэкапа. Обе вызываются из планировщика
 * (см. scheduler.ts) и при обнаружении проблемы уведомляют
 * администратора в Telegram один раз — чтобы не ждать, пока кто-то
 * случайно заметит молчание бота или отсутствие свежих бэкапов,
 * но и не заваливать сообщениями о уже известной проблеме каждый час.
 */

export interface HealthCheckResult {
  checked: boolean;
  note: string;
}

/** Отправляет сообщение всем администраторам; сбой отправки одному не мешает остальным. */
async function notifyAdmins(env: Env, text: string): Promise<number> {
  const admins = await listAdminRecipients(env.DB);
  let sent = 0;

  for (const tgId of admins) {
    try {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, tgId, text);
      sent += 1;
    } catch (error) {
      console.error("Не удалось отправить уведомление о здоровье системы:", error);
    }
  }

  return sent;
}

interface TelegramWebhookInfo {
  url: string;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
}

async function fetchWebhookInfo(botToken: string): Promise<TelegramWebhookInfo | null> {
  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/getWebhookInfo`
  );
  if (!response.ok) {
    return null;
  }
  const data = (await response.json()) as {
    ok: boolean;
    result?: TelegramWebhookInfo;
  };
  return data.ok && data.result ? data.result : null;
}

/**
 * Раз в сутки (в настраиваемый час) проверяет состояние webhook'а
 * через Telegram getWebhookInfo: не сброшен ли адрес, нет ли свежей
 * ошибки доставки. При обнаружении новой проблемы — уведомляет
 * администраторов один раз; про ту же самую ошибку повторно не
 * напоминает, пока она не исчезнет или не сменится на другую.
 */
export async function checkWebhookHealth(
  env: Env,
  local: LocalDateTime
): Promise<HealthCheckResult> {
  const checkHour = Math.min(
    Math.max(
      Math.trunc(await getSettingNumber(env.DB, "webhook_check_hour_local", 6)),
      0
    ),
    23
  );

  if (local.hour !== checkHour) {
    return { checked: false, note: "не время проверки" };
  }

  const info = await fetchWebhookInfo(env.TELEGRAM_BOT_TOKEN);
  if (!info) {
    return { checked: false, note: "не удалось получить getWebhookInfo" };
  }

  let path = "";
  try {
    path = info.url ? new URL(info.url).pathname : "";
  } catch {
    path = "";
  }

  const urlLooksWrong = info.url.length === 0 || path !== "/tg-webhook";
  const errorKey = urlLooksWrong
    ? "url_missing_or_wrong"
    : info.last_error_date
      ? String(info.last_error_date)
      : null;

  if (errorKey === null) {
    // Проблем нет — сбрасываем отметку, чтобы при повторном появлении
    // той же (по дате) ошибки позже уведомление пришло снова.
    await setSettingText(env.DB, "webhook_last_notified_error", "");
    return { checked: true, note: "webhook в порядке" };
  }

  const alreadyNotified = await getSettingText(
    env.DB,
    "webhook_last_notified_error",
    ""
  );
  if (alreadyNotified === errorKey) {
    return { checked: true, note: "проблема уже известна, повторно не уведомляем" };
  }

  const description = urlLooksWrong
    ? `webhook не настроен или указывает не на тот адрес (${info.url || "адрес не задан"}).`
    : `Telegram сообщает об ошибке доставки: ${info.last_error_message ?? "без текста"}.`;

  const sent = await notifyAdmins(
    env,
    `⚠️ Проблема с приёмом сообщений ботом\n\n${description}\n\n` +
      "Жильцы могли не получить ответ на свои сообщения. Проверьте webhook вручную."
  );

  await setSettingText(env.DB, "webhook_last_notified_error", errorKey);

  await logEvent(env.DB, {
    entityType: "system",
    entityId: 1,
    action: "webhook_error_detected",
    payload: {
      url: info.url,
      pending_update_count: info.pending_update_count,
      last_error_message: info.last_error_message ?? null,
      notified_admins: sent,
    },
  });

  return { checked: true, note: "обнаружена проблема, администратор уведомлён" };
}

/**
 * Проверяет, не был ли пропущен еженедельный автоматический бэкап:
 * срабатывает ровно в тот час, когда окно бэкапа закрывается
 * (backup_hour_local + backup_window_hours), в день бэкапа. Если
 * к этому моменту свежего бэкапа так и не появилось — значит, все
 * попытки в течение окна провалились, а ошибка видна только в
 * event_log, который никто специально не читает каждый день.
 */
export async function checkBackupWindowHealth(
  env: Env,
  local: LocalDateTime
): Promise<HealthCheckResult> {
  const backupWeekday = Math.min(
    Math.max(Math.trunc(await getSettingNumber(env.DB, "backup_weekday", 0)), 0),
    6
  );
  const backupHour = Math.min(
    Math.max(Math.trunc(await getSettingNumber(env.DB, "backup_hour_local", 3)), 0),
    23
  );
  const windowHours = Math.min(
    Math.max(
      Math.trunc(await getSettingNumber(env.DB, "backup_window_hours", 2)),
      1
    ),
    24
  );

  const weekday = new Date(`${local.isoDate}T00:00:00Z`).getUTCDay();
  const windowClosedHour = backupHour + windowHours;

  if (weekday !== backupWeekday || local.hour !== windowClosedHour) {
    return { checked: false, note: "не момент проверки окна бэкапа" };
  }

  const lastBackupAt = await getSettingText(env.DB, "last_backup_at", "");
  if (lastBackupAt === local.isoDate) {
    return { checked: true, note: "бэкап за сегодня есть, всё в порядке" };
  }

  const sent = await notifyAdmins(
    env,
    "⚠️ Автоматический бэкап не создался\n\n" +
      `Окно для еженедельного бэкапа (${String(backupHour).padStart(2, "0")}:00–` +
      `${String(windowClosedHour).padStart(2, "0")}:00 по местному времени) закрылось, ` +
      "а новой резервной копии так и не появилось. Проверьте раздел «Бэкапы» " +
      "в административной панели и при необходимости создайте бэкап вручную."
  );

  await logEvent(env.DB, {
    entityType: "system",
    entityId: 1,
    action: "backup_window_missed",
    payload: { date: local.isoDate, notified_admins: sent },
  });

  return { checked: true, note: "окно бэкапа пропущено, администратор уведомлён" };
}