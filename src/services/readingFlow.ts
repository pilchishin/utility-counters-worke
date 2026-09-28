import type { Env } from "../index";
import { sendMessage } from "../telegram";
import type { TelegramUserRow } from "../db/telegramUsers";
import {
  findActiveMetersByResource,
  findMeterForApartment,
  findMeterGroupForApartment,
} from "../db/meters";
import type { MeterRow } from "../db/meters";
import { getOrCreateCurrentPeriod } from "../db/billingPeriods";
import type { BillingPeriodRow } from "../db/billingPeriods";
import {
  findReadingForPeriod,
  findPreviousReadingValue,
  insertReading,
  updateReadingValue,
} from "../db/readings";
import type { ReadingRow } from "../db/readings";
import {
  getDialogState,
  setDialogState,
  clearDialogState,
} from "../db/dialogState";
import type { DialogState } from "../db/dialogState";
import { getSettingNumber } from "../db/settings";
import { logEvent } from "../db/eventLog";
import { parseReadingInput } from "./numberParser";
import {
  assessConsumption,
  warningText,
  shortReason,
} from "./consumptionCheck";
import type { FlagReason } from "./consumptionCheck";
import {
  backToMenuKeyboard,
  cancelKeyboard,
  confirmKeyboard,
  meterSelectKeyboard,
} from "../bot/keyboards";

/**
 * Диалог передачи показаний счётчика.
 *
 * Работает с ГРУППОЙ счётчиков: физический двухтарифный электросчётчик
 * хранится как две записи meters (день/ночь) с одним serial_number, и бот
 * запрашивает их показания по очереди. Вода и однотарифные счётчики —
 * это группа из одного счётчика.
 *
 * Состояние диалога (dialog_state.context_json):
 *   meter_ids   — id счётчиков группы в порядке ввода;
 *   values      — уже введённые значения (по порядку meter_ids);
 *   rounded_any — округлялось ли хоть одно значение (для подсказки).
 * Номер текущего шага = количество уже введённых значений.
 *
 * Проверка расхода (слишком большой, скачок, нулевой) вынесена
 * в consumptionCheck.ts.
 */

const MONTH_NAMES = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

// Максимум счётчиков в одной группе — защита от повреждённого состояния.
const MAX_GROUP_SIZE = 4;

function periodLabel(period: BillingPeriodRow): string {
  return `${MONTH_NAMES[period.month - 1]} ${period.year}`;
}

function formatValue(value: number): string {
  return value.toFixed(3);
}

function resourceEmoji(resourceCode: string): string {
  if (resourceCode === "cold_water") return "💧";
  if (resourceCode === "electricity") return "⚡";
  return "📟";
}

function meterLabel(meter: MeterRow): string {
  return meter.serial_number ? meter.serial_number : `№${meter.id}`;
}

/** Отображаемое название тарифной зоны (null, если зоны нет). */
function zoneName(zone: string | null): string | null {
  if (zone === "day") return "День";
  if (zone === "night") return "Ночь";
  return zone;
}

/**
 * Разбивает список счётчиков на физические группы: счётчики с одинаковым
 * непустым serial_number объединяются, остальные — по одному.
 * Порядок групп соответствует порядку первого счётчика в списке.
 */
function groupMeters(meters: MeterRow[]): MeterRow[][] {
  const groups: MeterRow[][] = [];
  const bySerial = new Map<string, MeterRow[]>();

  for (const meter of meters) {
    if (!meter.serial_number) {
      groups.push([meter]);
      continue;
    }
    const existing = bySerial.get(meter.serial_number);
    if (existing) {
      existing.push(meter);
    } else {
      const group = [meter];
      bySerial.set(meter.serial_number, group);
      groups.push(group);
    }
  }

  return groups;
}

/** Подпись группы на кнопке выбора счётчика. */
function groupButtonLabel(group: MeterRow[]): string {
  const first = group[0];
  let label = `${resourceEmoji(first.resource_code)} ${meterLabel(first)}`;

  if (group.length > 1) {
    const zones = group
      .map((meter) => zoneName(meter.tariff_zone))
      .filter((name): name is string => name !== null)
      .map((name) => name.toLowerCase());
    if (zones.length > 0) {
      label += ` (${zones.join(" + ")})`;
    }
  }

  return label;
}

