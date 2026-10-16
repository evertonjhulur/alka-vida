import { useEffect, useState } from 'react';
import { api, type Session } from '../lib/api';
import { PUSH_WORDS, currentEndpoint, pushState, turnPushOff, turnPushOn, type PushState } from '../lib/push';
import { ask } from './Dialog';

/** What the server keeps about who gets what (15 Oct 2026). */
export interface AlertSettings {
  userId: string; name: string; email: string; role: string; active: boolean;
  orders: boolean; decisions: boolean; decisionEmails: boolean; load: boolean;
  quietFrom: string | null; quietTo: string | null; devices: number;
}
export interface Device { id: string; device: string | null; created_at: string; last_ok_at: string | null; last_error: string | null; endpoint: string }

/** The kinds of notification, and which roles can have each. */
export const KINDS: Array<{ key: 'orders' | 'decisions' | 'decisionEmails' | 'load'; label: string; hint: string; roles: string[] }> = [
  { key: 'orders', label: 'New online orders', hint: 'a customer places an order on the portal', roles: ['admin', 'user'] },
  { key: 'decisions', label: 'Needs a decision', hint: 'a notification when something waits for an administrator', roles: ['admin'] },
  { key: 'decisionEmails', label: 'Needs a decision, by email', hint: 'the same, as an email', roles: ['admin'] },
  { key: 'load', label: 'Changes to my load', hint: 'something added to the truck after you confirmed it', roles: ['driver'] },
];

const dayTime = (ts: string | null) => (ts
  ? new Date(ts).toLocaleString('en-JM', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Jamaica' })
  : '—');

/** The list of someone's devices, with Remove. Plain function, not a component. */
export function devicesList(list: Device[], here: string | null, busy: boolean, remove: (d: Device) => void) {
  if (list.length === 0) return <p className="muted small" style={{ margin: '4px 0 0' }}>No devices have notifications turned on.</p>;
  return (
    <ul className="device-list">
      {list.map((d) => (
        <li key={d.id}>
          <span>
            <strong>{d.device || 'A device'}</strong>{here === d.endpoint && <span className="chip info" style={{ marginLeft: 6 }}>this device</span>}
            <span className="muted small"> · added {dayTime(d.created_at)}{d.last_ok_at ? ` · last reached ${dayTime(d.last_ok_at)}` : ''}</span>
            {d.last_error && <span className="small" style={{ color: 'var(--bad)', display: 'block' }}>Last try failed: {d.last_error}</span>}
          </span>
          <button type="button" className="danger-soft" disabled={busy} onClick={() => remove(d)}>Remove</button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Notifications, on My account (15 Oct 2026): push on this device; which
 * kinds; quiet hours; the devices that have it on, each removable.
 */
export default function NotificationsCard({ session }: { session: Session }) {
  const [state, setState] = useState<PushState | null>(null);
  const [mine, setMine] = useState<AlertSettings | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [here, setHere] = useState<string | null>(null);
  const [quiet, setQuiet] = useState({ on: false, from: '21:00', to: '06:00' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const s = await api.get<AlertSettings>('/api/me/alerts');
    setMine(s);
    setQuiet({ on: !!(s.quietFrom && s.quietTo), from: s.quietFrom ?? '21:00', to: s.quietTo ?? '06:00' });
    setDevices(await api.get<Device[]>('/api/push/devices').catch(() => []));
    setHere(await currentEndpoint());
  }
  useEffect(() => {
    pushState().then(setState).catch(() => setState('unsupported'));
    void load().catch(() => {});
  }, []);

  async function go(fn: () => Promise<void>) {
    setBusy(true); setError(null); setMsg(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'That did not work'); } finally { setBusy(false); }
  }
  const kinds = KINDS.filter((k) => k.roles.includes(session.role));

  return (
    <div className="panel" style={{ maxWidth: 620 }}>
      <h2 style={{ marginTop: 0 }}>Notifications</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        A message on your phone or computer, even with Alka Vida closed.
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
                      } else setMsg(next === 'off' ? 'Turned off on this device.' : PUSH_WORDS[next]);
                      await load();
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

      {mine && kinds.length > 0 && (
        <>
          <h3 className="notif-h">What to tell me</h3>
          {kinds.map((k) => (
            <div className="switch-row" key={k.key}>
              <div>
                <strong>{k.label}</strong>
                <div className="small muted">
                  {k.key === 'decisionEmails' ? (mine.email ? `To ${mine.email}` : 'Your login has no email address.') : k.hint}
                </div>
              </div>
              <button type="button" role="switch" aria-checked={mine[k.key]} aria-label={k.label}
                      className={`switch${mine[k.key] ? ' on' : ''}`} disabled={busy}
                      onClick={() => go(async () => { setMine(await api.patch<AlertSettings>('/api/me/alerts', { [k.key]: !mine[k.key] })); })}>
                <span /></button>
            </div>
          ))}
        </>
      )}

      {mine && (
        <>
          <h3 className="notif-h">Quiet hours</h3>
          <div className="switch-row">
            <div>
              <strong>Don't buzz me {quiet.on ? `from ${quiet.from} to ${quiet.to}` : 'at night'}</strong>
              <div className="small muted">Anything that comes in arrives when quiet hours end. Emails still come.</div>
            </div>
            <button type="button" role="switch" aria-checked={quiet.on} aria-label="Quiet hours"
                    className={`switch${quiet.on ? ' on' : ''}`} disabled={busy}
                    onClick={() => go(async () => {
                      const on = !quiet.on;
                      setMine(await api.patch<AlertSettings>('/api/me/alerts', on
                        ? { quietFrom: quiet.from, quietTo: quiet.to } : { quietFrom: null, quietTo: null }));
                      setQuiet({ ...quiet, on });
                    })}><span /></button>
          </div>
          {quiet.on && (
            <form className="row quiet-times" onSubmit={(e) => {
              e.preventDefault();
              void go(async () => {
                setMine(await api.patch<AlertSettings>('/api/me/alerts', { quietFrom: quiet.from, quietTo: quiet.to }));
                setMsg(`Quiet from ${quiet.from} to ${quiet.to}.`);
              });
            }}>
              <div className="field"><label htmlFor="q-from">From</label>
                <input id="q-from" type="time" value={quiet.from} required onChange={(e) => setQuiet({ ...quiet, from: e.target.value })} /></div>
              <div className="field"><label htmlFor="q-to">To</label>
                <input id="q-to" type="time" value={quiet.to} required onChange={(e) => setQuiet({ ...quiet, to: e.target.value })} /></div>
              <button className="secondary" disabled={busy}>Save times</button>
            </form>
          )}
        </>
      )}

      <h3 className="notif-h">My devices</h3>
      {devicesList(devices, here, busy, (d) => {
        void go(async () => {
          if (!await ask(`Stop notifications to ${d.device || 'this device'}?`, { confirmLabel: 'Remove it', danger: true })) return;
          await api.del(`/api/push/devices/${d.id}`);
          if (d.endpoint === here) { await turnPushOff().catch(() => {}); setState('off'); }
          setMsg(`${d.device || 'That device'} will not get notifications any more.`);
          await load();
        });
      })}
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
