import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { money, date, todayInJamaica, when } from '../lib/format';

interface Sheet {
  id: string; delivery_date: string; zone: string; status: string;
  stop_count: number; driver_name: string | null; cash_variance_cents: number | null;
  started_at: string | null;
}

/*
 * Everton, 10 Oct 2026: a round is in one of three states, said the same way
 * on the filter and in the Status column. Open with no started_at = Not
 * started; Open and started = Out on the road; Completed = Settled.
 */
type Phase = 'not-started' | 'on-road' | 'settled';
const PHASES: Array<{ key: Phase; label: string; chip: string }> = [
  { key: 'not-started', label: 'Not started', chip: 'neutral' },
  { key: 'on-road', label: 'Out on the road', chip: 'info' },
  { key: 'settled', label: 'Settled', chip: 'ok' },
];
function phaseOf(s: { status: string; started_at: string | null }): Phase {
  if (s.status === 'Completed') return 'settled';
  return s.started_at ? 'on-road' : 'not-started';
}

interface Expected {
  scheduleId: string; customerName: string; zone: string | null; lineSummary: string;
  fromOrder: string; pattern: string; deliveryMode: string;
}

export default function DeliverySheets() {
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Blank means every date. A day is picked from the calendar. */
  const [day, setDay] = useState('');
  const [phase, setPhase] = useState<Phase | 'all'>('all');
  /** Standing orders due on the chosen day but not raised yet (point 16). */
  const [expected, setExpected] = useState<Expected[]>([]);

  const loadSheets = () => api.get<Sheet[]>('/api/delivery-sheets').then(setSheets);
  useEffect(() => { loadSheets().catch((e) => setError(e.message)); }, []);
  useEffect(() => {
    if (!day) { setExpected([]); return; }
    api.get<Expected[]>(`/api/recurring/expected?date=${day}`).then(setExpected).catch(() => setExpected([]));
  }, [day]);

  async function raiseNow() {
    setBusy(true); setError(null); setMsg(null);
    try {
      const r = await api.post<{ created: unknown[]; problems: Array<{ customerName: string; reason: string }> }>(
        '/api/recurring/raise-through', { date: day });
      setMsg(`${r.created.length} standing order${r.created.length === 1 ? '' : 's'} raised and put on their rounds.`
        + (r.problems.length ? ` Not raised: ${r.problems.map((p) => `${p.customerName} (${p.reason})`).join('; ')}.` : ''));
      await loadSheets();
      setExpected(await api.get<Expected[]>(`/api/recurring/expected?date=${day}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not raise them');
    } finally { setBusy(false); }
  }
  const tomorrow = (() => {
    const d = new Date(`${todayInJamaica()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  })();

  /*
   * Rounds accumulate - one per zone per day, for as long as the business has
   * been running - so listing every one of them buries today's under last
   * month's. The date is how anybody actually looks for a round.
   */
  const dayOf = (s: Sheet) => String(s.delivery_date).slice(0, 10);
  const daysWithSheets = [...new Set(sheets.map(dayOf))].sort().reverse();
  const onDay = day ? sheets.filter((s) => dayOf(s) === day) : sheets;
  const shown = phase === 'all' ? onDay : onDay.filter((s) => phaseOf(s) === phase);
  const pill = (key: Phase | 'all', label: string) => {
    const n = key === 'all' ? onDay.length : onDay.filter((s) => phaseOf(s) === key).length;
    return (
      <button key={key} type="button" className={`pill${phase === key ? ' active' : ''}`}
              aria-pressed={phase === key} onClick={() => setPhase(key)}>
        {label} · {n}
      </button>
    );
  };

  return (
    <>
      <h1>Delivery rounds</h1>
      <p className="subtitle">
        Orders are auto-routed onto the sheet for the customer's zone and requested date.
      </p>
      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      <div className="panel">
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field">
            <label htmlFor="day">Which day?</label>
            <input id="day" type="date" value={day} list="sheet-days"
                   onChange={(e) => setDay(e.target.value)} />
            {/* The days that actually have a round, offered by the picker. */}
            <datalist id="sheet-days">
              {daysWithSheets.map((d) => <option key={d} value={d} />)}
            </datalist>
          </div>
          <div className="field">
            {/* Jamaica's today, not the browser's: a laptop set to another
                timezone would otherwise ask for the wrong day's round. */}
            <button className="secondary" onClick={() => setDay(todayInJamaica())}>
              Today
            </button>{' '}
            <button className="secondary" onClick={() => setDay(tomorrow)}>
              Tomorrow
            </button>{' '}
            <button className="secondary" onClick={() => setDay('')}>
              Show every day
            </button>
          </div>
          <div className="field">
            <div className="muted small">
              {day
                ? `${shown.length} round(s) on this day`
                : `${sheets.length} round(s) across ${daysWithSheets.length} day(s)`}
            </div>
          </div>
        </div>
      </div>

      {day && expected.length > 0 && (
        <div className="panel">
          <div className="panel-head">
            <h2>Standing orders due {when(day)}, not on a round yet</h2>
            <button type="button" disabled={busy} onClick={raiseNow}>
              {busy ? 'Raising…' : 'Put them on their rounds now'}
            </button>
          </div>
          <p className="muted small" style={{ marginTop: 0 }}>
            Standing orders are raised a week before they are due, then appear on their round.
            These are further ahead than that; raise them now to plan the day.
          </p>
          <table>
            <thead><tr><th>Customer</th><th>Zone</th><th>What</th><th>Repeats</th></tr></thead>
            <tbody>
              {expected.map((e) => (
                <tr key={e.scheduleId}>
                  <td>{e.customerName}<div className="muted small">from {e.fromOrder}</div></td>
                  <td>{e.deliveryMode === 'Pickup' ? 'Collection' : (e.zone ?? <span className="chip warn">no zone</span>)}</td>
                  <td className="small">{e.lineSummary.replace(/Alka Vida\s+/gi, '')}</td>
                  <td className="small">{e.pattern === 'Biweekly' ? 'every 2 weeks' : e.pattern.toLowerCase()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="panel">
        <div className="pills" role="group" aria-label="Status">
          {pill('all', 'All')}
          {PHASES.map((p) => pill(p.key, p.label))}
        </div>
        <table>
          <thead>
            <tr>
              <th>Date</th><th>Zone</th><th>Driver</th><th>Stops</th>
              <th>Status</th><th className="num">Cash variance</th><th />
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => (
              <tr key={s.id}>
                <td>{when(s.delivery_date)}</td>
                <td>{s.zone}</td>
                <td>
                  {s.driver_name ?? <span className="muted">Not assigned</span>}
                </td>
                <td>{s.stop_count}</td>
                <td>
                  {(() => {
                    const p = PHASES.find((x) => x.key === phaseOf(s))!;
                    return <span className={`chip ${p.chip}`}>{p.label}</span>;
                  })()}
                </td>
                <td className="num">
                  {s.cash_variance_cents === null || Number(s.cash_variance_cents) === 0
                    ? <span className="muted">—</span>
                    : <span className="chip warn">{money(Number(s.cash_variance_cents))}</span>}
                </td>
                <td className="num">
                  {/* Opening the route comes first: assigning a driver, adding a
                      waiting order and reordering stops all live in there.
                      Settling is the END of a route, not the way into one. */}
                  <Link to={`/delivery/${s.id}`}>Open round</Link>
                  {s.status === 'Open' && (
                    <>
                      {' · '}
                      <Link to={`/delivery/${s.id}/settlement`}>Settle</Link>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && (
          <p className="muted">
            {phase !== 'all' && onDay.length > 0
              ? 'No round in that state. Choose All to see the rest.'
              : day
                ? 'No round on that day. Pick another date, or show every day.'
                : 'No delivery rounds yet.'}
          </p>
        )}
      </div>
    </>
  );
}