/**
 * База для расчёта расхода: последнее подтверждённое показание
 * за предыдущие периоды, а если его нет — начальное показание счётчика.
 */
async function getBaseReading(
  db: D1Database,
  meter: MeterRow,
  period: BillingPeriodRow
): Promise<{ value: number; isInitial: boolean }> {
  const previous = await findPreviousReadingValue(
    db,
    meter.id,
    period.year,
    period.month
  );

  if (previous !== null) {
    return { value: previous, isInitial: false };
  }
  return { value: meter.initial_reading, isInitial: true };
}

interface Session {
  meterIds: number[];
  values: number[];
  roundedAny: boolean;
}

/**
 * Безопасно разбирает состояние диалога. Возвращает null, если данные
 * повреждены или не соответствуют ожидаемому формату.
 */
function parseSession(context: Record<string, unknown>): Session | null {
  const rawIds = context["meter_ids"];
  if (
    !Array.isArray(rawIds) ||
    rawIds.length === 0 ||
    rawIds.length > MAX_GROUP_SIZE
  ) {
    return null;
  }

  const meterIds = rawIds.map(Number);
  if (!meterIds.every((id) => Number.isInteger(id) && id > 0)) {
    return null;
  }

  const rawValues = context["values"];
  const values = Array.isArray(rawValues) ? rawValues.map(Number) : [];
  if (!values.every((value) => Number.isFinite(value))) {
    return null;
  }
  if (values.length > meterIds.length) {
    return null;
  }

  return { meterIds, values, roundedAny: Boolean(context["rounded_any"]) };
}

/**
 * Загружает счётчики по id, проверяя принадлежность КАЖДОГО квартире.
 * Возвращает null, если хотя бы один счётчик не найден или чужой.
 */
async function loadMeters(
  db: D1Database,
  ids: number[],
  apartmentId: number
): Promise<MeterRow[] | null> {
  const meters: MeterRow[] = [];
  for (const id of ids) {
    const meter = await findMeterForApartment(db, id, apartmentId);
    if (!meter) {
      return null;
    }
    meters.push(meter);
  }
  return meters;
}

async function sendExpiredSession(env: Env, chatId: number): Promise<void> {
  await sendMessage(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    "Сессия ввода устарела. Начните заново из главного меню.",
    backToMenuKeyboard()
  );
}

async function sendNoApartment(env: Env, chatId: number): Promise<void> {
  await sendMessage(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    "К вашему аккаунту не привязана квартира. Обратитесь к администратору.",
    backToMenuKeyboard()
  );
}

/**
 * Шаг 1. Пользователь нажал кнопку ресурса («Вода», «Электроэнергия»).
 * Если физический счётчик один — сразу начинаем ввод, если несколько —
 * предлагаем выбрать.
 */
export async function startReadingFlow(
  env: Env,
  user: TelegramUserRow,
  chatId: number,
  resourceCode: string
): Promise<void> {
  const apartmentId = user.apartment_id;
  if (apartmentId === null) {
    await sendNoApartment(env, chatId);
    return;
  }

  const meters = await findActiveMetersByResource(
    env.DB,
    apartmentId,
    resourceCode
  );

  if (meters.length === 0) {
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      "Для вашей квартиры не заведены счётчики этого типа. " +
        "Обратитесь к администратору.",
      backToMenuKeyboard()
    );
    return;
  }

  const groups = groupMeters(meters);

  if (groups.length === 1) {
    await startGroup(env, user, chatId, await orderedGroup(env, groups[0]));
    return;
  }

  await clearDialogState(env.DB, user.tg_id);
  await sendMessage(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    "У вас несколько счётчиков. Выберите нужный:",
    // В кнопке передаётся id первого счётчика группы; остальные счётчики
    // группы сервер определяет сам (см. selectMeter).
    meterSelectKeyboard(
      groups.map((group) => ({
        id: group[0].id,
        label: groupButtonLabel(group),
      }))
    )
  );
}

/**
 * Упорядочивает счётчики группы для ввода (день, затем ночь).
 * Для группы из одного счётчика порядок не важен.
 */
