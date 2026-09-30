import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { money, date, todayInJamaica, when } from '../lib/format';

interface Sheet {
  id: string; delivery_date: string; zone: string; status: string;
  stop_count: number; driver_name: string | null; cash_variance_cents: number | null;
  started_at: string | null;
}

export default function DeliverySheets() {
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Blank means every date. A day is picked from the calendar. */
  const [day, setDay] = useState('');

  useEffect(() => {
    api.get<Sheet[]>('/api/delivery-sheets').then(setSheets).catch((e) => setError(e.message));
  }, []);

  /*
   * Rounds accumulate - one per zone per day, for as long as the business has
   * been running - so listing every one of them buries today's under last
   * month's. The date is how anybody actually looks for a round.
   */
  const dayOf = (s: Sheet) => String(s.delivery_date).slice(0, 10);
  const daysWithSheets = [...new Set(sheets.map(dayOf))].sort().reverse();
  const shown = day ? sheets.filter((s) => dayOf(s) === day) : sheets;

  return (
    <>
      <h1>Delivery rounds</h1>
      <p className="subtitle">
        Orders are auto-routed onto the sheet for the customer's zone and requested date.
      </p>
      {error && <div className="notice error">{error}</div>}

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

      <div className="panel">
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
                  {s.started_at && <div className="muted small">started</div>}
                </td>
                <td>{s.stop_count}</td>
                <td>
                  <span className={`chip ${s.status === 'Open' ? 'info' : 'ok'}`}>{s.status}</span>
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
            {day
              ? 'No round on that day. Pick another date, or show every day.'
              : 'No delivery rounds yet.'}
          </p>
        )}
      </div>
    </>
  );
}
