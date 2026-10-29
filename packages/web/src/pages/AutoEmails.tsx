import { useEffect, useRef, useState } from 'react';
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
  sameDayCutoff: string; whatsappNumber: string; broadcastDailyCap: number; contactEmail?: string;
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
        orderDeliveredEmails: o!.orderDeliveredEmails, contactEmail: o!.contactEmail,
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
        <div className="field" style={{ marginTop: 10 }}>
          <label htmlFor="ce">Contact address on every email and document</label>
          <input id="ce" type="email" style={{ maxWidth: 320 }} value={o.contactEmail ?? ''} placeholder="orders@alkavidaja.com"
                 onChange={(e) => set('contactEmail', e.target.value)} />
          <div className="muted small">Shown as "Contact … for any orders or queries".</div>
        </div>
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
      <EmailWording isAdmin={isAdmin} />
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

/* ------------------------------------------------------------------ */

interface WordingRow {
  kind: string; label: string; blanks: string[];
  subject: string; message: string;
  standardSubject: string; standardMessage: string; changed: boolean;
}

/**
 * The wording of the emails the office sends (Everton, 28 Oct 2026). Each
 * kind of document has a subject and message; the send screen starts from
 * it and anyone sending can change it for that one email. The automatic
 * emails use it as it stands. Words in {braces} are filled in per customer.
 */
function EmailWording({ isAdmin }: { isAdmin: boolean }) {
  const [rows, setRows] = useState<WordingRow[]>([]);
  const [kind, setKind] = useState('invoice');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  const pick = (list: WordingRow[], k: string) => {
    const r = list.find((x) => x.kind === k) ?? list[0];
    if (!r) return;
    setKind(r.kind); setSubject(r.subject); setMessage(r.message);
  };
  useEffect(() => {
    api.get<WordingRow[]>('/api/email-wording')
      .then((list) => { setRows(list); pick(list, 'invoice'); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the wording'));
  }, []);

  const row = rows.find((r) => r.kind === kind);
  if (!row) return error ? <div className="notice error">{error}</div> : null;
  const dirty = subject !== row.subject || message !== row.message;

  /** Puts a blank where the cursor is in the message. */
  const insert = (blank: string) => {
    const el = box.current;
    if (!el) { setMessage((m) => m + blank); return; }
    const a = el.selectionStart ?? message.length;
    const b = el.selectionEnd ?? message.length;
    const next = message.slice(0, a) + blank + message.slice(b);
    setMessage(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + blank.length, a + blank.length); });
  };

  async function save(reset: boolean) {
    setBusy(true); setError(null); setMsg(null);
    try {
      const list = await api.put<WordingRow[]>(`/api/email-wording/${kind}`, reset ? { reset: true } : { subject, message });
      setRows(list);
      pick(list, kind);
      setMsg(reset ? `${row!.label}: back to the standard wording.` : `${row!.label} wording saved.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the wording');
    } finally { setBusy(false); }
  }

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Wording of the emails you send</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        What the subject and message say when someone presses Email… on a document. They can change it for that one email before sending.
        The automatic emails (monthly statements, weekly and monthly invoices, receipts from the tick box) use it as it stands.
        The figures, the attachment and the "See it online" button are added below the message.
      </p>
      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}
      <fieldset className="form-block" disabled={!isAdmin || busy}>
        <div className="field">
          <label htmlFor="ew-kind">Email for</label>
          <select id="ew-kind" value={kind} onChange={(e) => pick(rows, e.target.value)}>
            {rows.map((r) => <option key={r.kind} value={r.kind}>{r.label}{r.changed ? ' (changed)' : ''}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ew-subject">Subject</label>
          <input id="ew-subject" value={subject} style={{ width: '100%' }} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ew-message">Message</label>
          <textarea id="ew-message" ref={box} rows={8} value={message} style={{ width: '100%', lineHeight: 1.45 }}
                    onChange={(e) => setMessage(e.target.value)} />
        </div>
        <div className="row" style={{ alignItems: 'center', marginBottom: 10 }}>
          <span className="muted small">Add a blank:</span>
          {row.blanks.map((b) => (
            <button key={b} type="button" className="secondary small-button" onClick={() => insert(b)}>{b}</button>
          ))}
        </div>
      </fieldset>
      <p className="muted small" style={{ marginTop: 0 }}>
        Each blank is filled in for the customer the email goes to: {'{customer}'} is their name, {'{contact}'} the contact person (or the name).
      </p>
      {isAdmin ? (
        <div className="row">
          <button type="button" disabled={busy || !dirty || !subject.trim() || !message.trim()} onClick={() => save(false)}>Save</button>
          {dirty && <button type="button" className="secondary" disabled={busy} onClick={() => pick(rows, kind)}>Undo changes</button>}
          {row.changed && <button type="button" className="secondary" disabled={busy} onClick={() => save(true)}>Use the standard wording</button>}
        </div>
      ) : <p className="muted small">Only an administrator can change the wording.</p>}
    </div>
  );
}
