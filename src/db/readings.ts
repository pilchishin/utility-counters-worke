/**
 * Работа с таблицей readings (показания счётчиков).
 */

export interface ReadingRow {
  id: number;
  meter_id: number;
  billing_period_id: number;
  value: number;
  consumption: number | null;
  status: string;
  flag_reason: string | null;
}

/**
 * Показание конкретного счётчика за конкретный период (или null).
 */
export async function findReadingForPeriod(
  db: D1Database,
  meterId: number,
  periodId: number
): Promise<ReadingRow | null> {
  const row = await db
    .prepare(
      `SELECT id, meter_id, billing_period_id, value, consumption, status, flag_reason
       FROM readings WHERE meter_id = ? AND billing_period_id = ?`
    )
    .bind(meterId, periodId)
    .first<ReadingRow>();

  return row ?? null;
}

/**
 * Последнее подтверждённое показание счётчика за периоды ДО указанного.
 *
 * Учитываются только показания со статусом 'ok' или 'corrected'.
 * Подозрительные ('suspicious') не считаются базой для расчёта:
 * иначе одна опечатка исказила бы расход следующего месяца.
 */
export async function findPreviousReadingValue(
  db: D1Database,
  meterId: number,
  periodYear: number,
  periodMonth: number
): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT r.value AS value
       FROM readings r
       JOIN billing_periods bp ON bp.id = r.billing_period_id
       WHERE r.meter_id = ?
         AND r.status IN ('ok', 'corrected')
         AND (bp.year * 12 + bp.month) < ?
       ORDER BY bp.year DESC, bp.month DESC
       LIMIT 1`
    )
    .bind(meterId, periodYear * 12 + periodMonth)
    .first<{ value: number }>();

  return row ? row.value : null;
}

/**
 * Расходы последних подтверждённых показаний счётчика за периоды ДО
 * указанного, от новых к старым. Нужны для проверки скачка расхода
 * и серии нулевых расходов.
 *
 * Учитываются только показания со статусом 'ok' или 'corrected'
 * и с рассчитанным расходом.
 */
export async function listRecentConsumptions(
  db: D1Database,
  meterId: number,
  periodYear: number,
  periodMonth: number,
  limit: number
): Promise<number[]> {
  const result = await db
    .prepare(
      `SELECT r.consumption AS consumption
       FROM readings r
       JOIN billing_periods bp ON bp.id = r.billing_period_id
       WHERE r.meter_id = ?
         AND r.status IN ('ok', 'corrected')
         AND r.consumption IS NOT NULL
         AND (bp.year * 12 + bp.month) < ?
       ORDER BY bp.year DESC, bp.month DESC
       LIMIT ?`
    )
    .bind(meterId, periodYear * 12 + periodMonth, limit)
    .all<{ consumption: number }>();

  return result.results.map((row) => row.consumption);
}

export interface NewReadingParams {
  meterId: number;
  periodId: number;
  value: number;
  consumption: number | null;
  status: string;
  flagReason: string | null;
  userId: number;
}

/**
 * Добавляет новое показание. Возвращает id созданной записи.
 * Уникальный индекс (meter_id, billing_period_id) не даст создать дубликат.
 */
export async function insertReading(
  db: D1Database,
  params: NewReadingParams
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO readings
         (meter_id, billing_period_id, value, consumption, status, flag_reason, submitted_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      params.meterId,
      params.periodId,
      params.value,
      params.consumption,
      params.status,
      params.flagReason,
      params.userId
    )
    .run();

  return result.meta.last_row_id;
}

export interface UpdateReadingParams {
  value: number;
  consumption: number | null;
  status: string;
  flagReason: string | null;
  userId: number;
}

/**
 * Заменяет значение уже существующего показания (используется
 * жильцом при повторном вводе за тот же период).
 * Старое значение вызывающий код обязан записать в event_log.
 */
export async function updateReadingValue(
  db: D1Database,
  readingId: number,
  params: UpdateReadingParams
): Promise<void> {
  await db
    .prepare(
      `UPDATE readings
       SET value = ?, consumption = ?, status = ?, flag_reason = ?,
           submitted_by_user_id = ?, submitted_at = datetime('now')
       WHERE id = ?`
    )
    .bind(
      params.value,
      params.consumption,
      params.status,
      params.flagReason,
      params.userId,
      readingId
    )
    .run();
}

export interface ReadingWithPeriodRow {
  id: number;
  meter_id: number;
  billing_period_id: number;
  value: number;
  consumption: number | null;
  status: string;
  flag_reason: string | null;
  period_year: number;
  period_month: number;
}

/**
 * Показание по id вместе с годом/месяцем его периода —
 * используется административными действиями (подтвердить/исправить).
 */
export async function findReadingById(
  db: D1Database,
  readingId: number
): Promise<ReadingWithPeriodRow | null> {
  const row = await db
    .prepare(
      `SELECT r.id AS id, r.meter_id AS meter_id, r.billing_period_id AS billing_period_id,
              r.value AS value, r.consumption AS consumption, r.status AS status,
              r.flag_reason AS flag_reason,
              bp.year AS period_year, bp.month AS period_month
       FROM readings r
       JOIN billing_periods bp ON bp.id = r.billing_period_id
       WHERE r.id = ?`
    )
    .bind(readingId)
    .first<ReadingWithPeriodRow>();

  return row ?? null;
}

export interface AdminCorrectionParams {
  value: number;
  consumption: number | null;
  comment: string;
}

/**
 * Исправление показания администратором.
 *
 * В отличие от updateReadingValue (которым жилец сам заменяет своё
 * значение), эта функция фиксирует причину исправления
 * (correction_comment) и всегда переводит показание в статус
 * 'corrected' — как показание, изменённое администратором, а не
 * жильцом.
 */
export async function adminCorrectReading(
  db: D1Database,
  readingId: number,
  params: AdminCorrectionParams
): Promise<void> {
  await db
    .prepare(
      `UPDATE readings
       SET value = ?, consumption = ?, status = 'corrected', flag_reason = NULL,
           correction_comment = ?, corrected_by_user_id = NULL
       WHERE id = ?`
    )
    .bind(params.value, params.consumption, params.comment, readingId)
    .run();
}

/**
 * Подтверждение администратором: значение верное, несмотря на пометку.
 * Само значение не меняется, статус переводится в 'ok'.
 */
export async function adminConfirmReading(
  db: D1Database,
  readingId: number
): Promise<void> {
  await db
    .prepare(
      "UPDATE readings SET status = 'ok' WHERE id = ? AND status = 'suspicious'"
    )
    .bind(readingId)
    .run();
}