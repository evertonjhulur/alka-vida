import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, downloadPost } from '../lib/api';
import { money, date, when } from '../lib/format';
import { INVOICE_FILTERS, STATE_TONE, invoiceMatches, invoiceState } from '../lib/invoiceState';
import { BatchBar, SortTh, StatusSelect, TickAllTh, TickTd, sendSummary, useSort, useTicks } from '../components/ListTools';
import { downloadCsv, dollars } from '../lib/csv';
import StatementDialog from '../components/StatementDialog';

interface Row {
  invoice_id: string; invoice_number: string; invoice_date: string;
  customer_name: string; customer_id: string; lifecycle?: string;
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
      setRows(await api.get<Row[]>('/api/invoices'));
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not raise them'); } finally { setBusy(false); }
  }
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [statementOpen, setStatementOpen] = useState(false);

  const navigate = useNavigate();
  const load = () => api.get<Row[]>('/api/invoices').then(setRows).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);

  const q = search.trim().toLowerCase();
  const filtered = rows.filter((r) => (q === '' || r.invoice_number.toLowerCase().includes(q)
      || (r.customer_name ?? '').toLowerCase().includes(q))
    && invoiceMatches(r, status)
    && (!from || date(r.invoice_date) >= from) && (!to || date(r.invoice_date) <= to));
  const { sorted: shown, sort, onSort } = useSort(filtered, {
    number: (r) => r.invoice_number, customer: (r) => r.customer_name, date: (r) => date(r.invoice_date),
    due: (r) => (r.due_date && !r.is_credit_note ? date(r.due_date) : null),
    total: (r) => Number(r.grand_total_cents), paid: (r) => Number(r.amount_paid_cents),
    balance: (r) => Number(r.balance_cents), status: (r) => invoiceState(r),
  });
  const ticks = useTicks(shown.map((r) => r.invoice_id));
  const picked = shown.filter((r) => ticks.has(r.invoice_id));
  const pickedOwed = picked.reduce((n, r) => n + Math.max(0, Number(r.balance_cents)), 0);

  async function batch(fn: () => Promise<string | null>, failed: string) {
    setBusy(true); setError(null); setMsg(null);
    try { const m = await fn(); if (m) setMsg(m); } catch (e) { setError(e instanceof Error ? e.message : failed); }
    finally { setBusy(false); }
  }
  const ids = () => picked.map((r) => r.invoice_id);
  const printPicked = () => batch(async () => {
    await downloadPost('/api/batch/invoices/print.pdf', { ids: ids() }, `Invoices-${picked.length}.pdf`);
    return `${picked.length} printed to one PDF.`;
  }, 'Could not build the PDF');
  const sendPicked = () => batch(async () => {
    const r = await api.post<Array<{ label: string; sentTo?: string; error?: string }>>('/api/batch/invoices/send', { ids: ids() });
    const s = sendSummary(r);
    if (s.problems.length) setError(`Not sent: ${s.problems.join(' · ')}`);
    await load();
    return s.ok;
  }, 'Could not send them');
  const markSent = () => batch(async () => {
    const open = picked.filter((r) => ['Open'].includes(invoiceState(r)));
    for (const r of open) await api.post(`/api/invoices/${r.invoice_id}/sent`, {});
    await load();
    return `${open.length} marked as sent.`;
  }, 'Could not mark them');
  const oneCustomer = new Set(picked.map((r) => r.customer_id)).size === 1;
  const owedPicked = picked.filter((r) => Number(r.balance_cents) > 0 && !r.is_credit_note && invoiceState(r) !== 'Cancelled');
  const receivePayment = () => navigate(`/customers/${picked[0].customer_id}?tab=transactions&pay=${owedPicked.map((r) => r.invoice_id).join(',')}`);

  /** The list as it is filtered on screen, for Excel (team feedback, point 13). */
  function exportList(list: Row[] = shown) {
    downloadCsv(`invoices${from || to ? `-${from || 'start'}-to-${to || 'today'}` : ''}`, [
      ['Invoice', 'Customer', 'Date', 'Due', 'Type', 'Subtotal', 'Discount', 'GCT', 'Total', 'Paid', 'Balance', 'Status'],
      ...list.map((r) => [
        r.invoice_number, r.customer_name, date(r.invoice_date), r.due_date ? date(r.due_date) : '',
        r.is_credit_note ? 'Credit note' : 'Invoice',
        dollars(r.subtotal_cents), dollars(r.discount_amount_cents), dollars(r.gct_cents),
        dollars(r.grand_total_cents), dollars(r.amount_paid_cents), dollars(r.balance_cents), invoiceState(r),
      ]),
    ]);
  }

  return (
    <>
      <div className="panel-head record-head">
        <div>
          <h1>Invoices</h1>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            An invoice is raised at the moment of delivery, from the quantities actually delivered, or
            once a week or month for customers billed that way.
          </p>
        </div>
        {/* A customer's statement without opening their page first: the
            Statements menu item this replaces (UX review, 11 Oct 2026). */}
        <div className="record-actions">
          <button type="button" className="secondary" onClick={() => setStatementOpen(true)}>Statement…</button>
        </div>
      </div>
      {statementOpen && (
        <StatementDialog onClose={() => setStatementOpen(false)}
                         onDone={(m) => { setError(null); setMsg(m); }} />
      )}
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
                  <td className="lead"><Link to={`/customers/${w.customerId}?tab=transactions`}>{w.customerName}</Link></td>
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
        <StatusSelect id="st" value={status} onChange={setStatus} options={INVOICE_FILTERS} />
        <div className="field">
          <label htmlFor="ifrom">From</label>
          <input id="ifrom" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ito">To</label>
          <input id="ito" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="field" style={{ alignSelf: 'flex-end' }}>
          <button type="button" className="secondary" disabled={shown.length === 0} onClick={() => exportList()}>
            Export to Excel ({shown.length})
          </button>
        </div>
        </div>

        <BatchBar count={picked.length} noun={['invoice', 'invoices']} busy={busy}
                  summary={pickedOwed > 0 ? `${money(pickedOwed)} still owed on them` : undefined}
                  onClear={ticks.clear}
                  actions={[
                    { label: 'Print (one PDF)', run: printPicked },
                    { label: 'Send by email (each customer gets theirs together)', run: sendPicked },
                    { label: 'Receive payment', run: receivePayment,
                      disabledWhy: !oneCustomer ? 'Tick invoices of one customer' : owedPicked.length === 0 ? 'Nothing owed on these' : null },
                    { label: 'Mark as sent', run: markSent,
                      disabledWhy: picked.some((r) => invoiceState(r) === 'Open') ? null : 'None of these is waiting to be sent' },
                    { label: 'Export to Excel', run: () => exportList(picked) },
                  ]} />
        <table>
          <thead>
            <tr>
              <TickAllTh all={ticks.all} some={ticks.some} onToggle={ticks.toggleAll} disabled={shown.length === 0} />
              <SortTh label="Invoice" k="number" sort={sort} onSort={onSort} />
              <SortTh label="Customer" k="customer" sort={sort} onSort={onSort} />
              <SortTh label="Date" k="date" sort={sort} onSort={onSort} />
              <SortTh label="Due" k="due" sort={sort} onSort={onSort} />
              <SortTh label="Total" k="total" sort={sort} onSort={onSort} className="num" />
              <SortTh label="Paid" k="paid" sort={sort} onSort={onSort} className="num" />
              <SortTh label="Balance" k="balance" sort={sort} onSort={onSort} className="num" />
              <SortTh label="Status" k="status" sort={sort} onSort={onSort} />
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const st = invoiceState(r);
              return (
                <tr key={r.invoice_id}>
                  <TickTd checked={ticks.has(r.invoice_id)} onToggle={() => ticks.toggle(r.invoice_id)} label={`Tick ${r.invoice_number}`} />
                  <td><Link to={`/invoices/${r.invoice_id}`}>{r.invoice_number}</Link></td>
                  <td><Link to={`/customers/${r.customer_id}?tab=transactions`}>{r.customer_name}</Link></td>
                  <td>{when(r.invoice_date)}</td>
                  <td>{r.is_credit_note || !r.due_date ? '—' : when(r.due_date)}</td>
                  <td className="num">{money(Number(r.grand_total_cents))}</td>
                  <td className="num">{money(Number(r.amount_paid_cents))}</td>
                  <td className="num">{money(Number(r.balance_cents))}</td>
                  <td><span className={`chip ${STATE_TONE[st]}`}>{st}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {shown.length === 0 && (
          <p className="muted">
            {rows.length === 0 ? 'No invoices found.' : 'Nothing matches. Try another status or dates.'}
          </p>
        )}
      </div>
    </>
  );
}
