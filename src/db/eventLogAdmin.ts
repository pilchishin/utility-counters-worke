/**
 * Запросы журнала аудита для административной панели: постраничный
 * список событий с фильтрами и справочники значений для выпадающих
 * списков фильтров.
 */

export interface EventLogRow {
  id: number;
  entity_type: string;
  entity_id: number;
  action: string;
  actor_tg_id: number | null;
  payload: string | null;
  created_at: string;
}

export interface EventLogFilters {
  entityType?: string;
  action?: string;
}

/**
 * Страница журнала, новые события сверху. actor_tg_id получен join'ом
 * с telegram_users — для системных событий (напоминания, авто-закрытие
 * периода) actor_user_id пуст, и tg_id будет null.
 */
export async function listEventLogPage(
  db: D1Database,
  filters: EventLogFilters,
  limit: number,
  offset: number
): Promise<EventLogRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.entityType) {
    conditions.push("e.entity_type = ?");
    params.push(filters.entityType);
  }
  if (filters.action) {
    conditions.push("e.action = ?");
    params.push(filters.action);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit, offset);

  const result = await db
    .prepare(
      `SELECT e.id AS id, e.entity_type AS entity_type, e.entity_id AS entity_id,
              e.action AS action, u.tg_id AS actor_tg_id,
              e.payload AS payload, e.created_at AS created_at
       FROM event_log e
       LEFT JOIN telegram_users u ON u.id = e.actor_user_id
       ${where}
       ORDER BY e.id DESC
       LIMIT ? OFFSET ?`
    )
    .bind(...params)
    .all<EventLogRow>();

  return result.results;
}

/** Все встречающиеся в базе типы сущностей — для выпадающего списка фильтра. */
export async function listDistinctEntityTypes(db: D1Database): Promise<string[]> {
  const result = await db
    .prepare("SELECT DISTINCT entity_type FROM event_log ORDER BY entity_type")
    .all<{ entity_type: string }>();

  return result.results.map((row) => row.entity_type);
}

/** Все встречающиеся в базе действия — для выпадающего списка фильтра. */
export async function listDistinctActions(db: D1Database): Promise<string[]> {
  const result = await db
    .prepare("SELECT DISTINCT action FROM event_log ORDER BY action")
    .all<{ action: string }>();

  return result.results.map((row) => row.action);
}