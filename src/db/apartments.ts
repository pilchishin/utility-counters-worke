/**
 * Работа с таблицей apartments: поиск квартиры и подсчёт
 * привязанных к ней пользователей.
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