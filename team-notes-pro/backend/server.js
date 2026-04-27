const express = require('express');
const path = require('path');
const { createPool } = require('./db');

const app = express();
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

// Serve React build in production
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
