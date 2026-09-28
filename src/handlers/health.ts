import type { Env } from "../index";

/**
 * Проверяет доступность базы данных D1: выполняет тривиальный запрос
 * и возвращает результат в виде JSON.
 *
 * Используется только для ручной проверки после деплоя — не является
 * частью пользовательской логики бота.
 */
export async function handleDatabaseHealthCheck(env: Env): Promise<Response> {
  try {
    const result = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM resource_types"
    ).first<{ count: number }>();

    return new Response(
      JSON.stringify({
        ok: true,
        resource_types_count: result?.count ?? 0,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    // Если база недоступна или не привязана — сообщаем об этом явно,
    // а не отдаём общую ошибку 500 без объяснения.
    const message = error instanceof Error ? error.message : String(error);
    return new Response(
      JSON.stringify({ ok: false, error: message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}