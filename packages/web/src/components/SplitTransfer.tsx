import { useMemo, useState } from 'react';
import { api, idempotencyKey } from '../lib/api';
import { payMethods } from '../lib/payments';
import { money, toCents, day, todayInJamaica } from '../lib/format';
import CustomerPicker, { type PickerCustomer } from './CustomerPicker';

/**
 * One bank transfer that pays invoices of several customers (Everton and
 * Luckie, 4 Nov 2026) - the app's version of QuickBooks' "Find other
 * matches": every open invoice of every customer, a Payment box on each, a
 * running "received · allocated · left" line. What is left stays as credit
 * on a customer picked here. One payment, RCT number and receipt per customer.
 */

export interface OpenInvoice {
  invoice_id: string; invoice_number: string; invoice_date: string; customer_id: string;
  customer_name?: string; grand_total_cents: number | string; balance_cents: number | string;
}

const METHODS: Array<[string, string]> = [
  ['Bank Transfer', 'Bank transfer'], ['Cheque', 'Cheque'], ['Card', 'Card'], ['Cash', 'Cash'], ['Other', 'Other'],
];
const SHOW = 150;

export default function SplitTransfer({ invoices, customers, takeCard, onDone, onCancel }: {
  invoices: OpenInvoice[]; customers: PickerCustomer[]; takeCard: boolean;
  onDone: (message: string) => void; onCancel: () => void;
}) {
  const [f, setF] = useState({ amount: '', date: '', method: 'Bank Transfer', reference: '', notes: '', receipt: true });
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [pay, setPay] = useState<Record<string, string>>({});
  const [leftWith, setLeftWith] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(() => idempotencyKey('split'));

  const received = toCents(f.amount || '0');
  const owed = (i: OpenInvoice) => Number(i.balance_cents);
  const ticked = invoices.filter((i) => pay[i.invoice_id] !== undefined);
  const allocated = ticked.reduce((s, i) => s + Math.max(0, toCents(pay[i.invoice_id] || '0')), 0);
  const left = received - allocated;
  const customersTicked = new Set(ticked.map((i) => i.customer_id)).size;

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return invoices.filter((i) => pay[i.invoice_id] !== undefined || (
      (!q || i.invoice_number.toLowerCase().includes(q) || (i.customer_name ?? '').toLowerCase().includes(q))
      && (!from || i.invoice_date.slice(0, 10) >= from) && (!to || i.invoice_date.slice(0, 10) <= to)));
  }, [invoices, search, from, to, pay]);

  const toggle = (i: OpenInvoice) => setPay((p) => {
    const next = { ...p };
    if (next[i.invoice_id] !== undefined) { delete next[i.invoice_id]; return next; }
    // Ticking fills what is still owed, or what is left of the transfer if less.
    const room = received > 0 ? Math.max(0, received - allocated) : owed(i);
    next[i.invoice_id] = (Math.min(owed(i), room || owed(i)) / 100).toFixed(2);
    return next;
  });

  const problem = received <= 0 ? 'Enter the amount of the transfer.'
    : ticked.length === 0 ? 'Tick the invoices it pays.'
      : ticked.some((i) => toCents(pay[i.invoice_id] || '0') <= 0) ? 'Each ticked invoice needs an amount.'
        : ticked.some((i) => toCents(pay[i.invoice_id] || '0') > owed(i)) ? 'An amount is more than that invoice still owes.'
          : left < 0 ? `The invoices take ${money(-left)} more than was received.`
            : left > 0 && !leftWith ? `Choose who keeps the ${money(left)} left over, as credit.` : null;

  async function save() {
    if (problem) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{
        parts: Array<{ customerName: string; amountCents: number; receiptNumber: string | null }>;
        receipts: Array<{ customerName: string; sentTo?: string; receiptNumber?: string; error?: string }>;
        replayed: boolean;
      }>('/api/payments/split', {
        amountCents: received, method: f.method, paymentDate: f.date || null,
        reference: f.reference || null, notes: f.notes || null,
        allocations: ticked.map((i) => ({ invoiceId: i.invoice_id, amountCents: toCents(pay[i.invoice_id]) })),
        leftoverCustomerId: left > 0 ? leftWith : null,
        idempotencyKey: key, sendReceipt: f.receipt,
      });
      if (r.replayed) { onDone('That transfer was already recorded.'); return; }
      const parts = r.parts.map((p) => `${p.customerName} ${money(p.amountCents)}${p.receiptNumber ? ` (${p.receiptNumber})` : ''}`).join('; ');
      const sent = r.receipts.filter((x) => x.sentTo).length;
      const failed = r.receipts.filter((x) => x.error);
      onDone(`${money(received)} transfer recorded for ${r.parts.length} ${r.parts.length === 1 ? 'customer' : 'customers'}: ${parts}.`
        + (sent ? ` ${sent} ${sent === 1 ? 'receipt' : 'receipts'} emailed.` : '')
        + (failed.length ? ` No receipt for ${failed.map((x) => x.customerName).join(', ')}: ${failed[0].error}` : ''));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the transfer');
    } finally { setBusy(false); }
  }

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Split a bank transfer across customers</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        One transfer that pays invoices of several customers. Each customer gets their own payment and receipt
        number; all carry the bank reference below.
      </p>
      {error && <div className="notice error">{error}</div>}
      <div className="pay-fields">
        <div className="field"><label htmlFor="st-amt">Amount received</label>
          <input id="st-amt" inputMode="decimal" placeholder="0.00" value={f.amount}
                 onChange={(e) => setF({ ...f, amount: e.target.value })} /></div>
        <div className="field"><label htmlFor="st-meth">How</label>
          <select id="st-meth" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
            {payMethods(METHODS, takeCard, f.method).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select></div>
        <div className="field"><label htmlFor="st-date">Date paid</label>
          <input id="st-date" type="date" value={f.date} max={todayInJamaica()}
                 onChange={(e) => setF({ ...f, date: e.target.value })} /></div>
        <div className="field"><label htmlFor="st-ref">Bank ref</label>
          <input id="st-ref" placeholder="e.g. RTGS no." value={f.reference}
                 onChange={(e) => setF({ ...f, reference: e.target.value })} /></div>
      </div>

      <div className="row" style={{ gap: 8, margin: '10px 0', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: '1 1 220px' }}><label htmlFor="st-q">Find invoices</label>
          <input id="st-q" placeholder="Customer or invoice no." value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <div className="field"><label htmlFor="st-from">From</label>
          <input id="st-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="field"><label htmlFor="st-to">To</label>
          <input id="st-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      </div>

      <div className="table-scroll">
        <table className="phone-cards">
          <thead>
            <tr><th aria-label="Tick" /><th>Date</th><th>Invoice</th><th>Customer</th>
              <th className="num">Total</th><th className="num">Still owed</th><th className="num">Payment</th></tr>
          </thead>
          <tbody>
            {shown.slice(0, SHOW).map((i) => {
              const on = pay[i.invoice_id] !== undefined;
              return (
                <tr key={i.invoice_id} className={on ? 'row-on' : undefined}>
                  <td><input type="checkbox" aria-label={`Tick ${i.invoice_number}`} checked={on} onChange={() => toggle(i)} /></td>
                  <td data-label="Date">{day(i.invoice_date)}</td>
                  <td data-label="Invoice">{i.invoice_number}</td>
                  <td data-label="Customer">{i.customer_name ?? ''}</td>
                  <td data-label="Total" className="num">{money(Number(i.grand_total_cents))}</td>
                  <td data-label="Still owed" className="num">{money(owed(i))}</td>
                  <td data-label="Payment" className="num">
                    <input inputMode="decimal" aria-label={`Payment on ${i.invoice_number}`} style={{ width: 110, textAlign: 'right' }}
                           value={pay[i.invoice_id] ?? ''} placeholder="0.00"
                           onChange={(e) => setPay((p) => ({ ...p, [i.invoice_id]: e.target.value }))} />
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && <tr><td colSpan={7} className="muted">No open invoices match.</td></tr>}
          </tbody>
        </table>
      </div>
      {shown.length > SHOW && <p className="muted small">Showing {SHOW} of {shown.length}. Search or choose dates to narrow it.</p>}

      <div className="notice" style={{ margin: '12px 0' }}>
        <strong>{money(received)}</strong> received · <strong>{money(allocated)}</strong> on {ticked.length}{' '}
        {ticked.length === 1 ? 'invoice' : 'invoices'} ({customersTicked} {customersTicked === 1 ? 'customer' : 'customers'}) ·{' '}
        <strong className={left < 0 ? 'bad-text' : undefined}>{money(Math.abs(left))}</strong> {left < 0 ? 'too much' : 'left'}
      </div>

      {left > 0 && received > 0 && (
        <div className="field" style={{ maxWidth: 420 }}>
          <label htmlFor="st-left">Who keeps the {money(left)} left over, as credit</label>
          <CustomerPicker id="st-left" customers={customers} value={leftWith} onChange={setLeftWith} />
        </div>
      )}

      <details className="pay-notes">
        <summary className="small">Add a note</summary>
        <input aria-label="Note" style={{ width: '100%', marginTop: 6 }} value={f.notes}
               onChange={(e) => setF({ ...f, notes: e.target.value })} />
      </details>
      <label className="check">
        <input type="checkbox" checked={f.receipt} onChange={(e) => setF({ ...f, receipt: e.target.checked })} />
        Email each customer a receipt for their part
      </label>

      <div className="pay-foot">
        <span className="small">{problem ?? 'Ready to record.'}</span>
        <span className="row" style={{ gap: 8 }}>
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="button" disabled={busy || !!problem} onClick={save}>
            {busy ? 'Recording…' : `Record ${money(received)}`}
          </button>
        </span>
      </div>
    </div>
  );
}
