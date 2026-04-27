const express = require('express');
const { randomUUID } = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());

// In-memory store — replaced by RDS in Stage 2
const notes = [];

// --- Health ---
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// --- Notes API ---
app.get('/api/notes', (_req, res) => {
  res.json(notes);
});

app.post('/api/notes', (req, res) => {
  const { title, content, createdBy } = req.body;
  if (!title?.trim() || !content?.trim()) {
    return res.status(400).json({ error: 'title and content are required' });
  }
  const note = {
    id: randomUUID(),
    title: title.trim(),
    content: content.trim(),
    createdBy: createdBy?.trim() || 'Anonymous',
    createdAt: new Date().toISOString(),
  };
  notes.unshift(note);
  res.status(201).json(note);
});

app.delete('/api/notes/:id', (req, res) => {
  const index = notes.findIndex((n) => n.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'note not found' });
  notes.splice(index, 1);
  res.status(204).send();
});

// Serve React build in production
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
