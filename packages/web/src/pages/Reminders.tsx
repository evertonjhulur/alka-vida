import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { money, when } from '../lib/format';

/**
 * Tomorrow's round: remind customers to order (Everton, 7 Oct 2026).
 *
 * Everyone whose delivery day it is and who has not ordered yet, each with a
 * message typed for them. "Send on WhatsApp" opens a chat with that customer
 * with the message filled in (press send in WhatsApp), ticks them off and
 * brings up the next one. Customers without WhatsApp can be ticked and sent
 * the same words by email.
 */

interface Row {
  customerId: string; name: string; contactPerson: string | null; zone: string | null;
  phone: string | null; whatsapp: string | null; email: string | null;
  usual: string | null; lastOrderOn: string | null; balanceCents: number;
  message: string; whatsappLink: string | null; canEmail: boolean;
  remindedBy: string[]; remindedAt: string | null;
}
interface Data {
  date: string; weekday: string; when: string; template: string; mailConfigured: boolean; rows: Row[];
}

export default function Reminders() {
  const [date, setDate] = useState('');
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hideDone, setHideDone] = useState(false);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState(false);
  const [template, setTemplate] = useState('');
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});

  async function load(d = date) {
    const r = await api.get<Data>(`/api/reminders${d ? `?date=${d}` : ''}`);
    setData(r);
    if (!d) setDate(r.date);
    setTemplate(r.template);
    return r;
  }
  useEffect(() => { load().catch((e) => setError(e.message)); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const done = (r: Row) => r.remindedBy.length > 0;
  const rows = (data?.rows ?? []).filter((r) => !hideDone || !done(r));
  const next = data?.rows.find((r) => !done(r) && r.whatsappLink) ?? null;
  const doneCount = (data?.rows ?? []).filter(done).length;

  /** The link opens straight from the click (so no pop-up blocker); the tick follows. */
  async function sentOnWhatsApp(r: Row) {
    setError(null); setMsg(null);
    try {
      await api.post(`/api/reminders/${r.customerId}/sent`, { date: data!.date });
      const fresh = await load(data!.date);
      const after = fresh.rows.find((x) => !done(x) && x.whatsappLink);
      if (after) setTimeout(() => rowRefs.current[after.customerId]?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not tick them off'); }
  }

  async function undo(r: Row) {
    setBusy(true);
    try {
      await api.del(`/api/reminders/${r.customerId}/sent?date=${data!.date}`);
      await load(data!.date);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not undo'); } finally { setBusy(false); }
  }

  async function emailPicked() {
    const ids = Object.entries(picked).filter(([, v]) => v).map(([k]) => k);
    if (ids.length === 0) return;
    setBusy(true); setError(null); setMsg(null);
    try {
      const r = await api.post<{ sent: number; skipped: number; failed: Array<{ name: string; reason: string }> }>(
        '/api/reminders/email', { date: data!.date, customerIds: ids });
      setMsg(`Emailed ${r.sent}.${r.skipped ? ` ${r.skipped} skipped (no email, or they turned off service announcements).` : ''}`
        + (r.failed.length ? ` Not sent: ${r.failed.map((f) => `${f.name} (${f.reason})`).join('; ')}.` : ''));
      setPicked({});
      await load(data!.date);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not send the emails'); } finally { setBusy(false); }
  }

  async function saveTemplate() {
    setBusy(true); setError(null);
    try {
      await api.put('/api/reminders/template', { template });
      setEditing(false);
      await load(data!.date);
      setMsg('Message saved. Every customer\'s message below uses it.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save the message'); } finally { setBusy(false); }
  }

  const pickedCount = Object.values(picked).filter(Boolean).length;

  return (
    <>
      <h1>Tomorrow&rsquo;s round: remind customers</h1>
      <p className="subtitle">
        Customers whose delivery day it is and who have not ordered yet. Press <strong>Send on WhatsApp</strong>,
        press send in WhatsApp, and the next one comes up.
      </p>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      <div className="panel">
        <div className="filter-row">
          <div className="field">
            <label htmlFor="rd">Delivery day</label>
            <input id="rd" type="date" value={date}
                   onChange={(e) => { setDate(e.target.value); setPicked({}); load(e.target.value).catch((x) => setError(x.message)); }} />
          </div>
          {data && (
            <div className="field">
              <strong>{data.rows.length}</strong> to remind for {when(data.date)} · <strong>{doneCount}</strong> done
            </div>
          )}
          <label className="check" style={{ margin: 0 }}>
            <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} /> Hide the ones done
          </label>
          <button type="button" className="secondary" onClick={() => setEditing(!editing)}>
            {editing ? 'Close' : 'Change the message'}
          </button>
          {next && (
            <a className="button-link whatsapp" href={next.whatsappLink!} target="_blank" rel="noreferrer"
               onClick={() => sentOnWhatsApp(next)}>
              Next: {next.name}
            </a>
          )}
        </div>
        {editing && (
          <div className="sub-panel" style={{ marginTop: 10 }}>
            <label htmlFor="tpl">The message (the same for everyone; the words in braces are filled in for each customer)</label>
            <textarea id="tpl" rows={3} style={{ width: '100%', boxSizing: 'border-box' }} value={template}
                      onChange={(e) => setTemplate(e.target.value)} />
            <div className="muted small" style={{ margin: '4px 0 8px' }}>
              {'{name}'} their contact person (or the business) · {'{business}'} the business name · {'{zone}'} the round ·
              {' '}{'{when}'} "tomorrow, Thu 8 Oct" · {'{ask}'} "Would you like your usual 3 cases of 500ml?" ·
              {' '}{'{link}'} the link to order online
            </div>
            <button type="button" disabled={busy} onClick={saveTemplate}>Save the message</button>
          </div>
        )}
      </div>

      {data && rows.length === 0 && (
        <p className="muted">{data.rows.length === 0
          ? `Nobody to remind for ${when(data.date)}: everyone due that day has ordered, or no one's delivery day falls on it.`
          : 'All done.'}</p>
      )}

      {rows.map((r) => {
        const isNext = next?.customerId === r.customerId;
        return (
          <div key={r.customerId} ref={(el) => { rowRefs.current[r.customerId] = el; }}
               className={`panel remind-row${done(r) ? ' done' : ''}${isNext ? ' next' : ''}`}>
            <div className="remind-head">
              <label className="check" style={{ margin: 0 }} title={r.canEmail ? 'Tick to email' : 'No email, or they turned off service announcements'}>
                <input type="checkbox" disabled={!r.canEmail} checked={!!picked[r.customerId]}
                       onChange={(e) => setPicked({ ...picked, [r.customerId]: e.target.checked })} />
              </label>
              <div style={{ flex: 1 }}>
                <Link to={`/customers/${r.customerId}`}><strong>{r.name}</strong></Link>
                {r.contactPerson && <span className="muted small"> · {r.contactPerson}</span>}
                <div className="muted small">
                  {r.zone ?? 'No zone'}
                  {r.usual ? ` · usual: ${r.usual}` : ' · no orders yet'}
                  {r.lastOrderOn ? ` (last ${when(r.lastOrderOn)})` : ''}
                  {r.balanceCents > 0 ? ` · owes ${money(r.balanceCents)}` : ''}
                </div>
              </div>
              <div className="remind-actions">
                {done(r) && <span className="chip ok">Sent{r.remindedBy.length ? ` · ${r.remindedBy.join(', ')}` : ''}</span>}
                {r.whatsappLink ? (
                  <a className={`button-link ${done(r) ? 'secondary' : 'whatsapp'}`} href={r.whatsappLink}
                     target="_blank" rel="noreferrer" onClick={() => sentOnWhatsApp(r)}>
                    {done(r) ? 'Send again' : 'Send on WhatsApp'}
                  </a>
                ) : <span className="muted small">No WhatsApp or phone number</span>}
                {r.remindedBy.includes('WhatsApp') && (
                  <button type="button" className="as-link small" disabled={busy} onClick={() => undo(r)}>undo</button>
                )}
              </div>
            </div>
            <div className="remind-msg">{r.message}</div>
          </div>
        );
      })}

      {data && data.rows.some((r) => r.canEmail) && (
        <div className="panel">
          <div className="row" style={{ alignItems: 'center', gap: 10 }}>
            <button type="button" className="secondary" onClick={() => setPicked(Object.fromEntries(
              data.rows.filter((r) => r.canEmail && !done(r)).map((r) => [r.customerId, true])))}>
              Tick everyone not yet reminded who has email
            </button>
            <button type="button" disabled={busy || pickedCount === 0 || !data.mailConfigured} onClick={emailPicked}>
              {busy ? 'Sending…' : `Email the ${pickedCount || ''} ticked`}
            </button>
            {!data.mailConfigured && <span className="muted small">Email is not set up on this copy.</span>}
          </div>
          <p className="muted small" style={{ marginBottom: 0 }}>
            The email carries the same words, an Order now button and an unsubscribe link. Customers who turned off
            service announcements cannot be ticked.
          </p>
        </div>
      )}
    </>
  );
}
