import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, type Session } from '../lib/api';
import Logo from '../components/Logo';
import GoogleButton, { useGoogleEnabled } from '../components/GoogleButton';
import { takeIdleSignedOut } from '../lib/idle';

/**
 * Sign in (approved design, 31 Oct 2026): one card in the middle of the page,
 * like the reference Everton sent - "Continue with Google", OR, email and
 * password with icons, Forgot password, Log in, and "Don't have an account?
 * Create one". Google's button only shows once GOOGLE_CLIENT_ID is set.
 */

const MailIcon = () => (
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="2" /><path d="m4 7 8 6 8-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg>
);
const LockIcon = () => (
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
);
export const EyeIcon = ({ off }: { off?: boolean }) => (
  <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" strokeWidth="2" /><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2" />{off && <path d="M4 4l16 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}</svg>
);

/** Signed in some other way than api.login: start the idle clock the same way. */
export function startedSession(s: Session, onSignedIn: (s: Session) => void) {
  try { localStorage.setItem('alkavida.lastActive', String(Date.now())); } catch { /* ignore */ }
  onSignedIn(s);
}

export default function Login({ onSignedIn }: { onSignedIn: (s: Session) => void }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const google = useGoogleEnabled();
  // "Forgotten your password?" on the website comes here with ?forgot=1.
  const [forgot, setForgot] = useState(new URLSearchParams(useLocation().search).get('forgot') === '1');
  const [resetSent, setResetSent] = useState(false);
  // Signed out for being idle (28 Oct 2026): say so, once.
  const [idleOut] = useState(takeIdleSignedOut);

  /** "Forgotten your password?": a reset link by email, never a yes/no on the address. */
  async function sendReset(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/api/auth/forgot-password', { email });
      setResetSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the link');
    } finally { setBusy(false); }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const out = await api.post<{ session: Session }>('/api/auth/login', { email, password, remember });
      startedSession(out.session, onSignedIn);
    } catch (err) {
      const m = err instanceof Error ? err.message : '';
      setError(/invalid email or password/i.test(m)
        ? 'That email and password do not match. Check them and try again.'
        : m || 'Sign in failed');
    } finally {
      setBusy(false);
    }
  }

  /** Google said who they are: signed in, or on to opening an account. */
  async function withGoogle(credential: string) {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ session?: Session; needsDetails?: boolean; profile?: { email: string; firstName: string; lastName: string } }>(
        '/api/auth/google', { credential, remember });
      if (r.session) startedSession(r.session, onSignedIn);
      else navigate('/register', { state: { google: { credential, profile: r.profile } } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in did not work');
    } finally { setBusy(false); }
  }

  return (
    <div className="auth-page">
      <div className="auth-top"><Link to="/">‹ Back to alkavidaja.com</Link></div>
      <main className="auth-col">
        <Link to="/" className="auth-logo" aria-label="Alka Vida home"><Logo height={84} /></Link>

        {forgot ? (
          <>
            <h1 className="auth-h1">Reset your password</h1>
            <p className="auth-sub">We'll email you a link to choose a new one.</p>
            <form className="auth-card" onSubmit={sendReset}>
              {error && <div className="notice error">{error}</div>}
              {resetSent ? (
                <div className="notice ok">
                  If <strong>{email}</strong> has an Alka Vida login, a link to choose a new
                  password is on its way. It works once, for 24 hours. Check your spam folder
                  if it does not arrive in a few minutes.
                </div>
              ) : (
                <>
                  <div className="auth-field">
                    <label htmlFor="remail">Email</label>
                    <div className="auth-input"><MailIcon />
                      <input id="remail" type="email" autoComplete="username" placeholder="you@example.com" value={email} required
                             onChange={(e) => setEmail(e.target.value)} /></div>
                  </div>
                  <button className="auth-submit" disabled={busy}>{busy ? 'Sending…' : 'Email me a link'}</button>
                  <p className="small muted" style={{ margin: 0 }}>Signed up with Google? You don't need a password: use Continue with Google instead.</p>
                </>
              )}
            </form>
            <button type="button" className="as-link auth-back" onClick={() => { setForgot(false); setResetSent(false); setError(null); }}>
              ‹ Back to sign in
            </button>
          </>
        ) : (
          <>
            <h1 className="auth-h1">Welcome back</h1>
            <p className="auth-sub">Sign in to your account</p>
            <form className="auth-card" onSubmit={submit}>
              {idleOut && !error && (
                <div className="notice info">You were signed out after 15 minutes without activity. Sign in to carry on where you were.</div>
              )}
              {error && <div className="notice error" role="alert">{error}</div>}
              {google && <>
                <GoogleButton onCredential={withGoogle} />
                <div className="auth-or" role="separator" aria-label="or"><span />OR<span /></div>
              </>}
              <div className="auth-field">
                <label htmlFor="email">Email</label>
                <div className="auth-input"><MailIcon />
                  <input id="email" type="email" autoComplete="username" placeholder="you@example.com" value={email} required
                         onChange={(e) => setEmail(e.target.value)} /></div>
              </div>
              <div className="auth-field">
                <div className="auth-label-row">
                  <label htmlFor="password">Password</label>
                  <button type="button" className="as-link small" onClick={() => { setForgot(true); setError(null); }}>Forgot password?</button>
                </div>
                <div className="auth-input"><LockIcon />
                  <input id="password" type={show ? 'text' : 'password'} autoComplete="current-password" value={password} required
                         onChange={(e) => setPassword(e.target.value)} />
                  <button type="button" className="auth-eye" aria-label={show ? 'Hide password' : 'Show password'} onClick={() => setShow(!show)}><EyeIcon off={show} /></button>
                </div>
              </div>
              <label className="auth-check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Keep me signed in on this device</label>
              <button className="auth-submit" disabled={busy}>{busy ? 'Signing in…' : 'Log in'}</button>
            </form>
            <p className="auth-foot">Don't have an account? <Link to="/register"><b>Create one</b></Link></p>
            <p className="auth-note">Office staff and drivers: sign in with the email the office set up for you.</p>
          </>
        )}
      </main>
    </div>
  );
}
