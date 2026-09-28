/**
 * Работа с таблицей telegram_users: поиск, создание,
 * получение номера квартиры пользователя.
 */

export interface TelegramUserRow {
  id: number;
  tg_id: number;
  apartment_id: number | null;
  role: string;
  display_name: string | null;
  is_blocked: number;
  is_deleted: number;
}

/**
 * Ищет пользователя по Telegram user ID (tg_id).
 * Возвращает null, если пользователь никогда не регистрировался.
 * Запись с is_deleted=1 тоже возвращается — вызывающий код сам решает,
 * считать ли такого пользователя зарегистрированным (обычно нет).
 */
export async function findUserByTgId(
  db: D1Database,
  tgId: number
): Promise<TelegramUserRow | null> {
  const row = await db
    .prepare(
      "SELECT id, tg_id, apartment_id, role, display_name, is_blocked, is_deleted FROM telegram_users WHERE tg_id = ?"
    )
    .bind(tgId)
    .first<TelegramUserRow>();

  return row ?? null;
}

/**
 * Создаёт новую запись пользователя, привязанную к квартире.
 * Роль по умолчанию — 'tenant' (обычный жилец); роль 'admin'
 * назначается только прямой правкой базы данных, не через бота.
 */
export async function createTelegramUser(
  db: D1Database,
  tgId: number,
  apartmentId: number
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO telegram_users (tg_id, apartment_id, role) VALUES (?, ?, 'tenant')"
    )
    .bind(tgId, apartmentId)
    .run();
}

/**
 * Возвращает номер квартиры по её ID.
 * Нужно для сообщений вида "Вы уже зарегистрированы (квартира №12)".
 */
export async function findApartmentNumberByUser(
  db: D1Database,
  apartmentId: number
): Promise<string | null> {
  const row = await db
    .prepare("SELECT number FROM apartments WHERE id = ?")
    .bind(apartmentId)
    .first<{ number: string }>();

  return row?.number ?? null;
}