async function orderedGroup(env: Env, group: MeterRow[]): Promise<MeterRow[]> {
  if (group.length <= 1) {
    return group;
  }
  const ordered = await findMeterGroupForApartment(
    env.DB,
    group[0].id,
    group[0].apartment_id
  );
  return ordered.length > 0 ? ordered : group;
}

/**
 * Шаг 1а. Пользователь выбрал счётчик кнопкой.
 * Принадлежность квартире проверяется на сервере, группа определяется
 * по данным базы, а не по данным из кнопки.
 */
export async function selectMeter(
  env: Env,
  user: TelegramUserRow,
  chatId: number,
  meterId: number
): Promise<void> {
  const apartmentId = user.apartment_id;
  if (apartmentId === null) {
    await sendNoApartment(env, chatId);
    return;
  }

  const group = await findMeterGroupForApartment(env.DB, meterId, apartmentId);
  if (group.length === 0) {
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      "Счётчик не найден.",
      backToMenuKeyboard()
    );
    return;
  }

  await startGroup(env, user, chatId, group);
}

/**
 * Шаг 2. Начинаем ввод показаний группы с первого счётчика.
 */
async function startGroup(
  env: Env,
  user: TelegramUserRow,
  chatId: number,
  meters: MeterRow[]
): Promise<void> {
  const period = await getOrCreateCurrentPeriod(env.DB);

  if (period.status !== "collecting") {
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      `Приём показаний за ${periodLabel(period)} закрыт. ` +
        "Если нужно передать показания — обратитесь к администратору.",
      backToMenuKeyboard()
    );
    return;
  }

  await setDialogState(env.DB, user.tg_id, "AWAITING_READING_VALUE", {
    meter_ids: meters.map((meter) => meter.id),
    values: [],
    rounded_any: false,
  });

  await sendMeterPrompt(env, chatId, meters, [], period);
}

/**
 * Показывает запрос показания для текущего шага (номер шага = количество
 * уже введённых значений). Для второго и последующих шагов сначала
 * перечисляются уже принятые значения.
 */
async function sendMeterPrompt(
  env: Env,
  chatId: number,
  meters: MeterRow[],
  values: number[],
  period: BillingPeriodRow
): Promise<void> {
  const index = values.length;
  const meter = meters[index];
  const zone = zoneName(meter.tariff_zone);

  const base = await getBaseReading(env.DB, meter, period);
  const existing = await findReadingForPeriod(env.DB, meter.id, period.id);

  let text = "";

  // Уже принятые значения предыдущих тарифных зон.
  for (let i = 0; i < index; i++) {
    const previousZone = zoneName(meters[i].tariff_zone) ?? `Счётчик ${i + 1}`;
    text += `Принято: ${previousZone} = ${formatValue(values[i])} ${meters[i].unit}\n`;
  }
  if (index > 0) {
    text += "\n";
  }

  const baseTitle = base.isInitial
    ? "Начальное показание счётчика"
    : "Последнее показание";

  text += `${resourceEmoji(meter.resource_code)} ${meter.resource_name}\n`;
  text += zone
    ? `Счётчик ${meterLabel(meter)}, тариф «${zone}»\n`
    : `Счётчик ${meterLabel(meter)}\n`;
  text += `${baseTitle}: ${formatValue(base.value)} ${meter.unit}\n`;

  if (existing) {
    text +=
      `\nЗа ${periodLabel(period)} уже подано: ${formatValue(existing.value)} ` +
      `${meter.unit}. Новое значение заменит его.\n`;
  }

  text += zone
    ? `\nВведите показание тарифа «${zone}» (${meter.unit}):`
    : `\nВведите текущее показание (${meter.unit}):`;

  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, text, cancelKeyboard());
}

/**
 * Шаг 3. Пользователь прислал текст, пока бот ждёт показание.
 * Разбираем число. Если в группе остались счётчики — запрашиваем следующее
 * значение, иначе показываем общий экран подтверждения.
 */
