import type { Env } from "../index";
import { checkAdminAuth, unauthorizedResponse } from "../services/adminAuth";
import { redirectWithMessage, todayIsoDate } from "../services/adminLayout";
import { findApartmentById } from "../db/apartments";
import {
  findAdminMeterById,
  insertMeter,
  decommissionMeter,
  markMeterReplaced,
} from "../db/meters";
import { logEvent } from "../db/eventLog";

const NOT_CONFIGURED_MESSAGE =
  "Административная панель ещё не настроена: не задан пароль администратора.";

// Формат "ГГГГ-ММ-ДД" из <input type="date">.
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function guard(request: Request, env: Env): Response | null {
  if (!env.ADMIN_PASSWORD) {
    return new Response(NOT_CONFIGURED_MESSAGE, { status: 503 });
  }
  if (!checkAdminAuth(request, env)) {
    return unauthorizedResponse();
  }
  return null;
}

/** Добавление нового счётчика для квартиры. */
export async function handleAdminMeterAdd(
  request: Request,
  env: Env,
  apartmentId: number
): Promise<Response> {
  const denied = guard(request, env);
  if (denied) return denied;

  const backPath = `/admin/apartments/${apartmentId}`;

  const apartment = await findApartmentById(env.DB, apartmentId);
  if (!apartment) {
    return redirectWithMessage("/admin/apartments", {
      kind: "error",
      text: "Квартира не найдена.",
    });
  }

  const form = await request.formData();
  const resourceTypeId = Number(form.get("resource_type_id"));
  const rawZone = String(form.get("tariff_zone") ?? "").trim();
  const tariffZone = rawZone === "day" || rawZone === "night" ? rawZone : null;
  const serialNumberRaw = String(form.get("serial_number") ?? "").trim();
  const serialNumber = serialNumberRaw.length > 0 ? serialNumberRaw : null;
  const initialReading = Number(form.get("initial_reading"));
  const installedAt = String(form.get("installed_at") ?? "");

  if (!Number.isInteger(resourceTypeId) || resourceTypeId <= 0) {
    return redirectWithMessage(backPath, {
      kind: "error",
      text: "Выберите ресурс.",
    });
  }
  if (!Number.isFinite(initialReading) || initialReading < 0) {
    return redirectWithMessage(backPath, {
      kind: "error",
      text: "Некорректное начальное показание.",
    });
  }
  if (!ISO_DATE_PATTERN.test(installedAt)) {
    return redirectWithMessage(backPath, {
      kind: "error",
      text: "Укажите дату установки.",
    });
  }

  const meterId = await insertMeter(env.DB, {
    apartmentId,
    resourceTypeId,
    tariffZone,
    serialNumber,
    initialReading,
    installedAt,
  });

  await logEvent(env.DB, {
    entityType: "meter",
    entityId: meterId,
    action: "meter_added",
    payload: { apartment_number: apartment.number, by: "admin_panel" },
  });

  return redirectWithMessage(backPath, {
    kind: "ok",
    text: "Счётчик добавлен.",
  });
}

/** Снятие счётчика с учёта без замены. */
export async function handleAdminMeterDecommission(
  request: Request,
  env: Env,
  meterId: number
): Promise<Response> {
  const denied = guard(request, env);
  if (denied) return denied;

  const meter = await findAdminMeterById(env.DB, meterId);
  if (!meter) {
    return redirectWithMessage("/admin/apartments", {
      kind: "error",
      text: "Счётчик не найден.",
    });
  }

  const backPath = `/admin/apartments/${meter.apartment_id}`;

  if (!meter.is_active) {
    return redirectWithMessage(backPath, {
      kind: "error",
      text: "Счётчик уже снят с учёта.",
    });
  }

  const decommissionedAt = todayIsoDate();
  await decommissionMeter(env.DB, meterId, decommissionedAt);

  await logEvent(env.DB, {
    entityType: "meter",
    entityId: meterId,
    action: "meter_decommissioned",
    payload: { decommissioned_at: decommissionedAt, by: "admin_panel" },
  });

  return redirectWithMessage(backPath, {
    kind: "ok",
    text: "Счётчик снят с учёта.",
  });
}

/**
 * Замена счётчика: старый снимается с учёта со ссылкой на новый,
 * новый создаётся активным с тем же ресурсом и тарифной зоной.
 */
export async function handleAdminMeterReplace(
  request: Request,
  env: Env,
  oldMeterId: number
): Promise<Response> {
  const denied = guard(request, env);
  if (denied) return denied;

  const oldMeter = await findAdminMeterById(env.DB, oldMeterId);
  if (!oldMeter) {
    return redirectWithMessage("/admin/apartments", {
      kind: "error",
      text: "Счётчик не найден.",
    });
  }

  const backPath = `/admin/apartments/${oldMeter.apartment_id}`;

  if (!oldMeter.is_active) {
    return redirectWithMessage(backPath, {
      kind: "error",
      text: "Счётчик уже снят с учёта или заменён ранее.",
    });
  }

  const form = await request.formData();
  const serialNumberRaw = String(form.get("serial_number") ?? "").trim();
  const serialNumber = serialNumberRaw.length > 0 ? serialNumberRaw : null;
  const initialReading = Number(form.get("initial_reading"));
  const installedAt = String(form.get("installed_at") ?? "");

  if (!Number.isFinite(initialReading) || initialReading < 0) {
    return redirectWithMessage(backPath, {
      kind: "error",
      text: "Некорректное начальное показание нового счётчика.",
    });
  }
  if (!ISO_DATE_PATTERN.test(installedAt)) {
    return redirectWithMessage(backPath, {
      kind: "error",
      text: "Укажите дату установки нового счётчика.",
    });
  }

  const newMeterId = await insertMeter(env.DB, {
    apartmentId: oldMeter.apartment_id,
    resourceTypeId: oldMeter.resource_code === "" ? 0 : (await resourceTypeIdByCode(env.DB, oldMeter.resource_code)),
    tariffZone: oldMeter.tariff_zone,
    serialNumber,
    initialReading,
    installedAt,
  });

  const decommissionedAt = todayIsoDate();
  await markMeterReplaced(env.DB, oldMeterId, newMeterId, decommissionedAt);

  await logEvent(env.DB, {
    entityType: "meter",
    entityId: newMeterId,
    action: "meter_replaced",
    payload: {
      old_meter_id: oldMeterId,
      decommissioned_at: decommissionedAt,
      by: "admin_panel",
    },
  });

  return redirectWithMessage(backPath, {
    kind: "ok",
    text: "Счётчик заменён.",
  });
}

/** Вспомогательный поиск id типа ресурса по его коду. */
async function resourceTypeIdByCode(
  db: D1Database,
  code: string
): Promise<number> {
  const row = await db
    .prepare("SELECT id FROM resource_types WHERE code = ?")
    .bind(code)
    .first<{ id: number }>();

  if (!row) {
    throw new Error(`Тип ресурса не найден: ${code}`);
  }
  return row.id;
}