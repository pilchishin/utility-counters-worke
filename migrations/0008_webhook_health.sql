-- Час (0-23 по местному времени), в который раз в сутки проверяется
-- состояние webhook'а Telegram через getWebhookInfo.
INSERT OR IGNORE INTO system_settings (key, value) VALUES
  ('webhook_check_hour_local', '6');