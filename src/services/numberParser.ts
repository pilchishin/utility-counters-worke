/**
 * Разбор числа, введённого пользователем как показание счётчика.
 *
 * Принимается:
 *  - "134.7" и "134,7" (запятая или точка);
 *  - "134.7 м3", "134,7 куб", "1500 кВт·ч" (единицы измерения игнорируются);
 *  - лишние знаки после запятой округляются (флаг rounded = true).
 *
 * Не принимается (not_a_number): пробелы внутри числа ("134 7"),
 * несколько разделителей ("134.7.0"), произвольный текст.
 */

export type ParseResult =
  | { ok: true; value: number; rounded: boolean }
  | { ok: false; reason: "not_a_number" | "negative" };

// Знак, целая часть, необязательная дробная часть, необязательная единица.
const READING_PATTERN =
  /^(-?)(\d+)(?:[.,](\d+))?\s*(?:м3|м³|куб|квтч|квт\.?\s?ч|квт·ч|kwh|m3)?$/iu;

// Ограничение на длину целой части — защита от абсурдно больших чисел.
const MAX_INTEGER_DIGITS = 9;

export function parseReadingInput(raw: string, maxDecimals: number): ParseResult {
  const match = READING_PATTERN.exec(raw.trim());
  if (!match) {
    return { ok: false, reason: "not_a_number" };
  }

  const sign = match[1];
  const integerPart = match[2];
  const fractionPart = match[3] ?? "";

  if (integerPart.length > MAX_INTEGER_DIGITS) {
    return { ok: false, reason: "not_a_number" };
  }

  if (sign === "-") {
    return { ok: false, reason: "negative" };
  }

  const parsed = Number(
    fractionPart ? `${integerPart}.${fractionPart}` : integerPart
  );

  const rounded = fractionPart.length > maxDecimals;
  const value = rounded ? Number(parsed.toFixed(maxDecimals)) : parsed;

  return { ok: true, value, rounded };
}