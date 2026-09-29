import type { Env } from "../index";
import { checkAdminAuth, unauthorizedResponse } from "../services/adminAuth";
import { getOrCreateCurrentPeriod } from "../db/billingPeriods";
import { listApartmentsOverview, listSuspiciousReadings } from "../db/admin";
import type {
  ApartmentOverviewRow,
  SuspiciousReadingRow,
} from "../db/admin";
import {
  periodLabel,
  capitalizeFirst,
  formatDateRu,
  formatValue,
  meterTitle,
} from "../services/format";
import { renderAdminPage, escapeHtml, readFlashMessage } from "../services/adminLayout";

const NOT_CONFIGURED_MESSAGE =
  "Административная панель ещё не настроена: не задан пароль администратора.";

/**
 * Обрабатывает запрос обзорной страницы административной панели:
 * сводка по текущему периоду, статус квартир, разбор подозрительных
 * показаний.
 */
export async function handleAdminDashboard(
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
  const period = await getOrCreateCurrentPeriod(env.DB);
  const apartments = await listApartmentsOverview(env.DB, period.id);
  const suspicious = await listSuspiciousReadings(env.DB, period.id);

  const html = renderAdminPage(
    "Обзор",
    "dashboard",
    readFlashMessage(url),
    renderDashboardBody(period, apartments, suspicious)
  );

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function flagReasonLabel(reason: string | null): string {
  switch (reason) {
    case "decreased":
      return "меньше предыдущего";
    case "over_absolute":
      return "превышен абсолютный предел";
    case "over_relative":
      return "расход выше обычного";
    default:
      return "—";
  }
}

function renderApartmentsTable(apartments: ApartmentOverviewRow[]): string {
  const rows = apartments
    .map((apartment) => {
      const complete =
        apartment.total_meters > 0 &&
        apartment.submitted_meters === apartment.total_meters;
      const statusClass = complete ? "status-ok" : "status-missing";
      const statusText =
        apartment.total_meters === 0
          ? "нет счётчиков"
          : `${apartment.submitted_meters} из ${apartment.total_meters}`;

      return `<tr>
        <td>№${escapeHtml(apartment.number)}</td>
        <td class="${statusClass}">${statusText}</td>
      </tr>`;
    })
    .join("\n");

  return `<table>
    <thead><tr><th>Квартира</th><th>Передано показаний</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/** Строка таблицы подозрительных показаний с формами действий. */
function renderSuspiciousRow(row: SuspiciousReadingRow): string {
  const meterLabel = escapeHtml(
    meterTitle(row.serial_number, row.meter_id, row.tariff_zone)
  );
  const consumptionText =
    row.consumption !== null ? formatValue(row.consumption) : "—";

  return `<tr>
    <td>№${escapeHtml(row.apartment_number)}</td>
    <td>${escapeHtml(row.resource_name)}, ${meterLabel}</td>
    <td>${formatValue(row.value)} ${escapeHtml(row.unit)}</td>
    <td>${consumptionText}</td>
    <td>${escapeHtml(flagReasonLabel(row.flag_reason))}</td>
    <td>
      <form class="inline" method="post" action="/admin/readings/confirm">
        <input type="hidden" name="reading_id" value="${row.reading_id}">
        <button type="submit">Подтвердить</button>
      </form>
    </td>
    <td>
      <form class="correction" method="post" action="/admin/readings/correct">
        <input type="hidden" name="reading_id" value="${row.reading_id}">
        <input type="number" step="0.001" min="0" name="value" placeholder="Верное значение" required>
        <input type="text" name="comment" placeholder="Причина исправления" required>
        <button type="submit">Исправить</button>
      </form>
    </td>
  </tr>`;
}

function renderSuspiciousTable(rows: SuspiciousReadingRow[]): string {
  if (rows.length === 0) {
    return "<p>Подозрительных показаний за этот период нет.</p>";
  }

  const body = rows.map(renderSuspiciousRow).join("\n");

  return `<table>
    <thead><tr>
      <th>Квартира</th><th>Счётчик</th><th>Значение</th>
      <th>Расход</th><th>Причина</th><th></th><th></th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function renderDashboardBody(
  period: { year: number; month: number; ends_at: string; status: string },
  apartments: ApartmentOverviewRow[],
  suspicious: SuspiciousReadingRow[]
): string {
  const total = apartments.length;
  const complete = apartments.filter(
    (apartment) =>
      apartment.total_meters > 0 &&
      apartment.submitted_meters === apartment.total_meters
  ).length;

  const periodTitle = capitalizeFirst(periodLabel(period.year, period.month));
  const statusText = period.status === "collecting" ? "открыт" : "закрыт";

  return `
  <div class="summary">
    <strong>${escapeHtml(periodTitle)}</strong> (${statusText}, срок — ${escapeHtml(formatDateRu(period.ends_at))})<br>
    Сдали показания: ${complete} из ${total} квартир
  </div>

  <h2>Квартиры за текущий период</h2>
  ${renderApartmentsTable(apartments)}

  <h2>Подозрительные показания</h2>
  ${renderSuspiciousTable(suspicious)}
  `;
}