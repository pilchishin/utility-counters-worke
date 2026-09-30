/**
 * Учёт пользователей, которые написали боту, но ещё не привязаны
 * к квартире. Нужен для админ-панели: список "ожидают привязки"
 * позволяет привязать жильца по одному клику, без ручного ввода
 * его Telegram ID через сторонние инструменты.
 */

export interface PendingRegistrationRow {
  tg_id: number;
  first_seen: string;
  last_seen: string;
}

/**
 * Отмечает обращение пользователя. Если запись уже есть — обновляет
 * только "последний раз", "впервые увидены" не трогается.
 */
export async function upsertPendingRegistration(
  db: D1Database,
  tgId: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pending_registrations (tg_id) VALUES (?)
       ON CONFLICT(tg_id) DO UPDATE SET last_seen = datetime('now')`
    )
    .bind(tgId)
    .run();
}

/** Убирает пользователя из списка ожидающих (после успешной привязки). */
export async function removePendingRegistration(
  db: D1Database,
  tgId: number
): Promise<void> {
  await db
    .prepare("DELETE FROM pending_registrations WHERE tg_id = ?")
    .bind(tgId)
    .run();
}

/** Список ожидающих привязки, новые обращения сверху. */
export async function listPendingRegistrations(
  db: D1Database,
  limit: number
): Promise<PendingRegistrationRow[]> {
  const result = await db
    .prepare(
      "SELECT tg_id, first_seen, last_seen FROM pending_registrations ORDER BY last_seen DESC LIMIT ?"
    )
    .bind(limit)
    .all<PendingRegistrationRow>();

  return result.results;
}