const express = require('express');
const path    = require('path');
const cors    = require('cors');
const { CognitoJwtVerifier }                   = require('aws-jwt-verify');
const { SQSClient, SendMessageCommand }         = require('@aws-sdk/client-sqs');
const { S3Client, GetObjectCommand }            = require('@aws-sdk/client-s3');
const { getSignedUrl }                          = require('@aws-sdk/s3-request-presigner');
const { createPool }                            = require('./db');

const app = express();

app.use(cors({
  origin:         process.env.CORS_ORIGIN?.split(',') ?? ['http://localhost:5173'],
  methods:        ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

let pool;

// --- AWS clients (Stage 5) ---

const REGION = process.env.AWS_REGION || 'us-east-1';

// Only initialised when env vars are present so the API still starts in dev without SQS/S3
const sqs = process.env.SQS_QUEUE_URL  ? new SQSClient({ region: REGION }) : null;
const s3  = process.env.EXPORT_BUCKET  ? new S3Client({ region: REGION })  : null;

// --- JWT verification (Stage 4) ---
//
// How it works:
//   1. Cognito issues a signed ID token (JWT) when the user logs in.
//   2. The frontend sends it as: Authorization: Bearer <token>
//   3. aws-jwt-verify fetches Cognito's public JWKS once and caches them.
//   4. It verifies the token signature, expiry, issuer, and audience — no secret needed.
//   5. req.user is set to the decoded payload (sub = user UUID, email = user email).
//
// Set DEV_SKIP_AUTH=true in local dev to bypass token validation when Cognito isn't configured.

const verifier = (process.env.COGNITO_USER_POOL_ID && process.env.COGNITO_CLIENT_ID)
  ? CognitoJwtVerifier.create({
      userPoolId: process.env.COGNITO_USER_POOL_ID,
      tokenUse:   'id',
      clientId:   process.env.COGNITO_CLIENT_ID,
    })
  : null;

async function requireAuth(req, res, next) {
  if (process.env.DEV_SKIP_AUTH === 'true') {
    req.user = { sub: 'dev-user', email: 'dev@local' };
    return next();
  }
  if (!verifier) {
    return res.status(500).json({ error: 'auth not configured' });
  }
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    req.user = await verifier.verify(auth.slice(7));
    next();
  } catch {
    res.status(401).json({ error: 'invalid or expired token' });
  }
}

// Maps pg snake_case columns → camelCase API response
function toNote(row) {
  return {
    id:        row.id,
    title:     row.title,
    content:   row.content,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function toExportJob(row) {
  return {
    id:          row.id,
    status:      row.status,
    requestedAt: row.requested_at,
    completedAt: row.completed_at ?? null,
    error:       row.error ?? null,
  };
}

// Wraps async route handlers and returns 500 on unhandled rejection
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });

// --- Health (public) ---
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// --- Notes API ---

app.get('/api/notes', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM notes WHERE user_id = $1 ORDER BY created_at DESC',
    [req.user.sub]
  );
  res.json(rows.map(toNote));
}));

app.post('/api/notes', requireAuth, wrap(async (req, res) => {
  const { title, content } = req.body;
  if (!title?.trim() || !content?.trim()) {
    return res.status(400).json({ error: 'title and content are required' });
  }
  const { rows } = await pool.query(
    'INSERT INTO notes (title, content, created_by, user_id) VALUES ($1, $2, $3, $4) RETURNING *',
    [title.trim(), content.trim(), req.user.email, req.user.sub]
  );
  res.status(201).json(toNote(rows[0]));
}));

app.delete('/api/notes/:id', requireAuth, wrap(async (req, res) => {
  const { rowCount } = await pool.query(
    'DELETE FROM notes WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.sub]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'note not found' });
  res.status(204).send();
}));

// --- Export API (Stage 5) ---

// POST /api/exports — create a job row, enqueue it, return 202 immediately
app.post('/api/exports', requireAuth, wrap(async (req, res) => {
  if (!sqs) {
    return res.status(503).json({ error: 'export not available (SQS_QUEUE_URL not set)' });
  }

  const { rows } = await pool.query(
    `INSERT INTO export_jobs (user_id) VALUES ($1)
     RETURNING id, status, requested_at`,
    [req.user.sub]
  );
  const job = rows[0];

  // Queue message shape:
  // { jobId, userId, requestedAt }
  // The worker only needs these three fields — it fetches notes from the DB itself.
  await sqs.send(new SendMessageCommand({
    QueueUrl:    process.env.SQS_QUEUE_URL,
    MessageBody: JSON.stringify({
      jobId:        job.id,
      userId:       req.user.sub,
      requestedAt:  job.requested_at,
    }),
  }));

  res.status(202).json({ jobId: job.id, status: job.status });
}));

// GET /api/exports/:id — poll for job status; includes a presigned download URL when complete
app.get('/api/exports/:id', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM export_jobs WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.sub]
  );
  if (!rows.length) return res.status(404).json({ error: 'export job not found' });

  const job    = rows[0];
  const result = { ...toExportJob(job), downloadUrl: null };

  if (job.status === 'completed' && job.s3_key && s3) {
    result.downloadUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: process.env.EXPORT_BUCKET, Key: job.s3_key }),
      { expiresIn: 3600 } // 1-hour window to download
    );
  }

  res.json(result);
}));

// Serve React build for local dev only — in production CloudFront serves S3 directly.
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

async function start() {
  pool = await createPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notes (
      id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      title      TEXT        NOT NULL,
      content    TEXT        NOT NULL,
      created_by TEXT        NOT NULL DEFAULT 'Anonymous',
      user_id    TEXT        NOT NULL DEFAULT 'legacy',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `ALTER TABLE notes ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT 'legacy'`
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS export_jobs (
      id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      TEXT        NOT NULL,
      status       TEXT        NOT NULL DEFAULT 'queued',
      s3_key       TEXT,
      error        TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS export_jobs_user_id_idx ON export_jobs (user_id)`
  );

  console.log('Schema ready');

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

start().catch((err) => { console.error(err); process.exit(1); });
