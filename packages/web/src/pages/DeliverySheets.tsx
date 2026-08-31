import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { money, date } from '../lib/format';

interface Sheet {
  id: string; delivery_date: string; zone: string; status: string;
  stop_count: number; driver_name: string | null; cash_variance_cents: number | null;
}

export default function DeliverySheets() {
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Sheet[]>('/api/delivery-sheets').then(setSheets).catch((e) => setError(e.message));
  }, []);

  return (
    <>
      <h1>Delivery sheets</h1>
      <p className="subtitle">
        Orders are auto-routed onto the sheet for the customer's zone and requested date.
      </p>
      {error && <div className="notice error">{error}</div>}

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Date</th><th>Zone</th><th>Driver</th><th>Stops</th>
              <th>Status</th><th className="num">Cash variance</th><th />
            </tr>
          </thead>
          <tbody>
            {sheets.map((s) => (
              <tr key={s.id}>
                <td>{date(s.delivery_date)}</td>
                <td>{s.zone}</td>
                <td>{s.driver_name ?? '—'}</td>
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
                  <Link to={`/delivery/${s.id}/settlement`}>
                    {s.status === 'Open' ? 'Settle' : 'View'}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {sheets.length === 0 && <p className="muted">No delivery sheets yet.</p>}
      </div>
    </>
  );
}
