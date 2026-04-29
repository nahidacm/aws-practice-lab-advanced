import { useState, useEffect, useRef } from 'react';
import { getIdToken, signOut } from './auth';
import AuthScreen from './AuthScreen';

// ---- Icons (inline SVG to avoid extra deps) ----

function Icon({ d, size = 16, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      {d}
    </svg>
  );
}

const NoteIcon = () => <Icon size={14} d={<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></>} stroke="white" strokeWidth="2.5" />;
const PlusIcon  = () => <Icon size={15} d={<><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></>} strokeWidth="2.5" />;
const TrashIcon = () => <Icon size={14} d={<><polyline points="3 6 5 6 21 6"/><path d="m19 6-.867 12.142A2 2 0 0 1 16.138 20H7.862a2 2 0 0 1-1.995-1.858L5 6m5 0V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2"/></>} />;
const CloseIcon = () => <Icon size={16} d={<><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></>} strokeWidth="2.5" />;

// ---- Helpers ----

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Decode the email claim from an ID token without verifying (display only — backend verifies)
function parseJwtEmail(token) {
  try { return JSON.parse(atob(token.split('.')[1])).email ?? ''; }
  catch { return ''; }
}

// ---- NoteCard ----

function NoteCard({ note, onDelete }) {
  const [pending, setPending] = useState(false);
  const timer = useRef(null);

  function handleDeleteClick() {
    if (pending) {
      clearTimeout(timer.current);
      onDelete(note.id);
    } else {
      setPending(true);
      timer.current = setTimeout(() => setPending(false), 2500);
    }
  }

  return (
    <article className="group relative bg-white rounded-2xl border border-gray-100 shadow-sm p-5
      flex flex-col gap-3 hover:shadow-md hover:border-indigo-100 transition-all duration-200 animate-slide-up">

      <button
        onClick={handleDeleteClick}
        title={pending ? 'Click again to confirm' : 'Delete note'}
        className={`absolute top-3.5 right-3.5 p-1.5 rounded-lg transition-all duration-150
          ${pending
            ? 'text-red-600 bg-red-50 opacity-100 scale-110'
            : 'text-gray-300 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100'
          }`}
      >
        <TrashIcon />
      </button>

      <h3 className="font-semibold text-gray-900 text-sm pr-7 leading-snug">{note.title}</h3>
      <p className="text-gray-500 text-sm leading-relaxed line-clamp-4 flex-1">{note.content}</p>

      <footer className="flex items-center justify-between text-xs pt-2 border-t border-gray-50 mt-auto">
        <span className="font-medium text-indigo-500 truncate max-w-[120px]">{note.createdBy}</span>
        <span className="text-gray-400">{timeAgo(note.createdAt)}</span>
      </footer>
    </article>
  );
}

// ---- Create Note Modal ----

