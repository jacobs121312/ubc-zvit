-- Черга перенесення зі старих таблиць: cron бере по кілька служінь за хвилину (ліміт процесорного часу
-- безкоштовного плану), звірка по кожному лишається тут.
CREATE TABLE import_jobs (
  ministry_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',     -- pending | done | error
  report TEXT,
  at INTEGER
);
