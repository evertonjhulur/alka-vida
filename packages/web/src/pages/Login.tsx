import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Session } from '../lib/api';
import Logo from '../components/Logo';

/**
 * Sign in (approved mockup, 29 Sep 2026): the logo on white on the left, the
 * form on the indigo from the logo on the right. The seeded passwords that
 * used to be printed under the form are gone; they are shown in the window
 * that opens when Alka Vida starts, which only the person at the computer
 * sees.
 */
export default function Login({ onSignedIn }: { onSignedIn: (s: Session) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [resetSent, setResetSent] = useState(false);

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
      onSignedIn(await api.login(email, password));
    } catch (err) {
      const m = err instanceof Error ? err.message : '';
      setError(/invalid email or password/i.test(m)
        ? 'That email and password do not match. Check them and try again.'
        : m || 'Sign in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <section className="signin-brand">
        <Logo height={150} className="signin-logo" />
        <div className="signin-line">Orders, rounds and money, in one place.</div>
        <div className="signin-sub">
          For the Alka Vida office, drivers and customers of 1506 Investments Limited, Kingston.
        </div>
        <svg className="signin-waves" aria-hidden="true" viewBox="0 0 640 120" preserveAspectRatio="none">
          <path d="M-10 70 q60 -34 120 0 t120 0 t120 0 t120 0 t120 0 t120 0" fill="none" stroke="#afe0e5" strokeWidth="14" strokeLinecap="round" />
          <path d="M-10 100 q60 -34 120 0 t120 0 t120 0 t120 0 t120 0 t120 0" fill="none" stroke="#0ab0da" strokeWidth="14" strokeLinecap="round" />
        </svg>
      </section>

      <section className="signin-side">
        {forgot ? (
          <form className="login-card" onSubmit={sendReset}>
            <h1>Reset your password</h1>
            {error && <div className="notice error">{error}</div>}
            {resetSent ? (
              <div className="notice ok">
                If <strong>{email}</strong> has an Alka Vida login, a link to choose a new
                password is on its way. It works once, for 24 hours. Check your spam folder
                if it does not arrive in a few minutes.
              </div>
            ) : (
              <>
                <p className="muted small" style={{ marginTop: 0 }}>
                  Enter the email you sign in with and we will email you a link to choose a new password.
                </p>
                <div className="field">
                  <label htmlFor="remail">Email</label>
                  <input id="remail" type="email" autoComplete="username" value={email} required
                         style={{ width: '100%' }} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <button disabled={busy}>{busy ? 'Sending…' : 'Email me a link'}</button>
              </>
            )}
            <p className="small" style={{ margin: '12px 0 0' }}>
              <button type="button" className="as-link" onClick={() => { setForgot(false); setResetSent(false); setError(null); }}>
                ‹ Back to sign in
              </button>
            </p>
          </form>
        ) : (
        <form className="login-card" onSubmit={submit}>
          <h1>Sign in</h1>
          {error && <div className="notice error">{error}</div>}
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" autoComplete="username" value={email} required
                   style={{ width: '100%' }} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input id="password" type="password" autoComplete="current-password" value={password} required
                   style={{ width: '100%' }} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <p className="small" style={{ margin: '12px 0 0' }}>
            <button type="button" className="as-link" onClick={() => { setForgot(true); setError(null); }}>
              Forgotten your password?
            </button>
          </p>
          <div className="signin-foot">
            Buying water for a business or home? <Link to="/register">Open an account</Link>
          </div>
        </form>
        )}
      </section>
    </div>
  );
}
