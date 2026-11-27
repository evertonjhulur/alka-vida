import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { SortTh, MultiStatusSelect, passes, useSort } from '../components/ListTools';
import NoRoundPanel from '../components/NoRoundPanel';
import { otherZones, roundTitle } from '../lib/rounds';
import { money, date, todayInJamaica, when } from '../lib/format';

interface Sheet {
  id: string; delivery_date: string; zone: string; status: string;
  stop_count: number; driver_name: string | null; cash_variance_cents: number | null;
  started_at: string | null;
  /** Several rounds a day (27 Nov 2026): an optional name, the vehicle, and the zones of its stops. */
  name?: string | null; vehicle?: string | null; stop_zones?: string[];
}


interface Zone { id: string; name: string; retired_at: string | null }
interface Driver { id: string; name: string; office?: boolean }

/**
 * + New round (27 Nov 2026): another round for a day - a second truck for a
 * zone, or a driver taking stops from several zones. Orders join the first
 * round of their zone that has not started; stops are moved across by hand.
 */
function NewRoundPanel({ defaultDay, onCancel }: { defaultDay: string; onCancel: () => void }) {
  const navigate = useNavigate();
  const [zones, setZones] = useState<Zone[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [day, setDay] = useState(defaultDay);
  const [zone, setZone] = useState('');
  const [name, setName] = useState('');
  const [driverId, setDriverId] = useState('');
  const [vehicle, setVehicle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.get<Zone[]>('/api/zones').then((z) => setZones(z.filter((x) => !x.retired_at))).catch(() => {});
    api.get<Driver[]>('/api/drivers').then(setDrivers).catch(() => {});
  }, []);
  async function make() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ id: string; label: string; warnings: string[] }>('/api/delivery-sheets', {
        day, zone, name: name.trim() || null, driverId: driverId || null, vehicle: vehicle.trim() || null,
      });
      navigate(`/delivery/${r.id}`, { state: { made: `The ${r.label} round was made.${r.warnings.length ? ` ${r.warnings.join(' ')}` : ''}` } });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The round could not be made');
      setBusy(false);
    }
  }
  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>New round</h2>
      {error && <div className="notice error">{error}</div>}
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="field">
          <label htmlFor="nr-day">Day</label>
          <input id="nr-day" type="date" value={day} min={todayInJamaica()} onChange={(e) => setDay(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="nr-zone">Zone</label>
          <select id="nr-zone" value={zone} onChange={(e) => setZone(e.target.value)}>
            <option value="">Choose a zone…</option>
            {zones.map((z) => <option key={z.id} value={z.name}>{z.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="nr-name">Name (optional)</label>
          <input id="nr-name" value={name} placeholder={zone ? `e.g. ${zone} 2` : 'e.g. Portmore 2'}
                 onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="nr-driver">Driver</label>
          <select id="nr-driver" value={driverId} onChange={(e) => setDriverId(e.target.value)}>
            <option value="">Choose later</option>
            {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}{d.office ? ' (office)' : ''}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="nr-vehicle">Vehicle (optional)</label>
          <input id="nr-vehicle" value={vehicle} onChange={(e) => setVehicle(e.target.value)} />
        </div>
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        New orders go on the first round of their zone that has not started. Move customers onto this one from the other round's page.
        A second round for the same zone and day is named "{zone || 'Zone'} 2" unless you name it.
      </p>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="approve-soft" disabled={busy || !day || !zone} onClick={make}>
          {busy ? 'Making…' : 'Make the round'}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
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
  const [phase, setPhase] = useState<string[]>([]);
  /** Standing orders due on the chosen day but not raised yet (point 16). */
  const [expected, setExpected] = useState<Expected[]>([]);
  const [making, setMaking] = useState(false);

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
  const filtered = onDay.filter((s) => passes(phase, (v) => phaseOf(s) === v));
  // Click a heading to sort (11 Oct 2026); until then, as they come.
  const { sorted: shown, sort, onSort } = useSort(filtered, {
    date: (s) => dayOf(s), zone: (s) => roundTitle(s), driver: (s) => s.driver_name ?? '',
    stops: (s) => Number(s.stop_count), status: (s) => PHASES.findIndex((p) => p.key === phaseOf(s)),
    variance: (s) => (s.cash_variance_cents === null ? null : Number(s.cash_variance_cents)),
  });

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <h1>Delivery rounds</h1>
        <button type="button" onClick={() => setMaking(!making)} aria-expanded={making}>
          {making ? 'Close' : '+ New round'}
        </button>
      </div>
      <p className="subtitle">
        Orders go on the first round for the customer's zone and day that has not started. Make another round for a second driver,
        then move customers onto it.
      </p>
      {making && <NewRoundPanel defaultDay={day && day >= todayInJamaica() ? day : todayInJamaica()} onCancel={() => setMaking(false)} />}
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

      {/* Delivery orders with no round (25 Nov 2026): for the day chosen, or all. */}
      <NoRoundPanel key={day || 'all'} forDay={day || null} onChange={() => { void loadSheets(); }} />

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
        <div className="row">
          <MultiStatusSelect id="rd-st" value={phase} onChange={setPhase}
                        options={[['all', 'Any status'], ...PHASES.map((p) => [p.key, p.label] as const)]} />
        </div>
        <table>
          <thead>
            <tr>
              <SortTh label="Date" k="date" sort={sort} onSort={onSort} />
              <SortTh label="Round" k="zone" sort={sort} onSort={onSort} />
              <SortTh label="Driver" k="driver" sort={sort} onSort={onSort} />
              <SortTh label="Stops" k="stops" sort={sort} onSort={onSort} />
              <SortTh label="Status" k="status" sort={sort} onSort={onSort} />
              <SortTh label="Cash variance" k="variance" sort={sort} onSort={onSort} className="num" />
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => (
              <tr key={s.id}>
                <td>{when(s.delivery_date)}</td>
                <td>
                  {roundTitle(s)}
                  {(s.name || otherZones(s).length > 0 || s.vehicle) && (
                    <div className="muted small">
                      {[s.name ? s.zone : null, otherZones(s).length ? `+ ${otherZones(s).join(', ')}` : null, s.vehicle]
                        .filter(Boolean).join(' · ')}
                    </div>
                  )}
                </td>
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
            {phase.length > 0 && onDay.length > 0
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