export async function handleReadingInput(
  env: Env,
  user: TelegramUserRow,
  chatId: number,
  text: string,
  state: DialogState
): Promise<void> {
  const apartmentId = user.apartment_id;
  const session = parseSession(state.context);

  if (
    apartmentId === null ||
    !session ||
    session.values.length >= session.meterIds.length
  ) {
    await clearDialogState(env.DB, user.tg_id);
    await sendExpiredSession(env, chatId);
    return;
  }

  const meters = await loadMeters(env.DB, session.meterIds, apartmentId);
  if (!meters) {
    await clearDialogState(env.DB, user.tg_id);
    await sendExpiredSession(env, chatId);
    return;
  }

  const maxDecimalsSetting = await getSettingNumber(
    env.DB,
    "max_decimal_digits",
    3
  );
  const maxDecimals = Math.min(Math.max(Math.trunc(maxDecimalsSetting), 0), 6);

  const parsed = parseReadingInput(text, maxDecimals);

  if (!parsed.ok) {
    // Состояние не сбрасываем — пользователь может сразу ввести число заново.
    const errorText =
      parsed.reason === "negative"
        ? "Показание не может быть отрицательным. Проверьте и введите число ещё раз."
        : "Не удалось распознать число. Введите показание счётчика, например: 134.7";

    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, errorText, cancelKeyboard());
    return;
  }

  const values = [...session.values, parsed.value];
  const roundedAny = session.roundedAny || parsed.rounded;
  const period = await getOrCreateCurrentPeriod(env.DB);

  // В группе остались счётчики — запрашиваем следующее показание.
  if (values.length < meters.length) {
    await setDialogState(env.DB, user.tg_id, "AWAITING_READING_VALUE", {
      meter_ids: session.meterIds,
      values,
      rounded_any: roundedAny,
    });
    await sendMeterPrompt(env, chatId, meters, values, period);
    return;
  }

  // Все значения введены — показываем экран подтверждения.
  await setDialogState(env.DB, user.tg_id, "CONFIRM_READING", {
    meter_ids: session.meterIds,
    values,
    rounded_any: roundedAny,
  });

  await sendConfirmScreen(
    env,
    chatId,
    meters,
    values,
    roundedAny,
    maxDecimals,
    period
  );
}

/**
 * Экран подтверждения: все введённые значения и расходы одним сообщением,
 * с предупреждениями о подозрительных значениях.
 */
async function sendConfirmScreen(
  env: Env,
  chatId: number,
  meters: MeterRow[],
  values: number[],
  roundedAny: boolean,
  maxDecimals: number,
  period: BillingPeriodRow
): Promise<void> {
  const first = meters[0];
  const hasZones = meters.length > 1 || first.tariff_zone !== null;

  let text =
    "Проверьте данные перед сохранением:\n\n" +
    `${resourceEmoji(first.resource_code)} ${first.resource_name}, счётчик ${meterLabel(first)}\n`;

  const warnings: string[] = [];
  const notes: string[] = [];

  for (let i = 0; i < meters.length; i++) {
    const meter = meters[i];
    const base = await getBaseReading(env.DB, meter, period);
    const assessment = await assessConsumption(
      env.DB,
      meter,
      period,
      values[i],
      base.value
    );
    const zone = zoneName(meter.tariff_zone);
    const prefix = zone ? `${zone}: ` : "";

    if (hasZones) {
      text +=
        `${zone ?? `Счётчик ${i + 1}`}: ${formatValue(values[i])} ${meter.unit} ` +
        `(расход ${formatValue(assessment.consumption)})\n`;
    } else {
      text +=
        `Текущее показание: ${formatValue(values[i])} ${meter.unit}\n` +
        `Расход: ${formatValue(assessment.consumption)} ${meter.unit}\n`;
    }

    const warning = warningText(assessment, meter.unit);
    if (warning) {
      warnings.push(`${prefix}${warning}.`);
    }

    if (assessment.isZero) {
      if (assessment.zeroStreakAlert) {
        notes.push(
          `${prefix}нулевой расход уже ${assessment.zeroStreak} мес. подряд — ` +
            "это будет отмечено для сведения администратора."
        );
      } else {
        notes.push(
          `${prefix}расход нулевой — так бывает, если ресурс не использовался.`
        );
      }
    }
  }

  if (roundedAny) {
    text += `\nЗначения округлены до ${maxDecimals} знаков после запятой.`;
  }

  if (warnings.length > 0) {
    text +=
      "\n\n⚠️ " +
      warnings.join("\n⚠️ ") +
      "\nЕсли это не опечатка, показание будет отмечено для проверки " +
      "администратором. Если ошиблись — нажмите «Изменить».";
  }

  if (notes.length > 0) {
    text += "\n\nℹ️ " + notes.join("\nℹ️ ");
  }

  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, text, confirmKeyboard());
}

