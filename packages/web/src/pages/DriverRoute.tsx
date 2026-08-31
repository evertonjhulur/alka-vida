import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { date } from '../lib/format';

interface Stop {
  id: string; customer_name: string; delivery_address: string | null;
  sequence_no: number; stop_outcome: string; line_items_summary: string | null;
}
interface Sheet {
  id: string; delivery_date: string; zone: string; status: string; stops: Stop[];
}

export default function DriverRoute() {
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const list = await api.get<Array<{ id: string }>>('/api/delivery-sheets?status=Open');
        const full = await Promise.all(
          list.map((s) => api.get<Sheet>(`/api/delivery-sheets/${s.id}`)),
        );
        setSheets(full);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load your route');
      }
    })();
  }, []);

  return (
    <>
      <h1>My route</h1>
      <p className="subtitle">Stops are listed in route order.</p>
      {error && <div className="notice error">{error}</div>}

      {sheets.map((sheet) => (
        <div key={sheet.id}>
          <h2>{date(sheet.delivery_date)} — {sheet.zone}</h2>
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
        </div>
      ))}
      {sheets.length === 0 && !error && <p className="muted">No open routes today.</p>}
    </>
  );
}
