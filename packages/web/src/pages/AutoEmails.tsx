import { useEffect, useState } from 'react';
import { api, type Session } from '../lib/api';
import { when } from '../lib/format';

/**
 * Automatic emails (Everton's revisions, 30 Sep 2026, point 17).
 *
 * Statements once a month and reminders for overdue invoices, sent by Alka
 * Vida on its own while it is running (it checks when it opens and every
 * hour). Each customer can be left out from their Details tab. Weekly and
 * monthly invoices can also be sent the moment they are raised.
 */

interface Settings {
  statementsEnabled: boolean; statementsDay: number;
  remindersEnabled: boolean; remindersAfterDays: number; remindersEveryDays: number;
  cycleInvoicesAutoSend: boolean; mailConfigured: boolean;
}
interface LogRow {
  id: string; kind: string; customer_name: string; sent_on: string; sent_to: string | null;
  period_key: string | null; detail: string | null; ok: boolean;
}

interface Ordering {
  sameDayCutoff: string; whatsappNumber: string; broadcastDailyCap: number;
  orderPlacedEmails: boolean; orderDeliveredEmails: boolean; mailConfigured: boolean;
}

/**
 * Ordering and customer messages (team feedback, 1 Oct 2026): the same-day
 * cut-off, the business WhatsApp number customers order on, order
 * confirmation emails, and how many message emails go out a day.
 */
function OrderingSettings({ isAdmin }: { isAdmin: boolean }) {
  const [o, setO] = useState<Ordering | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.get<Ordering>('/api/settings/ordering').then(setO).catch((e) => setErr(e.message)); }, []);
  if (!o) return err ? <div className="notice error">{err}</div> : null;
  const set = <K extends keyof Ordering>(k: K, v: Ordering[K]) => setO({ ...o, [k]: v });
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null); setNote(null);
    try {
      setO(await api.put<Ordering>('/api/settings/ordering', {
        sameDayCutoff: o!.sameDayCutoff, whatsappNumber: o!.whatsappNumber,
        broadcastDailyCap: o!.broadcastDailyCap, orderPlacedEmails: o!.orderPlacedEmails,
        orderDeliveredEmails: o!.orderDeliveredEmails,
      }));
      setNote('Saved.');
    } catch (e2) { setErr(e2 instanceof Error ? e2.message : 'Could not save'); } finally { setBusy(false); }
  }
  return (
    <form className="panel" onSubmit={save}>
      <h2 style={{ marginTop: 0 }}>Orders and messages</h2>
      {err && <div className="notice error">{err}</div>}
      {note && <div className="notice ok">{note}</div>}
      <fieldset className="form-block" disabled={!isAdmin}>
        <legend>Same-day orders</legend>
        <div className="field">
          <label htmlFor="cut">Cut-off time for same-day delivery</label>
          <input id="cut" type="time" value={o.sameDayCutoff} onChange={(e) => set('sameDayCutoff', e.target.value)} />
          <div className="muted small">
            An order for today placed after this time still comes in, but waits in Needs a decision until an
            administrator approves it. Not approved, it goes on the customer's next delivery day instead.
          </div>
        </div>
      </fieldset>
      <fieldset className="form-block" disabled={!isAdmin}>
        <legend>Emails to customers about their orders</legend>
        <label className="check"><input type="checkbox" checked={o.orderPlacedEmails} onChange={(e) => set('orderPlacedEmails', e.target.checked)} />
          When an order is placed (portal or office)</label>
        <label className="check"><input type="checkbox" checked={o.orderDeliveredEmails} onChange={(e) => set('orderDeliveredEmails', e.target.checked)} />
          When it is delivered, with the invoice attached</label>
        <div className="muted small">A customer can turn these off for themselves in their portal profile, or the office on their Details tab.</div>
      </fieldset>
      <fieldset className="form-block" disabled={!isAdmin}>
        <legend>WhatsApp and messages</legend>
        <div className="row">
          <div className="field">
            <label htmlFor="wa">Business WhatsApp number</label>
            <input id="wa" type="tel" value={o.whatsappNumber} placeholder="876-555-1234"
                   onChange={(e) => set('whatsappNumber', e.target.value)} />
            <div className="muted small">Shows an "Order on WhatsApp" button on the customer portal. Blank hides it.</div>
          </div>
          <div className="field">
            <label htmlFor="cap">Message emails a day</label>
            <input id="cap" type="number" min="0" style={{ width: 100 }} value={o.broadcastDailyCap}
                   onChange={(e) => set('broadcastDailyCap', Number(e.target.value))} />
            <div className="muted small">Resend's free plan allows 100 emails a day in all; this leaves room for invoices.</div>
          </div>
        </div>
      </fieldset>
      {isAdmin ? <button disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        : <p className="muted small">Only an administrator can change these.</p>}
    </form>
  );
}

