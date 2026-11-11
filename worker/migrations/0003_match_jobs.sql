-- Черга прив'язки чеків з папок служінь до витрат без посилання (mode: dry — лише звіт, apply — прив'язати).
CREATE TABLE match_jobs (
  ministry_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'dry',
  status TEXT NOT NULL DEFAULT 'pending',
  report TEXT,
  at INTEGER
);
