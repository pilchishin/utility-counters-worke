import type { Env } from "../index";
import { sendMessage } from "../telegram";
import { getOrCreateCurrentPeriod } from "../db/billingPeriods";
import {
  findResourceTypeByCode,
  listResourceTypesForApartment,
  listMeterReadingsForPeriod,
  listHistoryPeriods,
  listHistoryReadings,
} from "../db/history";
import {
  backToMenuKeyboard,
  myReadingsKeyboard,
  historyResourceKeyboard,
  historyPageKeyboard,
} from "../bot/keyboards";
import {
  periodLabel,
  capitalizeFirst,
  formatValue,
  formatDateRu,
  resourceEmoji,
  meterTitle,
  statusMark,
  statusLegend,
} from "./format";

// Сколько месяцев показывается на одной странице истории.
const HISTORY_PAGE_SIZE = 4;

// Верхняя граница смещения — защита от подставленных вручную больших значений.
const HISTORY_MAX_OFFSET = 600;

async function sendNoApartment(env: Env, chatId: number): Promise<void> {
  await sendMessage(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    "К вашему аккаунту не привязана квартира. Обратитесь к администратору.",
    backToMenuKeyboard()
  );
}

/**
 * «📊 Мои показания»: статус передачи показаний за текущий месяц
 * по всем активным счётчикам квартиры.
 */
export async function showMyReadings(
  env: Env,
  chatId: number,
  apartmentId: number | null,
  apartmentNumber: string | null
): Promise<void> {
  if (apartmentId === null) {
    await sendNoApartment(env, chatId);
    return;
  }

  const period = await getOrCreateCurrentPeriod(env.DB);
  const rows = await listMeterReadingsForPeriod(env.DB, apartmentId, period.id);

  if (rows.length === 0) {
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      "Для вашей квартиры пока не заведены счётчики. Обратитесь к администратору.",
      backToMenuKeyboard()
    );
    return;
  }

  let text = `📊 Показания за ${periodLabel(period.year, period.month)}`;
  if (apartmentNumber) {
    text += ` (квартира №${apartmentNumber})`;
  }
  text += "\n";

  text +=
    period.status === "collecting"
      ? `Передать до ${formatDateRu(period.ends_at)}\n`
      : "Приём показаний закрыт\n";

  const submittedCount = rows.filter((row) => row.value !== null).length;
  text += `Передано: ${submittedCount} из ${rows.length}\n`;

  let currentResource = "";
  let hasSuspicious = false;
  let hasCorrected = false;

  for (const row of rows) {
    if (row.resource_code !== currentResource) {
      currentResource = row.resource_code;
      text += `\n${resourceEmoji(row.resource_code)} ${row.resource_name}\n`;
    }

    const title = meterTitle(row.serial_number, row.meter_id, row.tariff_zone);

    if (row.value === null) {
      text += `${title}: не передано ❌\n`;
      continue;
    }

    const status = row.status ?? "";
    if (status === "suspicious") hasSuspicious = true;
    if (status === "corrected") hasCorrected = true;

    text += `${title}: ${formatValue(row.value)} ${row.unit}`;
    if (row.consumption !== null) {
      text += ` (расход ${formatValue(row.consumption)})`;
    }
    text += ` ${statusMark(status)}\n`;
  }

  const legend = statusLegend(hasSuspicious, hasCorrected);
  if (legend) {
    text += `\n${legend}\n`;
  }

  await sendMessage(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    text.trimEnd(),
    myReadingsKeyboard()
  );
}

/**
 * «📜 История»: выбор ресурса, по которому показать историю.
 */
export async function showHistoryMenu(
  env: Env,
  chatId: number,
  apartmentId: number | null
): Promise<void> {
  if (apartmentId === null) {
    await sendNoApartment(env, chatId);
    return;
  }

  const resources = await listResourceTypesForApartment(env.DB, apartmentId);

  if (resources.length === 0) {
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      "Для вашей квартиры пока не заведены счётчики. Обратитесь к администратору.",
      backToMenuKeyboard()
    );
    return;
  }

  await sendMessage(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    "За какой ресурс показать историю?",
    historyResourceKeyboard(
      resources.map((resource) => ({
        code: resource.code,
        label: `${resourceEmoji(resource.code)} ${resource.name}`,
      }))
    )
  );
}

/**
 * Страница истории по ресурсу: HISTORY_PAGE_SIZE месяцев, начиная
 * с указанного смещения (0 — самые свежие).
 */
export async function showHistoryPage(
  env: Env,
  chatId: number,
  apartmentId: number | null,
  resourceCode: string,
  offset: number
): Promise<void> {
  if (apartmentId === null) {
    await sendNoApartment(env, chatId);
    return;
  }

  const resource = await findResourceTypeByCode(env.DB, resourceCode);
  if (!resource) {
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      "Раздел не найден.",
      backToMenuKeyboard()
    );
    return;
  }

  const safeOffset = Math.min(Math.max(Math.trunc(offset), 0), HISTORY_MAX_OFFSET);

  // Запрашиваем на одну запись больше страницы: так узнаём, есть ли продолжение.
  const fetched = await listHistoryPeriods(
    env.DB,
    apartmentId,
    resource.code,
    HISTORY_PAGE_SIZE + 1,
    safeOffset
  );
  const hasMore = fetched.length > HISTORY_PAGE_SIZE;
  const periods = fetched.slice(0, HISTORY_PAGE_SIZE);

  if (periods.length === 0) {
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      safeOffset === 0
        ? `История показаний (${resource.name}) пока пуста.`
        : "Больше записей нет.",
      historyPageKeyboard(resource.code, null)
    );
    return;
  }

  const readings = await listHistoryReadings(
    env.DB,
    apartmentId,
    resource.code,
    periods.map((period) => period.id)
  );

  let text = `📜 История: ${resourceEmoji(resource.code)} ${resource.name}\n`;
  let hasSuspicious = false;
  let hasCorrected = false;

  for (const period of periods) {
    text += `\n${capitalizeFirst(periodLabel(period.year, period.month))}\n`;

    const periodReadings = readings.filter(
      (reading) => reading.billing_period_id === period.id
    );

    for (const reading of periodReadings) {
      if (reading.status === "suspicious") hasSuspicious = true;
      if (reading.status === "corrected") hasCorrected = true;

      const title = meterTitle(
        reading.serial_number,
        reading.meter_id,
        reading.tariff_zone
      );

      text += `${title}: ${formatValue(reading.value)} ${resource.unit}`;
      if (reading.consumption !== null) {
        text += ` (расход ${formatValue(reading.consumption)})`;
      }
      text += ` ${statusMark(reading.status)}\n`;
    }
  }

  const legend = statusLegend(hasSuspicious, hasCorrected);
  if (legend) {
    text += `\n${legend}\n`;
  }

  await sendMessage(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    text.trimEnd(),
    historyPageKeyboard(
      resource.code,
      hasMore ? safeOffset + HISTORY_PAGE_SIZE : null
    )
  );
}