export default function AutoEmails({ session }: { session: Session }) {
  const [s, setS] = useState<Settings | null>(null);
  const [log, setLog] = useState<LogRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isAdmin = session.role === 'admin';

  const load = () => api.get<{ settings: Settings; log: LogRow[] }>('/api/automation')
    .then((r) => { setS(r.settings); setLog(r.log); });
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!s) return;
    setBusy(true); setError(null); setMsg(null);
    try {
      await api.put('/api/automation', s);
      setMsg('Saved.');
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save'); } finally { setBusy(false); }
  }
  async function runNow() {
    setBusy(true); setError(null); setMsg(null);
    try {
      const r = await api.post<{ cycleInvoices: number; statements: number; reminders: number; problems: string[] }>('/api/automation/run', {});
      setMsg(`Done: ${r.cycleInvoices} weekly/monthly invoice(s) raised, ${r.statements} statement(s) and ${r.reminders} reminder(s) sent.`
        + (r.problems.length ? ` Problems: ${r.problems.join('; ')}` : ''));
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not run it'); } finally { setBusy(false); }
  }

  if (!s) return error ? <div className="notice error">{error}</div> : <p className="muted">Loading…</p>;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v });

  return (
    <>
      <h1>Emails &amp; ordering</h1>
      <p className="subtitle">What Alka Vida sends on its own, and the rules for taking orders. It checks when it is opened and every hour while it runs.</p>
      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}
      {!s.mailConfigured && (
        <div className="notice warn">
          Email is not set up on this computer yet, so nothing will be sent. Put the mail account in
          "Alka Vida settings.txt" beside the launcher and restart. Weekly and monthly invoices are
          still raised either way.
        </div>
      )}
      <OrderingSettings isAdmin={isAdmin} />
      <form className="panel" onSubmit={save}>
        <h2 style={{ marginTop: 0 }}>Statements and reminders</h2>
        <fieldset className="form-block" disabled={!isAdmin}>
          <legend>Monthly statements</legend>
          <label className="check">
            <input type="checkbox" checked={s.statementsEnabled} onChange={(e) => set('statementsEnabled', e.target.checked)} />
            Email every customer who owes something their statement once a month
          </label>
          <div className="field">
            <label htmlFor="ae-day">On or after this day of the month</label>
            <input id="ae-day" type="number" min="1" max="28" style={{ width: 80 }} value={s.statementsDay}
                   onChange={(e) => set('statementsDay', Number(e.target.value))} />
          </div>
        </fieldset>
        <fieldset className="form-block" disabled={!isAdmin}>
          <legend>Payment reminders</legend>
          <label className="check">
            <input type="checkbox" checked={s.remindersEnabled} onChange={(e) => set('remindersEnabled', e.target.checked)} />
            Remind customers about overdue invoices (their statement goes with it)
          </label>
          <div className="row">
            <div className="field">
              <label htmlFor="ae-after">First reminder when this many days overdue</label>
              <input id="ae-after" type="number" min="0" style={{ width: 80 }} value={s.remindersAfterDays}
                     onChange={(e) => set('remindersAfterDays', Number(e.target.value))} />
            </div>
            <div className="field">
              <label htmlFor="ae-every">Then again every … days while unpaid</label>
              <input id="ae-every" type="number" min="1" style={{ width: 80 }} value={s.remindersEveryDays}
                     onChange={(e) => set('remindersEveryDays', Number(e.target.value))} />
            </div>
          </div>
        </fieldset>
        <fieldset className="form-block" disabled={!isAdmin}>
          <legend>Weekly and monthly invoices</legend>
          <label className="check">
            <input type="checkbox" checked={s.cycleInvoicesAutoSend} onChange={(e) => set('cycleInvoicesAutoSend', e.target.checked)} />
            Email them to the customer as soon as they are raised
          </label>
          <p className="muted small" style={{ margin: 0 }}>Off: they wait under Invoices so you can check them and send them yourself.</p>
        </fieldset>
        <p className="muted small">A customer can be left out of statements or reminders on their Details tab.</p>
        {isAdmin ? (
          <div className="row">
            <button disabled={busy}>Save</button>
            <button type="button" className="secondary" disabled={busy} onClick={runNow}>Check and send now</button>
          </div>
        ) : <p className="muted small">Only an administrator can change these.</p>}
      </form>

      <div className="panel phone-cards">
        <h2 style={{ marginTop: 0 }}>Sent lately</h2>
        <table>
          <thead><tr><th>Day</th><th>What</th><th>Customer</th><th>To</th><th>Detail</th></tr></thead>
          <tbody>
            {log.map((l) => (
              <tr key={l.id}>
                <td>{when(l.sent_on)}</td>
                <td>{l.kind === 'CycleInvoice' ? 'Weekly/monthly invoice' : l.kind}
                  {!l.ok && <span className="chip bad">not sent</span>}</td>
                <td>{l.customer_name}</td>
                <td className="small">{l.sent_to ?? '—'}</td>
                <td className="small muted">{l.detail}{l.period_key ? ` · ${l.period_key}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {log.length === 0 && <p className="muted">Nothing sent automatically yet.</p>}
      </div>
    </>
  );
}
