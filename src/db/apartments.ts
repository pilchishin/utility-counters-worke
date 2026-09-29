/**
 * Работа с таблицей apartments: поиск квартиры, подсчёт пользователей,
 * а также операции администратора (список, добавление, отключение,
 * перевыпуск кода доступа).
 */

export interface ApartmentRow {
  id: number;
  number: string;
  access_code: string;
  access_code_active: number;
  is_active: number;
}

/**
 * Ищет квартиру по номеру. Возвращает null, если квартира не найдена.
 * Сверка кода доступа выполняется отдельно вызывающим кодом —
 * здесь только получение записи по номеру.
 */
export async function findApartmentByNumber(
  db: D1Database,
  number: string
): Promise<ApartmentRow | null> {
  const row = await db
    .prepare(
      "SELECT id, number, access_code, access_code_active, is_active FROM apartments WHERE number = ?"
    )
    .bind(number)
    .first<ApartmentRow>();

  return row ?? null;
}

/**
 * Ищет квартиру по id. Используется административными операциями.
 */
export async function findApartmentById(
  db: D1Database,
  apartmentId: number
): Promise<ApartmentRow | null> {
  const row = await db
    .prepare(
      "SELECT id, number, access_code, access_code_active, is_active FROM apartments WHERE id = ?"
    )
    .bind(apartmentId)
    .first<ApartmentRow>();

  return row ?? null;
}

/**
 * Считает количество активных (не удалённых) пользователей,
 * привязанных к квартире — нужно для проверки лимита
 * max_users_per_apartment при регистрации.
 */
export async function countActiveUsersForApartment(
  db: D1Database,
  apartmentId: number
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM telegram_users WHERE apartment_id = ? AND is_deleted = 0"
    )
    .bind(apartmentId)
    .first<{ count: number }>();

  return row?.count ?? 0;
}

/**
 * Все квартиры (активные и отключённые) для административной панели.
 */
export async function listAllApartmentsForAdmin(
  db: D1Database
): Promise<ApartmentRow[]> {
  const result = await db
    .prepare(
      "SELECT id, number, access_code, access_code_active, is_active FROM apartments ORDER BY LENGTH(number), number"
    )
    .all<ApartmentRow>();

  return result.results;
}

export type InsertApartmentResult =
  | { ok: true; id: number }
  | { ok: false; reason: "duplicate_number" };

/**
 * Добавляет новую квартиру. Возвращает ok:false, если квартира
 * с таким номером уже существует (UNIQUE-ограничение в базе).
 */
export async function insertApartment(
  db: D1Database,
  number: string,
  accessCode: string
): Promise<InsertApartmentResult> {
  try {
    const result = await db
      .prepare("INSERT INTO apartments (number, access_code) VALUES (?, ?)")
      .bind(number, accessCode)
      .run();

    return { ok: true, id: result.meta.last_row_id };
  } catch (error) {
    // D1 сообщает о нарушении UNIQUE-ограничения текстом ошибки.
    if (error instanceof Error && error.message.toUpperCase().includes("UNIQUE")) {
      return { ok: false, reason: "duplicate_number" };
    }
    throw error;
  }
}

/**
 * Включает или отключает квартиру (мягкое отключение — is_active).
 */
export async function setApartmentActive(
  db: D1Database,
  apartmentId: number,
  isActive: boolean
): Promise<void> {
  await db
    .prepare("UPDATE apartments SET is_active = ? WHERE id = ?")
    .bind(isActive ? 1 : 0, apartmentId)
    .run();
}

/**
 * Перевыпускает код доступа квартиры: старый код перестаёт действовать,
 * новый становится активным. Используется при смене владельца
 * или компрометации кода.
 */
export async function reissueApartmentCode(
  db: D1Database,
  apartmentId: number,
  newCode: string
): Promise<void> {
  await db
    .prepare(
      "UPDATE apartments SET access_code = ?, access_code_active = 1 WHERE id = ?"
    )
    .bind(newCode, apartmentId)
    .run();
}