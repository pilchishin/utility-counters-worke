import { handleTelegramWebhook } from "./handlers/webhook";
import { handleDatabaseHealthCheck } from "./handlers/health";
import { handleManualScheduledRun } from "./handlers/manualRun";
import { handleAdminDashboard } from "./handlers/admin";
import {
  handleAdminApartmentsPage,
  handleAdminApartmentAdd,
  handleAdminApartmentToggle,
  handleAdminApartmentReissueCode,
  handleAdminExportAll,
} from "./handlers/adminApartments";
import { handleAdminApartmentDetail } from "./handlers/adminApartmentDetail";
import {
  handleAdminUserAdd,
  handleAdminUserUnbind,
  handleAdminUserSetBlocked,
} from "./handlers/adminUsers";
import {
  handleAdminMeterAdd,
  handleAdminMeterDecommission,
  handleAdminMeterReplace,
  handleAdminMeterEdit,
} from "./handlers/adminMeters";
import {
  handleAdminConfirmReading,
  handleAdminCorrectReading,
} from "./handlers/adminReadingActions";
import {
  handleAdminReportsPage,
  handleAdminReportExport,
} from "./handlers/adminReports";
import {
  handleAdminPeriodClose,
  handleAdminPeriodReopen,
} from "./handlers/adminPeriods";
import { handleAdminLogPage } from "./handlers/adminLog";
import {
  handleAdminBackupsPage,
  handleAdminBackupDownload,
  handleAdminBackupDelete,
  handleAdminBackupRun,
} from "./handlers/adminBackups";
import { adminAuthGate } from "./services/adminAuth";
import { runScheduledTasks } from "./services/scheduler";

/**
 * Переменные окружения, секреты и биндинги, доступные Worker'у.
 *
 * Секреты (TELEGRAM_BOT_TOKEN, WEBHOOK_SECRET, MANUAL_RUN_TOKEN,
 * ADMIN_PASSWORD) задаются командой `wrangler secret put <ИМЯ>` и НЕ
 * хранятся ни в коде, ни в wrangler.jsonc. DB — биндинг на базу данных
 * D1 "et14a", et14a_bucket — биндинг на хранилище R2 "et14a" для
 * резервных копий; оба настроены в wrangler.jsonc.
 */
export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  DB: D1Database;
  et14a_bucket: R2Bucket;
  // Необязательный временный секрет для ручного запуска планировщика (тесты).
  MANUAL_RUN_TOKEN?: string;
  // Пароль администратора для HTTP Basic Auth в /admin.
  ADMIN_PASSWORD?: string;
}

/** Извлекает первую группу из регулярного выражения как целое число, или null. */
function matchId(pattern: RegExp, pathname: string): number | null {
  const match = pattern.exec(pathname);
  if (!match) {
    return null;
  }
  const id = Number(match[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
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

    // Единый "шлюз" для всей административной панели: проверка пароля
    // и защита от перебора по IP. Если запрос отклонён (неверный
    // пароль или блокировка) — отвечаем сразу, не доходя до
    // конкретного обработчика страницы/действия.
    if (pathname.startsWith("/admin")) {
      const gate = await adminAuthGate(request, env);
      if (gate) {
        return gate;
      }
    }

    // Административная панель: обзор.
    if (pathname === "/admin" && method === "GET") {
      return handleAdminDashboard(request, env);
    }

    // Административная панель: журнал событий.
    if (pathname === "/admin/log" && method === "GET") {
      return handleAdminLogPage(request, env);
    }

    // Административная панель: бэкапы.
    // Порядок важен: более специфичные пути проверяются раньше общих.
    if (pathname === "/admin/backups/download" && method === "GET") {
      return handleAdminBackupDownload(request, env);
    }
    if (pathname === "/admin/backups/delete" && method === "POST") {
      return handleAdminBackupDelete(request, env);
    }
    if (pathname === "/admin/backups/run" && method === "POST") {
      return handleAdminBackupRun(request, env);
    }
    if (pathname === "/admin/backups" && method === "GET") {
      return handleAdminBackupsPage(request, env);
    }

    // Административная панель: отчёты и экспорт по периоду.
    if (pathname === "/admin/reports/export" && method === "GET") {
      return handleAdminReportExport(request, env);
    }
    if (pathname === "/admin/reports" && method === "GET") {
      return handleAdminReportsPage(request, env);
    }

    // Административная панель: управление статусом периода.
    const periodCloseId = method === "POST"
      ? matchId(/^\/admin\/periods\/(\d+)\/close$/, pathname)
      : null;
    if (periodCloseId !== null) {
      return handleAdminPeriodClose(request, env, periodCloseId);
    }

    const periodReopenId = method === "POST"
      ? matchId(/^\/admin\/periods\/(\d+)\/reopen$/, pathname)
      : null;
    if (periodReopenId !== null) {
      return handleAdminPeriodReopen(request, env, periodReopenId);
    }

    // Административная панель: список квартир и полный экспорт.
    if (pathname === "/admin/apartments/export-all" && method === "GET") {
      return handleAdminExportAll(request, env);
    }
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

    // Административная панель: карточка квартиры.
    const apartmentDetailId = method === "GET"
      ? matchId(/^\/admin\/apartments\/(\d+)$/, pathname)
      : null;
    if (apartmentDetailId !== null) {
      return handleAdminApartmentDetail(request, env, apartmentDetailId);
    }

    // Административная панель: жильцы конкретной квартиры.
    const userAddApartmentId = method === "POST"
      ? matchId(/^\/admin\/apartments\/(\d+)\/users\/add$/, pathname)
      : null;
    if (userAddApartmentId !== null) {
      return handleAdminUserAdd(request, env, userAddApartmentId);
    }

    const userUnbindId = method === "POST"
      ? matchId(/^\/admin\/users\/(\d+)\/unbind$/, pathname)
      : null;
    if (userUnbindId !== null) {
      return handleAdminUserUnbind(request, env, userUnbindId);
    }

    const userBlockId = method === "POST"
      ? matchId(/^\/admin\/users\/(\d+)\/block$/, pathname)
      : null;
    if (userBlockId !== null) {
      return handleAdminUserSetBlocked(request, env, userBlockId, true);
    }

    const userUnblockId = method === "POST"
      ? matchId(/^\/admin\/users\/(\d+)\/unblock$/, pathname)
      : null;
    if (userUnblockId !== null) {
      return handleAdminUserSetBlocked(request, env, userUnblockId, false);
    }

    // Административная панель: счётчики конкретной квартиры.
    const meterAddApartmentId = method === "POST"
      ? matchId(/^\/admin\/apartments\/(\d+)\/meters\/add$/, pathname)
      : null;
    if (meterAddApartmentId !== null) {
      return handleAdminMeterAdd(request, env, meterAddApartmentId);
    }

    const meterDecommissionId = method === "POST"
      ? matchId(/^\/admin\/meters\/(\d+)\/decommission$/, pathname)
      : null;
    if (meterDecommissionId !== null) {
      return handleAdminMeterDecommission(request, env, meterDecommissionId);
    }

    const meterReplaceId = method === "POST"
      ? matchId(/^\/admin\/meters\/(\d+)\/replace$/, pathname)
      : null;
    if (meterReplaceId !== null) {
      return handleAdminMeterReplace(request, env, meterReplaceId);
    }

    const meterEditId = method === "POST"
      ? matchId(/^\/admin\/meters\/(\d+)\/edit$/, pathname)
      : null;
    if (meterEditId !== null) {
      return handleAdminMeterEdit(request, env, meterEditId);
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