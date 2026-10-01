import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { money, date, statusTone, when } from '../lib/format';
import { downloadCsv, dollars } from '../lib/csv';

interface Row {
  invoice_id: string; invoice_number: string; invoice_date: string;
  customer_name: string;
  grand_total_cents: number; amount_paid_cents: number;
  balance_cents: number; status: string;
  due_date?: string | null; is_credit_note?: boolean;
  subtotal_cents?: number; gct_cents?: number; discount_amount_cents?: number;
}

interface Waiting {
  customerId: string; customerName: string; cycle: string; deliveries: number;
  subtotalCents: number; firstDate: string; lastDate: string; readyNow: boolean;
}

export default function Invoices() {
  const [rows, setRows] = useState<Row[]>([]);
  const [waiting, setWaiting] = useState<Waiting[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loadWaiting = () => api.get<Waiting[]>('/api/invoice-cycles/waiting').then(setWaiting).catch(() => {});
  useEffect(() => { void loadWaiting(); }, []);

  async function raiseDue() {
    setBusy(true); setError(null); setMsg(null);
    try {
      const r = await api.post<Array<{ invoiceNumber: string; customerName: string }>>('/api/invoice-cycles/run', {});
      setMsg(r.length ? `Raised ${r.map((x) => `${x.invoiceNumber} (${x.customerName})`).join(', ')}.`
        : 'Nothing is due yet: every week or month with deliveries waiting is still running.');
      await loadWaiting();
      const q = status ? `?status=${encodeURIComponent(status)}` : '';
      setRows(await api.get<Row[]>(`/api/invoices${q}`));
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not raise them'); } finally { setBusy(false); }
  }
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = status ? `?status=${encodeURIComponent(status)}` : '';
    api.get<Row[]>(`/api/invoices${q}`).then(setRows).catch((e) => setError(e.message));
  }, [status]);

  const q = search.trim().toLowerCase();
  const shown = rows.filter((r) => (q === '' || r.invoice_number.toLowerCase().includes(q)
      || (r.customer_name ?? '').toLowerCase().includes(q))
    && (!from || date(r.invoice_date) >= from) && (!to || date(r.invoice_date) <= to));

  /** The list as it is filtered on screen, for Excel (team feedback, point 13). */
  function exportList() {
    downloadCsv(`invoices${from || to ? `-${from || 'start'}-to-${to || 'today'}` : ''}`, [
      ['Invoice', 'Customer', 'Date', 'Due', 'Type', 'Subtotal', 'Discount', 'GCT', 'Total', 'Paid', 'Balance', 'Status'],
      ...shown.map((r) => [
        r.invoice_number, r.customer_name, date(r.invoice_date), r.due_date ? date(r.due_date) : '',
        r.is_credit_note ? 'Credit note' : 'Invoice',
        dollars(r.subtotal_cents), dollars(r.discount_amount_cents), dollars(r.gct_cents),
        dollars(r.grand_total_cents), dollars(r.amount_paid_cents), dollars(r.balance_cents), r.status,
      ]),
    ]);
  }

  return (
    <>
      <h1>Invoices</h1>
      <p className="subtitle">
        An invoice is raised at the moment of delivery, from the quantities actually delivered, or
        once a week or month for customers billed that way.
      </p>
      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      {waiting.length > 0 && (
        <div className="panel phone-cards">
          <div className="panel-head">
            <h2>Delivered, waiting for a weekly or monthly invoice</h2>
            {waiting.some((w) => w.readyNow) && (
              <button type="button" disabled={busy} onClick={raiseDue}>Raise the ones due now</button>
            )}
          </div>
          <table>
            <thead><tr><th>Customer</th><th>Billed</th><th>Deliveries</th><th>From</th><th className="num">Before GCT</th><th /></tr></thead>
            <tbody>
              {waiting.map((w) => (
                <tr key={w.customerId}>
                  <td className="lead"><Link to={`/customers/${w.customerId}?tab=invoices`}>{w.customerName}</Link></td>
                  <td data-label="Billed">{w.cycle === 'PerDelivery' ? 'Per delivery' : w.cycle}</td>
                  <td data-label="Deliveries">{w.deliveries}</td>
                  <td data-label="From">{when(w.firstDate)}{w.lastDate !== w.firstDate ? ` – ${when(w.lastDate)}` : ''}</td>
                  <td data-label="Before GCT" className="num">{money(w.subtotalCents)}</td>
                  <td>{w.readyNow ? <span className="chip warn">due now</span> : <span className="chip neutral">period still running</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small" style={{ marginBottom: 0 }}>
            Raised automatically once the week (Mon–Sun) or month closes, due on receipt. A customer's
            own page has "Invoice now" to bill everything early.
          </p>
        </div>
      )}

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
        <div className="field">
          <label htmlFor="ifrom">From</label>
          <input id="ifrom" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ito">To</label>
          <input id="ito" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="field" style={{ alignSelf: 'flex-end' }}>
          <button type="button" className="secondary" disabled={shown.length === 0} onClick={exportList}>
            Export to Excel ({shown.length})
          </button>
        </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>Invoice</th><th>Customer</th><th>Date</th><th>Due</th><th className="num">Total</th>
              <th className="num">Paid</th><th className="num">Balance</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.invoice_id}>
                <td><Link to={`/invoices/${r.invoice_id}`}>{r.invoice_number}</Link></td>
                <td>{r.customer_name}</td>
                <td>{when(r.invoice_date)}</td>
                <td>{r.is_credit_note || !r.due_date ? '—' : when(r.due_date)}</td>
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
