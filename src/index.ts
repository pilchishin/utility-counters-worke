import { handleTelegramWebhook } from "./handlers/webhook";
import { handleDatabaseHealthCheck } from "./handlers/health";
import { handleManualScheduledRun } from "./handlers/manualRun";
import { handleAdminDashboard } from "./handlers/admin";
import {
  handleAdminApartmentsPage,
  handleAdminApartmentAdd,
  handleAdminApartmentToggle,
  handleAdminApartmentReissueCode,
} from "./handlers/adminApartments";
import {
  handleAdminConfirmReading,
  handleAdminCorrectReading,
} from "./handlers/adminReadingActions";
import { runScheduledTasks } from "./services/scheduler";

/**
 * Переменные окружения, секреты и биндинги, доступные Worker'у.
 *
 * Секреты (TELEGRAM_BOT_TOKEN, WEBHOOK_SECRET, MANUAL_RUN_TOKEN,
 * ADMIN_PASSWORD) задаются командой `wrangler secret put <ИМЯ>` и НЕ
 * хранятся ни в коде, ни в wrangler.jsonc. DB — биндинг на базу данных
 * D1 "et14a", настраивается в wrangler.jsonc.
 */
export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  DB: D1Database;
  // Необязательный временный секрет для ручного запуска планировщика (тесты).
  MANUAL_RUN_TOKEN?: string;
  // Пароль администратора для HTTP Basic Auth в /admin.
  ADMIN_PASSWORD?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const { method } = request;

    // Простой health-check — убедиться, что Worker задеплоен и отвечает,
    // не трогая ни Telegram, ни базу данных.
    if (pathname === "/" && method === "GET") {
      return new Response("OK", { status: 200 });
    }

    // Health-check с реальным обращением к базе данных D1.
    if (pathname === "/health/db" && method === "GET") {
      return handleDatabaseHealthCheck(env);
    }

    // Основной эндпоинт, на который Telegram присылает обновления (Update).
    if (pathname === "/tg-webhook" && method === "POST") {
      return handleTelegramWebhook(request, env);
    }

    // Ручной запуск планировщика (только если задан MANUAL_RUN_TOKEN).
    if (pathname === "/internal/run-scheduled" && method === "POST") {
      return handleManualScheduledRun(request, env);
    }

    // Административная панель: обзор.
    if (pathname === "/admin" && method === "GET") {
      return handleAdminDashboard(request, env);
    }

    // Административная панель: квартиры.
    if (pathname === "/admin/apartments" && method === "GET") {
      return handleAdminApartmentsPage(request, env);
    }
    if (pathname === "/admin/apartments/add" && method === "POST") {
      return handleAdminApartmentAdd(request, env);
    }
    if (pathname === "/admin/apartments/toggle" && method === "POST") {
      return handleAdminApartmentToggle(request, env);
    }
    if (pathname === "/admin/apartments/reissue-code" && method === "POST") {
      return handleAdminApartmentReissueCode(request, env);
    }

    // Административная панель: действия с показаниями.
    if (pathname === "/admin/readings/confirm" && method === "POST") {
      return handleAdminConfirmReading(request, env);
    }
    if (pathname === "/admin/readings/correct" && method === "POST") {
      return handleAdminCorrectReading(request, env);
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