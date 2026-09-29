import type { Env } from "../index";
import { checkAdminAuth, unauthorizedResponse } from "../services/adminAuth";
import {
  renderAdminPage,
  escapeHtml,
  readFlashMessage,
} from "../services/adminLayout";
import {
  listEventLogPage,
  listDistinctEntityTypes,
  listDistinctActions,
} from "../db/eventLogAdmin";
import type { EventLogRow } from "../db/eventLogAdmin";

const NOT_CONFIGURED_MESSAGE =
  "Административная панель ещё не настроена: не задан пароль администратора.";

// Сколько записей журнала показывать за раз.
const LOG_PAGE_SIZE = 30;

function guard(request: Request, env: Env): Response | null {
  if (!env.ADMIN_PASSWORD) {
    return new Response(NOT_CONFIGURED_MESSAGE, { status: 503 });
  }
  if (!checkAdminAuth(request, env)) {
    return unauthorizedResponse();
  }
  return null;
}

// Русские подписи для типов сущностей. Неизвестное значение
// показывается как есть — так журнал не "ломается" при появлении
// новых типов событий в будущем без обновления этого списка.
const ENTITY_TYPE_LABELS: Record<string, string> = {
  apartment: "Квартира",
  telegram_user: "Жилец",
  meter: "Счётчик",
  reading: "Показание",
  billing_period: "Период",
  reg_attempt: "Попытка регистрации",
};

// Русские подписи для действий.
const ACTION_LABELS: Record<string, string> = {
  user_registered: "Регистрация жильца",
  user_unbound: "Жилец отвязан",
  user_blocked: "Жилец заблокирован",
  user_unblocked: "Жилец разблокирован",
  reading_submitted: "Показание подано",
  reading_corrected: "Показание исправлено",
  reading_confirmed_by_admin: "Показание подтверждено администратором",
  zero_consumption_streak: "Серия нулевого расхода",
  period_opened: "Период открыт",
  period_closed: "Период закрыт",
  period_reopened: "Период открыт заново",
  reminder_skipped_no_user: "Напоминание пропущено (нет аккаунта)",
  reminder_failed: "Ошибка отправки напоминания",
  admin_overdue_report_sent: "Отчёт администратору отправлен",
  apartment_added: "Квартира добавлена",
  apartment_activated: "Квартира включена",
  apartment_deactivated: "Квартира отключена",
  apartment_code_reissued: "Код доступа перевыпущен",
  meter_added: "Счётчик добавлен",
  meter_replaced: "Счётчик заменён",
  meter_decommissioned: "Счётчик снят с учёта",
  failed: "Неудачная попытка",
};

// Русские подписи для самых частых полей в payload.
const PAYLOAD_FIELD_LABELS: Record<string, string> = {
  number: "номер",
  apartment_number: "квартира",
  apartment_id: "id квартиры",
  tg_id: "Telegram ID",
  old_value: "было",
  new_value: "стало",
  old_status: "был статус",
  new_status: "стал статус",
  old_flag_reason: "была причина",
  new_flag_reason: "стала причина",
  value: "значение",
  consumption: "расход",
  status: "статус",
  reason: "причина",
  by: "источник",
  meter_id: "id счётчика",
  old_meter_id: "id старого счётчика",
  streak: "серия месяцев",
  period_id: "id периода",
  year: "год",
  month: "месяц",
  starts_at: "начало",
  ends_at: "срок",
  kind: "вид",
  via: "способ",
  recipients: "получателей",
  missing_apartments: "не сдали (квартир)",
  meters_expected: "ожидалось счётчиков",
  readings_submitted: "подано показаний",
  decommissioned_at: "дата снятия",
};

