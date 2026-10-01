import type { Env } from "../index";
import { buildCsv } from "./csv";
import { buildStoredZip } from "./zip";
import {
  listApartmentsForExport,
  listMetersForExport,
  listAllReadingsForExport,
} from "../db/reports";
import type {
  ApartmentExportRow,
  MeterExportRow,
  ReadingFullExportRow,
} from "../db/reports";
import { formatValue } from "./format";
import { getSettingNumber, getSettingText, setSettingText } from "../db/settings";
import { logEvent } from "../db/eventLog";
import { getLocalDateTime } from "../utils/localTime";

/**
 * Полный резервный архив: три CSV-файла (квартиры, счётчики, показания)
 * в одном ZIP. Используется и ручным экспортом администратора
 * (/admin/apartments/export-all), и автоматическим бэкапом в R2 —
 * один и тот же код, без дублирования.
 */

function apartmentRowToCsv(row: ApartmentExportRow): unknown[] {
  return [
    row.id,
    row.number,
    row.is_active ? "активна" : "отключена",
    row.access_code_active ? "да" : "нет",
    row.created_at,
  ];
}

function meterRowToCsv(row: MeterExportRow): unknown[] {
  return [
    row.id,
    row.apartment_number,
    row.resource_name,
    row.tariff_zone ?? "",
    row.serial_number ?? "",
    formatValue(row.initial_reading),
    row.installed_at,
    row.is_active ? "активен" : "снят с учёта",
    row.decommissioned_at ?? "",
    row.replaced_by_meter_id ?? "",
  ];
}

function readingRowToCsv(row: ReadingFullExportRow): unknown[] {
  return [
    `${row.period_year}-${String(row.period_month).padStart(2, "0")}`,
    row.apartment_number,
    row.resource_name,
    row.tariff_zone ?? "",
    row.serial_number ?? "",
    formatValue(row.value),
    row.unit,
    row.consumption !== null ? formatValue(row.consumption) : "",
    row.status,
    row.flag_reason ?? "",
    row.submitted_at,
    row.submitted_by_tg_id ?? "",
  ];
}

/** Собирает полный архив данных в виде байтов ZIP-файла. */
export async function buildFullBackupZip(db: D1Database): Promise<Uint8Array> {
  const apartments = await listApartmentsForExport(db);
  const meters = await listMetersForExport(db);
  const readings = await listAllReadingsForExport(db);

  const apartmentsCsv = buildCsv(
    ["ID", "Номер", "Статус", "Код доступа активен", "Создана"],
    apartments.map(apartmentRowToCsv)
  );

  const metersCsv = buildCsv(
    [
      "ID", "Квартира", "Ресурс", "Тарифная зона", "Серийный номер",
      "Начальное показание", "Дата установки", "Статус", "Дата снятия",
      "Заменён на (ID)",
    ],
    meters.map(meterRowToCsv)
  );

  const readingsCsv = buildCsv(
    [
      "Период", "Квартира", "Ресурс", "Тарифная зона", "Серийный номер",
      "Показание", "Единица", "Расход", "Статус", "Причина пометки",
      "Подано (UTC)", "Telegram ID подавшего",
    ],
    readings.map(readingRowToCsv)
  );

  return buildStoredZip([
    { name: "apartments.csv", content: apartmentsCsv },
    { name: "meters.csv", content: metersCsv },
    { name: "readings.csv", content: readingsCsv },
  ]);
}

export interface BackupRunResult {
  ran: boolean;
  note: string;
  key?: string;
  sizeBytes?: number;
}

const DEFAULT_TIME_ZONE = "Europe/Kyiv";

function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/** День недели (0=вс..6=сб) календарной даты "ГГГГ-ММ-ДД", независимо от часового пояса. */
function weekdayOfIsoDate(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

/**
 * Выполняет бэкап безусловно (используется и расписанием, и ручной
 * кнопкой «Создать бэкап сейчас»). Кладёт архив в R2 под именем
 * backups/<dateLabel>.zip, обновляет отметку last_backup_at и пишет
 * событие в журнал. При ошибке событие тоже пишется (backup_failed),
 * а исключение не пробрасывается дальше — вызывающий код получает
 * результат в виде обычного значения, а не try/catch.
 */
export async function performBackup(
  env: Env,
  dateLabel: string,
  trigger: "schedule" | "manual"
): Promise<BackupRunResult> {
  const db = env.DB;

  try {
    const zipBytes = await buildFullBackupZip(db);
    const key = `backups/${dateLabel}.zip`;

    await env.et14a_bucket.put(key, zipBytes, {
      httpMetadata: { contentType: "application/zip" },
    });

    await setSettingText(db, "last_backup_at", dateLabel);

    await logEvent(db, {
      entityType: "system",
      entityId: 1,
      action: "backup_completed",
      payload: { key, size_bytes: zipBytes.byteLength, trigger },
    });

    return {
      ran: true,
      note: "бэкап создан",
      key,
      sizeBytes: zipBytes.byteLength,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    try {
      await logEvent(db, {
        entityType: "system",
        entityId: 1,
        action: "backup_failed",
        payload: { error: message, trigger },
      });
    } catch (logError) {
      console.error("Не удалось записать backup_failed в журнал:", logError);
    }

    return { ran: false, note: `ошибка: ${message}` };
  }
}

/**
 * Проверяет, наступило ли время для еженедельного автоматического
 * бэкапа (день недели, окно часов, ещё не делался сегодня), и если
 * да — выполняет его. Вызывается из планировщика на каждом часовом
 * запуске Cron — отдельный Cron Trigger под бэкап не нужен.
 */
export async function runBackupIfDue(
  env: Env,
  now: Date
): Promise<BackupRunResult> {
  const db = env.DB;
  const timeZone = await getSettingText(db, "timezone", DEFAULT_TIME_ZONE);
  const local = getLocalDateTime(now, timeZone);

  const backupWeekday = clampInt(
    await getSettingNumber(db, "backup_weekday", 0),
    0,
    6
  );
  const backupHour = clampInt(
    await getSettingNumber(db, "backup_hour_local", 3),
    0,
    23
  );
  const windowHours = clampInt(
    await getSettingNumber(db, "backup_window_hours", 2),
    1,
    24
  );

  if (local.hour < backupHour || local.hour >= backupHour + windowHours) {
    return { ran: false, note: "вне окна бэкапа" };
  }

  if (weekdayOfIsoDate(local.isoDate) !== backupWeekday) {
    return { ran: false, note: "сегодня не день бэкапа" };
  }

  const lastBackupAt = await getSettingText(db, "last_backup_at", "");
  if (lastBackupAt === local.isoDate) {
    return { ran: false, note: "бэкап сегодня уже выполнен" };
  }

  return performBackup(env, local.isoDate, "schedule");
}