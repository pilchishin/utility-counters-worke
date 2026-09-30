import type { Env } from "../index";
import { checkAdminAuth, unauthorizedResponse } from "../services/adminAuth";
import {
  renderAdminPage,
  escapeHtml,
  readFlashMessage,
  todayIsoDate,
} from "../services/adminLayout";
import { findApartmentById } from "../db/apartments";
import { listActiveUsersForApartment } from "../db/telegramUsers";
import type { TelegramUserRow } from "../db/telegramUsers";
import { listAllMetersForApartment } from "../db/meters";
import type { AdminMeterRow } from "../db/meters";
import { listActiveResourceTypes } from "../db/resourceTypes";
import { listPendingRegistrations } from "../db/pendingRegistrations";
import type { PendingRegistrationRow } from "../db/pendingRegistrations";
import { meterTitle, formatValue, formatDateRu } from "../services/format";

const NOT_CONFIGURED_MESSAGE =
  "Административная панель ещё не настроена: не задан пароль администратора.";

// Сколько ожидающих привязки показывать на карточке квартиры.
const PENDING_LIST_LIMIT = 20;

/** Карточка квартиры: жильцы и счётчики. */
export async function handleAdminApartmentDetail(
  request: Request,
  env: Env,
  apartmentId: number
): Promise<Response> {
  if (!env.ADMIN_PASSWORD) {
    return new Response(NOT_CONFIGURED_MESSAGE, { status: 503 });
  }
  if (!checkAdminAuth(request, env)) {
    return unauthorizedResponse();
  }

  const apartment = await findApartmentById(env.DB, apartmentId);
  if (!apartment) {
    return new Response("Квартира не найдена.", { status: 404 });
  }

  const url = new URL(request.url);
  const users = await listActiveUsersForApartment(env.DB, apartmentId);
  const pending = await listPendingRegistrations(env.DB, PENDING_LIST_LIMIT);
  const meters = await listAllMetersForApartment(env.DB, apartmentId);
  const resourceTypes = await listActiveResourceTypes(env.DB);

  const html = renderAdminPage(
    `Квартира №${apartment.number}`,
    "apartments",
    readFlashMessage(url),
    renderBody(apartmentId, apartment.number, users, pending, meters, resourceTypes)
  );

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function renderUserRow(user: TelegramUserRow): string {
  const statusText = user.is_blocked ? "заблокирован" : "активен";
  const statusClass = user.is_blocked ? "status-inactive" : "status-ok";
  const blockAction = user.is_blocked ? "unblock" : "block";
  const blockLabel = user.is_blocked ? "Разблокировать" : "Заблокировать";
  const roleText = user.role === "admin" ? "администратор" : "жилец";

  return `<tr>
    <td>${user.tg_id}</td>
    <td>${escapeHtml(roleText)}</td>
    <td class="${statusClass}">${statusText}</td>
    <td>
      <form class="inline" method="post" action="/admin/users/${user.id}/${blockAction}">
        <button type="submit">${blockLabel}</button>
      </form>
    </td>
    <td>
      <form class="inline" method="post" action="/admin/users/${user.id}/unbind"
            onsubmit="return confirm('Отвязать этот аккаунт от квартиры? История его показаний сохранится.');">
        <button type="submit">Отвязать</button>
      </form>
    </td>
  </tr>`;
}

/** Строка списка "ожидают привязки" с кнопкой быстрой привязки к этой квартире. */
function renderPendingRow(
  apartmentId: number,
  row: PendingRegistrationRow
): string {
  return `<tr>
    <td>${row.tg_id}</td>
    <td>${escapeHtml(row.first_seen)}</td>
    <td>${escapeHtml(row.last_seen)}</td>
    <td>
      <form class="inline" method="post" action="/admin/apartments/${apartmentId}/users/add">
        <input type="hidden" name="tg_id" value="${row.tg_id}">
        <button type="submit">Привязать к этой квартире</button>
      </form>
    </td>
  </tr>`;
}

/**
 * Раздел "Ожидают привязки" — список Telegram ID, которые писали боту,
 * но ещё не введены в базу как жильцы ни одной квартиры. Список общий
 * для всех квартир (бот заранее не знает, к какой квартире относится
 * обратившийся), поэтому показывается одинаково на любой карточке.
 */
function renderPendingSection(
  apartmentId: number,
  pending: PendingRegistrationRow[]
): string {
  if (pending.length === 0) {
    return "";
  }

  const rows = pending
    .map((row) => renderPendingRow(apartmentId, row))
    .join("\n");

  return `
  <h3 style="margin-top:16px;font-size:14px;">Ожидают привязки (написали боту, но не ввели код)</h3>
  <table>
    <thead><tr><th>Telegram ID</th><th>Впервые</th><th>Последний раз</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderUsersSection(
  apartmentId: number,
  users: TelegramUserRow[],
  pending: PendingRegistrationRow[]
): string {
  const rows = users.length
    ? users.map(renderUserRow).join("\n")
    : `<tr><td colspan="5">К квартире не привязано ни одного аккаунта.</td></tr>`;

  return `
  <h2>Жильцы</h2>
  <table>
    <thead><tr><th>Telegram ID</th><th>Роль</th><th>Статус</th><th></th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  ${renderPendingSection(apartmentId, pending)}

  <h3 style="margin-top:16px;font-size:14px;">Привязать вручную по Telegram ID</h3>
  <form class="add-form" method="post" action="/admin/apartments/${apartmentId}/users/add">
    <label>Telegram ID жильца (если его нет в списке выше — узнайте у него, например, через @userinfobot)
      <input type="number" name="tg_id" required min="1" step="1">
    </label>
    <div style="margin-top:12px;"><button type="submit">Привязать вручную</button></div>
  </form>
  `;
}

function renderMeterRow(meter: AdminMeterRow): string {
  const title = escapeHtml(
    meterTitle(meter.serial_number, meter.id, meter.tariff_zone)
  );
  const statusClass = meter.is_active ? "status-ok" : "status-inactive";
  const statusText = meter.is_active
    ? "активен"
    : `снят с учёта ${meter.decommissioned_at ? formatDateRu(meter.decommissioned_at) : ""}`;

  const actions = meter.is_active
    ? `
      <td>
        <form class="correction" method="post" action="/admin/meters/${meter.id}/replace">
          <input type="text" name="serial_number" placeholder="Новый серийный №" value="${escapeHtml(meter.serial_number ?? "")}">
          <input type="number" step="0.001" min="0" name="initial_reading" placeholder="Начальное показание" required>
          <input type="date" name="installed_at" value="${todayIsoDate()}" required>
          <button type="submit">Заменить</button>
        </form>
      </td>
      <td>
        <form class="inline" method="post" action="/admin/meters/${meter.id}/decommission"
              onsubmit="return confirm('Снять счётчик ${title} с учёта без замены?');">
          <button type="submit">Снять с учёта</button>
        </form>
      </td>`
    : `<td colspan="2">${meter.replaced_by_meter_id ? "заменён другим счётчиком" : ""}</td>`;

  return `<tr>
    <td>${escapeHtml(meter.resource_name)}</td>
    <td>${title}</td>
    <td>${formatValue(meter.initial_reading)} ${escapeHtml(meter.unit)}</td>
    <td class="${statusClass}">${statusText}</td>
    ${actions}
  </tr>`;
}

function renderResourceOptions(
  resourceTypes: { id: number; name: string }[]
): string {
  return resourceTypes
    .map((rt) => `<option value="${rt.id}">${escapeHtml(rt.name)}</option>`)
    .join("\n");
}

function renderMetersSection(
  apartmentId: number,
  meters: AdminMeterRow[],
  resourceTypes: { id: number; code: string; name: string; unit: string }[]
): string {
  const rows = meters.length
    ? meters.map(renderMeterRow).join("\n")
    : `<tr><td colspan="5">Для квартиры не заведено ни одного счётчика.</td></tr>`;

  return `
  <h2>Счётчики</h2>
  <table>
    <thead><tr>
      <th>Ресурс</th><th>Счётчик</th><th>Начальное показание</th>
      <th>Статус</th><th colspan="2">Действия</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <h2>Добавить счётчик</h2>
  <form class="add-form" method="post" action="/admin/apartments/${apartmentId}/meters/add">
    <label>Ресурс
      <select name="resource_type_id" required>
        ${renderResourceOptions(resourceTypes)}
      </select>
    </label>
    <label>Тарифная зона (для многотарифных электросчётчиков)
      <select name="tariff_zone">
        <option value="">нет</option>
        <option value="day">день</option>
        <option value="night">ночь</option>
      </select>
    </label>
    <label>Серийный номер (можно оставить пустым)
      <input type="text" name="serial_number" maxlength="50">
    </label>
    <label>Начальное показание
      <input type="number" step="0.001" min="0" name="initial_reading" required>
    </label>
    <label>Дата установки
      <input type="date" name="installed_at" value="${todayIsoDate()}" required>
    </label>
    <div style="margin-top:12px;"><button type="submit">Добавить счётчик</button></div>
  </form>
  `;
}

function renderBody(
  apartmentId: number,
  apartmentNumber: string,
  users: TelegramUserRow[],
  pending: PendingRegistrationRow[],
  meters: AdminMeterRow[],
  resourceTypes: { id: number; code: string; name: string; unit: string }[]
): string {
  return `
  <a class="back-link" href="/admin/apartments">← Все квартиры</a>
  <h2 style="margin-top:8px;">Квартира №${escapeHtml(apartmentNumber)}</h2>
  ${renderUsersSection(apartmentId, users, pending)}
  ${renderMetersSection(apartmentId, meters, resourceTypes)}
  `;
}