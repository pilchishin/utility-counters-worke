import type { Env } from "../index";
import {
  findApartmentByNumber,
  countActiveUsersForApartment,
} from "../db/apartments";
import {
  findUserByTgId,
  createTelegramUser,
  findApartmentNumberByUser,
} from "../db/telegramUsers";
import { getSettingNumber } from "../db/settings";
import { logEvent, countRecentEvents } from "../db/eventLog";

// Тип сущности в event_log для попыток регистрации конкретного tg_id —
// используется для подсчёта неудачных попыток (защита от подбора кода).
const REG_ATTEMPT_ENTITY_TYPE = "reg_attempt";

export type RegistrationResult =
  | { status: "success"; apartmentNumber: string }
  | { status: "locked_out" }
  | { status: "invalid_format" }
  | { status: "not_found" }
  | { status: "apartment_inactive" }
  | { status: "already_registered"; apartmentNumber: string | null }
  | { status: "limit_reached" };

/**
 * Разбирает пользовательский ввод в номер квартиры и код доступа.
 * Поддерживаются два формата:
 *  - "12 A93F1"  — ручной ввод текстом (разделитель — пробел);
 *  - "12-A93F1"  — параметр deep-ссылки /start (разделитель — дефис,
 *                  т.к. Telegram не пропускает пробелы в start-параметре).
 */
function parseRegistrationInput(
  raw: string
): { number: string; code: string } | null {
  const trimmed = raw.trim();

  const bySpace = trimmed.split(/\s+/);
  if (bySpace.length === 2 && bySpace[0] && bySpace[1]) {
    return { number: bySpace[0], code: bySpace[1] };
  }

  const byDash = trimmed.split("-");
  if (byDash.length === 2 && byDash[0] && byDash[1]) {
    return { number: byDash[0], code: byDash[1] };
  }

  return null;
}

/**
 * Основная функция регистрации: проверяет защиту от подбора кода,
 * разбирает ввод, ищет квартиру, проверяет код и лимит пользователей,
 * при успехе создаёт запись telegram_users.
 *
 * Каждая неудачная попытка фиксируется в event_log — накопленное
 * число неудач за последние N минут (system_settings) блокирует
 * дальнейшие попытки этого tg_id на M минут.
 */
export async function tryRegister(
  env: Env,
  tgId: number,
  rawInput: string
): Promise<RegistrationResult> {
  const db = env.DB;

  const maxAttempts = await getSettingNumber(db, "reg_max_attempts", 5);
  const lockoutMinutes = await getSettingNumber(db, "reg_lockout_minutes", 15);

  const recentFailures = await countRecentEvents(
    db,
    REG_ATTEMPT_ENTITY_TYPE,
    tgId,
    "failed",
    lockoutMinutes
  );

  if (recentFailures >= maxAttempts) {
    return { status: "locked_out" };
  }

  // Дополнительная защита: если этот tg_id уже привязан к квартире —
  // не создаём вторую привязку. Обычно этот случай отсекается раньше,
  // в webhook.ts, но проверка здесь исключает гонку состояний.
  const existingUser = await findUserByTgId(db, tgId);
  if (existingUser && existingUser.is_deleted === 0) {
    const apartmentNumber = existingUser.apartment_id
      ? await findApartmentNumberByUser(db, existingUser.apartment_id)
      : null;
    return { status: "already_registered", apartmentNumber };
  }

  const parsed = parseRegistrationInput(rawInput);
  if (!parsed) {
    await logEvent(db, {
      entityType: REG_ATTEMPT_ENTITY_TYPE,
      entityId: tgId,
      action: "failed",
      payload: { reason: "invalid_format", raw: rawInput },
    });
    return { status: "invalid_format" };
  }

  const apartment = await findApartmentByNumber(db, parsed.number);

  if (!apartment) {
    await logEvent(db, {
      entityType: REG_ATTEMPT_ENTITY_TYPE,
      entityId: tgId,
      action: "failed",
      payload: { reason: "apartment_not_found", number: parsed.number },
    });
    return { status: "not_found" };
  }

  if (apartment.is_active === 0) {
    await logEvent(db, {
      entityType: REG_ATTEMPT_ENTITY_TYPE,
      entityId: tgId,
      action: "failed",
      payload: { reason: "apartment_inactive", number: parsed.number },
    });
    return { status: "apartment_inactive" };
  }

  const codeMatches =
    apartment.access_code_active === 1 &&
    apartment.access_code.toUpperCase() === parsed.code.toUpperCase();

  if (!codeMatches) {
    // Намеренно тот же статус, что и "квартира не найдена" —
    // сообщение пользователю не должно давать подсказку, что именно
    // неверно (номер или код), это затрудняет подбор.
    await logEvent(db, {
      entityType: REG_ATTEMPT_ENTITY_TYPE,
      entityId: tgId,
      action: "failed",
      payload: { reason: "invalid_code", number: parsed.number },
    });
    return { status: "not_found" };
  }

  const maxUsersPerApartment = await getSettingNumber(
    db,
    "max_users_per_apartment",
    2
  );
  const activeUsersCount = await countActiveUsersForApartment(
    db,
    apartment.id
  );

  if (activeUsersCount >= maxUsersPerApartment) {
    await logEvent(db, {
      entityType: REG_ATTEMPT_ENTITY_TYPE,
      entityId: tgId,
      action: "failed",
      payload: { reason: "limit_reached", number: parsed.number },
    });
    return { status: "limit_reached" };
  }

  try {
    await createTelegramUser(db, tgId, apartment.id);
  } catch (error) {
    // Могла произойти гонка (например, повторная доставка одного
    // и того же апдейта Telegram). Если пользователь уже успел
    // создаться — отвечаем как при обычной повторной регистрации,
    // а не падаем с ошибкой.
    const existingAfterRace = await findUserByTgId(db, tgId);
    if (existingAfterRace && existingAfterRace.is_deleted === 0) {
      return { status: "already_registered", apartmentNumber: apartment.number };
    }
    throw error;
  }

  await logEvent(db, {
    entityType: "telegram_user",
    entityId: tgId,
    action: "user_registered",
    payload: { apartment_number: apartment.number },
  });

  return { status: "success", apartmentNumber: apartment.number };
}