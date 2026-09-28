import { handleTelegramWebhook } from "./handlers/webhook";
import { handleDatabaseHealthCheck } from "./handlers/health";
import { handleManualScheduledRun } from "./handlers/manualRun";
import { runScheduledTasks } from "./services/scheduler";

/**
 * Переменные окружения, секреты и биндинги, доступные Worker'у.
 *
 * Секреты (TELEGRAM_BOT_TOKEN, WEBHOOK_SECRET, MANUAL_RUN_TOKEN) задаются
 * командой `wrangler secret put <ИМЯ>` и НЕ хранятся ни в коде,
 * ни в wrangler.jsonc. DB — биндинг на базу данных D1 "et14a",
 * настраивается в wrangler.jsonc.
 */
export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  DB: D1Database;
  // Необязательный временный секрет для ручного запуска планировщика (тесты).
  MANUAL_RUN_TOKEN?: string;
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

    // Ручной запуск планировщика (только если задан MANUAL_RUN_TOKEN).
    if (url.pathname === "/internal/run-scheduled" && request.method === "POST") {
      return handleManualScheduledRun(request, env);
    }

    // Всё остальное — не найдено.
    return new Response("Not Found", { status: 404 });
  },

  /**
   * Запуск по расписанию (Cron Trigger из wrangler.jsonc, раз в час).
   */
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(
      runScheduledTasks(env, new Date(controller.scheduledTime))
        .then((summary) => {
          console.log("Планировщик завершён:", JSON.stringify(summary));
        })
        .catch((error) => {
          console.error("Планировщик завершился ошибкой:", error);
        })
    );
  },
};