interface SaveResult {
  meter: MeterRow;
  value: number;
  consumption: number;
  status: string;
  flagReason: FlagReason | null;
  outcome: SaveOutcome;
}

/**
 * Шаг 4. Пользователь нажал «Подтвердить» — сохраняем показания группы.
 *
 * Счётчики сохраняются последовательно. Если произойдёт сбой посреди
 * сохранения, состояние диалога не сбрасывается: повторное нажатие
 * «Подтвердить» безопасно — уже сохранённые значения будут заменены
 * теми же самыми, дубликатов не появится.
 */
export async function confirmReading(
  env: Env,
  user: TelegramUserRow,
  chatId: number
): Promise<void> {
  const state = await getDialogState(env.DB, user.tg_id);
  const apartmentId = user.apartment_id;

  if (!state || state.state !== "CONFIRM_READING" || apartmentId === null) {
    await sendExpiredSession(env, chatId);
    return;
  }

  const session = parseSession(state.context);
  if (!session || session.values.length !== session.meterIds.length) {
    await clearDialogState(env.DB, user.tg_id);
    await sendExpiredSession(env, chatId);
    return;
  }

  // Повторная проверка принадлежности счётчиков — данные могли измениться
  // между вводом значений и нажатием кнопки.
  const meters = await loadMeters(env.DB, session.meterIds, apartmentId);
  if (!meters) {
    await clearDialogState(env.DB, user.tg_id);
    await sendExpiredSession(env, chatId);
    return;
  }

  const period = await getOrCreateCurrentPeriod(env.DB);
  if (period.status !== "collecting") {
    await clearDialogState(env.DB, user.tg_id);
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      `Приём показаний за ${periodLabel(period)} закрыт. ` +
        "Обратитесь к администратору.",
      backToMenuKeyboard()
    );
    return;
  }

  const results: SaveResult[] = [];

  for (let i = 0; i < meters.length; i++) {
    const meter = meters[i];
    const value = session.values[i];
    const base = await getBaseReading(env.DB, meter, period);
    const assessment = await assessConsumption(
      env.DB,
      meter,
      period,
      value,
      base.value
    );

    const saved = await saveReading(env.DB, {
      meter,
      periodId: period.id,
      userId: user.id,
      value,
      consumption: assessment.consumption,
      status: assessment.status,
      flagReason: assessment.flagReason,
    });

    // Серия нулевых расходов не меняет статус показания, но фиксируется
    // в журнале — позже администратор увидит её в разделе проверок.
    if (
      assessment.zeroStreakAlert &&
      saved.outcome !== "locked" &&
      saved.readingId !== null
    ) {
      await logEvent(env.DB, {
        entityType: "reading",
        entityId: saved.readingId,
        action: "zero_consumption_streak",
        actorUserId: user.id,
        payload: {
          meter_id: meter.id,
          streak: assessment.zeroStreak,
        },
      });
    }

    results.push({
      meter,
      value,
      consumption: assessment.consumption,
      status: assessment.status,
      flagReason: assessment.flagReason,
      outcome: saved.outcome,
    });
  }

  await clearDialogState(env.DB, user.tg_id);

  await sendMessage(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    buildResultText(results, period),
    backToMenuKeyboard()
  );
}

/**
 * Формирует итоговое сообщение после сохранения.
 */
