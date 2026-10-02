import type { Env } from "../index";
import { checkAdminAuth, unauthorizedResponse } from "../services/adminAuth";
import { redirectWithMessage } from "../services/adminLayout";
import {
  findPeriodByIdFull,
  closePeriod,
  reopenPeriod,
} from "../db/billingPeriods";
import { logEvent } from "../db/eventLog";
import { periodLabel, capitalizeFirst } from "../services/format";
import {
  verifyCsrfToken,
  csrfRejectedResponse,
} from "../services/csrf";

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

/** Ручное закрытие периода администратором (раньше автоматического срока). */
export async function handleAdminPeriodClose(
  request: Request,
  env: Env,
  periodId: number
): Promise<Response> {
  const denied = guard(request, env);
  if (denied) return denied;

  const form = await request.formData();
  if (!(await verifyCsrfToken(env, form.get("csrf_token")))) {
    return csrfRejectedResponse();
  }

  const backPath = `/admin/reports?period=${periodId}`;

  const period = await findPeriodByIdFull(env.DB, periodId);
  if (!period) {
    return redirectWithMessage("/admin/reports", {
      kind: "error",
      text: "Период не найден.",
    });
  }

  if (period.status !== "collecting") {
    return redirectWithMessage(backPath, {
      kind: "error",
      text: "Период уже закрыт.",
    });
  }

  const changed = await closePeriod(env.DB, periodId);
  if (!changed) {
    return redirectWithMessage(backPath, {
      kind: "error",
      text: "Не удалось закрыть период — возможно, его статус уже изменился.",
    });
  }

  await logEvent(env.DB, {
    entityType: "billing_period",
    entityId: periodId,
    action: "period_closed",
    payload: { year: period.year, month: period.month, reason: "manual_admin", by: "admin_panel" },
  });

  const label = capitalizeFirst(periodLabel(period.year, period.month));
  return redirectWithMessage(backPath, {
    kind: "ok",
    text: `Период «${label}» закрыт.`,
  });
}

/**
 * Повторное открытие закрытого периода. Причина обязательна — это
 * нестандартная операция, требующая объяснения при последующем разборе.
 */
export async function handleAdminPeriodReopen(
  request: Request,
  env: Env,
  periodId: number
): Promise<Response> {
  const denied = guard(request, env);
  if (denied) return denied;

  const form = await request.formData();
  if (!(await verifyCsrfToken(env, form.get("csrf_token")))) {
    return csrfRejectedResponse();
  }

  const backPath = `/admin/reports?period=${periodId}`;

  const period = await findPeriodByIdFull(env.DB, periodId);
  if (!period) {
    return redirectWithMessage("/admin/reports", {
      kind: "error",
      text: "Период не найден.",
    });
  }

  if (period.status !== "closed") {
    return redirectWithMessage(backPath, {
      kind: "error",
      text: "Период уже открыт.",
    });
  }

  const reason = String(form.get("reason") ?? "").trim();

  if (reason.length === 0) {
    return redirectWithMessage(backPath, {
      kind: "error",
      text: "Укажите причину повторного открытия периода.",
    });
  }

  const changed = await reopenPeriod(env.DB, periodId);
  if (!changed) {
    return redirectWithMessage(backPath, {
      kind: "error",
      text: "Не удалось открыть период — возможно, его статус уже изменился.",
    });
  }

  await logEvent(env.DB, {
    entityType: "billing_period",
    entityId: periodId,
    action: "period_reopened",
    payload: { year: period.year, month: period.month, reason, by: "admin_panel" },
  });

  const label = capitalizeFirst(periodLabel(period.year, period.month));
  return redirectWithMessage(backPath, {
    kind: "ok",
    text: `Период «${label}» открыт заново. Жильцы снова могут подавать показания.`,
  });
}