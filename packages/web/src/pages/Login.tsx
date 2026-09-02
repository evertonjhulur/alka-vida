import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Session } from '../lib/api';

export default function Login({ onSignedIn }: { onSignedIn: (s: Session) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await api.login(email, password));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>Alka Vida</h1>
        <p className="subtitle">1506 Investments Limited</p>
        {error && <div className="notice error">{error}</div>}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} required
                 style={{ width: '100%' }}
                 onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" value={password} required
                 style={{ width: '100%' }}
                 onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="small" style={{ marginTop: 12 }}>
          New customer? <Link to="/register">Open an account</Link>
        </p>
        <div className="login-hint">
          Seeded accounts:<br />
          admin@alkavida.jm / admin1234<br />
          office@alkavida.jm / office1234<br />
          driver@alkavida.jm / driver1234<br />
          ap@bluemountain.jm / portal1234
        </div>
      </form>
    </div>
  );
}
