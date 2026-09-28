import type { Env } from "../index";
import { runScheduledTasks } from "../services/scheduler";

/**
 * Ручной запуск планировщика — ТОЛЬКО для проверки после деплоя.
 *
 * Работает, только если задан секрет MANUAL_RUN_TOKEN. Без него адрес
 * отвечает «Not Found», как будто его не существует. После тестов
 * секрет рекомендуется удалить: wrangler secret delete MANUAL_RUN_TOKEN
 *
 * Необязательный параметр now (время в формате ISO, например
 * 2026-09-20T07:00:00Z) позволяет проверить поведение «на другую дату».
 */

/** Сравнение токенов за постоянное время (защита от подбора по задержке). */
function tokensMatch(received: string | null, expected: string): boolean {
  if (received === null) {
    return false;
  }

  const encoder = new TextEncoder();
  const receivedBytes = encoder.encode(received);
  const expectedBytes = encoder.encode(expected);

  if (receivedBytes.byteLength !== expectedBytes.byteLength) {
    return false;
  }
  return crypto.subtle.timingSafeEqual(receivedBytes, expectedBytes);
}

export async function handleManualScheduledRun(
  request: Request,
  env: Env
): Promise<Response> {
  if (!env.MANUAL_RUN_TOKEN) {
    return new Response("Not Found", { status: 404 });
  }

  if (!tokensMatch(request.headers.get("X-Run-Token"), env.MANUAL_RUN_TOKEN)) {
    return new Response("Forbidden", { status: 403 });
  }

  const url = new URL(request.url);
  const nowParam = url.searchParams.get("now");
  let now = new Date();

  if (nowParam) {
    now = new Date(nowParam);
    if (Number.isNaN(now.getTime())) {
      return new Response(
        "Неверный формат параметра now. Пример: 2026-09-20T07:00:00Z",
        { status: 400 }
      );
    }
  }

  try {
    const summary = await runScheduledTasks(env, now);
    return new Response(JSON.stringify(summary, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}