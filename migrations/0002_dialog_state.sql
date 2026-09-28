-- Состояние диалога пользователя с ботом (одна строка на пользователя).
-- Нужно, потому что Worker не хранит память между запросами:
-- бот должен "помнить", что пользователь сейчас вводит показание.
CREATE TABLE dialog_state (
  tg_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  context_json TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);