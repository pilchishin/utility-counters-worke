import { getSettingNumber, getSettingText } from "./settings";
import { logEvent } from "./eventLog";
import { getLocalDateTime } from "../utils/localTime";

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

// Часовой пояс по умолчанию, если настройка timezone отсутствует.
const DEFAULT_TIME_ZONE = "Europe/Kyiv";

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
 * Период по id со всеми полями — используется административными
 * действиями (ручное закрытие, повторное открытие).
 */
export async function findPeriodByIdFull(
  db: D1Database,
  periodId: number
): Promise<BillingPeriodRow | null> {
  const row = await db
    .prepare(
      "SELECT id, year, month, starts_at, ends_at, status FROM billing_periods WHERE id = ?"
    )
    .bind(periodId)
    .first<BillingPeriodRow>();

  return row ?? null;
}

/**
 * Возвращает расчётный период текущего МЕСТНОГО месяца (часовой пояс
 * берётся из system_settings.timezone). Если периода ещё нет — создаёт
 * его со статусом 'collecting', используя настройки billing_day_start
 * и billing_day_end.
 *
 * Обычно период создаёт Cron в начале месяца; эта функция остаётся
 * запасным вариантом, если кто-то из жильцов обратился к боту раньше
 * планировщика.
 *
 * Параметр now нужен для тестов планировщика (имитация другой даты).
 */
export async function getOrCreateCurrentPeriod(
  db: D1Database,
  now: Date = new Date()
): Promise<BillingPeriodRow> {
  const timeZone = await getSettingText(db, "timezone", DEFAULT_TIME_ZONE);
  const local = getLocalDateTime(now, timeZone);
  const year = local.year;
  const month = local.month;

  const existing = await findPeriod(db, year, month);
  if (existing) {
    return existing;
  }

  const startDaySetting = await getSettingNumber(db, "billing_day_start", 1);
  const endDaySetting = await getSettingNumber(db, "billing_day_end", 25);

  // Последний день месяца (Date.UTC с "нулевым днём" следующего месяца).
  const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  const startDay = Math.min(
    Math.max(Math.trunc(startDaySetting), 1),
    lastDayOfMonth
  );
  const endDay = Math.min(
    Math.max(Math.trunc(endDaySetting), startDay),
    lastDayOfMonth
  );

  const startsAt = `${year}-${pad2(month)}-${pad2(startDay)}`;
  const endsAt = `${year}-${pad2(month)}-${pad2(endDay)}`;

  // INSERT OR IGNORE — защита от гонки: если два запроса одновременно
  // создают период, уникальный индекс (year, month) пропустит только один.
  const insertResult = await db
    .prepare(
      "INSERT OR IGNORE INTO billing_periods (year, month, starts_at, ends_at, status) VALUES (?, ?, ?, ?, 'collecting')"
    )
    .bind(year, month, startsAt, endsAt)
    .run();

  const created = await findPeriod(db, year, month);
  if (!created) {
    throw new Error("Не удалось создать расчётный период");
  }

  // В журнал пишем только если период создан именно этим вызовом.
  if (insertResult.meta.changes > 0) {
    try {
      await logEvent(db, {
        entityType: "billing_period",
        entityId: created.id,
        action: "period_opened",
        payload: { year, month, starts_at: startsAt, ends_at: endsAt },
      });
    } catch (error) {
      // Сбой журнала не должен мешать работе с периодом.
      console.error("Не удалось записать period_opened в журнал:", error);
    }
  }

  return created;
}

/**
 * Все периоды со статусом 'collecting' (от старых к новым).
 */
export async function listCollectingPeriods(
  db: D1Database
): Promise<BillingPeriodRow[]> {
  const result = await db
    .prepare(
      "SELECT id, year, month, starts_at, ends_at, status FROM billing_periods WHERE status = 'collecting' ORDER BY year, month"
    )
    .all<BillingPeriodRow>();

  return result.results;
}

/**
 * Закрывает период. Возвращает true, если период был закрыт именно
 * этим вызовом (false — он уже был закрыт).
 *
 * Используется и планировщиком (автоматическое закрытие по сроку),
 * и администратором (ручное закрытие раньше срока).
 */
export async function closePeriod(
  db: D1Database,
  periodId: number
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE billing_periods SET status = 'closed', closed_at = datetime('now') WHERE id = ? AND status = 'collecting'"
    )
    .bind(periodId)
    .run();

  return result.meta.changes > 0;
}

/**
 * Открывает закрытый период заново — административная операция.
 * Возвращает true, если период был открыт именно этим вызовом
 * (false — он уже был открыт).
 *
 * После повторного открытия жильцы снова могут подавать и исправлять
 * показания за этот период через бота. Cron не закроет его повторно
 * немедленно: закрытие по расписанию срабатывает только когда для
 * периода наступает условие закрытия (конец месяца или истечение
 * period_close_grace_days после дедлайна) — то есть механизм не
 * требует отдельной защиты от "мгновенного повторного закрытия".
 */
export async function reopenPeriod(
  db: D1Database,
  periodId: number
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE billing_periods SET status = 'collecting', closed_at = NULL WHERE id = ? AND status = 'closed'"
    )
    .bind(periodId)
    .run();

  return result.meta.changes > 0;
}