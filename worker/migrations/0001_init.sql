-- Звіт по витратах УБЦ — схема D1. Джерело правди — ця база; «Звіт 26-27» у таблицях — дзеркало для бухгалтерії.

-- Служіння: з таблиці служінь (синхронізація cron). id = ID папки служіння на Диску (як у старому API).
CREATE TABLE ministries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  responsible TEXT NOT NULL DEFAULT '',
  emails TEXT NOT NULL DEFAULT '',            -- як у таблиці служінь (для адмінки)
  report_sheet_id TEXT,                       -- «Звіт 26-27» — дзеркало
  receipts_folder_id TEXT,                    -- «Чеки…» у папці служіння
  opening_balance REAL NOT NULL DEFAULT 0,    -- «Початковий залишок» жовтня
  sort INTEGER NOT NULL DEFAULT 0,            -- порядок рядків у таблиці служінь
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE ministry_emails (
  ministry_id TEXT NOT NULL REFERENCES ministries(id),
  email TEXT NOT NULL,
  PRIMARY KEY (ministry_id, email)
);
CREATE INDEX ministry_emails_email ON ministry_emails(email);

-- Категорії бюджету служіння (аркуш «БЮДЖЕТ 26-27»).
CREATE TABLE categories (
  ministry_id TEXT NOT NULL REFERENCES ministries(id),
  name TEXT NOT NULL,                         -- повна назва з кодом, напр. «3401 Події/заходи …»
  plan REAL NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ministry_id, name)
);

-- Операції: витрати (кожна частина розбитого чека — окремий рядок) і аванси.
CREATE TABLE ops (
  id TEXT PRIMARY KEY,
  ministry_id TEXT NOT NULL REFERENCES ministries(id),
  type TEXT NOT NULL CHECK (type IN ('expense', 'advance')),
  date TEXT NOT NULL,                         -- рррр-мм-дд
  amount REAL NOT NULL,                       -- у гривнях
  orig TEXT,                                  -- JSON {amount, currency, rate} — якщо подано у валюті
  category TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  vendor TEXT NOT NULL DEFAULT '',
  has_receipt INTEGER NOT NULL DEFAULT 0,
  receipt_text TEXT NOT NULL DEFAULT '',      -- як у колонці «Чек» («Так», «Так (2 фото)», «Ні»)
  no_receipt_reason TEXT NOT NULL DEFAULT '',
  over INTEGER NOT NULL DEFAULT 0,            -- перевищення бюджету з поясненням
  over_reason TEXT NOT NULL DEFAULT '',
  part_of TEXT,                               -- частина розбитого чека: базовий ID
  part_note TEXT NOT NULL DEFAULT '',
  by_email TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,                -- мс; від нього рахується вікно редагування
  checked_by TEXT, checked_at INTEGER,
  reimbursed_by TEXT, reimbursed_at INTEGER,
  note TEXT NOT NULL DEFAULT '',              -- історія змін для примітки в таблиці
  deleted_at INTEGER, deleted_by TEXT,
  sheet_month TEXT, sheet_row INTEGER,        -- де рядок лежить у дзеркалі
  source TEXT NOT NULL DEFAULT 'app'          -- app | import
);
CREATE INDEX ops_ministry ON ops(ministry_id, deleted_at, date);

-- Фото чеків на Диску. status: pre — завантажено наперед, ще не подано; used — прив'язано до операції.
CREATE TABLE receipts (
  file_id TEXT PRIMARY KEY,
  ministry_id TEXT NOT NULL,
  by_email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pre',
  created_at INTEGER NOT NULL
);

CREATE TABLE op_receipts (
  op_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  pos INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (op_id, file_id)
);

-- Ідемпотентність подання: повтор тієї самої картки (обрив зв'язку) повертає збережений результат.
CREATE TABLE op_keys (
  key TEXT PRIMARY KEY,                       -- ministry_id:opId
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Довгий вхід: лише геш ключа.
CREATE TABLE sessions (
  hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  exp INTEGER NOT NULL
);
CREATE INDEX sessions_email ON sessions(email);

CREATE TABLE seen (email TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE invites (email TEXT PRIMARY KEY, at INTEGER NOT NULL);

-- Ліміт завантажень фото на людину (за 6 год).
CREATE TABLE upload_quota (email TEXT PRIMARY KEY, since INTEGER NOT NULL, n INTEGER NOT NULL, bytes INTEGER NOT NULL);

-- Журнал змін (як аркуш «Журнал змін»).
CREATE TABLE changelog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ministry_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  email TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT ''
);

-- Черга дзеркала в Google-таблиці: виконується після відповіді, повтори — cron.
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ministry_id TEXT NOT NULL,
  kind TEXT NOT NULL,                         -- upsert_op | delete_op | log
  payload TEXT NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX outbox_next ON outbox(next_at);

-- Статистика: атомарні лічильники (INSERT … ON CONFLICT), без read-modify-write.
CREATE TABLE stat_counts (
  day TEXT NOT NULL, hour INTEGER NOT NULL, fn TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0, e INTEGER NOT NULL DEFAULT 0, a INTEGER NOT NULL DEFAULT 0,
  t INTEGER NOT NULL DEFAULT 0, x INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, hour, fn)
);
CREATE TABLE stat_users (day TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (day, hash));
CREATE TABLE stat_errors (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, fn TEXT NOT NULL, m TEXT NOT NULL);

-- ID службових папок на Диску («Чеки…/Листопад 26», «_Завантаження»), щоб не шукати їх щоразу.
CREATE TABLE folders (key TEXT PRIMARY KEY, id TEXT NOT NULL);

-- Оренда дзеркала на служіння: одночасно в «Звіт 26-27» служіння пише лише один процес.
CREATE TABLE locks (key TEXT PRIMARY KEY, until INTEGER NOT NULL);
