/**
 * Запросы планировщика: напоминания, недостающие показания,
 * получатели уведомлений.
 */

export type ReminderKind = "first" | "second" | "final";

/**
 * "Занимает" напоминание: записывает в таблицу reminders, что данное
 * напоминание квартире по периоду отправляется. Возвращает true, если
 * запись создана именно этим вызовом (false — уже была).
 */
export async function claimReminder(
  db: D1Database,
  apartmentId: number,
  periodId: number,
  kind: ReminderKind
): Promise<boolean> {
  const result = await db
    .prepare(
      "INSERT OR IGNORE INTO reminders (apartment_id, billing_period_id, kind) VALUES (?, ?, ?)"
    )
    .bind(apartmentId, periodId, kind)
    .run();

  return result.meta.changes > 0;
}

/**
 * Снимает "бронь" напоминания — нужно, если отправка не удалась
 * по временной причине и её надо повторить в следующий запуск.
 */
export async function releaseReminder(
  db: D1Database,
  apartmentId: number,
  periodId: number,
  kind: ReminderKind
): Promise<void> {
  await db
    .prepare(
      "DELETE FROM reminders WHERE apartment_id = ? AND billing_period_id = ? AND kind = ?"
    )
    .bind(apartmentId, periodId, kind)
    .run();
}

/**
 * Квартиры, которым напоминание данного вида по периоду уже отправлено.
 */
export async function listClaimedApartmentIds(
  db: D1Database,
  periodId: number,
  kind: ReminderKind
): Promise<Set<number>> {
  const result = await db
    .prepare(
      "SELECT apartment_id FROM reminders WHERE billing_period_id = ? AND kind = ?"
    )
    .bind(periodId, kind)
    .all<{ apartment_id: number }>();

  return new Set(result.results.map((row) => row.apartment_id));
}

export interface MissingReadingRow {
  apartment_id: number;
  apartment_number: string;
  resource_code: string;
  resource_name: string;
}

/**
 * Активные счётчики активных квартир, по которым за период
 * ещё нет показания (одна строка на счётчик).
 */
export async function listMissingReadings(
  db: D1Database,
  periodId: number
): Promise<MissingReadingRow[]> {
  const result = await db
    .prepare(
      `SELECT m.apartment_id AS apartment_id, a.number AS apartment_number,
              rt.code AS resource_code, rt.name AS resource_name
       FROM meters m
       JOIN apartments a ON a.id = m.apartment_id
       JOIN resource_types rt ON rt.id = m.resource_type_id
       LEFT JOIN readings r
         ON r.meter_id = m.id AND r.billing_period_id = ?
       WHERE a.is_active = 1 AND m.is_active = 1 AND rt.is_active = 1
         AND r.id IS NULL
       ORDER BY a.id, rt.id, m.id`
    )
    .bind(periodId)
    .all<MissingReadingRow>();

  return result.results;
}

export interface ReminderRecipientRow {
  tg_id: number;
  apartment_id: number;
}

/**
 * Жильцы, которым можно отправлять напоминания: не удалены,
 * не заблокированы, привязаны к квартире.
 */
export async function listReminderRecipients(
  db: D1Database
): Promise<ReminderRecipientRow[]> {
  const result = await db
    .prepare(
      `SELECT tg_id, apartment_id FROM telegram_users
       WHERE is_deleted = 0 AND is_blocked = 0 AND apartment_id IS NOT NULL
       ORDER BY id`
    )
    .all<ReminderRecipientRow>();

  return result.results;
}

/**
 * Администраторы (role = 'admin'), которым можно отправлять уведомления.
 */
export async function listAdminRecipients(
  db: D1Database
): Promise<number[]> {
  const result = await db
    .prepare(
      `SELECT tg_id FROM telegram_users
       WHERE role = 'admin' AND is_deleted = 0 AND is_blocked = 0
       ORDER BY id`
    )
    .all<{ tg_id: number }>();

  return result.results.map((row) => row.tg_id);
}

/**
 * Количество подозрительных показаний за период.
 */
export async function countSuspiciousReadings(
  db: D1Database,
  periodId: number
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM readings WHERE billing_period_id = ? AND status = 'suspicious'"
    )
    .bind(periodId)
    .first<{ count: number }>();

  return row?.count ?? 0;
}

/**
 * Сводка для журнала при закрытии периода: сколько активных счётчиков
 * и сколько показаний за период (для оценки полноты сбора).
 */
export async function countMetersAndReadings(
  db: D1Database,
  periodId: number
): Promise<{ metersExpected: number; readingsSubmitted: number }> {
  const meters = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM meters m
       JOIN apartments a ON a.id = m.apartment_id
       WHERE m.is_active = 1 AND a.is_active = 1`
    )
    .first<{ count: number }>();

  const readings = await db
    .prepare("SELECT COUNT(*) AS count FROM readings WHERE billing_period_id = ?")
    .bind(periodId)
    .first<{ count: number }>();

  return {
    metersExpected: meters?.count ?? 0,
    readingsSubmitted: readings?.count ?? 0,
  };
}