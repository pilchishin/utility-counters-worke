import type { Env } from "../index";
import { findUserByTgId, findApartmentNumberByUser } from "../db/telegramUsers";
import type { TelegramUserRow } from "../db/telegramUsers";

export interface RegisteredAuth {
  kind: "registered";
  user: TelegramUserRow;
  apartmentNumber: string | null;
}

export type AuthResult =
  | { kind: "unregistered" }
  | { kind: "blocked" }
  | RegisteredAuth;

/**
 * Определяет статус пользователя по Telegram ID.
 * Единая точка проверки — используется и для сообщений, и для нажатий кнопок,
 * чтобы правила доступа не расходились между разными обработчиками.
 */
export async function resolveUser(env: Env, tgId: number): Promise<AuthResult> {
  const user = await findUserByTgId(env.DB, tgId);

  // Заблокированный пользователь проверяется первым.
  if (user && user.is_blocked === 1) {
    return { kind: "blocked" };
  }

  // Нет записи или пользователь мягко удалён — считаем незарегистрированным.
  if (!user || user.is_deleted === 1) {
    return { kind: "unregistered" };
  }

  const apartmentNumber =
    user.apartment_id !== null
      ? await findApartmentNumberByUser(env.DB, user.apartment_id)
      : null;

  return { kind: "registered", user, apartmentNumber };
}