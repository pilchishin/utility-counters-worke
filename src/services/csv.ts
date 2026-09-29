/**
 * Простая генерация CSV для выгрузки данных администратору.
 *
 * Разделитель — точка с запятой: так Excel с русской локалью (где
 * запятая уже занята под десятичный разделитель) сам разбивает файл
 * на столбцы без ручного импорта через "Данные → Текст по столбцам".
 */

const DELIMITER = ";";
// Byte Order Mark — без него Excel на Windows может принять
// UTF-8 файл за ANSI и показать кириллицу нечитаемой.
const UTF8_BOM = "\uFEFF";

/** Экранирует одно значение ячейки CSV. */
function escapeCsvCell(value: string): string {
  if (value.includes(DELIMITER) || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Приводит значение любого типа к строке ячейки (null/undefined → пусто). */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

/**
 * Собирает CSV-текст из строки заголовков и массива строк данных.
 * Каждая строка данных — массив значений в том же порядке, что и headers.
 */
export function buildCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(escapeCsvCell).join(DELIMITER)];

  for (const row of rows) {
    lines.push(row.map((cell) => escapeCsvCell(cellToString(cell))).join(DELIMITER));
  }

  // \r\n — Excel ожидает именно такие переводы строк в CSV.
  return UTF8_BOM + lines.join("\r\n");
}

/** Формирует Response с CSV-файлом для скачивания браузером. */
export function csvResponse(csvText: string, fileName: string): Response {
  return new Response(csvText, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
}