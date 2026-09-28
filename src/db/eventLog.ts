/**
 * Работа с журналом аудита event_log.
 * Таблица только для добавления — существующие записи никогда
 * не изменяются и не удаляются кодом системы.
 */

export interface LogEventParams {
  entityType: string;
  entityId: number;
  action: string;
  actorUserId?: number | null;
  payload?: Record<string, unknown>;
}

/**
 * Добавляет запись в журнал аудита.
 */
export async function logEvent(
  db: D1Database,
  params: LogEventParams
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO event_log (entity_type, entity_id, action, actor_user_id, payload) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(
      params.entityType,
      params.entityId,
      params.action,
      params.actorUserId ?? null,
      params.payload ? JSON.stringify(params.payload) : null
    )
    .run();
}

/**
 * Считает количество событий с заданным action для указанной сущности
 * за последние withinMinutes минут.
 * Используется для защиты от подбора кода регистрации (brute force).
 */
export async function countRecentEvents(
  db: D1Database,
  entityType: string,
  entityId: number,
  action: string,
  withinMinutes: number
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM event_log
       WHERE entity_type = ? AND entity_id = ? AND action = ?
         AND created_at >= datetime('now', ?)`
    )
    .bind(entityType, entityId, action, `-${withinMinutes} minutes`)
    .first<{ count: number }>();

  return row?.count ?? 0;
}