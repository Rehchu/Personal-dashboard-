-- Session-signing secret storage (applied to production via the Cloudflare
-- API on 2026-08-28; locally: npx wrangler d1 execute lifehq-sync --local --file migrations/0002_secrets.sql)
CREATE TABLE IF NOT EXISTS secrets (k TEXT PRIMARY KEY, v TEXT NOT NULL);
