import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { money, date, statusTone, when } from '../lib/format';

interface Row {
  invoice_id: string; invoice_number: string; invoice_date: string;
  customer_name: string;
  grand_total_cents: number; amount_paid_cents: number;
  balance_cents: number; status: string;
}

export default function Invoices() {
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = status ? `?status=${encodeURIComponent(status)}` : '';
    api.get<Row[]>(`/api/invoices${q}`).then(setRows).catch((e) => setError(e.message));
  }, [status]);

  const q = search.trim().toLowerCase();
  const shown = q === '' ? rows : rows.filter(
    (r) => r.invoice_number.toLowerCase().includes(q)
      || (r.customer_name ?? '').toLowerCase().includes(q));

  return (
    <>
      <h1>Invoices</h1>
      <p className="subtitle">
        An invoice is raised at the moment of delivery, from the quantities actually delivered.
      </p>
      {error && <div className="notice error">{error}</div>}

      <div className="panel">
        <div className="row">
        <div className="field" style={{ flex: '1 1 260px' }}>
          <label htmlFor="q">Quick search</label>
          <input id="q" placeholder="invoice number or customer…" style={{ width: '100%' }}
                 value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="field" style={{ maxWidth: 220 }}>
          <label htmlFor="st">Status</label>
          <select id="st" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {['Open', 'Sent', 'Partial', 'Paid', 'Overdue', 'Credit Note'].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>Invoice</th><th>Customer</th><th>Date</th><th className="num">Total</th>
              <th className="num">Paid</th><th className="num">Balance</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.invoice_id}>
                <td><Link to={`/invoices/${r.invoice_id}`}>{r.invoice_number}</Link></td>
                <td>{r.customer_name}</td>
                <td>{when(r.invoice_date)}</td>
                <td className="num">{money(Number(r.grand_total_cents))}</td>
                <td className="num">{money(Number(r.amount_paid_cents))}</td>
                <td className="num">{money(Number(r.balance_cents))}</td>
                <td><span className={`chip ${statusTone(r.status)}`}>{r.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && (
          <p className="muted">
            {rows.length === 0 ? 'No invoices found.'
              : `Nothing matches "${search}".`}
          </p>
        )}
      </div>
    </>
  );
}
