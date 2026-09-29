/**
 * Запросы для административной панели.
 */

export interface ApartmentOverviewRow {
  id: number;
  number: string;
  total_meters: number;
  submitted_meters: number;
}

/**
 * Активные квартиры со сводкой по текущему периоду: сколько всего
 * активных счётчиков и сколько из них уже имеют показание за период.
 * Квартиры без счётчиков тоже попадают в список (total_meters = 0).
 */
export async function listApartmentsOverview(
  db: D1Database,
  periodId: number
): Promise<ApartmentOverviewRow[]> {
  const result = await db
    .prepare(
      `SELECT a.id AS id, a.number AS number,
              (SELECT COUNT(*) FROM meters m
                 JOIN resource_types rt ON rt.id = m.resource_type_id
                 WHERE m.apartment_id = a.id AND m.is_active = 1 AND rt.is_active = 1
              ) AS total_meters,
              (SELECT COUNT(*) FROM meters m
                 JOIN resource_types rt ON rt.id = m.resource_type_id
                 JOIN readings r ON r.meter_id = m.id AND r.billing_period_id = ?
                 WHERE m.apartment_id = a.id AND m.is_active = 1 AND rt.is_active = 1
              ) AS submitted_meters
       FROM apartments a
       WHERE a.is_active = 1
       ORDER BY LENGTH(a.number), a.number`
    )
    .bind(periodId)
    .all<ApartmentOverviewRow>();

  return result.results;
}

export interface SuspiciousReadingRow {
  reading_id: number;
  meter_id: number;
  apartment_number: string;
  resource_name: string;
  tariff_zone: string | null;
  serial_number: string | null;
  value: number;
  consumption: number | null;
  flag_reason: string | null;
  unit: string;
  submitted_at: string;
}

/**
 * Показания со статусом 'suspicious' за указанный период,
 * с данными квартиры и счётчика — для разбора администратором.
 */
export async function listSuspiciousReadings(
  db: D1Database,
  periodId: number
): Promise<SuspiciousReadingRow[]> {
  const result = await db
    .prepare(
      `SELECT r.id AS reading_id, m.id AS meter_id, a.number AS apartment_number,
              rt.name AS resource_name, m.tariff_zone AS tariff_zone,
              m.serial_number AS serial_number, r.value AS value,
              r.consumption AS consumption, r.flag_reason AS flag_reason,
              rt.unit AS unit, r.submitted_at AS submitted_at
       FROM readings r
       JOIN meters m ON m.id = r.meter_id
       JOIN apartments a ON a.id = m.apartment_id
       JOIN resource_types rt ON rt.id = m.resource_type_id
       WHERE r.billing_period_id = ? AND r.status = 'suspicious'
       ORDER BY r.submitted_at DESC`
    )
    .bind(periodId)
    .all<SuspiciousReadingRow>();

  return result.results;
}