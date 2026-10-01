/**
 * Минимальный ZIP-архиватор без сжатия (метод STORE).
 *
 * Полноценные библиотеки архивации плохо работают в среде Workers без
 * Node.js-совместимости, а формат ZIP для несжатых файлов достаточно
 * прост, чтобы собрать его вручную — так надёжнее и не добавляет
 * внешних зависимостей. Используется и для ручного экспорта всех
 * данных администратором, и для автоматического бэкапа в R2.
 */

export interface ZipEntry {
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

export function buildStoredZip(entries: ZipEntry[]): Uint8Array {
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

  const totalSize = offset + centralSize + endRecord.length;
  const result = new Uint8Array(totalSize);
  let position = 0;
  for (const part of [...localParts, ...centralParts, endRecord]) {
    result.set(part, position);
    position += part.length;
  }

  return result;
}