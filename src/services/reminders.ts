import type { Env } from "../index";
import { sendMessage } from "../telegram";
import type { InlineKeyboard } from "../telegram";
import type { BillingPeriodRow } from "../db/billingPeriods";
import { getSettingNumber } from "../db/settings";
import { logEvent, hasEvent } from "../db/eventLog";
import {
  claimReminder,
  releaseReminder,
  listClaimedApartmentIds,
  listMissingReadings,
  listReminderRecipients,
  listAdminRecipients,
  countSuspiciousReadings,
} from "../db/reminders";
import type { ReminderKind, MissingReadingRow } from "../db/reminders";
import { CB } from "../bot/keyboards";
import { daysUntil } from "../utils/localTime";
import type { LocalDateTime } from "../utils/localTime";
import { periodLabel, formatDateRu, resourceEmoji } from "./format";

/**
 * Напоминания жильцам и отчёт администратору.
 *
 * Все временные параметры (за сколько дней напоминать, окно отправки,
 * лимит сообщений) читаются из system_settings и меняются без деплоя.
 */

export interface ReminderRunResult {
  kind: ReminderKind | null;
  sent: number; // сколько сообщений реально доставлено
  apartmentsReminded: number;
  skippedNoUser: number; // квартиры без привязанного аккаунта
  forbidden: number; // жилец заблокировал бота
  failed: number; // временные сбои (будет повтор в следующий запуск)
  remaining: number; // квартир осталось до следующего запуска
  note: string;
}

export interface AdminReportResult {
  sent: number;
  note: string;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/** Попадает ли местный час в окно отправки. */
function isInSendWindow(
  local: LocalDateTime,
  startHour: number,
  windowHours: number
): boolean {
  return local.hour >= startHour && local.hour < startHour + windowHours;
}

/**
 * Какое напоминание положено сегодня (по числу дней до дедлайна).
 * Выбирается самый поздний из уже наступивших этапов; напоминания
 * после дедлайна жильцам не отправляются.
 */
function pickReminderKind(
  daysToDeadline: number,
  firstDays: number,
  secondDays: number,
  finalEnabled: boolean
): ReminderKind | null {
  if (daysToDeadline < 0) return null;
  if (daysToDeadline === 0) return finalEnabled ? "final" : null;
  if (daysToDeadline <= secondDays) return "second";
  if (daysToDeadline <= firstDays) return "first";
  return null;
}

/** Склонение слова «день» после числа. */
function daysWord(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return "дней";
  if (mod10 === 1) return "день";
  if (mod10 >= 2 && mod10 <= 4) return "дня";
  return "дней";
}

interface MissingApartment {
  number: string;
  resourceCodes: string[];
  resourceNames: string[];
}

/** Группирует недостающие показания по квартирам (без повторов ресурсов). */
function groupMissing(rows: MissingReadingRow[]): Map<number, MissingApartment> {
  const grouped = new Map<number, MissingApartment>();

  for (const row of rows) {
    let entry = grouped.get(row.apartment_id);
    if (!entry) {
      entry = { number: row.apartment_number, resourceCodes: [], resourceNames: [] };
      grouped.set(row.apartment_id, entry);
    }
    if (!entry.resourceCodes.includes(row.resource_code)) {
      entry.resourceCodes.push(row.resource_code);
      entry.resourceNames.push(
        `${resourceEmoji(row.resource_code)} ${row.resource_name}`
      );
    }
  }

  return grouped;
}

/** Кнопки под напоминанием: быстрый переход только к недостающим ресурсам. */
function reminderKeyboard(missingCodes: string[]): InlineKeyboard {
  const buttons: InlineKeyboard[number] = [];

  if (missingCodes.includes("cold_water")) {
    buttons.push({ text: "💧 Передать воду", callback_data: CB.MENU_WATER });
  }
  if (missingCodes.includes("electricity")) {
    buttons.push({
      text: "⚡ Передать электро",
      callback_data: CB.MENU_ELECTRICITY,
    });
  }

  const rows: InlineKeyboard = [];
  if (buttons.length > 0) {
    rows.push(buttons);
  }
  rows.push([{ text: "🏠 Главное меню", callback_data: CB.MENU_MAIN }]);
  return rows;
}

function buildReminderText(
  kind: ReminderKind,
  period: BillingPeriodRow,
  daysToDeadline: number,
  resourceNames: string[]
): string {
  const label = periodLabel(period.year, period.month);
  const list = resourceNames.join(", ");

  if (kind === "first") {
    return (
      `👋 Напоминаем передать показания счётчиков за ${label}.\n\n` +
      `Не переданы: ${list}.\n` +
      `Срок — до ${formatDateRu(period.ends_at)}.`
    );
  }

  if (kind === "second") {
    const when =
      daysToDeadline === 1
        ? "завтра"
        : `через ${daysToDeadline} ${daysWord(daysToDeadline)}`;
    return (
      `⏰ Приём показаний за ${label} заканчивается ${when}.\n\n` +
      `Не переданы: ${list}.`
    );
  }

  return (
    `❗ Сегодня последний день приёма показаний за ${label}.\n\n` +
    `Не переданы: ${list}.`
  );
}

/** Ошибка «бот заблокирован пользователем» (Telegram отвечает 403). */
function isForbiddenError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("(403)");
}

