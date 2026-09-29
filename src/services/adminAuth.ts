import type { Env } from "../index";

/**
 * Проверка HTTP Basic Auth для административной панели.
 *
 * Логин фиксированный ("admin"), пароль — секрет ADMIN_PASSWORD.
 * Сравнение — за постоянное время, чтобы не давать подсказку через
 * задержку ответа. Это временный вариант авторизации: он проще, чем
 * Telegram Login Widget (требует настройки домена в @BotFather),
 * и годится, пока панель находится в разработке.
 */

const ADMIN_USERNAME = "admin";

function tokensMatch(received: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const receivedBytes = encoder.encode(received);
  const expectedBytes = encoder.encode(expected);

  if (receivedBytes.byteLength !== expectedBytes.byteLength) {
    return false;
  }
  return crypto.subtle.timingSafeEqual(receivedBytes, expectedBytes);
}

/** Разбирает заголовок "Basic <base64>". Возвращает null при любой проблеме. */
function parseBasicAuthHeader(
  header: string | null
): { username: string; password: string } | null {
  if (!header || !header.startsWith("Basic ")) {
    return null;
  }

  try {
    const decoded = atob(header.slice("Basic ".length));
    const separatorIndex = decoded.indexOf(":");
    if (separatorIndex === -1) {
      return null;
    }
    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1),
    };
  } catch {
    // Некорректный base64 — считаем, что авторизации нет.
    return null;
  }
}

/** Ответ, который просит браузер показать окно ввода логина и пароля. */
export function unauthorizedResponse(): Response {
  return new Response("Требуется авторизация администратора", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Admin panel"' },
  });
}

/**
 * Проверяет заголовок Authorization запроса. Возвращает true, если
 * логин и пароль верны.
 */
export function checkAdminAuth(request: Request, env: Env): boolean {
  if (!env.ADMIN_PASSWORD) {
    return false;
  }

  const credentials = parseBasicAuthHeader(request.headers.get("Authorization"));
  if (!credentials) {
    return false;
  }

  return (
    tokensMatch(credentials.username, ADMIN_USERNAME) &&
    tokensMatch(credentials.password, env.ADMIN_PASSWORD)
  );
}