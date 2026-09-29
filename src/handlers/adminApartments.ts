import type { Env } from "../index";
import { checkAdminAuth, unauthorizedResponse } from "../services/adminAuth";
import {
  renderAdminPage,
  escapeHtml,
  readFlashMessage,
  redirectWithMessage,
} from "../services/adminLayout";
import {
  listAllApartmentsForAdmin,
  insertApartment,
  setApartmentActive,
  findApartmentById,
  reissueApartmentCode,
} from "../db/apartments";
import type { ApartmentRow } from "../db/apartments";
import { generateAccessCode } from "../services/accessCode";
import { logEvent } from "../db/eventLog";
import { buildCsv, csvResponse } from "../services/csv";
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
import { formatValue } from "../services/format";

const NOT_CONFIGURED_MESSAGE =
  "Административная панель ещё не настроена: не задан пароль администратора.";

// Буквы (в т.ч. кириллица), цифры, слэш и дефис — для номеров вида "12", "12А", "1/2".
const APARTMENT_NUMBER_PATTERN = /^[A-Za-zА-Яа-яЁё0-9/-]{1,20}$/;

/** Страница со списком квартир и формой добавления новой. */
export async function handleAdminApartmentsPage(
  request: Request,
  env: Env
): Promise<Response> {
  if (!env.ADMIN_PASSWORD) {
    return new Response(NOT_CONFIGURED_MESSAGE, { status: 503 });
  }
  if (!checkAdminAuth(request, env)) {
    return unauthorizedResponse();
  }

  const url = new URL(request.url);
  const apartments = await listAllApartmentsForAdmin(env.DB);

  const html = renderAdminPage(
    "Квартиры",
    "apartments",
    readFlashMessage(url),
    renderApartmentsPageBody(apartments)
  );

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function renderApartmentRow(apartment: ApartmentRow): string {
  const statusClass = apartment.is_active ? "status-ok" : "status-inactive";
  const statusText = apartment.is_active ? "активна" : "отключена";
  const toggleLabel = apartment.is_active ? "Отключить" : "Включить";
  const codeSuffix = apartment.access_code_active ? "" : " (код отозван)";

  return `<tr>
    <td><a class="apartment-link" href="/admin/apartments/${apartment.id}">№${escapeHtml(apartment.number)}</a></td>
    <td class="code">${escapeHtml(apartment.access_code)}${codeSuffix}</td>
    <td class="${statusClass}">${statusText}</td>
    <td>
      <form class="inline" method="post" action="/admin/apartments/toggle">
        <input type="hidden" name="apartment_id" value="${apartment.id}">
        <button type="submit">${toggleLabel}</button>
      </form>
    </td>
    <td>
      <form class="inline" method="post" action="/admin/apartments/reissue-code"
            onsubmit="return confirm('Перевыпустить код доступа для квартиры №${escapeHtml(apartment.number)}? Старый код перестанет действовать.');">
        <input type="hidden" name="apartment_id" value="${apartment.id}">
        <button type="submit">Перевыпустить код</button>
      </form>
    </td>
  </tr>`;
}

function renderApartmentsPageBody(apartments: ApartmentRow[]): string {
  const rows = apartments.map(renderApartmentRow).join("\n");

  return `
  <div class="toolbar">
    <a class="button-link" href="/admin/apartments/export-all">⬇ Экспорт всех данных (CSV, 3 файла)</a>
  </div>

  <table>
    <thead><tr><th>Квартира</th><th>Код доступа</th><th>Статус</th><th></th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <h2>Добавить квартиру</h2>
  <form class="add-form" method="post" action="/admin/apartments/add">
    <label>Номер квартиры
      <input type="text" name="number" required maxlength="20">
    </label>
    <label>Код доступа (оставьте пустым — сгенерируется автоматически)
      <input type="text" name="code" maxlength="20">
    </label>
    <div style="margin-top:12px;"><button type="submit">Добавить</button></div>
  </form>
  `;
}

/** Добавление новой квартиры. */
export async function handleAdminApartmentAdd(
  request: Request,
  env: Env
): Promise<Response> {
  if (!env.ADMIN_PASSWORD) {
    return new Response(NOT_CONFIGURED_MESSAGE, { status: 503 });
  }
  if (!checkAdminAuth(request, env)) {
    return unauthorizedResponse();
  }

  const form = await request.formData();
  const number = String(form.get("number") ?? "").trim();
  const rawCode = String(form.get("code") ?? "").trim();

  if (!APARTMENT_NUMBER_PATTERN.test(number)) {
    return redirectWithMessage("/admin/apartments", {
      kind: "error",
      text: "Номер квартиры должен быть от 1 до 20 символов (буквы, цифры, / и -).",
    });
  }

  const code = rawCode.length > 0 ? rawCode.toUpperCase() : generateAccessCode();

  const result = await insertApartment(env.DB, number, code);
  if (!result.ok) {
    return redirectWithMessage("/admin/apartments", {
      kind: "error",
      text: `Квартира №${number} уже существует.`,
    });
  }

  await logEvent(env.DB, {
    entityType: "apartment",
    entityId: result.id,
    action: "apartment_added",
    payload: { number, by: "admin_panel" },
  });

  return redirectWithMessage("/admin/apartments", {
    kind: "ok",
    text: `Квартира №${number} добавлена. Код доступа: ${code}`,
  });
}

/** Включение/отключение квартиры. */
export async function handleAdminApartmentToggle(
  request: Request,
  env: Env
): Promise<Response> {
  if (!env.ADMIN_PASSWORD) {
    return new Response(NOT_CONFIGURED_MESSAGE, { status: 503 });
  }
  if (!checkAdminAuth(request, env)) {
    return unauthorizedResponse();
  }

  const form = await request.formData();
  const apartmentId = Number(form.get("apartment_id"));

  if (!Number.isInteger(apartmentId) || apartmentId <= 0) {
    return redirectWithMessage("/admin/apartments", {
      kind: "error",
      text: "Некорректная квартира.",
    });
  }

  const apartment = await findApartmentById(env.DB, apartmentId);
  if (!apartment) {
    return redirectWithMessage("/admin/apartments", {
      kind: "error",
      text: "Квартира не найдена.",
    });
  }

  const newActive = apartment.is_active === 0;
  await setApartmentActive(env.DB, apartmentId, newActive);

  await logEvent(env.DB, {
    entityType: "apartment",
    entityId: apartmentId,
    action: newActive ? "apartment_activated" : "apartment_deactivated",
    payload: { number: apartment.number, by: "admin_panel" },
  });

  return redirectWithMessage("/admin/apartments", {
    kind: "ok",
    text: `Квартира №${apartment.number} ${newActive ? "включена" : "отключена"}.`,
  });
}

/** Перевыпуск кода доступа квартиры. */
export async function handleAdminApartmentReissueCode(
  request: Request,
  env: Env
): Promise<Response> {
  if (!env.ADMIN_PASSWORD) {
    return new Response(NOT_CONFIGURED_MESSAGE, { status: 503 });
  }
  if (!checkAdminAuth(request, env)) {
    return unauthorizedResponse();
  }

  const form = await request.formData();
  const apartmentId = Number(form.get("apartment_id"));

  if (!Number.isInteger(apartmentId) || apartmentId <= 0) {
    return redirectWithMessage("/admin/apartments", {
      kind: "error",
      text: "Некорректная квартира.",
    });
  }

  const apartment = await findApartmentById(env.DB, apartmentId);
  if (!apartment) {
    return redirectWithMessage("/admin/apartments", {
      kind: "error",
      text: "Квартира не найдена.",
    });
  }

  const newCode = generateAccessCode();
  await reissueApartmentCode(env.DB, apartmentId, newCode);

  await logEvent(env.DB, {
    entityType: "apartment",
    entityId: apartmentId,
    action: "apartment_code_reissued",
    payload: { number: apartment.number, by: "admin_panel" },
  });

  return redirectWithMessage("/admin/apartments", {
    kind: "ok",
    text: `Новый код для квартиры №${apartment.number}: ${newCode}`,
  });
}

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

/**
 * Полная выгрузка всех данных: три CSV-файла (квартиры, счётчики,
 * показания) в одном ZIP-архиве. Это ручной резервный экспорт по
 * запросу администратора — не автоматический бэкап (он появится
 * отдельным этапом вместе с Cron и R2).
 *
 * ZIP собирается без сжатия (store), поэтому формат архива простой
 * и не требует внешних библиотек — при таком объёме данных (дом на
 * 50 квартир) размер файла роли не играет.
 */
export async function handleAdminExportAll(
  request: Request,
  env: Env
): Promise<Response> {
  if (!env.ADMIN_PASSWORD) {
    return new Response(NOT_CONFIGURED_MESSAGE, { status: 503 });
  }
  if (!checkAdminAuth(request, env)) {
    return unauthorizedResponse();
  }

  const apartments = await listApartmentsForExport(env.DB);
  const meters = await listMetersForExport(env.DB);
  const readings = await listAllReadingsForExport(env.DB);

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

  const zipBytes = buildStoredZip([
    { name: "apartments.csv", content: apartmentsCsv },
    { name: "meters.csv", content: metersCsv },
    { name: "readings.csv", content: readingsCsv },
  ]);

  return new Response(zipBytes, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="export_${new Date().toISOString().slice(0, 10)}.zip"`,
    },
  });
}

// --- Минимальный ZIP-архиватор без сжатия (метод STORE) ---
//
// Полноценные библиотеки архивации плохо работают в среде Workers
// без Node.js-совместимости, а формат ZIP для несжатых файлов
// достаточно прост, чтобы собрать его вручную: так надёжнее и не
// добавляет внешних зависимостей ради трёх небольших CSV-файлов.

interface ZipEntry {
  name: string;
  content: string;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint32LE(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

function writeUint16LE(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function buildStoredZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const contentBytes = encoder.encode(entry.content);
    const crc = crc32(contentBytes);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    writeUint32LE(localView, 0, 0x04034b50); // сигнатура локального заголовка
    writeUint16LE(localView, 4, 20); // версия для распаковки
    writeUint16LE(localView, 6, 0); // флаги
    writeUint16LE(localView, 8, 0); // метод сжатия: 0 = без сжатия
    writeUint16LE(localView, 10, 0); // время (не используется)
    writeUint16LE(localView, 12, 0); // дата (не используется)
    writeUint32LE(localView, 14, crc);
    writeUint32LE(localView, 18, contentBytes.length); // сжатый размер
    writeUint32LE(localView, 22, contentBytes.length); // исходный размер
    writeUint16LE(localView, 26, nameBytes.length);
    writeUint16LE(localView, 28, 0); // длина доп. полей
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, contentBytes);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    writeUint32LE(centralView, 0, 0x02014b50); // сигнатура центрального заголовка
    writeUint16LE(centralView, 4, 20); // версия, создавшая архив
    writeUint16LE(centralView, 6, 20); // версия для распаковки
    writeUint16LE(centralView, 8, 0); // флаги
    writeUint16LE(centralView, 10, 0); // метод сжатия
    writeUint16LE(centralView, 12, 0); // время
    writeUint16LE(centralView, 14, 0); // дата
    writeUint32LE(centralView, 16, crc);
    writeUint32LE(centralView, 20, contentBytes.length);
    writeUint32LE(centralView, 24, contentBytes.length);
    writeUint16LE(centralView, 28, nameBytes.length);
    writeUint16LE(centralView, 30, 0); // доп. поля
    writeUint16LE(centralView, 32, 0); // комментарий
    writeUint16LE(centralView, 34, 0); // номер диска
    writeUint16LE(centralView, 36, 0); // внутренние атрибуты
    writeUint32LE(centralView, 38, 0); // внешние атрибуты
    writeUint32LE(centralView, 42, offset); // смещение локального заголовка
    centralHeader.set(nameBytes, 46);

    centralParts.push(centralHeader);
    offset += localHeader.length + contentBytes.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const centralOffset = offset;

  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  writeUint32LE(endView, 0, 0x06054b50); // сигнатура конца центрального каталога
  writeUint16LE(endView, 4, 0); // номер диска
  writeUint16LE(endView, 6, 0); // диск с центральным каталогом
  writeUint16LE(endView, 8, entries.length); // записей на этом диске
  writeUint16LE(endView, 10, entries.length); // всего записей
  writeUint32LE(endView, 12, centralSize);
  writeUint32LE(endView, 16, centralOffset);
  writeUint16LE(endView, 20, 0); // длина комментария

  const totalSize =
    offset + centralSize + endRecord.length;
  const result = new Uint8Array(totalSize);
  let position = 0;
  for (const part of [...localParts, ...centralParts, endRecord]) {
    result.set(part, position);
    position += part.length;
  }

  return result;
}