function buildResultText(
  results: SaveResult[],
  period: BillingPeriodRow
): string {
  const hasZones = results.length > 1 || results[0].meter.tariff_zone !== null;
  const saved = results.filter((result) => result.outcome !== "locked");

  if (saved.length === 0) {
    return (
      (results.length > 1 ? "Эти показания исправлены" : "Это показание исправлено") +
      " администратором. Изменить их может только администратор."
    );
  }

  const allUpdated = saved.every((result) => result.outcome === "updated");
  const plural = results.length > 1;

  let text = plural
    ? allUpdated
      ? "Показания обновлены ✅\n"
      : "Показания приняты ✅\n"
    : allUpdated
      ? "Показание обновлено ✅\n"
      : "Показание принято ✅\n";

  text += `Расход за ${periodLabel(period)}:\n`;

  let anySuspicious = false;

  for (const result of results) {
    const zone = zoneName(result.meter.tariff_zone);
    const name = hasZones ? `${zone ?? "Счётчик"}: ` : "";

    if (result.outcome === "locked") {
      text += `🔒 ${name}исправлено администратором, изменить может только он\n`;
      continue;
    }

    text += `${name}${formatValue(result.consumption)} ${result.meter.unit}`;
    if (result.status === "suspicious") {
      anySuspicious = true;
      text += ` ⚠️ ${shortReason(result.flagReason)}`;
    }
    text += "\n";
  }

  if (anySuspicious) {
    text +=
      "\n⚠️ Отмеченные значения выглядят необычными — " +
      "они будут проверены администратором.";
  }

  return text.trimEnd();
}

/**
 * Кнопка «Изменить» на экране подтверждения: начинаем ввод группы заново
 * с первого счётчика.
 */
export async function retryReading(
  env: Env,
  user: TelegramUserRow,
  chatId: number
): Promise<void> {
  const state = await getDialogState(env.DB, user.tg_id);
  const apartmentId = user.apartment_id;
  const session = state ? parseSession(state.context) : null;

  if (!state || apartmentId === null || !session) {
    await sendExpiredSession(env, chatId);
    return;
  }

  const meters = await loadMeters(env.DB, session.meterIds, apartmentId);
  if (!meters) {
    await sendExpiredSession(env, chatId);
    return;
  }

  await startGroup(env, user, chatId, meters);
}

interface SaveReadingParams {
  meter: MeterRow;
  periodId: number;
  userId: number;
  value: number;
  consumption: number;
  status: string;
  flagReason: FlagReason | null;
}

type SaveOutcome = "submitted" | "updated" | "locked";

interface SaveReadingResult {
  outcome: SaveOutcome;
  readingId: number | null;
}

/**
 * Сохраняет показание: создаёт новое или заменяет существующее
 * за тот же период. Все изменения фиксируются в event_log.
 */
async function saveReading(
  db: D1Database,
  params: SaveReadingParams
): Promise<SaveReadingResult> {
  const { meter, periodId, userId, value, consumption, status, flagReason } =
    params;

  // Замена существующего показания (с записью старого значения в журнал).
  const replaceExisting = async (
    existing: ReadingRow
  ): Promise<SaveReadingResult> => {
    // Показание, исправленное администратором, жилец менять не может.
    if (existing.status === "corrected") {
      return { outcome: "locked", readingId: existing.id };
    }

    await updateReadingValue(db, existing.id, {
      value,
      consumption,
      status,
      flagReason,
      userId,
    });

    await logEvent(db, {
      entityType: "reading",
      entityId: existing.id,
      action: "reading_corrected",
      actorUserId: userId,
      payload: {
        meter_id: meter.id,
        old_value: existing.value,
        new_value: value,
        old_status: existing.status,
        new_status: status,
        old_flag_reason: existing.flag_reason,
        new_flag_reason: flagReason,
        by: "tenant",
      },
    });
    return { outcome: "updated", readingId: existing.id };
  };

  const existing = await findReadingForPeriod(db, meter.id, periodId);
  if (existing) {
    return replaceExisting(existing);
  }

  try {
    const readingId = await insertReading(db, {
      meterId: meter.id,
      periodId,
      value,
      consumption,
      status,
      flagReason,
      userId,
    });

    await logEvent(db, {
      entityType: "reading",
      entityId: readingId,
      action: "reading_submitted",
      actorUserId: userId,
      payload: {
        meter_id: meter.id,
        value,
        consumption,
        status,
        flag_reason: flagReason,
      },
    });
    return { outcome: "submitted", readingId };
  } catch (error) {
    // Возможна гонка: другой пользователь той же квартиры (или повторная
    // доставка апдейта) успел создать показание раньше. Уникальный индекс
    // отклонил вставку — переходим к замене существующей записи.
    const raced = await findReadingForPeriod(db, meter.id, periodId);
    if (!raced) {
      throw error;
    }
    return replaceExisting(raced);
  }
}