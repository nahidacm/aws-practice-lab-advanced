const express = require('express');
const path = require('path');
const cors = require('cors');
const { createPool } = require('./db');

const app = express();

// Stage 3: allow the CloudFront-hosted frontend (different origin) to call this API.
// Set CORS_ORIGIN to your CloudFront / custom domain in production.
// Falls back to localhost:5173 for Vite dev server when running outside Docker.
app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(',') ?? ['http://localhost:5173'],
  methods: ['GET', 'POST', 'DELETE'],
}));

app.use(express.json());

let pool;

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

// --- Health ---
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// --- Notes API ---
app.get('/api/notes', wrap(async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM notes ORDER BY created_at DESC');
  res.json(rows.map(toNote));
}));

app.post('/api/notes', wrap(async (req, res) => {
  const { title, content, createdBy } = req.body;
  if (!title?.trim() || !content?.trim()) {
    return res.status(400).json({ error: 'title and content are required' });
  }
  const { rows } = await pool.query(
    'INSERT INTO notes (title, content, created_by) VALUES ($1, $2, $3) RETURNING *',
    [title.trim(), content.trim(), createdBy?.trim() || 'Anonymous']
  );
  res.status(201).json(toNote(rows[0]));
}));

app.delete('/api/notes/:id', wrap(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM notes WHERE id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: 'note not found' });
  res.status(204).send();
}));

// Serve React build for local dev only — in production CloudFront serves S3 directly.
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

async function start() {
  pool = await createPool();

  // Bootstrap schema — safe to run on every startup
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notes (
      id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      title      TEXT        NOT NULL,
      content    TEXT        NOT NULL,
      created_by TEXT        NOT NULL DEFAULT 'Anonymous',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  console.log('Schema ready');

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

start().catch((err) => { console.error(err); process.exit(1); });
