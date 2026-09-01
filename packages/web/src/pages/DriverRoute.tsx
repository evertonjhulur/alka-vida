import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Session } from '../lib/api';
import { date } from '../lib/format';

interface Stop {
  id: string; customer_name: string; delivery_address: string | null;
  sequence_no: number; stop_outcome: string; line_items_summary: string | null;
}
interface Sheet {
  id: string; delivery_date: string; zone: string; status: string;
  assigned_driver_id: string | null; driver_name: string | null;
  started_at: string | null; stops: Stop[];
}

export default function DriverRoute({ session }: { session: Session }) {
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * The API scopes this list: a driver is served their own routes and any
   * nobody has claimed, never another driver's round.
   */
  const load = useCallback(async () => {
    try {
      const list = await api.get<Array<{ id: string }>>('/api/delivery-sheets?status=Open');
      setSheets(await Promise.all(
        list.map((s) => api.get<Sheet>(`/api/delivery-sheets/${s.id}`)),
      ));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your routes');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function start(sheetId: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/delivery-sheets/${sheetId}/start`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start that route');
    } finally {
      setBusy(false);
    }
  }

  const mine = sheets.filter((s) => s.assigned_driver_id === session.id);
  const unclaimed = sheets.filter((s) => !s.assigned_driver_id);

  /**
   * Plain functions returning JSX, NOT nested components: a component
   * declared inside another gets a new type every render, so everything
   * under it unmounts and remounts.
   */
  const stopList = (sheet: Sheet) => (
    <>
      {sheet.stops.map((stop) => (
        <Link key={stop.id} to={`/route/stop/${stop.id}`}
              style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="stop-card">
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <div>
                <span className="seq">{stop.sequence_no}</span>
                <strong>{stop.customer_name}</strong>
                <div className="muted small" style={{ marginLeft: 34 }}>
                  {stop.delivery_address ?? 'No address on file'}
                </div>
                {stop.line_items_summary && (
                  <div className="small" style={{ marginLeft: 34, marginTop: 4 }}>
                    {stop.line_items_summary}
                  </div>
                )}
              </div>
              <span className={`chip ${stop.stop_outcome === 'Delivered' ? 'ok'
                : stop.stop_outcome === 'Pending' ? 'neutral' : 'warn'}`}>
                {stop.stop_outcome}
              </span>
            </div>
          </div>
        </Link>
      ))}
      {sheet.stops.length === 0 && <p className="muted">No stops on this route.</p>}
    </>
  );

  const heading = (sheet: Sheet) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <h2>{date(sheet.delivery_date)} — {sheet.zone}</h2>
      <span className="muted small">
        {sheet.stops.filter((s) => s.stop_outcome !== 'Pending').length} of{' '}
        {sheet.stops.length} done
      </span>
    </div>
  );

  return (
    <>
      <h1>My route</h1>
      {error && <div className="notice error">{error}</div>}

      {mine.map((sheet) => (
        <div key={sheet.id}>
          {heading(sheet)}
          {sheet.started_at ? (
            <p className="subtitle">
              Started {String(sheet.started_at).slice(11, 16)}. Stops are in visit order.
            </p>
          ) : (
            <div className="panel">
              <p style={{ marginTop: 0 }}>This route is yours. Start it when you set off.</p>
              <button type="button" disabled={busy} onClick={() => start(sheet.id)}>
                Start route
              </button>
            </div>
          )}
          {sheet.started_at && stopList(sheet)}
        </div>
      ))}

      {unclaimed.length > 0 && (
        <div style={{ marginTop: mine.length ? 32 : 0 }}>
          <h2>Routes nobody has taken</h2>
          <p className="subtitle">Starting one puts it in your name.</p>
          {unclaimed.map((sheet) => (
            <div className="panel" key={sheet.id}>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16,
              }}>
                <div>
                  <strong>{date(sheet.delivery_date)} — {sheet.zone}</strong>
                  <div className="muted small">
                    {sheet.stops.length} stop{sheet.stops.length === 1 ? '' : 's'}
                  </div>
                </div>
                <button type="button" disabled={busy} onClick={() => start(sheet.id)}>
                  Start this route
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {sheets.length === 0 && !error && <p className="muted">No open routes today.</p>}
    </>
  );
}
