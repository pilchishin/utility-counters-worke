import { getSettingNumber } from "./settings";

/**
 * Работа с расчётными периодами (таблица billing_periods).
 */

export interface BillingPeriodRow {
  id: number;
  year: number;
  month: number;
  starts_at: string;
  ends_at: string;
  status: string;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

async function findPeriod(
  db: D1Database,
  year: number,
  month: number
): Promise<BillingPeriodRow | null> {
  const row = await db
    .prepare(
      "SELECT id, year, month, starts_at, ends_at, status FROM billing_periods WHERE year = ? AND month = ?"
    )
    .bind(year, month)
    .first<BillingPeriodRow>();

  return row ?? null;
}

/**
 * Возвращает расчётный период текущего месяца. Если его ещё нет —
 * создаёт со статусом 'collecting', используя настройки
 * billing_day_start и billing_day_end из system_settings.
 *
 * Пока автоматического планировщика (Cron) нет, период создаётся
 * при первом обращении в новом месяце. Позже эту работу возьмёт на
 * себя Cron, а эта функция останется как запасной вариант.
 *
 * Внимание: текущий месяц определяется по UTC. Поправка на часовой
 * пояс будет добавлена вместе с Cron-задачами.
 */
export async function getOrCreateCurrentPeriod(
  db: D1Database,
  now: Date = new Date()
): Promise<BillingPeriodRow> {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;

  const existing = await findPeriod(db, year, month);
  if (existing) {
    return existing;
  }

  const startDaySetting = await getSettingNumber(db, "billing_day_start", 1);
  const endDaySetting = await getSettingNumber(db, "billing_day_end", 25);

  // Последний день месяца (Date.UTC с "нулевым днём" следующего месяца).
  const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  const startDay = Math.min(Math.max(Math.trunc(startDaySetting), 1), lastDayOfMonth);
  const endDay = Math.min(Math.max(Math.trunc(endDaySetting), startDay), lastDayOfMonth);

  const startsAt = `${year}-${pad2(month)}-${pad2(startDay)}`;
  const endsAt = `${year}-${pad2(month)}-${pad2(endDay)}`;

  // INSERT OR IGNORE — защита от гонки: если два запроса одновременно
  // создают период, уникальный индекс (year, month) пропустит только один.
  await db
    .prepare(
      "INSERT OR IGNORE INTO billing_periods (year, month, starts_at, ends_at, status) VALUES (?, ?, ?, ?, 'collecting')"
    )
    .bind(year, month, startsAt, endsAt)
    .run();

  const created = await findPeriod(db, year, month);
  if (!created) {
    throw new Error("Не удалось создать расчётный период");
  }
  return created;
}