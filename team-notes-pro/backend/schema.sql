-- Applied automatically on server start (CREATE TABLE IF NOT EXISTS).
-- Keep this file in sync with the bootstrap queries in server.js for reference.
--
-- Stage 4 migration (idempotent):
--   ALTER TABLE notes ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT 'legacy';

CREATE TABLE IF NOT EXISTS notes (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title      TEXT        NOT NULL,
  content    TEXT        NOT NULL,
  created_by TEXT        NOT NULL DEFAULT 'Anonymous',
  user_id    TEXT        NOT NULL DEFAULT 'legacy',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Stage 5: export job tracking
-- status: queued | processing | completed | failed
CREATE TABLE IF NOT EXISTS export_jobs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT        NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'queued',
  s3_key       TEXT,
  error        TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS export_jobs_user_id_idx ON export_jobs (user_id);
