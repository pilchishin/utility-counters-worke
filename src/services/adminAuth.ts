import type { Env } from "../index";
import { getSettingNumber } from "../db/settings";
import { countRecentEvents, logEvent } from "../db/eventLog";

/**
 * Проверка HTTP Basic Auth для административной панели, плюс защита
 * от перебора пароля по IP-адресу.
 *
 * Логин фиксированный ("admin"), пароль — секрет ADMIN_PASSWORD.
 * Сравнение — за постоянное время, чтобы не давать подсказку через
 * задержку ответа. Это временный вариант авторизации: он проще, чем
 * Telegram Login Widget (требует настройки домена в @BotFather),
 * и годится, пока панель находится в разработке.
 *
 * Защита от перебора устроена так же, как для кода регистрации
 * жильцов (см. services/registration.ts): неудачные попытки
 * фиксируются в event_log с типом сущности 'admin_login_attempt',
 * а блокировка — это подсчёт таких записей за скользящее окно
 * времени, а не отдельная таблица с состоянием.
 *
 * Сам IP-адрес нигде не сохраняется: в event_log попадает только
 * числовой идентификатор, полученный хэшированием IP (SHA-256,
 * первые 4 байта) — этого достаточно, чтобы отличать разные
 * источники попыток друг от друга, но по нему нельзя восстановить
 * исходный адрес.
 */

const ADMIN_USERNAME = "admin";
const ADMIN_LOGIN_ENTITY_TYPE = "admin_login_attempt";
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_LOCKOUT_MINUTES = 15;

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
 * логин и пароль верны. Не учитывает блокировку по перебору —
 * для этого используется adminAuthGate.
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

/**
 * Числовой идентификатор клиента для подсчёта попыток — хэш IP-адреса,
 * а не сам адрс. Если заголовок недоступен (локальная отладка и т.п.),
 * используется общий идентификатор "unknown" — это объединит все такие
 * запросы в один счётчик, что приемлемо как запасной вариант.
 */
async function clientEntityId(request: Request): Promise<number> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(ip));
  return new DataView(digest).getUint32(0);
}

/**
 * Единый «шлюз» для всех запросов к /admin/*: сначала проверяет,
 * не заблокирован ли этот источник за недавние неудачные попытки,
 * затем — сам логин/пароль. При неудаче фиксирует попытку.
 *
 * Возвращает Response, если запрос нужно остановить прямо здесь
 * (заблокирован или не авторизован), и null, если можно пропустить
 * запрос дальше к обработчику конкретной страницы/действия.
 *
 * Если ADMIN_PASSWORD не задан, возвращает null — пусть обработчик
 * сам ответит «панель не настроена» (как и раньше, до этого шлюза).
 */
export async function adminAuthGate(
  request: Request,
  env: Env
): Promise<Response | null> {
  if (!env.ADMIN_PASSWORD) {
    return null;
  }

  const entityId = await clientEntityId(request);

  const maxAttempts = await getSettingNumber(
    env.DB,
    "admin_login_max_attempts",
    DEFAULT_MAX_ATTEMPTS
  );
  const lockoutMinutes = await getSettingNumber(
    env.DB,
    "admin_login_lockout_minutes",
    DEFAULT_LOCKOUT_MINUTES
  );

  const recentFailures = await countRecentEvents(
    env.DB,
    ADMIN_LOGIN_ENTITY_TYPE,
    entityId,
    "failed",
    lockoutMinutes
  );

  if (recentFailures >= maxAttempts) {
    return new Response(
      `Слишком много неудачных попыток входа. Попробуйте снова через ${lockoutMinutes} мин.`,
      { status: 429 }
    );
  }

  if (!checkAdminAuth(request, env)) {
    await logEvent(env.DB, {
      entityType: ADMIN_LOGIN_ENTITY_TYPE,
      entityId,
      action: "failed",
    });
    return unauthorizedResponse();
  }

  return null;
}