/**
 * Рассылка напоминаний жильцам. Безопасна для повторных запусков:
 * каждой квартире каждый вид напоминания уходит не более одного раза.
 */
export async function runReminders(
  env: Env,
  period: BillingPeriodRow,
  local: LocalDateTime
): Promise<ReminderRunResult> {
  const db = env.DB;
  const result: ReminderRunResult = {
    kind: null,
    sent: 0,
    apartmentsReminded: 0,
    skippedNoUser: 0,
    forbidden: 0,
    failed: 0,
    remaining: 0,
    note: "",
  };

  const startHour = clampInt(
    await getSettingNumber(db, "reminder_hour_local", 10),
    0,
    23
  );
  const windowHours = clampInt(
    await getSettingNumber(db, "reminder_window_hours", 10),
    1,
    24
  );

  if (!isInSendWindow(local, startHour, windowHours)) {
    result.note = "вне окна отправки";
    return result;
  }

  if (period.status !== "collecting") {
    result.note = "период закрыт";
    return result;
  }

  const firstDays = clampInt(
    await getSettingNumber(db, "reminder_first_days_before_deadline", 5),
    0,
    60
  );
  const secondDays = clampInt(
    await getSettingNumber(db, "reminder_second_days_before_deadline", 2),
    0,
    60
  );
  const finalEnabled =
    (await getSettingNumber(db, "reminder_final_on_deadline_day", 1)) === 1;
  const maxPerRun = clampInt(
    await getSettingNumber(db, "reminder_max_per_run", 15),
    1,
    40
  );

  const daysToDeadline = daysUntil(local.isoDate, period.ends_at);
  const kind = pickReminderKind(
    daysToDeadline,
    firstDays,
    secondDays,
    finalEnabled
  );

  if (kind === null) {
    result.note =
      daysToDeadline < 0 ? "срок передачи прошёл" : "сегодня напоминаний нет";
    return result;
  }
  result.kind = kind;

  const missing = groupMissing(await listMissingReadings(db, period.id));
  const claimed = await listClaimedApartmentIds(db, period.id, kind);
  const pending = [...missing.entries()].filter(
    ([apartmentId]) => !claimed.has(apartmentId)
  );

  if (pending.length === 0) {
    result.note = "всем нужным квартирам уже отправлено";
    return result;
  }

  const recipientsByApartment = new Map<number, number[]>();
  for (const recipient of await listReminderRecipients(db)) {
    const list = recipientsByApartment.get(recipient.apartment_id) ?? [];
    list.push(recipient.tg_id);
    recipientsByApartment.set(recipient.apartment_id, list);
  }

  let attempts = 0; // попытки отправки в этом запуске (для лимита)
  let processed = 0;

  for (const [apartmentId, info] of pending) {
    const tgIds = recipientsByApartment.get(apartmentId) ?? [];

    // Лимит сообщений за запуск: остальные квартиры получат напоминание
    // в следующие часовые запуски в пределах окна отправки.
    if (tgIds.length > 0 && attempts > 0 && attempts + tgIds.length > maxPerRun) {
      break;
    }
    if (tgIds.length > 0 && attempts >= maxPerRun) {
      break;
    }

    processed += 1;

    // Защита от двойной отправки: продолжаем, только если "бронь" наша.
    const won = await claimReminder(db, apartmentId, period.id, kind);
    if (!won) {
      continue;
    }

    if (tgIds.length === 0) {
      result.skippedNoUser += 1;
      await logEvent(db, {
        entityType: "apartment",
        entityId: apartmentId,
        action: "reminder_skipped_no_user",
        payload: { period_id: period.id, kind },
      });
      continue;
    }

    const text = buildReminderText(
      kind,
      period,
      daysToDeadline,
      info.resourceNames
    );
    const keyboard = reminderKeyboard(info.resourceCodes);

    let okCount = 0;
    let forbiddenCount = 0;
    let otherFailCount = 0;

    for (const tgId of tgIds) {
      attempts += 1;
      try {
        // В личном чате id чата совпадает с id пользователя.
        await sendMessage(env.TELEGRAM_BOT_TOKEN, tgId, text, keyboard);
        okCount += 1;
      } catch (error) {
        if (isForbiddenError(error)) {
          forbiddenCount += 1;
        } else {
          otherFailCount += 1;
        }
        console.error(`Не удалось отправить напоминание (квартира ${info.number}):`, error);
      }
    }

    result.sent += okCount;
    result.forbidden += forbiddenCount;

    if (okCount > 0) {
      result.apartmentsReminded += 1;
    }

    if (okCount === 0 && otherFailCount > 0) {
      // Временный сбой (сеть, Telegram): снимаем "бронь", чтобы
      // следующий запуск попробовал ещё раз.
      result.failed += otherFailCount;
      await releaseReminder(db, apartmentId, period.id, kind);
      continue;
    }

    if (forbiddenCount > 0) {
      await logEvent(db, {
        entityType: "apartment",
        entityId: apartmentId,
        action: "reminder_failed",
        payload: { period_id: period.id, kind, reason: "forbidden" },
      });
    }
  }

  result.remaining = pending.length - processed;
  return result;
}

