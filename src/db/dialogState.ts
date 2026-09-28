/**
 * Работа с таблицей dialog_state — состоянием диалога пользователя.
 */

// Через сколько минут неактивности состояние считается устаревшим.
// Защита от ситуации, когда человек вернулся через несколько дней
// и случайное число в чате было воспринято как показание счётчика.
const DIALOG_TTL_MINUTES = 30;

export type DialogStateName = "AWAITING_READING_VALUE" | "CONFIRM_READING";

export interface DialogState {
  state: DialogStateName;
  context: Record<string, unknown>;
}

/**
 * Возвращает текущее состояние диалога или null, если состояния нет
 * либо оно устарело.
 */
export async function getDialogState(
  db: D1Database,
  tgId: number
): Promise<DialogState | null> {
  const row = await db
    .prepare(
      `SELECT state, context_json FROM dialog_state
       WHERE tg_id = ? AND updated_at >= datetime('now', ?)`
    )
    .bind(tgId, `-${DIALOG_TTL_MINUTES} minutes`)
    .first<{ state: string; context_json: string | null }>();

  if (!row) {
    return null;
  }

  let context: Record<string, unknown> = {};
  if (row.context_json) {
    try {
      context = JSON.parse(row.context_json) as Record<string, unknown>;
    } catch {
      // Повреждённый JSON не должен ломать бота — считаем контекст пустым.
      context = {};
    }
  }

  return { state: row.state as DialogStateName, context };
}

/**
 * Устанавливает (создаёт или перезаписывает) состояние диалога.
 */
export async function setDialogState(
  db: D1Database,
  tgId: number,
  state: DialogStateName,
  context: Record<string, unknown>
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO dialog_state (tg_id, state, context_json, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(tg_id) DO UPDATE SET
         state = excluded.state,
         context_json = excluded.context_json,
         updated_at = datetime('now')`
    )
    .bind(tgId, state, JSON.stringify(context))
    .run();
}

/**
 * Сбрасывает состояние диалога (пользователь вернулся в "свободный" режим).
 */
export async function clearDialogState(
  db: D1Database,
  tgId: number
): Promise<void> {
  await db.prepare("DELETE FROM dialog_state WHERE tg_id = ?").bind(tgId).run();
}