-- Полная схема базы данных согласно утверждённой архитектуре.
-- Таблицы, не используемые кодом на текущем этапе (readings, meters
-- и т.д.), уже создаются здесь, чтобы не пересоздавать структуру
-- миграциями позже — но код, работающий с ними, будет добавляться
-- постепенно на следующих этапах.

-- Квартиры дома.
CREATE TABLE apartments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  access_code TEXT NOT NULL,
  access_code_active INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Типы ресурсов (вода, электричество, в будущем — газ и т.д.).
CREATE TABLE resource_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  has_tariff_zones INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1
);

-- Пользователи Telegram, привязанные к квартирам.
CREATE TABLE telegram_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL UNIQUE,
  apartment_id INTEGER REFERENCES apartments(id),
  role TEXT NOT NULL DEFAULT 'tenant',
  display_name TEXT,
  registered_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_blocked INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_telegram_users_apartment ON telegram_users(apartment_id);

-- Счётчики (один или несколько на квартиру, на ресурс, с тарифными зонами).
CREATE TABLE meters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  apartment_id INTEGER REFERENCES apartments(id),
  resource_type_id INTEGER NOT NULL REFERENCES resource_types(id),
  tariff_zone TEXT,
  serial_number TEXT,
  initial_reading REAL NOT NULL,
  installed_at TEXT NOT NULL,
  decommissioned_at TEXT,
  replaced_by_meter_id INTEGER REFERENCES meters(id),
  is_active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_meters_apartment_active ON meters(apartment_id, is_active);

-- Расчётные периоды (месяцы сбора показаний).
CREATE TABLE billing_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'collecting',
  closed_at TEXT,
  UNIQUE(year, month)
);

-- Показания счётчиков.
CREATE TABLE readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meter_id INTEGER NOT NULL REFERENCES meters(id),
  billing_period_id INTEGER NOT NULL REFERENCES billing_periods(id),
  value REAL NOT NULL,
  consumption REAL,
  status TEXT NOT NULL DEFAULT 'ok',
  submitted_by_user_id INTEGER REFERENCES telegram_users(id),
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  corrected_by_user_id INTEGER REFERENCES telegram_users(id),
  correction_comment TEXT,
  UNIQUE(meter_id, billing_period_id)
);
CREATE INDEX idx_readings_period ON readings(billing_period_id);
CREATE INDEX idx_readings_status ON readings(status);

-- Отправленные напоминания.
CREATE TABLE reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  apartment_id INTEGER NOT NULL REFERENCES apartments(id),
  billing_period_id INTEGER NOT NULL REFERENCES billing_periods(id),
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  kind TEXT NOT NULL
);

-- Журнал аудита (кто/когда/что изменил).
CREATE TABLE event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES telegram_users(id),
  payload TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_event_log_entity ON event_log(entity_type, entity_id);
CREATE INDEX idx_event_log_created ON event_log(created_at);

-- Настройки системы (ключ-значение), редактируемые администратором.
CREATE TABLE system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Начальные данные: два типа ресурсов из первоначального задания.
INSERT INTO resource_types (code, name, unit, has_tariff_zones) VALUES
  ('cold_water', 'Холодная вода', 'м³', 0),
  ('electricity', 'Электроэнергия', 'кВт·ч', 1);

-- Начальные настройки системы со значениями по умолчанию.
INSERT INTO system_settings (key, value) VALUES
  ('max_users_per_apartment', '2'),
  ('billing_day_start', '1'),
  ('billing_day_end', '25'),
  ('reminder_first_days_before_deadline', '5'),
  ('reminder_second_days_before_deadline', '2'),
  ('suspicious_multiplier', '3'),
  ('max_decimal_digits', '3'),
  ('reg_max_attempts', '5'),
  ('reg_lockout_minutes', '15');