/** Сортировка номеров квартир: 2, 10, 12 (а не 10, 12, 2). */
function sortApartmentNumbers(numbers: string[]): string[] {
  return [...numbers].sort((a, b) =>
    a.localeCompare(b, "ru", { numeric: true })
  );
}

/**
 * Отчёт администраторам на следующий день после дедлайна.
 * Отправляется один раз за период (факт отправки — в event_log).
 */
export async function runAdminReport(
  env: Env,
  period: BillingPeriodRow,
  local: LocalDateTime
): Promise<AdminReportResult> {
  const db = env.DB;
  const result: AdminReportResult = { sent: 0, note: "" };

  if ((await getSettingNumber(db, "admin_notify_after_deadline", 1)) !== 1) {
    result.note = "отключено настройкой";
    return result;
  }

  const startHour = clampInt(
    await getSettingNumber(db, "reminder_hour_local", 10),
    0,
    23
  );
  const windowHours = clampInt(
    await getSettingNumber(db, "reminder_window_hours", 10),
    1,
    24
  );

  if (!isInSendWindow(local, startHour, windowHours)) {
    result.note = "вне окна отправки";
    return result;
  }

  // Отчёт формируется только после дедлайна.
  if (local.isoDate <= period.ends_at) {
    result.note = "срок передачи ещё не прошёл";
    return result;
  }

  if (await hasEvent(db, "billing_period", period.id, "admin_overdue_report_sent")) {
    result.note = "отчёт уже отправлен";
    return result;
  }

  const missing = groupMissing(await listMissingReadings(db, period.id));

  if (missing.size === 0) {
    // Все сдали — отчёт не нужен. Фиксируем, чтобы не считать заново каждый час.
    await logEvent(db, {
      entityType: "billing_period",
      entityId: period.id,
      action: "admin_overdue_report_sent",
      payload: { missing_apartments: 0, recipients: 0 },
    });
    result.note = "все показания переданы";
    return result;
  }

  const admins = await listAdminRecipients(db);
  if (admins.length === 0) {
    // Не фиксируем в журнале: когда администратор появится, отчёт уйдёт.
    result.note = "нет администраторов";
    return result;
  }

  const recipientApartments = new Set<number>();
  for (const recipient of await listReminderRecipients(db)) {
    recipientApartments.add(recipient.apartment_id);
  }

  const missingNumbers = sortApartmentNumbers(
    [...missing.values()].map((item) => item.number)
  );
  const withoutAccount = sortApartmentNumbers(
    [...missing.entries()]
      .filter(([apartmentId]) => !recipientApartments.has(apartmentId))
      .map(([, item]) => item.number)
  );
  const suspiciousCount = await countSuspiciousReadings(db, period.id);

  let text =
    `📋 Итоги приёма показаний за ${periodLabel(period.year, period.month)}\n` +
    `Срок передачи был до ${formatDateRu(period.ends_at)}.\n\n` +
    `Не передали показания: квартиры №${missingNumbers.join(", ")} ` +
    `(всего ${missingNumbers.length}).`;

  if (withoutAccount.length > 0) {
    text += `\nБез привязанного Telegram-аккаунта: №${withoutAccount.join(", ")}.`;
  }
  if (suspiciousCount > 0) {
    text += `\nПодозрительных показаний ждут проверки: ${suspiciousCount}.`;
  }

  for (const adminTgId of admins) {
    try {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, adminTgId, text);
      result.sent += 1;
    } catch (error) {
      console.error("Не удалось отправить отчёт администратору:", error);
    }
  }

  if (result.sent > 0) {
    await logEvent(db, {
      entityType: "billing_period",
      entityId: period.id,
      action: "admin_overdue_report_sent",
      payload: { missing_apartments: missingNumbers.length, recipients: result.sent },
    });
    result.note = "отчёт отправлен";
  } else {
    // Не отправился никому — журнал не пишем, следующий запуск повторит.
    result.note = "не удалось отправить, будет повтор";
  }

  return result;
}