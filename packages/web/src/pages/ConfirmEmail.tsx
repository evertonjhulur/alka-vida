import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import Logo from '../components/Logo';

/** The link in "Confirm your email" (31 Oct 2026). The account works either way. */
export default function ConfirmEmail() {
  const token = new URLSearchParams(useLocation().search).get('token') ?? '';
  const [state, setState] = useState<'checking' | 'ok' | 'bad'>('checking');
  useEffect(() => {
    api.post<{ confirmed: boolean }>('/api/auth/confirm-email', { token })
      .then((r) => setState(r.confirmed ? 'ok' : 'bad')).catch(() => setState('bad'));
  }, [token]);
  return (
    <div className="auth-page">
      <div className="auth-top"><Link to="/">‹ Back to alkavidaja.com</Link></div>
      <main className="auth-col">
        <Link to="/" className="auth-logo" aria-label="Alka Vida home"><Logo height={84} /></Link>
        <div className="auth-card center">
          {state === 'checking' && <p>Confirming your email…</p>}
          {state === 'ok' && <>
            <h1 className="auth-h1">Thank you</h1>
            <p>Your email is confirmed, so your receipts and invoices will reach you.</p>
            <Link to="/sign-in" className="auth-submit">Sign in</Link>
          </>}
          {state === 'bad' && <>
            <h1 className="auth-h1">This link has been used</h1>
            <p>It may already have been clicked, which is fine: your account works either way.</p>
            <Link to="/sign-in" className="auth-submit">Sign in</Link>
          </>}
        </div>
      </main>
    </div>
  );
}
