import { sendMessage } from "../telegram";
import type { TelegramUpdate } from "../telegram";
import type { Env } from "../index";
import { handleTextMessage } from "./message";
import { handleCallbackQuery } from "./callback";
import { timingSafeStringEqual } from "../services/timingSafe";

/**
 * Заголовок, в котором Telegram присылает секретный токен webhook'а.
 * По нему отличаем настоящие запросы Telegram от подделок.
 */
const SECRET_TOKEN_HEADER = "X-Telegram-Bot-Api-Secret-Token";

/**
 * Точка входа для всех обновлений от Telegram.
 * Проверяет секрет и направляет обновление в нужный обработчик.
 */
export async function handleTelegramWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  const receivedSecret = request.headers.get(SECRET_TOKEN_HEADER);

  // Сравнение за постоянное время — тот же подход, что и для пароля
  // администратора и токена ручного запуска планировщика.
  if (
    receivedSecret === null ||
    !timingSafeStringEqual(receivedSecret, env.WEBHOOK_SECRET)
  ) {
    return new Response("Forbidden", { status: 403 });
  }

  let update: TelegramUpdate;
  try {
    update = await request.json();
  } catch {
    return new Response("OK", { status: 200 });
  }

  try {
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, env);
    } else if (update.message) {
      await handleTextMessage(update.message, env);
    }
  } catch (error) {
    // Ошибку логируем (её видно в `wrangler tail`) и всё равно отвечаем
    // Telegram кодом 200. Иначе Telegram будет бесконечно повторять
    // доставку одного и того же сбойного обновления.
    console.error("Ошибка обработки обновления Telegram:", error);
    await tryNotifyAboutError(update, env);
  }

  return new Response("OK", { status: 200 });
}

/**
 * Пытается сообщить пользователю, что что-то пошло не так.
 * Сама может завершиться ошибкой — это не критично.
 */
async function tryNotifyAboutError(
  update: TelegramUpdate,
  env: Env
): Promise<void> {
  try {
    const chatId = update.callback_query
      ? update.callback_query.message?.chat.id ?? update.callback_query.from.id
      : update.message?.chat.id;

    if (chatId === undefined) {
      return;
    }

    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      "Произошла ошибка. Пожалуйста, попробуйте ещё раз чуть позже."
    );
  } catch (notifyError) {
    console.error("Не удалось отправить сообщение об ошибке:", notifyError);
  }
}