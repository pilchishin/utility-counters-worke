/**
 * Запросы для отчётов и экспорта: список существующих периодов,
 * подробные показания за период, полная выгрузка всех данных.
 */

export interface PeriodOption {
  id: number;
  year: number;
  month: number;
  status: string;
}

/** Все периоды, за которые в базе есть хоть какие-то показания, новые сверху. */
export async function listAllPeriods(db: D1Database): Promise<PeriodOption[]> {
  const result = await db
    .prepare(
      `SELECT id, year, month, status FROM billing_periods
       ORDER BY year DESC, month DESC`
    )
    .all<PeriodOption>();

  return result.results;
}

/** Один период по id (или null). */
export async function findPeriodById(
  db: D1Database,
  periodId: number
): Promise<PeriodOption | null> {
  const row = await db
    .prepare("SELECT id, year, month, status FROM billing_periods WHERE id = ?")
    .bind(periodId)
    .first<PeriodOption>();

  return row ?? null;
}

export interface ReadingExportRow {
  apartment_number: string;
  resource_name: string;
  tariff_zone: string | null;
  serial_number: string | null;
  value: number;
  consumption: number | null;
  unit: string;
  status: string;
  flag_reason: string | null;
  submitted_at: string;
  submitted_by_tg_id: number | null;
}

/**
 * Все показания периода со всеми полями, нужными для начислений
 * и для разбора: квартира, ресурс, счётчик, значение, расход, статус.
 */
export async function listReadingsForExport(
  db: D1Database,
  periodId: number
): Promise<ReadingExportRow[]> {
  const result = await db
    .prepare(
      `SELECT a.number AS apartment_number, rt.name AS resource_name,
              m.tariff_zone AS tariff_zone, m.serial_number AS serial_number,
              r.value AS value, r.consumption AS consumption, rt.unit AS unit,
              r.status AS status, r.flag_reason AS flag_reason,
              r.submitted_at AS submitted_at, u.tg_id AS submitted_by_tg_id
       FROM readings r
       JOIN meters m ON m.id = r.meter_id
       JOIN apartments a ON a.id = m.apartment_id
       JOIN resource_types rt ON rt.id = m.resource_type_id
       LEFT JOIN telegram_users u ON u.id = r.submitted_by_user_id
       WHERE r.billing_period_id = ?
       ORDER BY LENGTH(a.number), a.number, rt.id, m.serial_number`
    )
    .bind(periodId)
    .all<ReadingExportRow>();

  return result.results;
}

export interface ApartmentExportRow {
  id: number;
  number: string;
  is_active: number;
  access_code_active: number;
  created_at: string;
}

/** Полная выгрузка квартир (для общего экспорта данных). */
export async function listApartmentsForExport(
  db: D1Database
): Promise<ApartmentExportRow[]> {
  const result = await db
    .prepare(
      "SELECT id, number, is_active, access_code_active, created_at FROM apartments ORDER BY id"
    )
    .all<ApartmentExportRow>();

  return result.results;
}

export interface MeterExportRow {
  id: number;
  apartment_number: string;
  resource_name: string;
  tariff_zone: string | null;
  serial_number: string | null;
  initial_reading: number;
  installed_at: string;
  is_active: number;
  decommissioned_at: string | null;
  replaced_by_meter_id: number | null;
}

/** Полная выгрузка счётчиков, включая снятые с учёта. */
export async function listMetersForExport(
  db: D1Database
): Promise<MeterExportRow[]> {
  const result = await db
    .prepare(
      `SELECT m.id AS id, a.number AS apartment_number, rt.name AS resource_name,
              m.tariff_zone AS tariff_zone, m.serial_number AS serial_number,
              m.initial_reading AS initial_reading, m.installed_at AS installed_at,
              m.is_active AS is_active, m.decommissioned_at AS decommissioned_at,
              m.replaced_by_meter_id AS replaced_by_meter_id
       FROM meters m
       JOIN apartments a ON a.id = m.apartment_id
       JOIN resource_types rt ON rt.id = m.resource_type_id
       ORDER BY a.id, m.id`
    )
    .all<MeterExportRow>();

  return result.results;
}

export interface ReadingFullExportRow extends ReadingExportRow {
  period_year: number;
  period_month: number;
}

/** Полная выгрузка всех показаний за всё время (для общего экспорта данных). */
export async function listAllReadingsForExport(
  db: D1Database
): Promise<ReadingFullExportRow[]> {
  const result = await db
    .prepare(
      `SELECT a.number AS apartment_number, rt.name AS resource_name,
              m.tariff_zone AS tariff_zone, m.serial_number AS serial_number,
              r.value AS value, r.consumption AS consumption, rt.unit AS unit,
              r.status AS status, r.flag_reason AS flag_reason,
              r.submitted_at AS submitted_at, u.tg_id AS submitted_by_tg_id,
              bp.year AS period_year, bp.month AS period_month
       FROM readings r
       JOIN meters m ON m.id = r.meter_id
       JOIN apartments a ON a.id = m.apartment_id
       JOIN resource_types rt ON rt.id = m.resource_type_id
       JOIN billing_periods bp ON bp.id = r.billing_period_id
       LEFT JOIN telegram_users u ON u.id = r.submitted_by_user_id
       ORDER BY bp.year, bp.month, LENGTH(a.number), a.number`
    )
    .all<ReadingFullExportRow>();

  return result.results;
}