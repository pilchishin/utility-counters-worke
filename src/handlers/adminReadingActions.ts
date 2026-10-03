import type { Env } from "../index";
import { checkAdminAuth, unauthorizedResponse } from "../services/adminAuth";
import { redirectWithMessage } from "../services/adminLayout";
import {
  findReadingById,
  findPreviousReadingValue,
  adminConfirmReading,
  adminCorrectReading,
} from "../db/readings";
import { findMeterById } from "../db/meters";
import { getSettingNumber } from "../db/settings";
import { logEvent } from "../db/eventLog";
import { parseReadingInput } from "../services/numberParser";
import {
  verifyCsrfToken,
  csrfRejectedResponse,
} from "../services/csrf";

const NOT_CONFIGURED_MESSAGE =
  "Административная панель ещё не настроена: не задан пароль администратора.";

// Допустимые пути возврата после действия — только свои страницы панели.
// Всё остальное (в т.ч. попытка подставить внешний адрес) откатывается
// на безопасный путь по умолчанию.
const REPORTS_RETURN_PATTERN = /^\/admin\/reports\?period=\d+$/;

function sanitizeReturnTo(raw: unknown): string {
  if (typeof raw !== "string") {
    return "/admin";
  }
  if (raw === "/admin" || REPORTS_RETURN_PATTERN.test(raw)) {
    return raw;
  }
  return "/admin";
}

function roundTo3(value: number): number {
  return Number(value.toFixed(3));
}

/**
 * Администратор подтверждает: подозрительное значение верное.
 * Само значение не меняется, показание переводится в статус 'ok'.
 */
export async function handleAdminConfirmReading(
  request: Request,
  env: Env
): Promise<Response> {
  if (!env.ADMIN_PASSWORD) {
    return new Response(NOT_CONFIGURED_MESSAGE, { status: 503 });
  }
  if (!checkAdminAuth(request, env)) {
    return unauthorizedResponse();
  }

  const form = await request.formData();
  if (!(await verifyCsrfToken(env, form.get("csrf_token")))) {
    return csrfRejectedResponse();
  }

  const readingId = Number(form.get("reading_id"));
  const backPath = sanitizeReturnTo(form.get("return_to"));

  if (!Number.isInteger(readingId) || readingId <= 0) {
    return redirectWithMessage(backPath, {
      kind: "error",
      text: "Некорректный номер показания.",
    });
  }

  // Эта выборка — только для текста события и ранней проверки для
  // удобства пользователя (быстрый ответ "уже обработано" без лишней
  // записи UPDATE). Окончательное решение принимает условие WHERE
  // в самом adminConfirmReading — оно же защищает от гонки.
  const reading = await findReadingById(env.DB, readingId);
  if (!reading || reading.status !== "suspicious") {
    return redirectWithMessage(backPath, {
      kind: "error",
      text: "Показание не найдено или уже обработано.",
    });
  }

  const changed = await adminConfirmReading(env.DB, readingId);

  if (!changed) {
    // Кто-то (или этот же запрос, отправленный повторно) успел
    // обработать показание в промежутке между проверкой выше и этим
    // вызовом. Не пишем событие и не показываем ложный успех.
    return redirectWithMessage(backPath, {
      kind: "error",
      text: "Показание уже обработано — возможно, кем-то другим буквально сейчас.",
    });
  }

  await logEvent(env.DB, {
    entityType: "reading",
    entityId: readingId,
    action: "reading_confirmed_by_admin",
    payload: {
      meter_id: reading.meter_id,
      value: reading.value,
      previous_flag_reason: reading.flag_reason,
    },
  });

  return redirectWithMessage(backPath, {
    kind: "ok",
    text: "Показание подтверждено.",
  });
}

/**
 * Администратор исправляет значение показания. Причина обязательна
 * и сохраняется в readings.correction_comment — это ответ на вопрос
 * "почему изменили" при последующем разборе.
 */
export async function handleAdminCorrectReading(
  request: Request,
  env: Env
): Promise<Response> {
  if (!env.ADMIN_PASSWORD) {
    return new Response(NOT_CONFIGURED_MESSAGE, { status: 503 });
  }
  if (!checkAdminAuth(request, env)) {
    return unauthorizedResponse();
  }

  const form = await request.formData();
  if (!(await verifyCsrfToken(env, form.get("csrf_token")))) {
    return csrfRejectedResponse();
  }

  const readingId = Number(form.get("reading_id"));
  const rawValue = String(form.get("value") ?? "");
  const comment = String(form.get("comment") ?? "").trim();
  const backPath = sanitizeReturnTo(form.get("return_to"));

  if (!Number.isInteger(readingId) || readingId <= 0) {
    return redirectWithMessage(backPath, {
      kind: "error",
      text: "Некорректный номер показания.",
    });
  }

  if (comment.length === 0) {
    return redirectWithMessage(backPath, {
      kind: "error",
      text: "Укажите причину исправления.",
    });
  }

  const maxDecimalsSetting = await getSettingNumber(
    env.DB,
    "max_decimal_digits",
    3
  );
  const maxDecimals = Math.min(Math.max(Math.trunc(maxDecimalsSetting), 0), 6);
  const parsed = parseReadingInput(rawValue, maxDecimals);

  if (!parsed.ok) {
    return redirectWithMessage(backPath, {
      kind: "error",
      text: "Не удалось распознать введённое значение.",
    });
  }

  // Эта выборка — для расчёта расхода и ранней проверки для удобства
  // (быстрый ответ "уже обработано"). Окончательное решение — за
  // условием WHERE в самом adminCorrectReading, оно же защищает
  // от гонки между двумя одновременными исправлениями.
  const reading = await findReadingById(env.DB, readingId);
  if (!reading || reading.status !== "suspicious") {
    return redirectWithMessage(backPath, {
      kind: "error",
      text: "Показание не найдено или уже обработано.",
    });
  }

  const meter = await findMeterById(env.DB, reading.meter_id);
  if (!meter) {
    return redirectWithMessage(backPath, {
      kind: "error",
      text: "Счётчик не найден.",
    });
  }

  const previous = await findPreviousReadingValue(
    env.DB,
    meter.id,
    reading.period_year,
    reading.period_month
  );
  const baseValue = previous !== null ? previous : meter.initial_reading;
  const consumption = roundTo3(parsed.value - baseValue);

  const changed = await adminCorrectReading(env.DB, readingId, {
    value: parsed.value,
    consumption,
    comment,
  });

  if (!changed) {
    // Кто-то успел подтвердить или исправить это же показание первым
    // в промежутке между проверкой выше и этим вызовом — не затираем
    // его работу молча и не пишем событие о несостоявшемся изменении.
    return redirectWithMessage(backPath, {
      kind: "error",
      text: "Показание уже обработано — возможно, кем-то другим буквально сейчас.",
    });
  }

  await logEvent(env.DB, {
    entityType: "reading",
    entityId: readingId,
    action: "reading_corrected",
    payload: {
      meter_id: meter.id,
      old_value: reading.value,
      new_value: parsed.value,
      old_status: reading.status,
      new_status: "corrected",
      by: "admin_panel",
      reason: comment,
    },
  });

  return redirectWithMessage(backPath, {
    kind: "ok",
    text: "Показание исправлено.",
  });
}