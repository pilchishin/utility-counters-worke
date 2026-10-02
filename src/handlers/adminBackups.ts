import type { Env } from "../index";
import { checkAdminAuth, unauthorizedResponse } from "../services/adminAuth";
import {
  renderAdminPage,
  escapeHtml,
  readFlashMessage,
  redirectWithMessage,
} from "../services/adminLayout";
import { performBackup } from "../services/backup";
import { getSettingText } from "../db/settings";
import { getLocalDateTime } from "../utils/localTime";
import {
  computeCsrfToken,
  csrfField,
  verifyCsrfToken,
  csrfRejectedResponse,
} from "../services/csrf";

const NOT_CONFIGURED_MESSAGE =
  "Административная панель ещё не настроена: не задан пароль администратора.";

// Префикс ключей бэкапов в R2 — одновременно и "папка", и проверка
// на то, что запрошенный ключ действительно относится к бэкапам
// (защита от обращения к произвольному объекту в бакете по имени).
const BACKUP_PREFIX = "backups/";
const BACKUP_KEY_PATTERN = /^backups\/\d{4}-\d{2}-\d{2}\.zip$/;

function guard(request: Request, env: Env): Response | null {
  if (!env.ADMIN_PASSWORD) {
    return new Response(NOT_CONFIGURED_MESSAGE, { status: 503 });
  }
  if (!checkAdminAuth(request, env)) {
    return unauthorizedResponse();
  }
  return null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

/** Страница со списком бэкапов в R2 и кнопками управления. */
export async function handleAdminBackupsPage(
  request: Request,
  env: Env
): Promise<Response> {
  const denied = guard(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const csrfToken = await computeCsrfToken(env);

  const listing = await env.et14a_bucket.list({ prefix: BACKUP_PREFIX, limit: 100 });
  // Новые сверху — ключи вида backups/ГГГГ-ММ-ДД.zip сортируются
  // лексикографически так же, как хронологически.
  const objects = [...listing.objects].sort((a, b) => (a.key < b.key ? 1 : -1));

  const timeZone = await getSettingText(env.DB, "timezone", "Europe/Kyiv");
  const local = getLocalDateTime(new Date(), timeZone);

  const rows = objects.length
    ? objects
        .map(
          (object) => `<tr>
            <td>${escapeHtml(object.key.slice(BACKUP_PREFIX.length))}</td>
            <td>${formatBytes(object.size)}</td>
            <td>${object.uploaded.toISOString()}</td>
            <td><a class="button-link" href="/admin/backups/download?key=${encodeURIComponent(object.key)}">Скачать</a></td>
            <td>
              <form class="inline" method="post" action="/admin/backups/delete"
                    onsubmit="return confirm('Удалить бэкап ${escapeHtml(object.key.slice(BACKUP_PREFIX.length))}? Это необратимо.');">
                ${csrfField(csrfToken)}
                <input type="hidden" name="key" value="${escapeHtml(object.key)}">
                <button type="submit">Удалить</button>
              </form>
            </td>
          </tr>`
        )
        .join("\n")
    : `<tr><td colspan="5">Бэкапов пока нет — первый будет создан автоматически по расписанию, либо нажмите «Создать бэкап сейчас».</td></tr>`;

  const body = `
    <div class="summary">
      Автоматический бэкап выполняется еженедельно по расписанию
      (день недели и час задаются в system_settings: backup_weekday,
      backup_hour_local). Текущее местное время: ${escapeHtml(local.isoDate)}, ${local.hour}:00.
    </div>

    <div class="toolbar">
      <form method="post" action="/admin/backups/run">
        ${csrfField(csrfToken)}
        <button type="submit">Создать бэкап сейчас</button>
      </form>
    </div>

    <h2>Резервные копии</h2>
    <table>
      <thead><tr><th>Файл</th><th>Размер</th><th>Создан (UTC)</th><th></th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <p style="font-size:13px;color:#666;margin-top:16px;">
      Рекомендуется периодически скачивать и открывать архив, чтобы убедиться,
      что резервная копия действительно восстанавливаема.
    </p>
  `;

  const html = renderAdminPage("Бэкапы", "backups", readFlashMessage(url), body);

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Скачивание конкретного бэкапа из R2. Это GET-запрос, не изменяющий
 * данные, поэтому CSRF-проверка не нужна.
 */
export async function handleAdminBackupDownload(
  request: Request,
  env: Env
): Promise<Response> {
  const denied = guard(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const key = url.searchParams.get("key") ?? "";

  if (!BACKUP_KEY_PATTERN.test(key)) {
    return new Response("Некорректное имя файла.", { status: 400 });
  }

  const object = await env.et14a_bucket.get(key);
  if (!object) {
    return new Response("Файл не найден.", { status: 404 });
  }

  const fileName = key.slice(BACKUP_PREFIX.length);

  return new Response(object.body, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
}

/** Удаление бэкапа из R2. */
export async function handleAdminBackupDelete(
  request: Request,
  env: Env
): Promise<Response> {
  const denied = guard(request, env);
  if (denied) return denied;

  const form = await request.formData();
  if (!(await verifyCsrfToken(env, form.get("csrf_token")))) {
    return csrfRejectedResponse();
  }

  const key = String(form.get("key") ?? "");

  if (!BACKUP_KEY_PATTERN.test(key)) {
    return redirectWithMessage("/admin/backups", {
      kind: "error",
      text: "Некорректное имя файла.",
    });
  }

  await env.et14a_bucket.delete(key);

  return redirectWithMessage("/admin/backups", {
    kind: "ok",
    text: `Бэкап ${key.slice(BACKUP_PREFIX.length)} удалён.`,
  });
}

/** Ручной запуск бэкапа немедленно, не дожидаясь расписания. */
export async function handleAdminBackupRun(
  request: Request,
  env: Env
): Promise<Response> {
  const denied = guard(request, env);
  if (denied) return denied;

  const form = await request.formData();
  if (!(await verifyCsrfToken(env, form.get("csrf_token")))) {
    return csrfRejectedResponse();
  }

  const timeZone = await getSettingText(env.DB, "timezone", "Europe/Kyiv");
  const local = getLocalDateTime(new Date(), timeZone);

  const result = await performBackup(env, local.isoDate, "manual");

  if (!result.ran) {
    return redirectWithMessage("/admin/backups", {
      kind: "error",
      text: `Не удалось создать бэкап: ${result.note}`,
    });
  }

  return redirectWithMessage("/admin/backups", {
    kind: "ok",
    text: `Бэкап создан: ${result.key} (${result.sizeBytes ?? 0} байт).`,
  });
}