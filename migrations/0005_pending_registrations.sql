-- Telegram-пользователи, которые писали боту, но ещё не привязаны
-- ни к одной квартире. Запись удаляется, как только человек
-- регистрируется (сам по коду или вручную администратором).
CREATE TABLE IF NOT EXISTS pending_registrations (
  tg_id INTEGER PRIMARY KEY,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now'))
);