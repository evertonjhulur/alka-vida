import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { money, date } from '../lib/format';

interface Sheet {
  id: string; delivery_date: string; zone: string; status: string; stop_count: number;
}
interface Receivable { customer_id: string; name: string; balance_cents: number }
interface Approval { id: string; requestType: string; customerName: string | null; amountCents: number }

export default function Dashboard() {
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [receivables, setReceivables] = useState<Receivable[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);

  useEffect(() => {
    api.get<Sheet[]>('/api/delivery-sheets?status=Open').then(setSheets).catch(() => {});
    api.get<Receivable[]>('/api/reports/receivables').then(setReceivables).catch(() => {});
    api.get<Approval[]>('/api/approvals').then(setApprovals).catch(() => {});
  }, []);

  const owed = receivables.reduce((s, r) => s + Number(r.balance_cents), 0);

  return (
    <>
      <h1>Dashboard</h1>
      <p className="subtitle">Alka Vida operations — 1506 Investments Limited</p>

      {approvals.length > 0 && (
        <div className="notice warn">
          {approvals.length} discount or credit note awaiting approval.{' '}
          <Link to="/approvals">Review now</Link> — operations continue in the meantime.
        </div>
      )}

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Open delivery sheets</h2>
        <table>
          <thead><tr><th>Date</th><th>Zone</th><th>Stops</th><th /></tr></thead>
          <tbody>
            {sheets.map((s) => (
              <tr key={s.id}>
                <td>{date(s.delivery_date)}</td>
                <td>{s.zone}</td>
                <td>{s.stop_count}</td>
                <td className="num">
                  <Link to={`/delivery/${s.id}/settlement`}>Settle route</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {sheets.length === 0 && <p className="muted">No open routes.</p>}
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Outstanding balances</h2>
        <table>
          <thead><tr><th>Customer</th><th className="num">Balance</th></tr></thead>
          <tbody>
            {receivables.slice(0, 10).map((r) => (
              <tr key={r.customer_id}>
                <td>{r.name}</td>
                <td className="num">{money(Number(r.balance_cents))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {receivables.length === 0
          ? <p className="muted">Nothing outstanding.</p>
          : <div className="total-line grand"><span>Total owed</span><span>{money(owed)}</span></div>}
      </div>
    </>
  );
}
