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
 * Возвращает счётчик по id БЕЗ проверки принадлежности квартире.
 *
 * Используется только в административной панели, где вызывающий код
 * уже прошёл проверку пароля администратора и работает с данными,
 * полученными не от жильца, а из собственной выборки панели.
 */
export async function findMeterById(
  db: D1Database,
  meterId: number
): Promise<MeterRow | null> {
  const row = await db
    .prepare(`${METER_SELECT} WHERE m.id = ?`)
    .bind(meterId)
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

/**
 * Счётчик вместе со служебными полями учёта — используется только
 * административной панелью (карточка квартиры, замена, снятие с учёта).
 */
export interface AdminMeterRow extends MeterRow {
  is_active: number;
  installed_at: string;
  decommissioned_at: string | null;
  replaced_by_meter_id: number | null;
}

const ADMIN_METER_SELECT = `
  SELECT m.id, m.apartment_id, m.tariff_zone, m.serial_number,
         m.initial_reading, m.is_active, m.installed_at,
         m.decommissioned_at, m.replaced_by_meter_id,
         rt.code AS resource_code, rt.name AS resource_name, rt.unit AS unit
  FROM meters m
  JOIN resource_types rt ON rt.id = m.resource_type_id
`;

/** Все счётчики квартиры (активные и снятые с учёта) для карточки квартиры. */
export async function listAllMetersForApartment(
  db: D1Database,
  apartmentId: number
): Promise<AdminMeterRow[]> {
  const result = await db
    .prepare(
      `${ADMIN_METER_SELECT}
       WHERE m.apartment_id = ?
       ORDER BY m.is_active DESC, rt.id, m.serial_number, ${ZONE_ORDER}`
    )
    .bind(apartmentId)
    .all<AdminMeterRow>();

  return result.results;
}

/** Счётчик по id со служебными полями — для действий администратора. */
export async function findAdminMeterById(
  db: D1Database,
  meterId: number
): Promise<AdminMeterRow | null> {
  const row = await db
    .prepare(`${ADMIN_METER_SELECT} WHERE m.id = ?`)
    .bind(meterId)
    .first<AdminMeterRow>();

  return row ?? null;
}

export interface NewMeterParams {
  apartmentId: number;
  resourceTypeId: number;
  tariffZone: string | null;
  serialNumber: string | null;
  initialReading: number;
  installedAt: string;
}

/** Создаёт новый активный счётчик. Возвращает id созданной записи. */
export async function insertMeter(
  db: D1Database,
  params: NewMeterParams
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO meters
         (apartment_id, resource_type_id, tariff_zone, serial_number, initial_reading, installed_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      params.apartmentId,
      params.resourceTypeId,
      params.tariffZone,
      params.serialNumber,
      params.initialReading,
      params.installedAt
    )
    .run();

  return result.meta.last_row_id;
}

/** Снимает счётчик с учёта без замены. */
export async function decommissionMeter(
  db: D1Database,
  meterId: number,
  decommissionedAt: string
): Promise<void> {
  await db
    .prepare(
      "UPDATE meters SET is_active = 0, decommissioned_at = ? WHERE id = ? AND is_active = 1"
    )
    .bind(decommissionedAt, meterId)
    .run();
}

/** Помечает старый счётчик как заменённый новым (используется при замене). */
export async function markMeterReplaced(
  db: D1Database,
  oldMeterId: number,
  newMeterId: number,
  decommissionedAt: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE meters
       SET is_active = 0, decommissioned_at = ?, replaced_by_meter_id = ?
       WHERE id = ? AND is_active = 1`
    )
    .bind(decommissionedAt, newMeterId, oldMeterId)
    .run();
}