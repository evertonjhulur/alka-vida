import { useEffect, useState } from 'react';
import { api, type Session } from '../lib/api';
import { money, date, statusTone } from '../lib/format';
import { StatementView } from './Statement';

interface Row {
  invoice_id: string; invoice_number: string; invoice_date: string;
  grand_total_cents: number; balance_cents: number; status: string;
}

export default function Portal({ session }: { session: Session }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    api.get<Row[]>('/api/invoices').then(setRows).catch(() => {});
    if (session.customerId) {
      api.get<{ balanceCents: number }>(`/api/customers/${session.customerId}/balance`)
        .then((b) => setBalance(b.balanceCents)).catch(() => {});
    }
  }, [session.customerId]);

  if (!session.customerId) {
    return <div className="notice error">This login is not linked to a customer account.</div>;
  }

  return (
    <>
      <h1>My account</h1>
      <p className="subtitle">Your invoices and statement.</p>

      <div className="panel">
        <div className="muted small">Current balance</div>
        <div className="owed">{money(balance ?? 0)}</div>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Invoices</h2>
        <table>
          <thead>
            <tr>
              <th>Invoice</th><th>Date</th><th className="num">Total</th>
              <th className="num">Balance</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.invoice_id}>
                <td>{r.invoice_number}</td>
                <td>{date(r.invoice_date)}</td>
                <td className="num">{money(Number(r.grand_total_cents))}</td>
                <td className="num">{money(Number(r.balance_cents))}</td>
                <td><span className={`chip ${statusTone(r.status)}`}>{r.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="muted">No invoices yet.</p>}
      </div>

      <h2>Statement</h2>
      <StatementView customerId={session.customerId} />
    </>
  );
}
