-- Защита от дублей: одно напоминание данного вида на квартиру и период.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reminders_unique
  ON reminders(apartment_id, billing_period_id, kind);

-- Настройки планировщика. INSERT OR IGNORE: уже существующие ключи
-- (например, reminder_first_days_before_deadline из первой миграции)
-- не перезаписываются.
INSERT OR IGNORE INTO system_settings (key, value) VALUES
  -- Часовой пояс дома (название по базе IANA).
  ('timezone', 'Europe/Kyiv'),
  -- Час (0-23 по местному времени), с которого начинается рассылка.
  ('reminder_hour_local', '10'),
  -- Сколько часов длится окно рассылки (повторные попытки в течение окна).
  ('reminder_window_hours', '10'),
  -- Отправлять ли финальное напоминание в день дедлайна (1 - да, 0 - нет).
  ('reminder_final_on_deadline_day', '1'),
  -- Уведомлять ли администратора после дедлайна (1 - да, 0 - нет).
  ('admin_notify_after_deadline', '1'),
  -- Максимум сообщений жильцам за один запуск (ограничение бесплатного тарифа).
  ('reminder_max_per_run', '15'),
  -- Через сколько дней после дедлайна период закрывается автоматически.
  ('period_close_grace_days', '5');