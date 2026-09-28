-- Причина, по которой показание помечено как подозрительное
-- (значения: decreased, over_absolute, over_relative; NULL — не помечено).
ALTER TABLE readings ADD COLUMN flag_reason TEXT;

-- Пороги проверки расхода. Все значения можно менять без деплоя кода.
-- INSERT OR IGNORE: уже существующие ключи (например, suspicious_multiplier
-- из первой миграции) не перезаписываются.
INSERT OR IGNORE INTO system_settings (key, value) VALUES
  -- Абсолютный максимум расхода за месяц на один счётчик/тарифную зону.
  -- Значение 0 отключает проверку для ресурса.
  ('max_consumption_cold_water', '30'),
  ('max_consumption_electricity', '1500'),
  -- Относительная проверка: расход больше среднего в N раз.
  -- Значение 0 отключает относительную проверку.
  ('suspicious_multiplier', '3'),
  -- Сколько последних месяцев брать для среднего.
  ('suspicious_history_periods', '3'),
  -- Минимум месяцев истории, при котором относительная проверка включается.
  ('suspicious_min_history', '2'),
  -- "Пол": расход ниже этого значения относительной проверкой не помечается.
  ('suspicious_relative_floor_cold_water', '3'),
  ('suspicious_relative_floor_electricity', '100'),
  -- Сколько месяцев подряд нулевого расхода считать заметной серией.
  ('zero_streak_alert_periods', '3');