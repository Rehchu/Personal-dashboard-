-- lifehq-sync schema (applied to production via the Cloudflare API on 2026-08-28;
-- run locally with: npx wrangler d1 execute lifehq-sync --local --file migrations/0001_init.sql)
CREATE TABLE IF NOT EXISTS kv_sync (
  col TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  key_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
