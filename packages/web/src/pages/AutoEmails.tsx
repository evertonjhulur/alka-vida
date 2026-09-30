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
      <h1>Automatic emails</h1>
      <p className="subtitle">What Alka Vida sends on its own. It checks when it is opened and every hour while it runs.</p>
      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}
      {!s.mailConfigured && (
        <div className="notice warn">
          Email is not set up on this computer yet, so nothing will be sent. Put the mail account in
          "Alka Vida settings.txt" beside the launcher and restart. Weekly and monthly invoices are
          still raised either way.
        </div>
      )}
      <form className="panel" onSubmit={save}>
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
