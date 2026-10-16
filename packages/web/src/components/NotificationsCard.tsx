import { useEffect, useState } from 'react';
import { api, type Session } from '../lib/api';
import { PUSH_WORDS, pushState, turnPushOff, turnPushOn, type PushState } from '../lib/push';

/**
 * Notifications, on My account (15 Oct 2026): push on this device, and for an
 * admin whether Needs a decision also comes by email.
 */
export default function NotificationsCard({ session }: { session: Session }) {
  const [state, setState] = useState<PushState | null>(null);
  const [emails, setEmails] = useState<{ decision_emails: boolean; email: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const admin = session.role === 'admin';

  useEffect(() => {
    pushState().then(setState).catch(() => setState('unsupported'));
    if (admin) api.get<{ decision_emails: boolean; email: string }>('/api/me/alerts').then(setEmails).catch(() => {});
  }, [admin]);

  async function go(fn: () => Promise<void>) {
    setBusy(true); setError(null); setMsg(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'That did not work'); } finally { setBusy(false); }
  }

  const what = session.role === 'driver'
    ? 'changes to your load'
    : admin ? 'new online orders, and everything that lands in Needs a decision' : 'new online orders';

  return (
    <div className="panel" style={{ maxWidth: 560 }}>
      <h2 style={{ marginTop: 0 }}>Notifications</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        A message on this phone or computer, even with Alka Vida closed, for {what}.
      </p>
      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}
      {state && (
        <div className="switch-row">
          <div>
            <strong>On this device</strong>
            <div className="small muted">{PUSH_WORDS[state]}</div>
          </div>
          {(state === 'on' || state === 'off') && (
            <button type="button" role="switch" aria-checked={state === 'on'} aria-label="Notifications on this device"
                    className={`switch${state === 'on' ? ' on' : ''}`} disabled={busy}
                    onClick={() => go(async () => {
                      const next = state === 'on' ? await turnPushOff() : await turnPushOn();
                      setState(next);
                      if (next === 'on') {
                        await api.post('/api/push/test', {});
                        setMsg('Turned on. A test notification is on its way.');
                      } else if (next !== 'off' || state === 'on') setMsg(next === 'off' ? 'Turned off on this device.' : PUSH_WORDS[next]);
                    })}><span /></button>
          )}
        </div>
      )}
      {state === 'on' && (
        <button type="button" className="as-link small" disabled={busy}
                onClick={() => go(async () => { await api.post('/api/push/test', {}); setMsg('Test sent.'); })}>
          Send me a test
        </button>
      )}
      {admin && emails && (
        <div className="switch-row" style={{ marginTop: 14 }}>
          <div>
            <strong>Email me about Needs a decision</strong>
            <div className="small muted">{emails.email ? `To ${emails.email}` : 'Your login has no email address.'}</div>
          </div>
          <button type="button" role="switch" aria-checked={emails.decision_emails} aria-label="Email me about Needs a decision"
                  className={`switch${emails.decision_emails ? ' on' : ''}`} disabled={busy}
                  onClick={() => go(async () => {
                    await api.patch('/api/me/alerts', { decisionEmails: !emails.decision_emails });
                    setEmails({ ...emails, decision_emails: !emails.decision_emails });
                  })}><span /></button>
        </div>
      )}
    </div>
  );
}

/**
 * A one-line nudge on the Today screen until notifications are on for this
 * device (or the person says not now). Remembered per browser only.
 */
export function NotifyPrompt({ session }: { session: Session }) {
  const [state, setState] = useState<PushState | null>(null);
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem('av-notify-prompt') === 'no'; } catch { return false; }
  });
  const [busy, setBusy] = useState(false);
  useEffect(() => { pushState().then(setState).catch(() => setState('unsupported')); }, []);
  if (hidden || session.role === 'customer' || (state !== 'off' && state !== 'needs-homescreen')) return null;
  const dismiss = () => { setHidden(true); try { localStorage.setItem('av-notify-prompt', 'no'); } catch { /* fine */ } };
  return (
    <div className="notice info notify-prompt">
      <span>
        <strong>Get new orders{session.role === 'admin' ? ' and decisions' : ''} on this {/(iPhone|Android)/.test(navigator.userAgent) ? 'phone' : 'device'}.</strong>{' '}
        {state === 'needs-homescreen' ? PUSH_WORDS['needs-homescreen'] : 'A notification arrives even with Alka Vida closed.'}
      </span>
      <span className="notify-prompt-actions">
        {state === 'off' && (
          <button type="button" disabled={busy} onClick={async () => {
            setBusy(true);
            try {
              const next = await turnPushOn();
              setState(next);
              if (next === 'on') await api.post('/api/push/test', {}).catch(() => {});
            } finally { setBusy(false); }
          }}>Turn on notifications</button>
        )}
        <button type="button" className="as-link small" onClick={dismiss}>Not now</button>
      </span>
    </div>
  );
}
