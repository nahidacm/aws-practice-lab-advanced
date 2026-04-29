const express = require('express');
const path = require('path');
const cors = require('cors');
const { CognitoJwtVerifier } = require('aws-jwt-verify');
const { createPool } = require('./db');

const app = express();

// Stage 3: cross-origin requests from CloudFront.
// Stage 4: Authorization header must be in allowedHeaders for CORS preflight.
app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(',') ?? ['http://localhost:5173'],
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

let pool;

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
      tokenUse: 'id',
      clientId: process.env.COGNITO_CLIENT_ID,
    })
  : null;

async function requireAuth(req, res, next) {
  if (process.env.DEV_SKIP_AUTH === 'true') {
    req.user = { sub: 'dev-user', email: 'dev@local' };
    return next();
  }
  if (!verifier) {
    return res.status(500).json({ error: 'auth not configured — set COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID' });
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
    id: row.id,
    title: row.title,
    content: row.content,
    createdBy: row.created_by,
    createdAt: row.created_at,
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

// --- Notes API (all routes require a valid Cognito ID token) ---

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
  // user_id check prevents users from deleting each other's notes
  const { rowCount } = await pool.query(
    'DELETE FROM notes WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.sub]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'note not found' });
  res.status(204).send();
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

  // Idempotent migration: adds user_id to any existing Stage 3 table
  await pool.query(
    `ALTER TABLE notes ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT 'legacy'`
  );

  console.log('Schema ready');

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

start().catch((err) => { console.error(err); process.exit(1); });
