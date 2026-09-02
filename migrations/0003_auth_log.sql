-- A best-effort audit of the front door: passphrase sign-ins and camera-
-- credential unlocks (who, when, and the outcome). The Worker also creates
-- this table on demand with CREATE TABLE IF NOT EXISTS, so it works even
-- before this migration is applied.
CREATE TABLE IF NOT EXISTS auth_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  ip TEXT,
  kind TEXT NOT NULL,
  outcome TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_log_at ON auth_log (at);
