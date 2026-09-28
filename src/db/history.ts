/**
 * Запросы для экранов «Мои показания» и «История».
 * Все запросы ограничены квартирой пользователя (apartment_id).
 */

// Порядок тарифных зон в списках: день, затем ночь, затем остальные.
const ZONE_ORDER =
  "CASE m.tariff_zone WHEN 'day' THEN 1 WHEN 'night' THEN 2 ELSE 3 END";

export interface ResourceTypeRow {
  id: number;
  code: string;
  name: string;
  unit: string;
}

/** Тип ресурса по коду (или null, если такого нет или он отключён). */
export async function findResourceTypeByCode(
  db: D1Database,
  code: string
): Promise<ResourceTypeRow | null> {
  const row = await db
    .prepare(
      "SELECT id, code, name, unit FROM resource_types WHERE code = ? AND is_active = 1"
    )
    .bind(code)
    .first<ResourceTypeRow>();

  return row ?? null;
}

/**
 * Типы ресурсов, по которым у квартиры есть (или были) счётчики.
 * Используется для меню истории.
 */
export async function listResourceTypesForApartment(
  db: D1Database,
  apartmentId: number
): Promise<ResourceTypeRow[]> {
  const result = await db
    .prepare(
      `SELECT rt.id AS id, rt.code AS code, rt.name AS name, rt.unit AS unit
       FROM resource_types rt
       WHERE rt.is_active = 1
         AND EXISTS (
           SELECT 1 FROM meters m
           WHERE m.apartment_id = ? AND m.resource_type_id = rt.id
         )
       ORDER BY rt.id`
    )
    .bind(apartmentId)
    .all<ResourceTypeRow>();

  return result.results;
}

export interface PeriodMeterReadingRow {
  meter_id: number;
  serial_number: string | null;
  tariff_zone: string | null;
  resource_code: string;
  resource_name: string;
  unit: string;
  value: number | null;
  consumption: number | null;
  status: string | null;
}

/**
 * Все активные счётчики квартиры с показаниями за период.
 * Если показания нет, поля value/consumption/status равны null.
 */
export async function listMeterReadingsForPeriod(
  db: D1Database,
  apartmentId: number,
  periodId: number
): Promise<PeriodMeterReadingRow[]> {
  const result = await db
    .prepare(
      `SELECT m.id AS meter_id, m.serial_number AS serial_number,
              m.tariff_zone AS tariff_zone,
              rt.code AS resource_code, rt.name AS resource_name, rt.unit AS unit,
              r.value AS value, r.consumption AS consumption, r.status AS status
       FROM meters m
       JOIN resource_types rt ON rt.id = m.resource_type_id
       LEFT JOIN readings r
         ON r.meter_id = m.id AND r.billing_period_id = ?
       WHERE m.apartment_id = ? AND m.is_active = 1 AND rt.is_active = 1
       ORDER BY rt.id, m.serial_number, ${ZONE_ORDER}, m.id`
    )
    .bind(periodId, apartmentId)
    .all<PeriodMeterReadingRow>();

  return result.results;
}

export interface HistoryPeriodRow {
  id: number;
  year: number;
  month: number;
}

/**
 * Периоды, за которые у квартиры есть показания по ресурсу,
 * от новых к старым, со смещением для постраничного вывода.
 */
export async function listHistoryPeriods(
  db: D1Database,
  apartmentId: number,
  resourceCode: string,
  limit: number,
  offset: number
): Promise<HistoryPeriodRow[]> {
  const result = await db
    .prepare(
      `SELECT DISTINCT bp.id AS id, bp.year AS year, bp.month AS month
       FROM readings r
       JOIN meters m ON m.id = r.meter_id
       JOIN resource_types rt ON rt.id = m.resource_type_id
       JOIN billing_periods bp ON bp.id = r.billing_period_id
       WHERE m.apartment_id = ? AND rt.code = ?
       ORDER BY bp.year DESC, bp.month DESC
       LIMIT ? OFFSET ?`
    )
    .bind(apartmentId, resourceCode, limit, offset)
    .all<HistoryPeriodRow>();

  return result.results;
}

export interface HistoryReadingRow {
  billing_period_id: number;
  meter_id: number;
  serial_number: string | null;
  tariff_zone: string | null;
  value: number;
  consumption: number | null;
  status: string;
}

/**
 * Показания квартиры по ресурсу за перечисленные периоды.
 * Включает показания снятых с учёта счётчиков.
 */
export async function listHistoryReadings(
  db: D1Database,
  apartmentId: number,
  resourceCode: string,
  periodIds: number[]
): Promise<HistoryReadingRow[]> {
  if (periodIds.length === 0) {
    return [];
  }

  // Количество плейсхолдеров зависит только от числа периодов на странице
  // (не более нескольких штук); сами значения передаются через bind.
  const placeholders = periodIds.map(() => "?").join(", ");

  const result = await db
    .prepare(
      `SELECT r.billing_period_id AS billing_period_id, m.id AS meter_id,
              m.serial_number AS serial_number, m.tariff_zone AS tariff_zone,
              r.value AS value, r.consumption AS consumption, r.status AS status
       FROM readings r
       JOIN meters m ON m.id = r.meter_id
       JOIN resource_types rt ON rt.id = m.resource_type_id
       JOIN billing_periods bp ON bp.id = r.billing_period_id
       WHERE m.apartment_id = ? AND rt.code = ?
         AND r.billing_period_id IN (${placeholders})
       ORDER BY bp.year DESC, bp.month DESC, m.serial_number, ${ZONE_ORDER}, m.id`
    )
    .bind(apartmentId, resourceCode, ...periodIds)
    .all<HistoryReadingRow>();

  return result.results;
}