function CreateModal({ onCreated, onClose, authFetch }) {
  const [form, setForm] = useState({ title: '', content: '' });
  const [saving, setSaving] = useState(false);
  const titleRef = useRef(null);

  useEffect(() => { titleRef.current?.focus(); }, []);

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.title.trim() || !form.content.trim()) return;
    setSaving(true);
    const res = await authFetch(`${API_BASE}/api/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    if (res) {
      const note = await res.json();
      onCreated(note);
      onClose();
    }
  }

  const inputCls = 'w-full px-3.5 py-2.5 border border-gray-200 rounded-xl text-sm ' +
    'focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-transparent ' +
    'placeholder:text-gray-400 transition-shadow';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-white rounded-2xl shadow-2xl p-6 flex flex-col gap-4 animate-slide-up"
      >
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-gray-900">New Note</h2>
          <button type="button" onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors">
            <CloseIcon />
          </button>
        </div>

        <input ref={titleRef} type="text" placeholder="Title" required
          value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
          className={inputCls} />

        <textarea placeholder="What's on your mind?" required rows={5}
          value={form.content} onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
          className={`${inputCls} resize-none`} />

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose}
            className="flex-1 py-2.5 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-xl transition-colors">
            Cancel
          </button>
          <button type="submit" disabled={saving}
            className="flex-1 py-2.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 rounded-xl transition-colors">
            {saving ? 'Saving…' : 'Save Note'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---- Empty State ----

function EmptyState({ onNew }) {
  return (
    <div className="flex flex-col items-center justify-center py-28 gap-4 text-center">
      <div className="w-16 h-16 bg-indigo-50 rounded-2xl flex items-center justify-center">
        <Icon size={28} stroke="#a5b4fc" strokeWidth="1.5"
          d={<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></>}
        />
      </div>
      <div>
        <p className="font-medium text-gray-700">No notes yet</p>
        <p className="text-sm text-gray-400 mt-1">Create the first note for your team</p>
      </div>
      <button onClick={onNew}
        className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-xl transition-colors">
        <PlusIcon /> New Note
      </button>
    </div>
  );
}

// ---- Loading Dots ----

function LoadingDots() {
  return (
    <div className="flex items-center justify-center py-24 gap-1.5">
      {[0, 1, 2].map((i) => (
        <div key={i} className="w-2 h-2 bg-indigo-300 rounded-full animate-bounce"
          style={{ animationDelay: `${i * 0.15}s` }} />
      ))}
    </div>
  );
}

// ---- App ----

// In production (S3 + CloudFront) the frontend and API live on different origins.
// Set VITE_API_URL at build time to the ALB URL or custom API domain.
// In local dev the Vite proxy forwards /api to localhost:3000, so API_BASE stays empty.
const API_BASE = import.meta.env.VITE_API_URL ?? '';

export default function App() {
  const [notes, setNotes]         = useState([]);
  const [loading, setLoading]     = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  // null = checking session, '' = signed out, string = valid ID token
  const [token, setToken]         = useState(null);

  const userEmail = token ? parseJwtEmail(token) : '';

  // Check for an existing Cognito session once on mount
  useEffect(() => {
    getIdToken().then((tok) => setToken(tok ?? ''));
  }, []);

  // Fetch wrapper — attaches Authorization header, handles expired sessions
  async function authFetch(url, options = {}) {
    const tok = await getIdToken();
    if (!tok) { setToken(''); return null; }
    return fetch(url, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${tok}` },
    });
  }

  // Load the user's notes whenever they sign in (token changes from '' to a real value)
  useEffect(() => {
    if (!token) return;
    setLoading(true);
    authFetch(`${API_BASE}/api/notes`)
      .then((r) => r?.json())
      .then((data) => { if (data) { setNotes(data); setLoading(false); } });
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleCreated(note) { setNotes((prev) => [note, ...prev]); }

  async function handleDelete(id) {
    await authFetch(`${API_BASE}/api/notes/${id}`, { method: 'DELETE' });
    setNotes((prev) => prev.filter((n) => n.id !== id));
  }

  function handleSignOut() {
    signOut();
    setToken('');
    setNotes([]);
  }

  // Checking existing session
  if (token === null) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <LoadingDots />
      </div>
    );
  }

  // Not authenticated
  if (!token) {
    return <AuthScreen onSuccess={() => getIdToken().then((tok) => setToken(tok ?? ''))} />;
  }

  return (
    <div className="min-h-screen bg-slate-50 font-sans">

      {/* ── Header ── */}
      <header className="bg-white border-b border-gray-100 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">

          {/* Logo + name + count */}
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 bg-indigo-600 rounded-lg flex items-center justify-center shrink-0">
              <NoteIcon />
            </div>
            <span className="font-semibold text-gray-900 text-[15px]">Team Notes Pro</span>
            {!loading && (
              <span className="hidden sm:inline text-xs font-medium text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                {notes.length} {notes.length === 1 ? 'note' : 'notes'}
              </span>
            )}
          </div>

          {/* User info + actions */}
          <div className="flex items-center gap-3">
            <span className="hidden sm:block text-xs text-gray-400 truncate max-w-[160px]">
              {userEmail}
            </span>
            <button onClick={handleSignOut}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors px-2 py-1 rounded-lg hover:bg-gray-100">
              Sign out
            </button>
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 text-white text-sm font-medium
                rounded-xl hover:bg-indigo-700 active:scale-95 transition-all"
            >
              <PlusIcon />
              <span>New Note</span>
            </button>
          </div>
        </div>
      </header>

      {/* ── Main ── */}
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        {loading ? (
          <LoadingDots />
        ) : notes.length === 0 ? (
          <EmptyState onNew={() => setShowCreate(true)} />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {notes.map((note) => (
              <NoteCard key={note.id} note={note} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </main>

      {/* ── Modal ── */}
      {showCreate && (
        <CreateModal
          onCreated={handleCreated}
          onClose={() => setShowCreate(false)}
          authFetch={authFetch}
        />
      )}
    </div>
  );
}
