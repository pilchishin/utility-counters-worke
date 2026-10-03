-- Настройки защиты от перебора пароля администратора.
-- Используется существующая таблица event_log (entity_type =
-- 'admin_login_attempt') — отдельная таблица не нужна.
INSERT OR IGNORE INTO system_settings (key, value) VALUES
  ('admin_login_max_attempts', '5'),
  ('admin_login_lockout_minutes', '15');