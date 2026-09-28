/**
 * Работа с таблицей meters (вместе с данными о типе ресурса).
 */

export interface MeterRow {
  id: number;
  apartment_id: number;
  tariff_zone: string | null;
  serial_number: string | null;
  initial_reading: number;
  resource_code: string;
  resource_name: string;
  unit: string;
}

// Общая часть запроса: счётчик + название и единица измерения ресурса.
const METER_SELECT = `
  SELECT m.id, m.apartment_id, m.tariff_zone, m.serial_number,
         m.initial_reading,
         rt.code AS resource_code, rt.name AS resource_name, rt.unit AS unit
  FROM meters m
  JOIN resource_types rt ON rt.id = m.resource_type_id
`;

// Порядок тарифных зон при вводе: сначала день, затем ночь, затем остальные.
const ZONE_ORDER = `
  CASE m.tariff_zone WHEN 'day' THEN 1 WHEN 'night' THEN 2 ELSE 3 END, m.id
`;

/**
 * Активные счётчики квартиры по коду ресурса (например, 'cold_water').
 */
export async function findActiveMetersByResource(
  db: D1Database,
  apartmentId: number,
  resourceCode: string
): Promise<MeterRow[]> {
  const result = await db
    .prepare(
      `${METER_SELECT}
       WHERE m.apartment_id = ? AND m.is_active = 1
         AND rt.is_active = 1 AND rt.code = ?
       ORDER BY m.id`
    )
    .bind(apartmentId, resourceCode)
    .all<MeterRow>();

  return result.results;
}

/**
 * Возвращает счётчик, ТОЛЬКО если он активен и принадлежит указанной квартире.
 *
 * Это ключевая проверка безопасности: id счётчика приходит из чата
 * (кнопка или сохранённое состояние диалога), и доверять ему без
 * проверки принадлежности квартире нельзя.
 */
export async function findMeterForApartment(
  db: D1Database,
  meterId: number,
  apartmentId: number
): Promise<MeterRow | null> {
  const row = await db
    .prepare(
      `${METER_SELECT}
       WHERE m.id = ? AND m.apartment_id = ? AND m.is_active = 1`
    )
    .bind(meterId, apartmentId)
    .first<MeterRow>();

  return row ?? null;
}

/**
 * Возвращает группу счётчиков, к которой относится указанный счётчик:
 * все активные счётчики той же квартиры и того же ресурса с тем же
 * серийным номером (например, тарифные зоны «день» и «ночь» одного
 * физического электросчётчика), в порядке ввода: день, ночь, остальные.
 *
 * Если серийный номер не задан, счётчик считается одиночным.
 * Если счётчик не найден или не принадлежит квартире — пустой массив.
 */
export async function findMeterGroupForApartment(
  db: D1Database,
  meterId: number,
  apartmentId: number
): Promise<MeterRow[]> {
  const meter = await findMeterForApartment(db, meterId, apartmentId);
  if (!meter) {
    return [];
  }

  if (!meter.serial_number) {
    return [meter];
  }

  const result = await db
    .prepare(
      `${METER_SELECT}
       WHERE m.apartment_id = ? AND m.is_active = 1
         AND rt.code = ? AND m.serial_number = ?
       ORDER BY ${ZONE_ORDER}`
    )
    .bind(apartmentId, meter.resource_code, meter.serial_number)
    .all<MeterRow>();

  return result.results;
}