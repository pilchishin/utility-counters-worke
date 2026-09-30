import type { Env } from "../index";
import { checkAdminAuth, unauthorizedResponse } from "../services/adminAuth";
import { redirectWithMessage } from "../services/adminLayout";
import {
  findUserById,
  adminBindUser,
  softDeleteUser,
  setUserBlocked,
} from "../db/telegramUsers";
import { findApartmentById, countActiveUsersForApartment } from "../db/apartments";
import { getSettingNumber } from "../db/settings";
import { logEvent } from "../db/eventLog";
import { removePendingRegistration } from "../db/pendingRegistrations";

const NOT_CONFIGURED_MESSAGE =
  "Административная панель ещё не настроена: не задан пароль администратора.";

function guard(request: Request, env: Env): Response | null {
  if (!env.ADMIN_PASSWORD) {
    return new Response(NOT_CONFIGURED_MESSAGE, { status: 503 });
  }
  if (!checkAdminAuth(request, env)) {
    return unauthorizedResponse();
  }
  return null;
}

/** Ручная привязка жильца к квартире по его Telegram ID. */
export async function handleAdminUserAdd(
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
  const tgId = Number(form.get("tg_id"));

  if (!Number.isInteger(tgId) || tgId <= 0) {
    return redirectWithMessage(backPath, {
      kind: "error",
      text: "Некорректный Telegram ID.",
    });
  }

  const maxUsers = await getSettingNumber(env.DB, "max_users_per_apartment", 2);
  const currentCount = await countActiveUsersForApartment(env.DB, apartmentId);

  if (currentCount >= maxUsers) {
    return redirectWithMessage(backPath, {
      kind: "error",
      text: `Достигнут лимит пользователей на квартиру (${maxUsers}).`,
    });
  }

  const result = await adminBindUser(env.DB, tgId, apartmentId);
  if (!result.ok) {
    return redirectWithMessage(backPath, {
      kind: "error",
      text: "Этот Telegram ID уже привязан к другой активной квартире.",
    });
  }

  // Привязка состоялась — человек больше не "ожидает привязки".
  await removePendingRegistration(env.DB, tgId);

  await logEvent(env.DB, {
    entityType: "telegram_user",
    entityId: tgId,
    action: "user_registered",
    payload: { apartment_number: apartment.number, via: "admin_panel" },
  });

  return redirectWithMessage(backPath, {
    kind: "ok",
    text: `Telegram ID ${tgId} привязан к квартире №${apartment.number}.`,
  });
}

/** Отвязка жильца (мягкое удаление). */
export async function handleAdminUserUnbind(
  request: Request,
  env: Env,
  userId: number
): Promise<Response> {
  const denied = guard(request, env);
  if (denied) return denied;

  const user = await findUserById(env.DB, userId);
  if (!user || user.apartment_id === null) {
    return redirectWithMessage("/admin/apartments", {
      kind: "error",
      text: "Пользователь не найден.",
    });
  }

  const backPath = `/admin/apartments/${user.apartment_id}`;

  await softDeleteUser(env.DB, userId);

  await logEvent(env.DB, {
    entityType: "telegram_user",
    entityId: user.tg_id,
    action: "user_unbound",
    payload: { apartment_id: user.apartment_id, by: "admin_panel" },
  });

  return redirectWithMessage(backPath, {
    kind: "ok",
    text: `Аккаунт ${user.tg_id} отвязан от квартиры.`,
  });
}

/** Блокировка или разблокировка жильца. */
export async function handleAdminUserSetBlocked(
  request: Request,
  env: Env,
  userId: number,
  blocked: boolean
): Promise<Response> {
  const denied = guard(request, env);
  if (denied) return denied;

  const user = await findUserById(env.DB, userId);
  if (!user || user.apartment_id === null) {
    return redirectWithMessage("/admin/apartments", {
      kind: "error",
      text: "Пользователь не найден.",
    });
  }

  const backPath = `/admin/apartments/${user.apartment_id}`;

  await setUserBlocked(env.DB, userId, blocked);

  await logEvent(env.DB, {
    entityType: "telegram_user",
    entityId: user.tg_id,
    action: blocked ? "user_blocked" : "user_unblocked",
    payload: { apartment_id: user.apartment_id, by: "admin_panel" },
  });

  return redirectWithMessage(backPath, {
    kind: "ok",
    text: `Аккаунт ${user.tg_id} ${blocked ? "заблокирован" : "разблокирован"}.`,
  });
}