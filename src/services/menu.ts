import type { Env } from "../index";
import { sendMessage } from "../telegram";
import { mainMenuKeyboard, backToMenuKeyboard } from "../bot/keyboards";

/** Показывает главное меню. */
export async function showMainMenu(
  env: Env,
  chatId: number,
  apartmentNumber: string | null
): Promise<void> {
  const header = apartmentNumber
    ? `Главное меню (квартира №${apartmentNumber})`
    : "Главное меню";

  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, header, mainMenuKeyboard());
}

/** Показывает справку. */
export async function showHelp(env: Env, chatId: number): Promise<void> {
  await sendMessage(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    "Этот бот принимает показания счётчиков воды и электроэнергии.\n\n" +
      "Команды:\n" +
      "/start — главное меню\n" +
      "/help — помощь\n" +
      "/cancel — отменить ввод\n\n" +
      "По вопросам обращайтесь к администратору дома.",
    backToMenuKeyboard()
  );
}

/** Заглушка для разделов, которые ещё не реализованы. */
export async function showComingSoon(env: Env, chatId: number): Promise<void> {
  await sendMessage(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    "Этот раздел появится на следующих этапах разработки.",
    backToMenuKeyboard()
  );
}