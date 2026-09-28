/**
 * Общие функции форматирования для сообщений бота.
 *
 * Примечание: в readingFlow.ts пока остаются собственные копии части
 * этих функций. При ближайшем рефакторинге он будет переведён на
 * этот модуль, чтобы форматирование было в одном месте.
 */

const MONTH_NAMES = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

/** Название периода, например «сентябрь 2026». */
export function periodLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1] ?? String(month)} ${year}`;
}

/** Делает первую букву заглавной: «сентябрь 2026» → «Сентябрь 2026». */
export function capitalizeFirst(text: string): string {
  if (text.length === 0) {
    return text;
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Значение счётчика с тремя знаками после запятой. */
export function formatValue(value: number): string {
  return value.toFixed(3);
}

/** Дата «2026-09-25» → «25.09.2026». Неизвестный формат возвращается как есть. */
export function formatDateRu(isoDate: string): string {
  const parts = isoDate.split("-");
  if (parts.length !== 3) {
    return isoDate;
  }
  return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

/** Значок ресурса по его коду. */
export function resourceEmoji(resourceCode: string): string {
  if (resourceCode === "cold_water") return "💧";
  if (resourceCode === "electricity") return "⚡";
  return "📟";
}

/** Отображаемое название тарифной зоны (null, если зоны нет). */
export function zoneName(zone: string | null): string | null {
  if (zone === "day") return "День";
  if (zone === "night") return "Ночь";
  return zone;
}

/**
 * Название счётчика для списков: серийный номер (или «№id»)
 * и, если есть, тарифная зона: «EM-1187, день».
 */
export function meterTitle(
  serialNumber: string | null,
  meterId: number,
  zone: string | null
): string {
  const base = serialNumber ? serialNumber : `№${meterId}`;
  const zoneText = zoneName(zone);
  return zoneText ? `${base}, ${zoneText.toLowerCase()}` : base;
}

/** Значок статуса показания. */
export function statusMark(status: string): string {
  if (status === "ok") return "✅";
  if (status === "suspicious") return "⚠️";
  if (status === "corrected") return "✏️";
  return "";
}

/** Пояснение к значкам статуса (только к тем, что реально встретились). */
export function statusLegend(
  hasSuspicious: boolean,
  hasCorrected: boolean
): string {
  const lines: string[] = [];
  if (hasSuspicious) {
    lines.push("⚠️ — значение будет проверено администратором");
  }
  if (hasCorrected) {
    lines.push("✏️ — значение исправлено администратором");
  }
  return lines.join("\n");
}