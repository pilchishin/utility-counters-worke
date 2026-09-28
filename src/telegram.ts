/**
 * Минимальный клиент Telegram Bot API.
 *
 * Здесь описаны только те типы и методы, которые нужны боту на
 * текущем этапе. Полная документация:
 * https://core.telegram.org/bots/api
 */

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

// Нажатие на inline-кнопку. Поле data — это callback_data кнопки.
export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

// Клавиатура — массив строк, каждая строка — массив кнопок.
export type InlineKeyboard = InlineKeyboardButton[][];

/**
 * Отправляет текстовое сообщение пользователю.
 * Необязательный параметр keyboard добавляет inline-кнопки под сообщением.
 *
 * Бросает исключение, если Telegram вернул ошибку.
 */
export async function sendMessage(
  botToken: string,
  chatId: number,
  text: string,
  keyboard?: InlineKeyboard
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      // Если keyboard не передан, поле пропадёт при сериализации в JSON.
      reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Telegram sendMessage завершился ошибкой (${response.status}): ${errorBody}`
    );
  }
}

/**
 * Подтверждает Telegram получение нажатия на кнопку — без этого
 * у пользователя на кнопке бесконечно крутится индикатор загрузки.
 *
 * Ошибки здесь не критичны (например, нажатие слишком старое),
 * поэтому они только логируются и не прерывают обработку.
 */
export async function answerCallbackQuery(
  botToken: string,
  callbackQueryId: string
): Promise<void> {
  try {
    const url = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    });

    if (!response.ok) {
      console.error(
        `answerCallbackQuery завершился ошибкой (${response.status})`
      );
    }
  } catch (error) {
    console.error("answerCallbackQuery: сетевая ошибка", error);
  }
}