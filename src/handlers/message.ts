import { sendMessage } from "../telegram";
import type { TelegramMessage } from "../telegram";
import type { Env } from "../index";
import { resolveUser } from "../services/auth";
import type { RegisteredAuth } from "../services/auth";
import { tryRegister } from "../services/registration";
import { getDialogState, clearDialogState } from "../db/dialogState";
import { handleReadingInput } from "../services/readingFlow";
import { showMainMenu, showHelp } from "../services/menu";
import { confirmKeyboard } from "../bot/keyboards";
import {
  upsertPendingRegistration,
  removePendingRegistration,
} from "../db/pendingRegistrations";

const REGISTRATION_PROMPT =
  "Здравствуйте! Введите номер квартиры и код доступа одним " +
  "сообщением, например: 12 A93F1";

/**
 * Обрабатывает текстовое сообщение пользователя.
 */
export async function handleTextMessage(
  message: TelegramMessage,
  env: Env
): Promise<void> {
  if (!message.text || !message.from) {
    return;
  }

  // Бот работает только в личных сообщениях.
  if (message.chat.type !== "private") {
    return;
  }

  const tgId = message.from.id;
  const chatId = message.chat.id;
  const text = message.text.trim();

  const auth = await resolveUser(env, tgId);

  if (auth.kind === "blocked") {
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      "Ваш аккаунт временно заблокирован. Обратитесь к администратору дома."
    );
    return;
  }

  if (auth.kind === "registered") {
    await handleRegisteredUser(text, chatId, auth, env);
    return;
  }

  await handleUnregisteredUser(text, chatId, tgId, env);
}

/**
 * Сообщение от зарегистрированного жильца.
 */
async function handleRegisteredUser(
  text: string,
  chatId: number,
  auth: RegisteredAuth,
  env: Env
): Promise<void> {
  const { user, apartmentNumber } = auth;

  // Команды, которые всегда сбрасывают диалог и возвращают в меню.
  if (
    text === "/start" ||
    text.startsWith("/start ") ||
    text === "/menu" ||
    text === "/cancel"
  ) {
    await clearDialogState(env.DB, user.tg_id);
    await showMainMenu(env, chatId, apartmentNumber);
    return;
  }

  if (text === "/help") {
    await showHelp(env, chatId);
    return;
  }

  const state = await getDialogState(env.DB, user.tg_id);

  if (state && state.state === "AWAITING_READING_VALUE") {
    await handleReadingInput(env, user, chatId, text, state);
    return;
  }

  if (state && state.state === "CONFIRM_READING") {
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      "Пожалуйста, выберите действие кнопками: подтвердить, изменить или отменить.",
      confirmKeyboard()
    );
    return;
  }

  // Состояния нет — любой текст просто открывает главное меню.
  await showMainMenu(env, chatId, apartmentNumber);
}

/**
 * Сообщение от пользователя, который ещё не зарегистрирован.
 *
 * Любое такое обращение отмечается в pending_registrations —
 * администратор увидит этот tg_id в списке "ожидают привязки"
 * на карточке квартиры и сможет привязать его в один клик,
 * не спрашивая Telegram ID отдельно.
 */
async function handleUnregisteredUser(
  text: string,
  chatId: number,
  tgId: number,
  env: Env
): Promise<void> {
  await upsertPendingRegistration(env.DB, tgId);

  if (text === "/start") {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, REGISTRATION_PROMPT);
    return;
  }

  // Любые другие команды (/help и т.п.) — не попытка регистрации,
  // поэтому не считаем их неудачными попытками ввода кода.
  if (text.startsWith("/") && !text.startsWith("/start ")) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, REGISTRATION_PROMPT);
    return;
  }

  // Deep-ссылка: /start 12-A93F1 — параметр идёт после команды.
  let registrationInput = text;
  if (text.startsWith("/start ")) {
    registrationInput = text.slice("/start ".length).trim();
  }

  const result = await tryRegister(env, tgId, registrationInput);

  switch (result.status) {
    case "success":
      // Регистрация состоялась — человек больше не "ожидает привязки".
      await removePendingRegistration(env.DB, tgId);
      await sendMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        `Регистрация завершена ✅ Вы привязаны к квартире №${result.apartmentNumber}.`
      );
      await showMainMenu(env, chatId, result.apartmentNumber);
      return;

    case "already_registered":
      await sendMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        result.apartmentNumber
          ? `Этот Telegram-аккаунт уже привязан к квартире №${result.apartmentNumber}.`
          : "Этот Telegram-аккаунт уже зарегистрирован в системе."
      );
      return;

    case "not_found":
      await sendMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        "Неверный номер квартиры или код. Проверьте данные из " +
          "уведомления и попробуйте ещё раз."
      );
      return;

    case "apartment_inactive":
      await sendMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        "Ваша квартира сейчас не активна в системе. Обратитесь к администратору."
      );
      return;

    case "limit_reached":
      await sendMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        "К этой квартире уже привязано максимальное число аккаунтов. " +
          "Если это ошибка — обратитесь к администратору."
      );
      return;

    case "locked_out":
      await sendMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        "Слишком много неудачных попыток. Пожалуйста, попробуйте позже."
      );
      return;

    case "invalid_format":
      await sendMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        "Не удалось распознать данные. Введите номер квартиры и код " +
          "доступа одним сообщением, например: 12 A93F1"
      );
      return;
  }
}