import type { Env } from "../index";
import { checkAdminAuth, unauthorizedResponse } from "../services/adminAuth";
import {
  renderAdminPage,
  escapeHtml,
  readFlashMessage,
  redirectWithMessage,
} from "../services/adminLayout";
import {
  listAllApartmentsForAdmin,
  insertApartment,
  setApartmentActive,
  findApartmentById,
  reissueApartmentCode,
} from "../db/apartments";
import type { ApartmentRow } from "../db/apartments";
import { generateAccessCode } from "../services/accessCode";
import { logEvent } from "../db/eventLog";

const NOT_CONFIGURED_MESSAGE =
  "Административная панель ещё не настроена: не задан пароль администратора.";

// Буквы (в т.ч. кириллица), цифры, слэш и дефис — для номеров вида "12", "12А", "1/2".
const APARTMENT_NUMBER_PATTERN = /^[A-Za-zА-Яа-яЁё0-9/-]{1,20}$/;

/** Страница со списком квартир и формой добавления новой. */
export async function handleAdminApartmentsPage(
  request: Request,
  env: Env
): Promise<Response> {
  if (!env.ADMIN_PASSWORD) {
    return new Response(NOT_CONFIGURED_MESSAGE, { status: 503 });
  }
  if (!checkAdminAuth(request, env)) {
    return unauthorizedResponse();
  }

  const url = new URL(request.url);
  const apartments = await listAllApartmentsForAdmin(env.DB);

  const html = renderAdminPage(
    "Квартиры",
    "apartments",
    readFlashMessage(url),
    renderApartmentsPageBody(apartments)
  );

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function renderApartmentRow(apartment: ApartmentRow): string {
  const statusClass = apartment.is_active ? "status-ok" : "status-inactive";
  const statusText = apartment.is_active ? "активна" : "отключена";
  const toggleLabel = apartment.is_active ? "Отключить" : "Включить";
  const codeSuffix = apartment.access_code_active ? "" : " (код отозван)";

  return `<tr>
    <td>№${escapeHtml(apartment.number)}</td>
    <td class="code">${escapeHtml(apartment.access_code)}${codeSuffix}</td>
    <td class="${statusClass}">${statusText}</td>
    <td>
      <form class="inline" method="post" action="/admin/apartments/toggle">
        <input type="hidden" name="apartment_id" value="${apartment.id}">
        <button type="submit">${toggleLabel}</button>
      </form>
    </td>
    <td>
      <form class="inline" method="post" action="/admin/apartments/reissue-code"
            onsubmit="return confirm('Перевыпустить код доступа для квартиры №${escapeHtml(apartment.number)}? Старый код перестанет действовать.');">
        <input type="hidden" name="apartment_id" value="${apartment.id}">
        <button type="submit">Перевыпустить код</button>
      </form>
    </td>
  </tr>`;
}

function renderApartmentsPageBody(apartments: ApartmentRow[]): string {
  const rows = apartments.map(renderApartmentRow).join("\n");

  return `
  <table>
    <thead><tr><th>Квартира</th><th>Код доступа</th><th>Статус</th><th></th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <h2>Добавить квартиру</h2>
  <form class="add-form" method="post" action="/admin/apartments/add">
    <label>Номер квартиры
      <input type="text" name="number" required maxlength="20">
    </label>
    <label>Код доступа (оставьте пустым — сгенерируется автоматически)
      <input type="text" name="code" maxlength="20">
    </label>
    <div style="margin-top:12px;"><button type="submit">Добавить</button></div>
  </form>
  `;
}

/** Добавление новой квартиры. */
export async function handleAdminApartmentAdd(
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
  const number = String(form.get("number") ?? "").trim();
  const rawCode = String(form.get("code") ?? "").trim();

  if (!APARTMENT_NUMBER_PATTERN.test(number)) {
    return redirectWithMessage("/admin/apartments", {
      kind: "error",
      text: "Номер квартиры должен быть от 1 до 20 символов (буквы, цифры, / и -).",
    });
  }

  const code = rawCode.length > 0 ? rawCode.toUpperCase() : generateAccessCode();

  const result = await insertApartment(env.DB, number, code);
  if (!result.ok) {
    return redirectWithMessage("/admin/apartments", {
      kind: "error",
      text: `Квартира №${number} уже существует.`,
    });
  }

  await logEvent(env.DB, {
    entityType: "apartment",
    entityId: result.id,
    action: "apartment_added",
    payload: { number, by: "admin_panel" },
  });

  return redirectWithMessage("/admin/apartments", {
    kind: "ok",
    text: `Квартира №${number} добавлена. Код доступа: ${code}`,
  });
}

/** Включение/отключение квартиры. */
export async function handleAdminApartmentToggle(
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
  const apartmentId = Number(form.get("apartment_id"));

  if (!Number.isInteger(apartmentId) || apartmentId <= 0) {
    return redirectWithMessage("/admin/apartments", {
      kind: "error",
      text: "Некорректная квартира.",
    });
  }

  const apartment = await findApartmentById(env.DB, apartmentId);
  if (!apartment) {
    return redirectWithMessage("/admin/apartments", {
      kind: "error",
      text: "Квартира не найдена.",
    });
  }

  const newActive = apartment.is_active === 0;
  await setApartmentActive(env.DB, apartmentId, newActive);

  await logEvent(env.DB, {
    entityType: "apartment",
    entityId: apartmentId,
    action: newActive ? "apartment_activated" : "apartment_deactivated",
    payload: { number: apartment.number, by: "admin_panel" },
  });

  return redirectWithMessage("/admin/apartments", {
    kind: "ok",
    text: `Квартира №${apartment.number} ${newActive ? "включена" : "отключена"}.`,
  });
}

/** Перевыпуск кода доступа квартиры. */
export async function handleAdminApartmentReissueCode(
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
  const apartmentId = Number(form.get("apartment_id"));

  if (!Number.isInteger(apartmentId) || apartmentId <= 0) {
    return redirectWithMessage("/admin/apartments", {
      kind: "error",
      text: "Некорректная квартира.",
    });
  }

  const apartment = await findApartmentById(env.DB, apartmentId);
  if (!apartment) {
    return redirectWithMessage("/admin/apartments", {
      kind: "error",
      text: "Квартира не найдена.",
    });
  }

  const newCode = generateAccessCode();
  await reissueApartmentCode(env.DB, apartmentId, newCode);

  await logEvent(env.DB, {
    entityType: "apartment",
    entityId: apartmentId,
    action: "apartment_code_reissued",
    payload: { number: apartment.number, by: "admin_panel" },
  });

  return redirectWithMessage("/admin/apartments", {
    kind: "ok",
    text: `Новый код для квартиры №${apartment.number}: ${newCode}`,
  });
}