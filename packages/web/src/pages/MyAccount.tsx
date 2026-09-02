import { useState } from 'react';
import { api, type Session } from '../lib/api';

const ROLE_LABEL: Record<string, string> = {
  admin: 'Administrator',
  user: 'Office staff',
  driver: 'Driver',
  customer: 'Customer portal',
};

/**
 * Everybody's own account. The only part of user administration that is not
 * restricted to an administrator, because a password nobody can change but
 * the boss is a password that never changes.
 */
export default function MyAccount({ session }: { session: Session }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mismatch = again.length > 0 && next !== again;
  const ready = current.length > 0 && next.length >= 8 && next === again;

  async function change(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setMsg(null);
    try {
      await api.post('/api/auth/change-password', {
        currentPassword: current, newPassword: next,
      });
      setMsg('Your password has been changed. It applies the next time you sign in.');
      setCurrent(''); setNext(''); setAgain('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change your password');
    } finally { setBusy(false); }
  }

  return (
    <>
      <h1>My account</h1>
      <p className="subtitle">Your own sign-in details.</p>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      <div className="panel">
        <div className="muted small">Signed in as</div>
        <h2 style={{ margin: '2px 0' }}>{session.name}</h2>
        <p className="muted small" style={{ margin: 0 }}>
          {ROLE_LABEL[session.role] ?? session.role}
        </p>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Change my password</h2>
        <p className="muted small">
          Your current password is needed as well, so that a browser left signed in
          is not enough for somebody to take your account over.
        </p>
        <form onSubmit={change}>
          <div className="row">
            <div className="field">
              <label htmlFor="cp">Current password</label>
              <input id="cp" type="password" required value={current}
                     onChange={(e) => setCurrent(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="np">New password</label>
              <input id="np" type="password" required value={next}
                     placeholder="at least 8 characters"
                     onChange={(e) => setNext(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="na">New password again</label>
              <input id="na" type="password" required value={again}
                     onChange={(e) => setAgain(e.target.value)} />
            </div>
            <div className="field">
              <button disabled={busy || !ready}>Change password</button>
            </div>
          </div>
          {mismatch && (
            <p className="muted small" style={{ margin: 0 }}>
              The two new passwords do not match yet.
            </p>
          )}
        </form>
      </div>
    </>
  );
}
