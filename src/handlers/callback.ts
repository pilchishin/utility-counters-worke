import { sendMessage, answerCallbackQuery } from "../telegram";
import type { TelegramCallbackQuery } from "../telegram";
import type { Env } from "../index";
import { resolveUser } from "../services/auth";
import { clearDialogState } from "../db/dialogState";
import {
  startReadingFlow,
  selectMeter,
  confirmReading,
  retryReading,
} from "../services/readingFlow";
import {
  showMyReadings,
  showHistoryMenu,
  showHistoryPage,
} from "../services/history";
import { showMainMenu, showHelp } from "../services/menu";
import { CB } from "../bot/keyboards";

// Допустимый вид кода ресурса в callback_data истории.
const RESOURCE_CODE_PATTERN = /^[a-z0-9_]{1,32}$/;

/**
 * Обрабатывает нажатие на inline-кнопку.
 */
export async function handleCallbackQuery(
  query: TelegramCallbackQuery,
  env: Env
): Promise<void> {
  // Сразу подтверждаем нажатие, чтобы у пользователя не "висела" кнопка.
  await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, query.id);

  const data = query.data ?? "";
  const tgId = query.from.id;
  // В личном чате id чата совпадает с id пользователя.
  const chatId = query.message?.chat.id ?? tgId;

  // Права проверяются заново при КАЖДОМ нажатии: кнопка из старого
  // сообщения не даёт доступа, если пользователя тем временем заблокировали.
  const auth = await resolveUser(env, tgId);

  if (auth.kind === "blocked") {
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      "Ваш аккаунт временно заблокирован. Обратитесь к администратору дома."
    );
    return;
  }

  if (auth.kind === "unregistered") {
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      "Сначала пройдите регистрацию: отправьте команду /start."
    );
    return;
  }

  const { user, apartmentNumber } = auth;

  if (data === CB.MENU_MAIN) {
    await clearDialogState(env.DB, user.tg_id);
    await showMainMenu(env, chatId, apartmentNumber);
    return;
  }

  if (data === CB.MENU_WATER) {
    await startReadingFlow(env, user, chatId, "cold_water");
    return;
  }

  if (data === CB.MENU_ELECTRICITY) {
    await startReadingFlow(env, user, chatId, "electricity");
    return;
  }

  if (data === CB.MENU_MY_READINGS) {
    // Просмотр не должен оставлять незавершённый ввод показания.
    await clearDialogState(env.DB, user.tg_id);
    await showMyReadings(env, chatId, user.apartment_id, apartmentNumber);
    return;
  }

  if (data === CB.MENU_HISTORY) {
    await clearDialogState(env.DB, user.tg_id);
    await showHistoryMenu(env, chatId, user.apartment_id);
    return;
  }

  if (data.startsWith(CB.HISTORY_PREFIX)) {
    // Формат: "hist:<код ресурса>:<смещение>"
    const parts = data.slice(CB.HISTORY_PREFIX.length).split(":");
    const resourceCode = parts[0] ?? "";
    const offset = Number(parts[1]);

    if (
      parts.length !== 2 ||
      !RESOURCE_CODE_PATTERN.test(resourceCode) ||
      !Number.isInteger(offset) ||
      offset < 0
    ) {
      await showMainMenu(env, chatId, apartmentNumber);
      return;
    }

    await clearDialogState(env.DB, user.tg_id);
    await showHistoryPage(env, chatId, user.apartment_id, resourceCode, offset);
    return;
  }

  if (data === CB.MENU_HELP) {
    await showHelp(env, chatId);
    return;
  }

  if (data.startsWith(CB.METER_PREFIX)) {
    const meterId = Number(data.slice(CB.METER_PREFIX.length));
    if (!Number.isInteger(meterId) || meterId <= 0) {
      await showMainMenu(env, chatId, apartmentNumber);
      return;
    }
    await selectMeter(env, user, chatId, meterId);
    return;
  }

  if (data === CB.READING_CONFIRM) {
    await confirmReading(env, user, chatId);
    return;
  }

  if (data === CB.READING_RETRY) {
    await retryReading(env, user, chatId);
    return;
  }

  if (data === CB.READING_CANCEL) {
    await clearDialogState(env.DB, user.tg_id);
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Ввод отменён.");
    await showMainMenu(env, chatId, apartmentNumber);
    return;
  }

  // Неизвестное значение (например, кнопка из устаревшей версии бота).
  await showMainMenu(env, chatId, apartmentNumber);
}