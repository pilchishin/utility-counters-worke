import type { Env } from "../index";

/**
 * Защита от CSRF для административной панели.
 *
 * Панель использует HTTP Basic Auth без сессий и кук. Браузер сам
 * прикладывает закэшированные учётные данные к ЛЮБОМУ запросу на этот
 * origin — в том числе к скрытой форме, отправленной со стороннего
 * сайта, если администратор недавно вводил пароль в этом же браузере.
 * Поэтому одного Basic Auth недостаточно против CSRF.
 *
 * Токен — это HMAC-SHA256 от фиксированной метки на основе пароля
 * администратора (ADMIN_PASSWORD), без отдельного хранилища сессий —
 * что соответствует архитектуре без состояния между запросами Worker'а.
 * Сторонний сайт не может прочитать HTML страницы панели (политика
 * Same-Origin), поэтому не может узнать токен — даже если браузер
 * и приложит действительные учётные данные к его запросу.
 */

const CSRF_LABEL = "admin-csrf-v1";

async function hmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Вычисляет CSRF-токен для текущего пароля администратора. */
export async function computeCsrfToken(env: Env): Promise<string> {
  return hmacHex(env.ADMIN_PASSWORD ?? "", CSRF_LABEL);
}

function tokensMatch(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  if (aBytes.byteLength !== bBytes.byteLength) {
    return false;
  }
  return crypto.subtle.timingSafeEqual(aBytes, bBytes);
}

/**
 * Проверяет CSRF-токен, присланный формой. Принимает значение поля
 * формы как есть (может быть не строкой — тогда проверка просто
 * не проходит).
 */
export async function verifyCsrfToken(
  env: Env,
  submitted: unknown
): Promise<boolean> {
  if (typeof submitted !== "string" || submitted.length === 0) {
    return false;
  }
  const expected = await computeCsrfToken(env);
  return tokensMatch(submitted, expected);
}

/** HTML-фрагмент скрытого поля с CSRF-токеном для вставки в форму. */
export function csrfField(token: string): string {
  return `<input type="hidden" name="csrf_token" value="${token}">`;
}

/** Ответ при неверном или отсутствующем CSRF-токене. */
export function csrfRejectedResponse(): Response {
  return new Response(
    "Проверка безопасности формы не пройдена. Обновите страницу и повторите действие.",
    { status: 403 }
  );
}