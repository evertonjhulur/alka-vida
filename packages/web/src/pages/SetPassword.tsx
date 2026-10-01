import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';

/**
 * Choosing a password from an invitation link. Public - somebody arriving
 * here has no way into their account yet, which is the entire point.
 *
 * The page never explains WHY a link is not valid. Expired, already used and
 * never existed all read the same, because the difference between them is
 * only useful to somebody working through tokens.
 */
export default function SetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [invitee, setInvitee] = useState<{ name: string; email: string; purpose?: string } | null>(null);
  const [checking, setChecking] = useState(true);
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ invitee: { name: string; email: string; purpose?: string } | null }>(
      `/api/invitations/${encodeURIComponent(token)}`,
    )
      .then((r) => setInvitee(r.invitee))
      .catch(() => setInvitee(null))
      .finally(() => setChecking(false));
  }, [token]);

  const mismatch = again.length > 0 && next !== again;
  const ready = next.length >= 8 && next === again;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post(`/api/invitations/${encodeURIComponent(token)}/accept`, { password: next });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set your password');
    } finally { setBusy(false); }
  }

  if (checking) {
    return (
      <div className="login-page">
        <div className="panel" style={{ maxWidth: 460 }}><p className="muted">Checking…</p></div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="login-page">
        <div className="panel" style={{ maxWidth: 460 }}>
          <h1>You are all set</h1>
          <p>Your password is saved. Sign in with it and your email address.</p>
          <Link to="/">Go to sign in</Link>
        </div>
      </div>
    );
  }

  if (!invitee) {
    return (
      <div className="login-page">
        <div className="panel" style={{ maxWidth: 460 }}>
          <h1>This link is not valid</h1>
          <p className="muted">
            It may have been used already, or it may have expired. Use
            {' '}<strong>Forgotten your password?</strong> on the sign-in page to get a new one.
          </p>
          <Link to="/">Back to sign in</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="panel" style={{ maxWidth: 460 }}>
        <h1>{invitee.purpose === 'reset' ? `New password, ${invitee.name}` : `Welcome, ${invitee.name}`}</h1>
        <p className="muted">
          Choose {invitee.purpose === 'reset' ? 'a new' : 'a'} password for <strong>{invitee.email}</strong>. Only you will
          know it — nobody at Alka Vida can see it.
        </p>

        {error && <div className="notice error">{error}</div>}

        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="np">Password</label>
            <input id="np" type="password" required value={next} style={{ width: '100%' }}
                   placeholder="at least 8 characters"
                   onChange={(e) => setNext(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="na">Password again</label>
            <input id="na" type="password" required value={again} style={{ width: '100%' }}
                   onChange={(e) => setAgain(e.target.value)} />
          </div>
          {mismatch && <p className="muted small">The two passwords do not match yet.</p>}
          <button disabled={busy || !ready}>
            {busy ? 'Saving…' : 'Save my password'}
          </button>
        </form>
      </div>
    </div>
  );
}
