import type { Env } from "../index";
import { checkAdminAuth, unauthorizedResponse } from "../services/adminAuth";
import {
  renderAdminPage,
  escapeHtml,
  readFlashMessage,
} from "../services/adminLayout";
import { buildCsv, csvResponse } from "../services/csv";
import {
  listAllPeriods,
  findPeriodById,
  listReadingsForExport,
} from "../db/reports";
import type { PeriodOption, ReadingExportRow } from "../db/reports";
import { listApartmentsOverview, listSuspiciousReadings } from "../db/admin";
import type {
  ApartmentOverviewRow,
  SuspiciousReadingRow,
} from "../db/admin";
import {
  periodLabel,
  capitalizeFirst,
  formatValue,
  meterTitle,
} from "../services/format";

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

/** Страница отчётов: выбор периода из списка существующих + сводка. */
export async function handleAdminReportsPage(
  request: Request,
  env: Env
): Promise<Response> {
  const denied = guard(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const periods = await listAllPeriods(env.DB);

  const requestedId = Number(url.searchParams.get("period"));
  const selectedPeriod =
    Number.isInteger(requestedId) && requestedId > 0
      ? periods.find((period) => period.id === requestedId) ?? null
      : periods[0] ?? null;

  let body: string;
  if (!selectedPeriod) {
    body = "<p>Периодов пока нет — они появятся после первой поданной квартиры показания.</p>";
  } else {
    const apartments = await listApartmentsOverview(env.DB, selectedPeriod.id);
    const suspicious = await listSuspiciousReadings(env.DB, selectedPeriod.id);
    body = renderReportBody(periods, selectedPeriod, apartments, suspicious);
  }

  const html = renderAdminPage("Отчёты", "reports", readFlashMessage(url), body);

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function renderPeriodSelect(periods: PeriodOption[], selectedId: number): string {
  const options = periods
    .map((period) => {
      const label = capitalizeFirst(periodLabel(period.year, period.month));
      const statusSuffix = period.status === "collecting" ? " (открыт)" : "";
      const selected = period.id === selectedId ? " selected" : "";
      return `<option value="${period.id}"${selected}>${escapeHtml(label + statusSuffix)}</option>`;
    })
    .join("\n");

  return `<form method="get" action="/admin/reports">
    <select name="period" onchange="this.form.submit()">${options}</select>
    <noscript><button type="submit">Показать</button></noscript>
  </form>`;
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

/** Строка таблицы подозрительных показаний с формами действий (как на обзоре). */
function renderSuspiciousRow(row: SuspiciousReadingRow, returnTo: string): string {
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
        <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
        <button type="submit">Подтвердить</button>
      </form>
    </td>
    <td>
      <form class="correction" method="post" action="/admin/readings/correct">
        <input type="hidden" name="reading_id" value="${row.reading_id}">
        <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
        <input type="number" step="0.001" min="0" name="value" placeholder="Верное значение" required>
        <input type="text" name="comment" placeholder="Причина исправления" required>
        <button type="submit">Исправить</button>
      </form>
    </td>
  </tr>`;
}

function renderSuspiciousTable(
  rows: SuspiciousReadingRow[],
  returnTo: string
): string {
  if (rows.length === 0) {
    return "<p>Подозрительных показаний за этот период нет.</p>";
  }

  const body = rows.map((row) => renderSuspiciousRow(row, returnTo)).join("\n");

  return `<table>
    <thead><tr>
      <th>Квартира</th><th>Счётчик</th><th>Значение</th>
      <th>Расход</th><th>Причина</th><th></th><th></th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

/** Форма управления статусом периода: закрыть вручную или открыть заново. */
function renderPeriodControls(period: PeriodOption): string {
  if (period.status === "collecting") {
    return `<form class="inline" method="post" action="/admin/periods/${period.id}/close"
                  onsubmit="return confirm('Закрыть период раньше срока? Жильцы больше не смогут подавать показания через бота.');">
      <button type="submit">Закрыть период вручную</button>
    </form>`;
  }

  return `<form class="correction" method="post" action="/admin/periods/${period.id}/reopen">
    <input type="text" name="reason" placeholder="Причина повторного открытия" required style="min-width:260px;">
    <button type="submit">Открыть период заново</button>
  </form>`;
}

function renderReportBody(
  periods: PeriodOption[],
  period: PeriodOption,
  apartments: ApartmentOverviewRow[],
  suspicious: SuspiciousReadingRow[]
): string {
  const total = apartments.length;
  const complete = apartments.filter(
    (apartment) =>
      apartment.total_meters > 0 &&
      apartment.submitted_meters === apartment.total_meters
  ).length;

  const title = capitalizeFirst(periodLabel(period.year, period.month));
  const returnTo = `/admin/reports?period=${period.id}`;

  return `
  ${renderPeriodSelect(periods, period.id)}

  <div class="summary">
    <strong>${escapeHtml(title)}</strong>
    (${period.status === "collecting" ? "открыт" : "закрыт"})<br>
    Сдали показания: ${complete} из ${total} квартир
  </div>

  <div class="toolbar">
    <a class="button-link" href="/admin/reports/export?period=${period.id}">⬇ Скачать CSV за этот период</a>
    ${renderPeriodControls(period)}
  </div>

  <h2>Квартиры</h2>
  ${renderApartmentsTable(apartments)}

  <h2>Подозрительные показания</h2>
  ${renderSuspiciousTable(suspicious, returnTo)}
  `;
}

/** Выгрузка показаний одного периода в CSV. */
export async function handleAdminReportExport(
  request: Request,
  env: Env
): Promise<Response> {
  const denied = guard(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const periodId = Number(url.searchParams.get("period"));

  if (!Number.isInteger(periodId) || periodId <= 0) {
    return new Response("Некорректный период.", { status: 400 });
  }

  const period = await findPeriodById(env.DB, periodId);
  if (!period) {
    return new Response("Период не найден.", { status: 404 });
  }

  const readings = await listReadingsForExport(env.DB, periodId);
  const csv = buildCsv(
    [
      "Квартира",
      "Ресурс",
      "Тарифная зона",
      "Серийный номер счётчика",
      "Показание",
      "Единица",
      "Расход",
      "Статус",
      "Причина пометки",
      "Подано (UTC)",
      "Telegram ID подавшего",
    ],
    readings.map((row) => readingRowToCsvRow(row))
  );

  const fileName = `readings_${period.year}-${String(period.month).padStart(2, "0")}.csv`;
  return csvResponse(csv, fileName);
}

function readingRowToCsvRow(row: ReadingExportRow): unknown[] {
  return [
    row.apartment_number,
    row.resource_name,
    row.tariff_zone ?? "",
    row.serial_number ?? "",
    formatValue(row.value),
    row.unit,
    row.consumption !== null ? formatValue(row.consumption) : "",
    row.status,
    flagReasonLabel(row.flag_reason),
    row.submitted_at,
    row.submitted_by_tg_id ?? "",
  ];
}