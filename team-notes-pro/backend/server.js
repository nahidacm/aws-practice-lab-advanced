const express = require('express');
const path    = require('path');
const cors    = require('cors');
const { CognitoJwtVerifier }             = require('aws-jwt-verify');
const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');
const { S3Client, GetObjectCommand }     = require('@aws-sdk/client-s3');
const { getSignedUrl }                   = require('@aws-sdk/s3-request-presigner');
const { createPool }                     = require('./db');
const { createCache }                    = require('./cache');
const logger                             = require('./logger');
const { putMetric }                      = require('./metrics');

// Stage 10: X-Ray traces all outbound AWS SDK calls and HTTP requests.
// Requires the X-Ray daemon sidecar in the ECS task definition.
// Set XRAY_ENABLED=true in ECS env vars; leave unset locally.
let AWSXRay = null;
if (process.env.XRAY_ENABLED === 'true') {
  AWSXRay = require('aws-xray-sdk-core');
  AWSXRay.config([AWSXRay.plugins.ECSPlugin]);
  logger.info('xray.enabled');
}

const app = express();

app.use(cors({
  origin:         process.env.CORS_ORIGIN?.split(',') ?? ['http://localhost:5173'],
  methods:        ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

// X-Ray: aws-xray-sdk-core patches outgoing AWS SDK calls automatically.
// Per-request HTTP segments require aws-xray-sdk-express (not installed here).

// Request log — one structured line per response, queryable in Logs Insights
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info('http.request', {
      method: req.method,
      route:  req.path,
      status: res.statusCode,
      ms:     Date.now() - start,
    });
  });
  next();
});

let pool;
let cache;

const notesKey = (userId) => `notes:${userId}`;

const REGION = process.env.AWS_REGION || 'us-east-1';

const sfn = process.env.STATE_MACHINE_ARN ? new SFNClient({ region: REGION }) : null;
const s3  = process.env.EXPORT_BUCKET     ? new S3Client({ region: REGION })  : null;

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

// Wraps async route handlers; logs + metrics on unhandled 500s
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    logger.error('request.error', { method: req.method, route: req.path, error: err.message });
    putMetric('ApiError');
    res.status(500).json({ error: 'internal server error' });
  });

// --- Health (public) ---
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// --- Notes API ---

app.get('/api/notes', requireAuth, wrap(async (req, res) => {
  const key    = notesKey(req.user.sub);
  const cached = await cache.get(key);

  if (cached) {
    putMetric('CacheHit');
    return res.json(cached);
  }

  putMetric('CacheMiss');
  const { rows } = await pool.query(
    'SELECT * FROM notes WHERE user_id = $1 ORDER BY created_at DESC',
    [req.user.sub]
  );
  const notes = rows.map(toNote);
  await cache.set(key, notes);
  res.json(notes);
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
  await cache.del(notesKey(req.user.sub));
  res.status(201).json(toNote(rows[0]));
}));

app.delete('/api/notes/:id', requireAuth, wrap(async (req, res) => {
  const { rowCount } = await pool.query(
    'DELETE FROM notes WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.sub]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'note not found' });
  await cache.del(notesKey(req.user.sub));
  res.status(204).send();
}));

// --- Export API ---

app.post('/api/exports', requireAuth, wrap(async (req, res) => {
  if (!sfn) {
    return res.status(503).json({ error: 'export not available (STATE_MACHINE_ARN not set)' });
  }

  const { rows } = await pool.query(
    `INSERT INTO export_jobs (user_id) VALUES ($1) RETURNING id, status, requested_at`,
    [req.user.sub]
  );
  const job = rows[0];

  await sfn.send(new StartExecutionCommand({
    stateMachineArn: process.env.STATE_MACHINE_ARN,
    name:            job.id,
    input:           JSON.stringify({ jobId: job.id, userId: req.user.sub }),
  }));

  putMetric('ExportStarted');
  logger.info('export.started', { jobId: job.id });
  res.status(202).json({ jobId: job.id, status: job.status });
}));

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
      { expiresIn: 3600 }
    );
  }

  res.json(result);
}));


// Serve React build for local dev only
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

async function start() {
  pool  = await createPool();
  cache = createCache();

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

  logger.info('server.ready', { port: process.env.PORT || 3000 });
  const PORT = process.env.PORT || 3000;
  app.listen(PORT);
}

start().catch((err) => {
  logger.error('server.start.failed', { error: err.message });
  process.exit(1);
});
