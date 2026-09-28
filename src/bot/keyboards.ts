import type { InlineKeyboard } from "../telegram";

/**
 * Значения callback_data для всех кнопок бота.
 * Ограничение Telegram: не более 64 байт на значение.
 */
export const CB = {
  MENU_MAIN: "menu:main",
  MENU_WATER: "menu:water",
  MENU_ELECTRICITY: "menu:electricity",
  MENU_MY_READINGS: "menu:my",
  MENU_HISTORY: "menu:history",
  MENU_HELP: "menu:help",
  METER_PREFIX: "meter:", // после префикса идёт id счётчика: "meter:15"
  HISTORY_PREFIX: "hist:", // формат: "hist:<код ресурса>:<смещение>"
  READING_CONFIRM: "reading:confirm",
  READING_RETRY: "reading:retry",
  READING_CANCEL: "reading:cancel",
} as const;

/** Главное меню жильца. */
export function mainMenuKeyboard(): InlineKeyboard {
  return [
    [
      { text: "💧 Вода", callback_data: CB.MENU_WATER },
      { text: "⚡ Электроэнергия", callback_data: CB.MENU_ELECTRICITY },
    ],
    [
      { text: "📊 Мои показания", callback_data: CB.MENU_MY_READINGS },
      { text: "📜 История", callback_data: CB.MENU_HISTORY },
    ],
    [{ text: "❓ Помощь", callback_data: CB.MENU_HELP }],
  ];
}

/** Одна кнопка возврата в главное меню. */
export function backToMenuKeyboard(): InlineKeyboard {
  return [[{ text: "🏠 Главное меню", callback_data: CB.MENU_MAIN }]];
}

/** Кнопка отмены ввода — показывается вместе с запросом показания. */
export function cancelKeyboard(): InlineKeyboard {
  return [[{ text: "❌ Отмена", callback_data: CB.READING_CANCEL }]];
}

/** Кнопки экрана подтверждения показания. */
export function confirmKeyboard(): InlineKeyboard {
  return [
    [
      { text: "✅ Подтвердить", callback_data: CB.READING_CONFIRM },
      { text: "✏️ Изменить", callback_data: CB.READING_RETRY },
    ],
    [{ text: "❌ Отмена", callback_data: CB.READING_CANCEL }],
  ];
}

/** Клавиатура выбора счётчика, если у квартиры их несколько. */
export function meterSelectKeyboard(
  meters: { id: number; label: string }[]
): InlineKeyboard {
  const rows: InlineKeyboard = meters.map((meter) => [
    { text: meter.label, callback_data: `${CB.METER_PREFIX}${meter.id}` },
  ]);
  rows.push([{ text: "🏠 Главное меню", callback_data: CB.MENU_MAIN }]);
  return rows;
}

/** Кнопки под экраном «Мои показания»: быстрый переход к передаче. */
export function myReadingsKeyboard(): InlineKeyboard {
  return [
    [
      { text: "💧 Передать воду", callback_data: CB.MENU_WATER },
      { text: "⚡ Передать электро", callback_data: CB.MENU_ELECTRICITY },
    ],
    [{ text: "🏠 Главное меню", callback_data: CB.MENU_MAIN }],
  ];
}

/** Выбор ресурса для просмотра истории. */
export function historyResourceKeyboard(
  resources: { code: string; label: string }[]
): InlineKeyboard {
  const rows: InlineKeyboard = resources.map((resource) => [
    {
      text: resource.label,
      callback_data: `${CB.HISTORY_PREFIX}${resource.code}:0`,
    },
  ]);
  rows.push([{ text: "🏠 Главное меню", callback_data: CB.MENU_MAIN }]);
  return rows;
}

/**
 * Кнопки под страницей истории. Если есть продолжение (nextOffset задан),
 * добавляется кнопка «Показать ещё».
 */
export function historyPageKeyboard(
  resourceCode: string,
  nextOffset: number | null
): InlineKeyboard {
  const rows: InlineKeyboard = [];

  if (nextOffset !== null) {
    rows.push([
      {
        text: "⬇️ Показать ещё",
        callback_data: `${CB.HISTORY_PREFIX}${resourceCode}:${nextOffset}`,
      },
    ]);
  }

  rows.push([
    { text: "📜 Другой ресурс", callback_data: CB.MENU_HISTORY },
    { text: "🏠 Главное меню", callback_data: CB.MENU_MAIN },
  ]);

  return rows;
}