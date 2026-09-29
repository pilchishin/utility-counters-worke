/**
 * Общий HTML-каркас страниц административной панели: разметка, стили,
 * навигация и флеш-сообщения — чтобы не дублировать их в каждом
 * обработчике страницы.
 */

export type AdminNavItem = "dashboard" | "apartments" | "reports" | "log";

export interface FlashMessage {
  kind: "ok" | "error";
  text: string;
}

/** Экранирует текст для безопасной вставки в HTML. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Читает флеш-сообщение из query-параметров (?ok=... или ?err=...). */
export function readFlashMessage(url: URL): FlashMessage | null {
  const ok = url.searchParams.get("ok");
  if (ok) {
    return { kind: "ok", text: ok };
  }
  const err = url.searchParams.get("err");
  if (err) {
    return { kind: "error", text: err };
  }
  return null;
}

/**
 * Формирует редирект (303) на указанный путь с флеш-сообщением
 * в query-параметре. Используется после каждого административного
 * действия, чтобы обновление страницы браузером не повторяло форму.
 */
export function redirectWithMessage(
  path: string,
  message: FlashMessage
): Response {
  const url = new URL(path, "https://placeholder.local");
  url.searchParams.set(message.kind === "ok" ? "ok" : "err", message.text);

  return new Response(null, {
    status: 303,
    headers: { Location: url.pathname + url.search },
  });
}

/** Сегодняшняя дата в формате "ГГГГ-ММ-ДД" (для value полей type=date). */
export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function renderNav(active: AdminNavItem): string {
  const dashboardClass = active === "dashboard" ? "nav-active" : "";
  const apartmentsClass = active === "apartments" ? "nav-active" : "";
  const reportsClass = active === "reports" ? "nav-active" : "";
  const logClass = active === "log" ? "nav-active" : "";

  return `<nav>
    <a class="${dashboardClass}" href="/admin">Обзор</a>
    <a class="${apartmentsClass}" href="/admin/apartments">Квартиры</a>
    <a class="${reportsClass}" href="/admin/reports">Отчёты</a>
    <a class="${logClass}" href="/admin/log">Журнал</a>
  </nav>`;
}

/** Собирает полную HTML-страницу панели: заголовок, навигация, флеш, тело. */
export function renderAdminPage(
  title: string,
  active: AdminNavItem,
  flash: FlashMessage | null,
  bodyHtml: string
): string {
  const flashHtml = flash
    ? `<div class="flash flash-${flash.kind}">${escapeHtml(flash.text)}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — админ-панель</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; color: #1a1a1a; background: #fafafa; }
  h1 { font-size: 20px; }
  h2 { font-size: 16px; margin-top: 32px; }
  nav { margin-bottom: 16px; }
  nav a { margin-right: 16px; text-decoration: none; color: #555; font-size: 14px; }
  nav a.nav-active { color: #111; font-weight: 600; border-bottom: 2px solid #111; }
  a.apartment-link { color: #1a5fb4; text-decoration: none; }
  a.apartment-link:hover { text-decoration: underline; }
  a.button-link { display: inline-block; padding: 6px 12px; background: #1a5fb4; color: #fff;
                  text-decoration: none; border-radius: 4px; font-size: 13px; }
  a.button-link:hover { background: #164e93; }
  table { border-collapse: collapse; width: 100%; margin-top: 8px; background: #fff; }
  th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; font-size: 14px; vertical-align: top; }
  th { background: #f0f0f0; }
  .status-ok { color: #1a7d1a; font-weight: 600; }
  .status-missing { color: #b23; font-weight: 600; }
  .status-inactive { color: #888; }
  .summary { background: #fff; border: 1px solid #ddd; padding: 12px 16px; border-radius: 6px; max-width: 480px; margin-bottom: 8px; }
  .flash { padding: 10px 14px; border-radius: 6px; margin-bottom: 16px; font-size: 14px; }
  .flash-ok { background: #e6f4ea; color: #1a7d1a; border: 1px solid #b8dfc3; }
  .flash-error { background: #fbe9e7; color: #a02a1f; border: 1px solid #f0b8ae; }
  form.inline { display: inline; }
  form.correction { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  input[type=text], input[type=number], input[type=date], select { padding: 4px 6px; font-size: 13px; }
  button { padding: 4px 10px; font-size: 13px; cursor: pointer; }
  .add-form { background: #fff; border: 1px solid #ddd; padding: 12px 16px; border-radius: 6px; max-width: 520px; margin-top: 8px; }
  .add-form label { display: block; margin-top: 8px; font-size: 13px; }
  .code { font-family: monospace; font-size: 14px; }
  .back-link { display: inline-block; margin-bottom: 8px; font-size: 14px; }
  .toolbar { display: flex; gap: 10px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
  .toolbar label { font-size: 13px; display: flex; gap: 4px; align-items: center; }
</style>
</head>
<body>
  <h1>Показания счётчиков — административная панель</h1>
  ${renderNav(active)}
  ${flashHtml}
  ${bodyHtml}
</body>
</html>`;
}