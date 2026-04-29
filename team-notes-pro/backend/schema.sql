-- Applied automatically on server start (CREATE TABLE IF NOT EXISTS).
-- Keep this file in sync with the bootstrap query in server.js for reference.
--
-- Stage 4 migration (idempotent, also runs on startup):
--   ALTER TABLE notes ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT 'legacy';

CREATE TABLE IF NOT EXISTS notes (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title      TEXT        NOT NULL,
  content    TEXT        NOT NULL,
  created_by TEXT        NOT NULL DEFAULT 'Anonymous',
  user_id    TEXT        NOT NULL DEFAULT 'legacy',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