function entityLabel(entityType: string): string {
  return ENTITY_TYPE_LABELS[entityType] ?? entityType;
}

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/** Разбирает payload (JSON-строку) в читаемый список "поле: значение". */
function formatPayload(payload: string | null): string {
  if (!payload) {
    return "—";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return escapeHtml(payload);
  }

  if (typeof parsed !== "object" || parsed === null) {
    return escapeHtml(String(parsed));
  }

  const parts: string[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const label = PAYLOAD_FIELD_LABELS[key] ?? key;
    parts.push(`${escapeHtml(label)}: ${escapeHtml(String(value))}`);
  }

  return parts.length > 0 ? parts.join("; ") : "—";
}

function renderFilters(
  entityTypes: string[],
  actions: string[],
  selectedEntityType: string,
  selectedAction: string
): string {
  const entityOptions = ['<option value="">все</option>']
    .concat(
      entityTypes.map((type) => {
        const selected = type === selectedEntityType ? " selected" : "";
        return `<option value="${escapeHtml(type)}"${selected}>${escapeHtml(entityLabel(type))}</option>`;
      })
    )
    .join("\n");

  const actionOptions = ['<option value="">все</option>']
    .concat(
      actions.map((action) => {
        const selected = action === selectedAction ? " selected" : "";
        return `<option value="${escapeHtml(action)}"${selected}>${escapeHtml(actionLabel(action))}</option>`;
      })
    )
    .join("\n");

  return `<form method="get" action="/admin/log" class="toolbar">
    <label>Сущность
      <select name="entity_type">${entityOptions}</select>
    </label>
    <label>Действие
      <select name="action">${actionOptions}</select>
    </label>
    <button type="submit">Применить</button>
  </form>`;
}

function renderRow(row: EventLogRow): string {
  return `<tr>
    <td>${escapeHtml(row.created_at)}</td>
    <td>${escapeHtml(actionLabel(row.action))}</td>
    <td>${escapeHtml(entityLabel(row.entity_type))} #${row.entity_id}</td>
    <td>${row.actor_tg_id !== null ? row.actor_tg_id : "система"}</td>
    <td>${formatPayload(row.payload)}</td>
  </tr>`;
}

function buildPageUrl(
  entityType: string,
  action: string,
  offset: number
): string {
  const params = new URLSearchParams();
  if (entityType) params.set("entity_type", entityType);
  if (action) params.set("action", action);
  if (offset > 0) params.set("offset", String(offset));
  const query = params.toString();
  return query ? `/admin/log?${query}` : "/admin/log";
}

/** Страница журнала событий с фильтрами и постраничной подгрузкой. */
export async function handleAdminLogPage(
  request: Request,
  env: Env
): Promise<Response> {
  const denied = guard(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const entityType = url.searchParams.get("entity_type") ?? "";
  const action = url.searchParams.get("action") ?? "";
  const rawOffset = Number(url.searchParams.get("offset"));
  const offset = Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;

  const entityTypes = await listDistinctEntityTypes(env.DB);
  const actions = await listDistinctActions(env.DB);

  // Запрашиваем на одну запись больше страницы, чтобы узнать,
  // есть ли продолжение — без отдельного COUNT(*) запроса.
  const fetched = await listEventLogPage(
    env.DB,
    { entityType: entityType || undefined, action: action || undefined },
    LOG_PAGE_SIZE + 1,
    offset
  );
  const hasMore = fetched.length > LOG_PAGE_SIZE;
  const rows = fetched.slice(0, LOG_PAGE_SIZE);

  const rowsHtml =
    rows.length > 0
      ? rows.map(renderRow).join("\n")
      : `<tr><td colspan="5">Событий не найдено.</td></tr>`;

  const nextLink = hasMore
    ? `<a class="button-link" href="${buildPageUrl(entityType, action, offset + LOG_PAGE_SIZE)}">Показать ещё</a>`
    : "";

  const body = `
    ${renderFilters(entityTypes, actions, entityType, action)}

    <table>
      <thead><tr>
        <th>Когда (UTC)</th><th>Действие</th><th>Сущность</th><th>Кто</th><th>Подробности</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>

    <div class="toolbar">${nextLink}</div>
  `;

  const html = renderAdminPage("Журнал событий", "log", readFlashMessage(url), body);

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}