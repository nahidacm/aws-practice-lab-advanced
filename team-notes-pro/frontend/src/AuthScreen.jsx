import { useState } from 'react';
import { signIn, signUp, confirmSignUp } from './auth';

function NoteIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="16" y1="13" x2="8" y2="13"/>
      <line x1="16" y1="17" x2="8" y2="17"/>
    </svg>
  );
}

function friendlyError(err) {
  const msg = err?.message ?? String(err);
  if (msg.includes('UserNotConfirmedException')) return 'Please confirm your email before signing in.';
  if (msg.includes('NotAuthorizedException'))    return 'Incorrect email or password.';
  if (msg.includes('UsernameExistsException'))   return 'An account with this email already exists.';
  if (msg.includes('InvalidPasswordException'))  return 'Password must be at least 8 characters.';
  if (msg.includes('CodeMismatchException'))     return 'Incorrect confirmation code.';
  if (msg.includes('ExpiredCodeException'))      return 'Code expired — please sign up again.';
  return msg;
}

export default function AuthScreen({ onSuccess }) {
  const [tab, setTab]           = useState('signin'); // 'signin' | 'signup' | 'confirm'
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode]         = useState('');
  const [error, setError]       = useState('');
  const [busy, setBusy]         = useState(false);

  function switchTab(t) { setTab(t); setError(''); }

  async function run(fn) {
    setBusy(true); setError('');
    try { await fn(); } catch (err) { setError(friendlyError(err)); }
    finally { setBusy(false); }
  }

  const inputCls =
    'w-full px-3.5 py-2.5 border border-gray-200 rounded-xl text-sm ' +
    'focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-transparent ' +
    'placeholder:text-gray-400 transition-shadow';

  const btnCls =
    'w-full py-2.5 mt-1 text-sm font-medium text-white bg-indigo-600 ' +
    'hover:bg-indigo-700 disabled:opacity-60 rounded-xl transition-colors';

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">

        <div className="flex items-center justify-center gap-2.5 mb-8">
          <div className="w-9 h-9 bg-indigo-600 rounded-xl flex items-center justify-center">
            <NoteIcon />
          </div>
          <span className="font-bold text-gray-900 text-lg">Team Notes Pro</span>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">

          {tab === 'confirm' ? (
            <form onSubmit={(e) => { e.preventDefault(); run(async () => {
              await confirmSignUp(email, code);
              await signIn(email, password);
              onSuccess();
            }); }} className="flex flex-col gap-4">

              <div>
                <h2 className="font-semibold text-gray-900">Check your email</h2>
                <p className="text-sm text-gray-500 mt-1">
                  We sent a 6-digit code to{' '}
                  <span className="font-medium text-gray-700">{email}</span>
                </p>
              </div>

              <input type="text" inputMode="numeric" placeholder="6-digit code"
                required autoFocus value={code} onChange={(e) => setCode(e.target.value)}
                className={inputCls} />

              {error && <p className="text-sm text-red-600">{error}</p>}

              <button type="submit" disabled={busy} className={btnCls}>
                {busy ? 'Verifying…' : 'Confirm email'}
              </button>
              <button type="button" onClick={() => switchTab('signup')}
                className="text-sm text-center text-gray-400 hover:text-gray-600 transition-colors">
                ← Back
              </button>
            </form>

          ) : (
            <>
              <div className="flex gap-1 bg-gray-100 rounded-xl p-1 mb-5">
                {['signin', 'signup'].map((t) => (
                  <button key={t} type="button" onClick={() => switchTab(t)}
                    className={`flex-1 py-1.5 text-sm font-medium rounded-lg transition-all ${
                      tab === t
                        ? 'bg-white text-gray-900 shadow-sm'
                        : 'text-gray-500 hover:text-gray-700'
                    }`}>
                    {t === 'signin' ? 'Sign in' : 'Sign up'}
                  </button>
                ))}
              </div>

              <form className="flex flex-col gap-3"
                onSubmit={(e) => { e.preventDefault(); run(async () => {
                  if (tab === 'signin') {
                    await signIn(email, password);
                    onSuccess();
                  } else {
                    await signUp(email, password);
                    setTab('confirm');
                  }
                }); }}>

                <input type="email" placeholder="Email" required autoComplete="email"
                  value={email} onChange={(e) => setEmail(e.target.value)}
                  className={inputCls} />

                <input type="password" placeholder="Password" required
                  autoComplete={tab === 'signin' ? 'current-password' : 'new-password'}
                  value={password} onChange={(e) => setPassword(e.target.value)}
                  className={inputCls} />

                {error && <p className="text-sm text-red-600">{error}</p>}

                <button type="submit" disabled={busy} className={btnCls}>
                  {busy ? '…' : tab === 'signin' ? 'Sign in' : 'Create account'}
                </button>
              </form>
            </>
          )}
        </div>

        {tab !== 'confirm' && (
          <p className="text-xs text-center text-gray-400 mt-4">
            {tab === 'signin' ? "Don't have an account? " : 'Already have an account? '}
            <button onClick={() => switchTab(tab === 'signin' ? 'signup' : 'signin')}
              className="text-indigo-600 hover:underline font-medium">
              {tab === 'signin' ? 'Sign up' : 'Sign in'}
            </button>
          </p>
        )}

      </div>
    </div>
  );
}
