/**
 * Работа с таблицей telegram_users: поиск, создание, привязка/отвязка,
 * блокировка — включая операции, выполняемые администратором.
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
 * Ищет пользователя по внутреннему id (не по tg_id) —
 * используется административными действиями (блокировка, отвязка).
 */
export async function findUserById(
  db: D1Database,
  userId: number
): Promise<TelegramUserRow | null> {
  const row = await db
    .prepare(
      "SELECT id, tg_id, apartment_id, role, display_name, is_blocked, is_deleted FROM telegram_users WHERE id = ?"
    )
    .bind(userId)
    .first<TelegramUserRow>();

  return row ?? null;
}

/**
 * Активные (не удалённые) пользователи квартиры — для карточки квартиры
 * в административной панели.
 */
export async function listActiveUsersForApartment(
  db: D1Database,
  apartmentId: number
): Promise<TelegramUserRow[]> {
  const result = await db
    .prepare(
      `SELECT id, tg_id, apartment_id, role, display_name, is_blocked, is_deleted
       FROM telegram_users
       WHERE apartment_id = ? AND is_deleted = 0
       ORDER BY id`
    )
    .bind(apartmentId)
    .all<TelegramUserRow>();

  return result.results;
}

/**
 * Создаёт новую запись пользователя, привязанную к квартире
 * (штатный путь самостоятельной регистрации по коду).
 * Роль по умолчанию — 'tenant'; роль 'admin' назначается только
 * прямой правкой базы данных.
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

/**
 * Ручная привязка администратором: жилец не может (или не хочет)
 * ввести код сам, и администратор лично привязывает его tg_id к
 * квартире. Работает и для нового tg_id, и для ранее отвязанного
 * (is_deleted=1) — тогда запись "оживает" на новой квартире.
 *
 * Если tg_id уже привязан к какой-то квартире и НЕ отвязан —
 * запрос игнорируется (ok:false), чтобы не перехватить чужой активный
 * аккаунт по ошибке.
 */
export async function adminBindUser(
  db: D1Database,
  tgId: number,
  apartmentId: number
): Promise<{ ok: boolean }> {
  const result = await db
    .prepare(
      `INSERT INTO telegram_users (tg_id, apartment_id, role)
       VALUES (?, ?, 'tenant')
       ON CONFLICT(tg_id) DO UPDATE SET
         apartment_id = excluded.apartment_id,
         is_deleted = 0,
         is_blocked = 0
       WHERE telegram_users.is_deleted = 1`
    )
    .bind(tgId, apartmentId)
    .run();

  return { ok: result.meta.changes > 0 };
}

/** Мягкое удаление (отвязка) — история показаний сохраняется. */
export async function softDeleteUser(
  db: D1Database,
  userId: number
): Promise<void> {
  await db
    .prepare("UPDATE telegram_users SET is_deleted = 1 WHERE id = ?")
    .bind(userId)
    .run();
}

/** Блокировка/разблокировка пользователя. */
export async function setUserBlocked(
  db: D1Database,
  userId: number,
  blocked: boolean
): Promise<void> {
  await db
    .prepare("UPDATE telegram_users SET is_blocked = ? WHERE id = ?")
    .bind(blocked ? 1 : 0, userId)
    .run();
}