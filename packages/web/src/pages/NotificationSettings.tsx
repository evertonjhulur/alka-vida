import { Fragment, useEffect, useState } from 'react';
import { api, type Session } from '../lib/api';
import { ask } from '../components/Dialog';
import { KINDS, devicesList, type AlertSettings, type Device } from '../components/NotificationsCard';

/**
 * Settings › Notifications (Everton, 15 Oct 2026): an administrator sets who
 * gets which notifications, their quiet hours, and can take a lost or
 * replaced phone off anyone's list. Each person can change their own under
 * My account & notifications as well.
 */

const ROLE_WORDS: Record<string, string> = { admin: 'Administrator', user: 'Office', driver: 'Driver' };

export default function NotificationSettings({ session }: { session: Session }) {
  const [rows, setRows] = useState<AlertSettings[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [quiet, setQuiet] = useState<{ id: string; from: string; to: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.get<AlertSettings[]>('/api/alert-settings').then(setRows).catch((e) => setError(e.message));
  useEffect(() => { if (session.role === 'admin') void load(); }, [session.role]);

  async function go(fn: () => Promise<void>) {
    setBusy(true); setError(null); setMsg(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'That did not work'); } finally { setBusy(false); }
  }
  const save = (r: AlertSettings, patch: Record<string, unknown>) => go(async () => {
    const next = await api.patch<AlertSettings>(`/api/alert-settings/${r.userId}`, patch);
    setRows((cur) => cur.map((x) => (x.userId === r.userId ? next : x)));
  });
  const openDevices = (r: AlertSettings) => go(async () => {
    if (open === r.userId) { setOpen(null); return; }
    setDevices(await api.get<Device[]>(`/api/alert-settings/${r.userId}/devices`));
    setOpen(r.userId);
  });

  if (session.role !== 'admin') return <div className="notice info">Notification settings for everyone are for administrators. Your own are under My account.</div>;

  return (
    <>
      <h1>Notifications</h1>
      <p className="subtitle">
        Who is told about what, on their phones and computers. Each person turns notifications on for a device
        themselves (My account &amp; notifications); here you choose what reaches them.
      </p>
      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      <div className="panel" style={{ padding: 0 }}>
        <table className="notif-table phone-cards">
          <thead>
            <tr>
              <th>Who</th>
              {KINDS.map((k) => <th key={k.key}>{k.label.replace('my load', 'their load')}</th>)}
              <th>Quiet hours</th>
              <th className="num">Devices</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.userId}>
                <tr>
                  <td className="lead" data-label="Who">
                    <span><strong>{r.name}</strong><div className="muted small">{ROLE_WORDS[r.role] ?? r.role}{r.email ? ` · ${r.email}` : ''}</div></span>
                  </td>
                  {KINDS.map((k) => (k.roles.includes(r.role) ? (
                    <td key={k.key} data-label={k.label}>
                      <button type="button" role="switch" aria-checked={r[k.key]} aria-label={`${k.label} for ${r.name}`}
                              className={`switch${r[k.key] ? ' on' : ''}`} disabled={busy || (k.key === 'decisionEmails' && !r.email)}
                              title={k.key === 'decisionEmails' && !r.email ? 'This login has no email address' : k.hint}
                              onClick={() => save(r, { [k.key]: !r[k.key] })}><span /></button>
                    </td>
                  ) : <td key={k.key} className="na on-desktop" aria-label="not for this role">—</td>))}
                  <td data-label="Quiet hours">
                    {quiet?.id === r.userId ? (
                      <form className="row quiet-times" onSubmit={(e) => {
                        e.preventDefault();
                        void save(r, { quietFrom: quiet.from, quietTo: quiet.to }).then(() => setQuiet(null));
                      }}>
                        <input type="time" aria-label="From" required value={quiet.from} onChange={(e) => setQuiet({ ...quiet, from: e.target.value })} />
                        <input type="time" aria-label="To" required value={quiet.to} onChange={(e) => setQuiet({ ...quiet, to: e.target.value })} />
                        <button className="secondary" disabled={busy}>Save</button>
                        <button type="button" className="as-link small" onClick={() => setQuiet(null)}>Close</button>
                      </form>
                    ) : (
                      <>
                        <span>{r.quietFrom && r.quietTo ? `${r.quietFrom}–${r.quietTo}` : <span className="muted">none</span>}</span>{' '}
                        <button type="button" className="as-link small"
                                onClick={() => setQuiet({ id: r.userId, from: r.quietFrom ?? '21:00', to: r.quietTo ?? '06:00' })}>
                          {r.quietFrom ? 'Change' : 'Set'}
                        </button>
                        {r.quietFrom && (
                          <> · <button type="button" className="as-link small" disabled={busy}
                                       onClick={() => save(r, { quietFrom: null, quietTo: null })}>Off</button></>
                        )}
                      </>
                    )}
                  </td>
                  <td data-label="Devices" className="num">
                    <button type="button" className="as-link" onClick={() => openDevices(r)}>
                      {r.devices === 0 ? 'none' : `${r.devices} device${r.devices === 1 ? '' : 's'}`}
                    </button>
                  </td>
                </tr>
                {open === r.userId && (
                  <tr>
                    <td colSpan={KINDS.length + 3} style={{ background: '#f9fafb' }}>
                      {devicesList(devices, null, busy, (d) => {
                        void go(async () => {
                          if (!await ask(`Stop notifications to ${d.device || 'that device'} for ${r.name}?`, { confirmLabel: 'Remove it', danger: true })) return;
                          await api.del(`/api/push/devices/${d.id}`);
                          setDevices(await api.get<Device[]>(`/api/alert-settings/${r.userId}/devices`));
                          setMsg(`${d.device || 'That device'} removed for ${r.name}.`);
                          await load();
                        });
                      })}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="muted" style={{ padding: '14px 16px', margin: 0 }}>No staff logins yet.</p>}
      </div>
      <p className="muted small">
        Office staff can have new online orders; administrators can also have Needs a decision (as a notification
        and by email); drivers, changes to their load. During quiet hours nothing buzzes: what comes in arrives when they end.
      </p>
    </>
  );
}
