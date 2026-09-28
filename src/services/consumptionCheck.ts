import type { MeterRow } from "../db/meters";
import type { BillingPeriodRow } from "../db/billingPeriods";
import { getSettingNumber } from "../db/settings";
import { listRecentConsumptions } from "../db/readings";

/**
 * Оценка расхода: решает, является ли показание подозрительным,
 * и по какой причине. Единственное место с правилами проверки —
 * экран подтверждения и сохранение используют один и тот же расчёт.
 *
 * Правила (проверяются по порядку, срабатывает первое подходящее):
 *  1. decreased     — значение меньше предыдущего (расход < 0);
 *  2. over_absolute — расход больше абсолютного порога ресурса
 *                     (system_settings: max_consumption_<код ресурса>);
 *  3. over_relative — расход больше среднего за последние месяцы
 *                     в suspicious_multiplier раз (и выше «пола»).
 *
 * Нулевой расход подозрительным НЕ считается: показание принимается,
 * а серия нулевых расходов только фиксируется для сведения администратора.
 */

export type FlagReason = "decreased" | "over_absolute" | "over_relative";

export interface ConsumptionAssessment {
  consumption: number;
  baseValue: number;
  status: "ok" | "suspicious";
  flagReason: FlagReason | null;
  isZero: boolean;
  // Длина серии нулевых расходов подряд, включая текущий (0, если расход не нулевой).
  zeroStreak: number;
  // true, если серия достигла порога zero_streak_alert_periods.
  zeroStreakAlert: boolean;
  // Среднее за последние месяцы (null, если истории недостаточно).
  average: number | null;
  // Абсолютный порог (null, если проверка отключена).
  absoluteLimit: number | null;
}

// Верхняя граница количества месяцев истории (защита от неверных настроек).
const MAX_HISTORY = 12;

function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}

// Округление до 3 знаков — убирает артефакты вида 6.299999999999983.
function roundTo3(value: number): number {
  return Number(value.toFixed(3));
}

function formatValue(value: number): string {
  return value.toFixed(3);
}

/**
 * Оценивает показание: считает расход и определяет статус.
 *
 * baseValue — значение, от которого считается расход (предыдущее
 * подтверждённое показание или начальное показание счётчика).
 */
export async function assessConsumption(
  db: D1Database,
  meter: MeterRow,
  period: BillingPeriodRow,
  value: number,
  baseValue: number
): Promise<ConsumptionAssessment> {
  const consumption = roundTo3(value - baseValue);
  const code = meter.resource_code;

  // Пороги читаются из system_settings. Если ключа нет,
  // используется значение по умолчанию (0 — проверка отключена).
  const absoluteSetting = await getSettingNumber(db, `max_consumption_${code}`, 0);
  const multiplier = await getSettingNumber(db, "suspicious_multiplier", 3);
  const historyPeriods = clampInt(
    await getSettingNumber(db, "suspicious_history_periods", 3),
    1,
    MAX_HISTORY
  );
  const minHistory = clampInt(
    await getSettingNumber(db, "suspicious_min_history", 2),
    1,
    MAX_HISTORY
  );
  const relativeFloor = await getSettingNumber(
    db,
    `suspicious_relative_floor_${code}`,
    0
  );
  const zeroStreakThreshold = clampInt(
    await getSettingNumber(db, "zero_streak_alert_periods", 3),
    2,
    MAX_HISTORY
  );

  // Одного запроса к истории хватает и для среднего, и для серии нулей.
  const fetchLimit = Math.max(historyPeriods, zeroStreakThreshold - 1);
  const history = await listRecentConsumptions(
    db,
    meter.id,
    period.year,
    period.month,
    fetchLimit
  );

  // Среднее считается по неотрицательным расходам последних месяцев.
  const sample = history
    .slice(0, historyPeriods)
    .filter((consumptionValue) => consumptionValue >= 0);
  const average =
    sample.length >= minHistory
      ? sample.reduce((sum, item) => sum + item, 0) / sample.length
      : null;

  const absoluteLimit = absoluteSetting > 0 ? absoluteSetting : null;

  let flagReason: FlagReason | null = null;

  if (consumption < 0) {
    flagReason = "decreased";
  } else if (absoluteLimit !== null && consumption > absoluteLimit) {
    flagReason = "over_absolute";
  } else if (
    average !== null &&
    multiplier > 0 &&
    consumption > relativeFloor &&
    consumption > average * multiplier
  ) {
    flagReason = "over_relative";
  }

  // Серия нулевых расходов: текущий + предыдущие подряд идущие нули.
  const isZero = consumption === 0;
  let zeroStreak = 0;
  if (isZero) {
    zeroStreak = 1;
    for (const previousConsumption of history) {
      if (previousConsumption === 0) {
        zeroStreak += 1;
      } else {
        break;
      }
    }
  }

  return {
    consumption,
    baseValue,
    status: flagReason === null ? "ok" : "suspicious",
    flagReason,
    isZero,
    zeroStreak,
    zeroStreakAlert: zeroStreak >= zeroStreakThreshold,
    average,
    absoluteLimit,
  };
}

/**
 * Текст предупреждения для экрана подтверждения (null, если предупреждать не о чем).
 * Формулировка без точки в конце — точку добавляет вызывающий код.
 */
export function warningText(
  assessment: ConsumptionAssessment,
  unit: string
): string | null {
  const consumptionText = `${formatValue(assessment.consumption)} ${unit}`;

  switch (assessment.flagReason) {
    case "decreased":
      return `значение меньше предыдущего (${formatValue(assessment.baseValue)})`;

    case "over_absolute":
      return assessment.absoluteLimit !== null
        ? `расход ${consumptionText} превышает допустимый предел (${formatValue(assessment.absoluteLimit)} ${unit})`
        : `расход ${consumptionText} слишком большой`;

    case "over_relative":
      return assessment.average !== null
        ? `расход ${consumptionText} заметно выше обычного (в среднем ${formatValue(assessment.average)} ${unit})`
        : `расход ${consumptionText} заметно выше обычного`;

    default:
      return null;
  }
}

/**
 * Короткая причина для итогового сообщения после сохранения.
 */
export function shortReason(reason: FlagReason | null): string {
  switch (reason) {
    case "decreased":
      return "меньше предыдущего";
    case "over_absolute":
      return "слишком большой расход";
    case "over_relative":
      return "расход выше обычного";
    default:
      return "";
  }
}