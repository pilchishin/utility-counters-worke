import type { Env } from "../index";
import { getSettingNumber, getSettingText } from "../db/settings";
import {
  getOrCreateCurrentPeriod,
  listCollectingPeriods,
  closePeriod,
} from "../db/billingPeriods";
import { countMetersAndReadings } from "../db/reminders";
import { logEvent } from "../db/eventLog";
import { getLocalDateTime, addDaysIso } from "../utils/localTime";
import type { LocalDateTime } from "../utils/localTime";
import { runReminders, runAdminReport } from "./reminders";
import type { ReminderRunResult, AdminReportResult } from "./reminders";
import { runBackupIfDue } from "./backup";
import type { BackupRunResult } from "./backup";
import { checkWebhookHealth, checkBackupWindowHealth } from "./systemHealth";
import type { HealthCheckResult } from "./systemHealth";

/**
 * Периодические задачи (вызываются Cron Trigger раз в час).
 *
 * Каждый шаг выполняется независимо: сбой одного не мешает остальным,
 * а ошибки собираются в итоговую сводку. Все шаги идемпотентны —
 * повторный запуск в тот же час ничего не дублирует.
 */

export interface ScheduledRunSummary {
  now: string;
  timeZone: string;
  localDate: string;
  localHour: number;
  period: { id: number; year: number; month: number; status: string } | null;
  reminders: ReminderRunResult | null;
  adminReport: AdminReportResult | null;
  closedPeriods: string[];
  backup: BackupRunResult | null;
  webhookHealth: HealthCheckResult | null;
  backupWindowHealth: HealthCheckResult | null;
  errors: string[];
}

const DEFAULT_TIME_ZONE = "Europe/Kyiv";

/** Выполняет шаг; при ошибке записывает её в список и возвращает null. */
async function runStep<T>(
  name: string,
  errors: string[],
  action: () => Promise<T>
): Promise<T | null> {
  try {
    return await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Планировщик, шаг «${name}»:`, error);
    errors.push(`${name}: ${message}`);
    return null;
  }
}

/**
 * Закрывает периоды, у которых закончился месяц или истёк срок
 * period_close_grace_days после дедлайна.
 */
async function closeExpiredPeriods(
  db: D1Database,
  local: LocalDateTime
): Promise<string[]> {
  const graceDays = Math.min(
    Math.max(
      Math.trunc(await getSettingNumber(db, "period_close_grace_days", 5)),
      0
    ),
    60
  );

  const closed: string[] = [];
  const currentMonthIndex = local.year * 12 + local.month;

  for (const period of await listCollectingPeriods(db)) {
    const monthEnded = period.year * 12 + period.month < currentMonthIndex;
    const graceExpired = local.isoDate > addDaysIso(period.ends_at, graceDays);

    if (!monthEnded && !graceExpired) {
      continue;
    }

    // Сводка считается до закрытия — на момент, когда сбор ещё шёл.
    const counters = await countMetersAndReadings(db, period.id);
    const wasClosed = await closePeriod(db, period.id);

    if (wasClosed) {
      const label = `${period.year}-${String(period.month).padStart(2, "0")}`;
      closed.push(label);
      await logEvent(db, {
        entityType: "billing_period",
        entityId: period.id,
        action: "period_closed",
        payload: {
          year: period.year,
          month: period.month,
          reason: monthEnded ? "month_ended" : "grace_expired",
          meters_expected: counters.metersExpected,
          readings_submitted: counters.readingsSubmitted,
        },
      });
    }
  }

  return closed;
}

/**
 * Главная функция планировщика. Параметр now позволяет проверять
 * сценарии на «другую» дату (см. ручной запуск для тестов).
 */
export async function runScheduledTasks(
  env: Env,
  now: Date
): Promise<ScheduledRunSummary> {
  const db = env.DB;
  const errors: string[] = [];

  const timeZone = await getSettingText(db, "timezone", DEFAULT_TIME_ZONE);
  const local = getLocalDateTime(now, timeZone);

  const summary: ScheduledRunSummary = {
    now: now.toISOString(),
    timeZone: local.timeZone,
    localDate: local.isoDate,
    localHour: local.hour,
    period: null,
    reminders: null,
    adminReport: null,
    closedPeriods: [],
    backup: null,
    webhookHealth: null,
    backupWindowHealth: null,
    errors,
  };

  // Шаг 1. Период текущего местного месяца (создаётся, если ещё нет).
  const period = await runStep("создание периода", errors, () =>
    getOrCreateCurrentPeriod(db, now)
  );

  if (period) {
    summary.period = {
      id: period.id,
      year: period.year,
      month: period.month,
      status: period.status,
    };

    // Шаг 2. Напоминания жильцам.
    summary.reminders = await runStep("напоминания", errors, () =>
      runReminders(env, period, local)
    );

    // Шаг 3. Отчёт администратору (до закрытия периода).
    summary.adminReport = await runStep("отчёт администратору", errors, () =>
      runAdminReport(env, period, local)
    );
  }

  // Шаг 4. Закрытие просроченных периодов.
  const closed = await runStep("закрытие периодов", errors, () =>
    closeExpiredPeriods(db, local)
  );
  if (closed) {
    summary.closedPeriods = closed;
  }

  // Шаг 5. Еженедельный автоматический бэкап в R2 (если наступило время).
  summary.backup = await runStep("бэкап", errors, () =>
    runBackupIfDue(env, now)
  );

  // Шаг 6. Проверка работоспособности webhook'а (раз в сутки).
  summary.webhookHealth = await runStep("проверка webhook", errors, () =>
    checkWebhookHealth(env, local)
  );

  // Шаг 7. Проверка, не пропущено ли окно еженедельного бэкапа.
  summary.backupWindowHealth = await runStep("проверка окна бэкапа", errors, () =>
    checkBackupWindowHealth(env, local)
  );

  return summary;
}