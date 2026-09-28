import { handleTelegramWebhook } from "./handlers/webhook";
import { handleDatabaseHealthCheck } from "./handlers/health";

/**
 * Переменные окружения, секреты и биндинги, доступные Worker'у.
 *
 * Секреты (TELEGRAM_BOT_TOKEN, WEBHOOK_SECRET) задаются командой
 * `wrangler secret put <ИМЯ>` и НЕ хранятся ни в коде, ни в wrangler.toml.
 * DB — биндинг на базу данных D1 "et14a", настраивается в wrangler.toml.
 */
export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  DB: D1Database;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Простой health-check — убедиться, что Worker задеплоен и отвечает,
    // не трогая ни Telegram, ни базу данных.
    if (url.pathname === "/" && request.method === "GET") {
      return new Response("OK", { status: 200 });
    }

    // Health-check с реальным обращением к базе данных D1.
    if (url.pathname === "/health/db" && request.method === "GET") {
      return handleDatabaseHealthCheck(env);
    }

    // Основной эндпоинт, на который Telegram присылает обновления (Update).
    if (url.pathname === "/tg-webhook" && request.method === "POST") {
      return handleTelegramWebhook(request, env);
    }

    // Всё остальное — не найдено.
    return new Response("Not Found", { status: 404 });
  },
};