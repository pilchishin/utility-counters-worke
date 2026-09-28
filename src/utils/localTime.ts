/**
 * Работа с местным временем дома.
 *
 * Часовой пояс задаётся в system_settings (ключ timezone). Используется
 * встроенный Intl, поэтому переход на летнее и зимнее время учитывается
 * автоматически, без ручных поправок.
 */

export interface LocalDateTime {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number; // 0–23
  isoDate: string; // "ГГГГ-ММ-ДД" — местная дата
  timeZone: string; // часовой пояс, который реально применён
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Пытается получить местное время в заданном часовом поясе.
 * Возвращает null, если название пояса неизвестно.
 */
function tryGetLocalDateTime(
  now: Date,
  timeZone: string
): LocalDateTime | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      // h23: часы от 00 до 23 (иначе полночь может прийти как "24").
      hourCycle: "h23",
    });

    const parts = formatter.formatToParts(now);
    const read = (type: string): number => {
      const part = parts.find((item) => item.type === type);
      return part ? Number(part.value) : NaN;
    };

    const year = read("year");
    const month = read("month");
    const day = read("day");
    const hour = read("hour");

    if ([year, month, day, hour].some((item) => !Number.isFinite(item))) {
      return null;
    }

    return {
      year,
      month,
      day,
      hour,
      isoDate: `${year}-${pad2(month)}-${pad2(day)}`,
      timeZone,
    };
  } catch {
    // Неизвестный часовой пояс — Intl бросает RangeError.
    return null;
  }
}

/**
 * Местное время в часовом поясе timeZone. Если название пояса
 * неизвестно, безопасно переключается на UTC (поле timeZone
 * результата покажет, какой пояс применён на самом деле).
 */
export function getLocalDateTime(now: Date, timeZone: string): LocalDateTime {
  const local =
    tryGetLocalDateTime(now, timeZone) ?? tryGetLocalDateTime(now, "UTC");

  if (!local) {
    throw new Error("Не удалось определить местное время");
  }
  return local;
}

// Дата "ГГГГ-ММ-ДД" → миллисекунды UTC на полночь этого дня.
function isoToUtcMs(iso: string): number {
  const [year, month, day] = iso.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/**
 * Сколько дней от fromIso до toIso (положительное — toIso в будущем,
 * 0 — тот же день, отрицательное — toIso уже в прошлом).
 */
export function daysUntil(fromIso: string, toIso: string): number {
  return Math.round((isoToUtcMs(toIso) - isoToUtcMs(fromIso)) / 86400000);
}

/** Прибавляет дни к дате "ГГГГ-ММ-ДД" и возвращает дату в том же формате. */
export function addDaysIso(iso: string, days: number): string {
  const date = new Date(isoToUtcMs(iso) + days * 86400000);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}