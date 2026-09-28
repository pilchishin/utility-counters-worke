/**
 * Чтение значений из таблицы system_settings.
 */

/**
 * Читает числовую настройку. Возвращает defaultValue, если ключ
 * не найден или значение не является числом — это защищает логику
 * от падения, если строка настройки будет случайно удалена или
 * повреждена напрямую в базе.
 */
export async function getSettingNumber(
  db: D1Database,
  key: string,
  defaultValue: number
): Promise<number> {
  const row = await db
    .prepare("SELECT value FROM system_settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();

  if (!row) {
    return defaultValue;
  }

  const parsed = Number(row.value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

/**
 * Читает текстовую настройку (например, название часового пояса).
 * Возвращает defaultValue, если ключ не найден или значение пустое.
 */
export async function getSettingText(
  db: D1Database,
  key: string,
  defaultValue: string
): Promise<string> {
  const row = await db
    .prepare("SELECT value FROM system_settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();

  if (!row) {
    return defaultValue;
  }

  const trimmed = row.value.trim();
  return trimmed.length > 0 ? trimmed : defaultValue;
}