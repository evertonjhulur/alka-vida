import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { money, date } from '../lib/format';

interface Entry {
  date: string;
  type: string;
  description: string;
  reference: string;
  amountCents: number;
  runningBalanceCents: number;
}

interface StatementData {
  customerId: string;
  customerName: string;
  openingBalanceCents: number;
  closingBalanceCents: number;
  entries: Entry[];
}

interface Customer { id: string; name: string }

/** Filters deliberately omit any "credit" category: an unattached payment is
 *  simply a payment, and a credit note is a line within Invoices. */
const FILTERS = ['All', 'Invoices', 'Payments'] as const;

export function StatementView(
  { customerId, showPicker }: { customerId?: string; showPicker?: boolean },
) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selected, setSelected] = useState(customerId ?? '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('All');
  const [data, setData] = useState<StatementData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (showPicker) api.get<Customer[]>('/api/customers').then(setCustomers).catch(() => {});
  }, [showPicker]);

  useEffect(() => {
    if (!selected) { setData(null); return; }
    const q = new URLSearchParams({ filter });
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    api.get<StatementData>(`/api/customers/${selected}/statement?${q}`)
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError(e.message));
  }, [selected, from, to, filter]);

  function exportCsv() {
    if (!data) return;
    // Plain data for accountant reconciliation.
    const rows = [
      ['Date', 'Type', 'Description', 'Reference', 'Amount', 'Running balance'],
      ...data.entries.map((e) => [
        e.date, e.type, e.description, e.reference,
        (e.amountCents / 100).toFixed(2),
        (e.runningBalanceCents / 100).toFixed(2),
      ]),
    ];
    const csv = rows
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `statement-${data.customerName.replace(/\W+/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="panel">
        <div className="row">
          {showPicker && (
            <div className="field" style={{ flex: '1 1 240px' }}>
              <label htmlFor="cust">Customer</label>
              <select id="cust" value={selected} style={{ width: '100%' }}
                      onChange={(e) => setSelected(e.target.value)}>
                <option value="">Select a customer…</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="from">From</label>
            <input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="to">To</label>
            <input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="filter">Show</label>
            <select id="filter" value={filter}
                    onChange={(e) => setFilter(e.target.value as typeof filter)}>
              {FILTERS.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div className="field">
            <button className="secondary" disabled={!data} onClick={exportCsv}>
              Export for accountant
            </button>
          </div>
          <div className="field">
            <button className="secondary" disabled={!data} onClick={() => window.print()}>
              Print / save as PDF
            </button>
          </div>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          A customer's periodic bill is simply this statement for a date range —
          nothing is batched or closed to produce one.
        </p>
      </div>

      {error && <div className="notice error">{error}</div>}

      {data && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>{data.customerName}</h2>
          <table>
            <thead>
              <tr>
                <th>Date</th><th>Type</th><th>Description</th><th>Reference</th>
                <th className="num">Amount</th><th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={5} className="muted">Opening balance</td>
                <td className="num muted">{money(data.openingBalanceCents)}</td>
              </tr>
              {data.entries.map((e, i) => (
                <tr key={i}>
                  <td>{date(e.date)}</td>
                  <td>
                    <span className={`chip ${
                      e.type === 'Invoice' ? 'neutral'
                      : e.type === 'Payment' ? 'ok'
                      : e.type === 'Reversal' ? 'bad' : 'info'}`}>
                      {e.type}
                    </span>
                  </td>
                  <td>{e.description}</td>
                  <td className="small muted">{e.reference}</td>
                  <td className="num">{money(e.amountCents)}</td>
                  <td className="num">{money(e.runningBalanceCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.entries.length === 0 && <p className="muted">No entries in this period.</p>}
          <div className="total-line grand">
            <span>Balance due</span><span>{money(data.closingBalanceCents)}</span>
          </div>
        </div>
      )}
    </>
  );
}

export default function Statement() {
  return (
    <>
      <h1>Customer statements</h1>
      <p className="subtitle">
        One running balance per customer — every payment counts, whether or not it
        is attached to a specific invoice.
      </p>
      <StatementView showPicker />
    </>
  );
}
