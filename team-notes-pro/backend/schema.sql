-- Applied automatically on server start (CREATE TABLE IF NOT EXISTS).
-- Keep this file in sync with the query in server.js for reference.

CREATE TABLE IF NOT EXISTS notes (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title      TEXT        NOT NULL,
  content    TEXT        NOT NULL,
  created_by TEXT        NOT NULL DEFAULT 'Anonymous',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
