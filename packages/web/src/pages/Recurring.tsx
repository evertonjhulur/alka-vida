import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { date, when } from '../lib/format';
import { ask, askText } from '../components/Dialog';

interface Schedule {
  id: string; orderNumber: string; customerId: string; customerName: string;
  pattern: 'Weekly' | 'Biweekly' | 'Monthly';
  nextDeliveryDate: string | null; paused: boolean; endsOn: string | null;
  deliveryZone: string | null; lastRunAt: string | null; lastNote: string | null;
  occurrencesRaised: number; lineSummary: string;
}

interface RunResult {
  created: Array<{ orderNumber: string; date: string }>;
  skipped: Array<{ customerName: string; date: string }>;
  problems: Array<{ customerName: string; reason: string }>;
  schedulesConsidered: number;
}

const PATTERNS = ['Weekly', 'Biweekly', 'Monthly'] as const;

export default function Recurring() {
  const [rows, setRows] = useState<Schedule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [run, setRun] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ pattern: 'Weekly', nextDeliveryDate: '', endsOn: '' });

  async function load() { setRows(await api.get<Schedule[]>('/api/recurring')); }
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  async function generate() {
    setBusy(true); setError(null); setMsg(null);
    try {
      const r = await api.post<RunResult>('/api/recurring/generate');
      setRun(r);
      setMsg(
        r.created.length
          ? `${r.created.length} order(s) raised.`
          : 'Nothing was due. Everything is up to date.',
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not raise standing orders');
    } finally { setBusy(false); }
  }

  async function togglePause(s: Schedule) {
    setBusy(true); setError(null);
    try {
      await api.post(`/api/recurring/${s.id}/pause`, { paused: !s.paused });
      setMsg(s.paused
        ? `${s.customerName} resumed. Missed weeks are not back-filled.`
        : `${s.customerName} paused. It will not raise orders until resumed.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the schedule');
    } finally { setBusy(false); }
  }

  async function end(s: Schedule) {
    if (!await ask(
      `End the standing order for ${s.customerName}?\n\n` +
      `Orders already raised are kept. To stop it only temporarily, pause it instead.`,
      { confirmLabel: 'End it', cancelLabel: 'Keep it', danger: true },
    )) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/api/recurring/${s.id}/end`, { reason: 'ended by office' });
      setMsg(`${s.customerName} ended.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not end the schedule');
    } finally { setBusy(false); }
  }

  function startEdit(s: Schedule) {
    setDraft({
      pattern: s.pattern,
      nextDeliveryDate: s.nextDeliveryDate ?? '',
      endsOn: s.endsOn ?? '',
    });
    setEditing(s.id);
  }

  async function saveEdit(s: Schedule) {
    setBusy(true); setError(null);
    try {
      await api.patch(`/api/recurring/${s.id}`, {
        pattern: draft.pattern,
        nextDeliveryDate: draft.nextDeliveryDate || undefined,
        endsOn: draft.endsOn || null,
      });
      setMsg(`${s.customerName} updated.`);
      setEditing(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally { setBusy(false); }
  }

  const active = rows.filter((r) => !r.paused);
  const paused = rows.filter((r) => r.paused);

  return (
    <>
      <h1>Standing orders</h1>
      <p className="subtitle">
        A customer who takes the same delivery every week or month. Alka Vida raises
        each one for you, a week before it is due.
      </p>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      <div className="notice info">
        Orders are raised automatically when you open Alka Vida, and once an hour
        while it is open. The button below only does it sooner — you never need to
        press it on a normal day.
      </div>

      {rows.some((r) => !r.paused && !r.nextDeliveryDate) && (
        <div className="notice warn">
          Some standing orders below have no next delivery date, so they are
          raising nothing. Press <strong>Change</strong> on each and set one.
        </div>
      )}

      {run && (run.skipped.length > 0 || run.problems.length > 0) && (
        <div className="notice warn">
          {run.skipped.length > 0 && (
            <div>
              <strong>{run.skipped.length} delivery date(s) were too far in the past
              to raise</strong>, so they were passed over rather than back-dated:{' '}
              {run.skipped.slice(0, 6).map((s) => `${s.customerName} (${s.date})`).join(', ')}
              {run.skipped.length > 6 ? ', …' : ''}. If any of these are still wanted,
              add them as one-off orders.
            </div>
          )}
          {run.problems.map((p, i) => (
            <div key={i}>{p.customerName} needs attention: {p.reason}</div>
          ))}
        </div>
      )}

      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ marginTop: 0 }}>Active ({active.length})</h2>
          <button disabled={busy} onClick={generate}>
            {busy ? 'Checking…' : 'Raise anything due now'}
          </button>
        </div>

        <table>
          <thead>
            <tr>
              <th>Customer</th><th>What they take</th><th>How often</th>
              <th>Next delivery</th><th className="num">Raised so far</th><th />
            </tr>
          </thead>
          <tbody>
            {active.map((s) => (
              <>
                <tr key={s.id}>
                  <td>
                    <strong>{s.customerName}</strong>
                    <div className="muted small">
                      {s.deliveryZone ?? 'no zone'} · from {s.orderNumber}
                    </div>
                  </td>
                  <td className="small">{s.lineSummary || <span className="muted">—</span>}</td>
                  <td>{s.pattern}</td>
                  <td>
                    {/* A schedule with no next date raises nothing and would
                        otherwise sit here looking healthy. Say so on the row,
                        not only after someone presses the button. */}
                    {s.nextDeliveryDate ? when(s.nextDeliveryDate) : (
                      <>
                        <span className="chip bad">not scheduled</span>
                        <div className="muted small">
                          Press Change and set a next delivery date, or end it.
                        </div>
                      </>
                    )}
                    {s.endsOn && (
                      <div className="muted small">ends {when(s.endsOn)}</div>
                    )}
                  </td>
                  <td className="num">{s.occurrencesRaised}</td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    <button className="secondary" onClick={() => startEdit(s)}>Change</button>{' '}
                    <button className="secondary" disabled={busy}
                            onClick={() => togglePause(s)}>Pause</button>{' '}
                    <button className="danger-soft" disabled={busy}
                            onClick={() => end(s)}>End</button>
                  </td>
                </tr>
                {editing === s.id && (
                  <tr key={`${s.id}-edit`}>
                    <td colSpan={6} style={{ background: '#f9fafb' }}>
                      <div className="row">
                        <div className="field">
                          <label>How often</label>
                          <select value={draft.pattern}
                                  onChange={(e) => setDraft({ ...draft, pattern: e.target.value })}>
                            {PATTERNS.map((p) => <option key={p} value={p}>{p}</option>)}
                          </select>
                        </div>
                        <div className="field">
                          <label>Next delivery</label>
                          <input type="date" value={draft.nextDeliveryDate}
                                 onChange={(e) => setDraft({
                                   ...draft, nextDeliveryDate: e.target.value,
                                 })} />
                        </div>
                        <div className="field">
                          <label>Stop after (optional)</label>
                          <input type="date" value={draft.endsOn}
                                 onChange={(e) => setDraft({ ...draft, endsOn: e.target.value })} />
                        </div>
                        <div className="field">
                          <button disabled={busy} onClick={() => saveEdit(s)}>Save</button>{' '}
                          <button className="secondary" onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                        </div>
                      </div>
                      {s.lastNote && (
                        <p className="muted small">
                          Last checked {when(s.lastRunAt)} — {s.lastNote}
                        </p>
                      )}
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
        {active.length === 0 && (
          <p className="muted">
            No standing orders yet. Create an order for a customer, then open it from
            Orders and turn it into a standing order.
          </p>
        )}
      </div>

      {paused.length > 0 && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Paused ({paused.length})</h2>
          <p className="muted small">
            These keep their history but raise nothing. Resuming picks up from the next
            delivery due — the quiet period is not back-filled.
          </p>
          <table>
            <thead>
              <tr>
                <th>Customer</th><th>How often</th>
                <th className="num">Raised so far</th><th>Why</th><th />
              </tr>
            </thead>
            <tbody>
              {paused.map((s) => (
                <tr key={s.id}>
                  <td>{s.customerName}</td>
                  <td>{s.pattern}</td>
                  <td className="num">{s.occurrencesRaised}</td>
                  <td className="small muted">{s.lastNote ?? '—'}</td>
                  <td className="num">
                    <button className="secondary" disabled={busy}
                            onClick={() => togglePause(s)}>Resume</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
