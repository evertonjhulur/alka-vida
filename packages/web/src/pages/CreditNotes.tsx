import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, download, type Session } from '../lib/api';
import { money, toCents, when } from '../lib/format';
import CustomerPicker, { type PickerCustomer } from '../components/CustomerPicker';

/**
 * Credit notes (Everton's revisions, 30 Sep 2026, point 2).
 *
 * Money given back to a customer, as its own numbered document. Either by
 * PRODUCT - goods returned, short-delivered or damaged, priced like an
 * invoice with GCT worked out the same way - or by AMOUNT, GCT included,
 * with the GCT part split out for the books. Against one of their invoices
 * or just against the account. Office staff raise them; an administrator's
 * approval (Needs a decision) is what makes an office one count.
 */

interface Row {
  id: string; invoice_number: string; invoice_date: string; customer_id: string; customer_name: string;
  grand_total_cents: number; gct_cents: number; credit_status: string; reason: string | null;
  linked_invoice_number: string | null; linked_invoice_id: string | null; sent_date: string | null;
  line_count: number; pending_amount_cents: number | null;
}
interface Inv {
  invoice_id: string; invoice_number: string; invoice_date: string; grand_total_cents: number;
  balance_cents: number; is_credit_note: boolean; status: string;
}
interface Priced {
  product_id: string; name: string; bottles_per_case: number;
  price_per_case_cents: number; price_per_bottle_cents: number;
}
interface InvLine {
  product_id: string; product_name: string; bottles_per_case: number; cases: number; loose_bottles: number;
  price_per_case_cents: number; price_per_bottle_cents: number;
}
interface Customer extends PickerCustomer { gct_exempt?: boolean }

export default function CreditNotes({ session }: { session: Session }) {
  const [params] = useSearchParams();
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showNew, setShowNew] = useState(params.get('new') === '1');

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState(params.get('customer') ?? '');
  const [invoices, setInvoices] = useState<Inv[]>([]);
  const [invoiceId, setInvoiceId] = useState(params.get('invoice') ?? '');
  const [how, setHow] = useState<'product' | 'amount'>('product');
  const [prices, setPrices] = useState<Priced[]>([]);
  const [lines, setLines] = useState<Array<{ productId: string; qty: number; price: string; name?: string; bpc?: number }>>([]);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [gctExempt, setGctExempt] = useState(false);

  const load = () => api.get<Row[]>('/api/credit-notes').then(setRows);
  useEffect(() => {
    load().catch((e) => setError(e.message));
    api.get<Customer[]>('/api/customers').then(setCustomers).catch(() => {});
  }, []);

  useEffect(() => {
    setInvoices([]); setPrices([]);
    if (!customerId) return;
    api.get<Inv[]>(`/api/invoices?customerId=${customerId}`)
      .then((r) => setInvoices(r.filter((i) => !i.is_credit_note && i.status !== 'Cancelled'))).catch(() => {});
    api.get<Priced[]>(`/api/customers/${customerId}/prices`).then(setPrices).catch(() => {});
  }, [customerId]);

  // Choosing an invoice offers its own lines, at the prices it was billed at.
  useEffect(() => {
    const c = customers.find((x) => x.id === customerId);
    setGctExempt(!!c?.gct_exempt);
    if (!invoiceId) return;
    api.get<{ lines: InvLine[]; gct_exempt?: boolean }>(`/api/invoices/${invoiceId}`).then((inv) => {
      setGctExempt(!!inv.gct_exempt);
      setLines(inv.lines.map((l) => {
        const cased = Number(l.bottles_per_case) > 0;
        return {
          productId: l.product_id, qty: 0, name: l.product_name, bpc: Number(l.bottles_per_case),
          price: (Number(cased ? l.price_per_case_cents : l.price_per_bottle_cents) / 100).toFixed(2),
        };
      }));
    }).catch(() => {});
  }, [invoiceId, customerId, customers.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const productOf = (id: string) => prices.find((p) => p.product_id === id);
  const usual = (p?: Priced) => (!p ? 0 : Number(p.bottles_per_case) > 0 ? Number(p.price_per_case_cents) : Number(p.price_per_bottle_cents));
  const unitOf = (l: { productId: string; price: string }) =>
    (l.price.trim() === '' ? usual(productOf(l.productId)) : Math.max(0, Math.round(Number(l.price) * 100) || 0));

  const preview = useMemo(() => {
    if (how === 'amount') {
      const total = toCents(amount);
      const sub = gctExempt ? total : Math.round(total / 1.15);
      return { subtotal: sub, gct: total - sub, total };
    }
    const sub = lines.reduce((a, l) => a + l.qty * unitOf(l), 0);
    const gct = gctExempt ? 0 : Math.round(sub * 0.15);
    return { subtotal: sub, gct, total: sub + gct };
  }, [how, amount, lines, gctExempt, prices]); // eslint-disable-line react-hooks/exhaustive-deps

  async function raise(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setMsg(null);
    try {
      const body = how === 'amount'
        ? { customerId, invoiceId: invoiceId || null, amountCents: toCents(amount), reason }
        : {
          customerId, invoiceId: invoiceId || null, reason,
          lines: lines.filter((l) => l.qty > 0).map((l) => {
            const cased = Number(productOf(l.productId)?.bottles_per_case ?? l.bpc) > 0;
            return {
              productId: l.productId,
              cases: cased ? l.qty : 0, looseBottles: cased ? 0 : l.qty,
              pricePerCaseCents: cased ? unitOf(l) : 0, pricePerBottleCents: cased ? 0 : unitOf(l),
            };
          }),
        };
      const r = await api.post<{ invoiceNumber: string; approvalRequestId: string | null; totalCents: number }>(
        '/api/credit-notes', body);
      setMsg(r.approvalRequestId
        ? `Credit note ${r.invoiceNumber} for ${money(r.totalCents)} raised. It is in Needs a decision and counts once approved.`
        : `Credit note ${r.invoiceNumber} for ${money(r.totalCents)} raised and taken off what they owe.`);
      setShowNew(false); setLines([]); setAmount(''); setReason(''); setInvoiceId('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not raise the credit note');
    } finally { setBusy(false); }
  }

  const email = (r: Row) => async () => {
    setBusy(true); setError(null); setMsg(null);
    try {
      const out = await api.post<{ sentTo: string }>(`/api/invoices/${r.id}/email`, {});
      setMsg(`${r.invoice_number} emailed to ${out.sentTo}.`);
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not send it'); } finally { setBusy(false); }
  };

  const notYet = prices.filter((p) => !lines.some((l) => l.productId === p.product_id));

  return (
    <>
      <div className="panel-head record-head">
        <div>
          <h1>Credit notes</h1>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            Money given back to a customer, as its own document. It comes off what they owe.
          </p>
        </div>
        <button type="button" className={showNew ? 'secondary' : ''} onClick={() => setShowNew(!showNew)}>
          {showNew ? 'Close' : 'New credit note'}
        </button>
      </div>
      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      {showNew && (
        <form className="panel" onSubmit={raise}>
          <h2 style={{ marginTop: 0 }}>New credit note</h2>
          <div className="row">
            <div className="field grow" style={{ maxWidth: 420 }}>
              <label htmlFor="cn-cust">For</label>
              <CustomerPicker id="cn-cust" customers={customers} value={customerId}
                              onChange={(id) => { setCustomerId(id); setInvoiceId(''); setLines([]); }} />
            </div>
            <div className="field grow">
              <label htmlFor="cn-inv">Against invoice</label>
              <select id="cn-inv" value={invoiceId} disabled={!customerId}
                      onChange={(e) => { setInvoiceId(e.target.value); if (!e.target.value) setLines([]); }}>
                <option value="">None, just their account</option>
                {invoices.map((i) => (
                  <option key={i.invoice_id} value={i.invoice_id}>
                    {i.invoice_number}, {when(i.invoice_date)}, {money(Number(i.grand_total_cents))}
                    {Number(i.balance_cents) > 0 ? ` (${money(Number(i.balance_cents))} owed)` : ' (paid)'}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <span className="label">Credit by</span>
            <div className="seg seg-small" role="group">
              <button type="button" className={how === 'product' ? 'active' : ''} onClick={() => setHow('product')}>Products (returned, short, damaged)</button>
              <button type="button" className={how === 'amount' ? 'active' : ''} onClick={() => setHow('amount')}>An amount</button>
            </div>
          </div>

          {how === 'product' ? (
            <>
              {lines.length > 0 && (
                <table className="lines-table">
                  <thead><tr><th>Product</th><th>How many</th><th className="num">Unit price</th><th className="num">Credit</th><th /></tr></thead>
                  <tbody>
                    {lines.map((l) => {
                      const p = productOf(l.productId);
                      const cased = Number(p?.bottles_per_case ?? l.bpc) > 0;
                      return (
                        <tr key={l.productId}>
                          <td>{p?.name ?? l.name ?? 'Product'}</td>
                          <td>
                            <input type="number" min="0" style={{ width: 80 }} value={l.qty || ''} aria-label={`How many ${p?.name}`}
                                   onChange={(e) => setLines(lines.map((x) => (x.productId === l.productId ? { ...x, qty: Math.max(0, Math.round(Number(e.target.value)) || 0) } : x)))} />
                            <span className="muted small"> {cased ? 'cases' : 'bottles'}</span>
                          </td>
                          <td className="num">
                            <input type="number" min="0" step="0.01" className="price-input" aria-label={`Unit price of ${p?.name}`}
                                   value={l.price === '' ? (usual(p) / 100).toFixed(2) : l.price}
                                   onChange={(e) => setLines(lines.map((x) => (x.productId === l.productId ? { ...x, price: e.target.value } : x)))} />
                          </td>
                          <td className="num">{money(l.qty * unitOf(l))}</td>
                          <td className="num"><button type="button" className="danger-soft"
                                                      onClick={() => setLines(lines.filter((x) => x.productId !== l.productId))}>Remove</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              {customerId && notYet.length > 0 && (
                <div className="add-row">
                  <span className="muted small">Add:</span>
                  {notYet.map((p) => (
                    <button key={p.product_id} type="button" className="secondary"
                            onClick={() => setLines([...lines, { productId: p.product_id, qty: 1, price: '' }])}>+ {p.name.replace(/^Alka Vida\s+/i, '')}</button>
                  ))}
                </div>
              )}
              {invoiceId && <p className="muted small">The invoice's own lines are listed at the prices billed; type how many to credit.</p>}
            </>
          ) : (
            <div className="field">
              <label htmlFor="cn-amt">Amount to credit, GCT included</label>
              <input id="cn-amt" type="number" min="0" step="0.01" style={{ width: 160 }} value={amount}
                     onChange={(e) => setAmount(e.target.value)} />
            </div>
          )}

          <div className="field">
            <label htmlFor="cn-why">Why (printed on the credit note) *</label>
            <input id="cn-why" required style={{ width: '100%' }} value={reason}
                   placeholder="e.g. 2 cases returned damaged on 28 Sep" onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="totals-card" style={{ maxWidth: 360 }}>
            <div className="total-line"><span>Before GCT</span><span>{money(preview.subtotal)}</span></div>
            <div className="total-line"><span>{gctExempt ? 'GCT (exempt)' : 'GCT 15%'}</span><span>{money(preview.gct)}</span></div>
            <div className="total-line grand"><span>Credit</span><span>{money(preview.total)}</span></div>
          </div>
          <p className="muted small">
            {session.role === 'admin' ? 'Counts as soon as it is raised.'
              : 'It goes to Needs a decision. What they owe does not change until an administrator approves it.'}
          </p>
          <button className="danger-soft" disabled={busy || !customerId || preview.total <= 0 || !reason.trim()}>
            {busy ? 'Raising…' : `Raise credit note for ${money(preview.total)}`}
          </button>
        </form>
      )}

      <div className="panel phone-cards">
        <table>
          <thead><tr><th>Credit note</th><th>Customer</th><th>Against</th><th>Why</th><th className="num">Credit</th><th>State</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => {
              const amt = r.credit_status === 'Pending' ? Math.abs(Number(r.pending_amount_cents ?? 0)) : Math.abs(Number(r.grand_total_cents));
              return (
                <tr key={r.id}>
                  <td className="lead"><Link to={`/invoices/${r.id}`}><strong>{r.invoice_number}</strong></Link>
                    <div className="muted small">{when(r.invoice_date)}</div></td>
                  <td data-label="Customer"><Link to={`/customers/${r.customer_id}`}>{r.customer_name}</Link></td>
                  <td data-label="Against">{r.linked_invoice_id
                    ? <Link to={`/invoices/${r.linked_invoice_id}`}>{r.linked_invoice_number}</Link>
                    : <span className="muted">their account</span>}</td>
                  <td data-label="Why" className="small">{r.reason}</td>
                  <td data-label="Credit" className="num money">{money(amt)}</td>
                  <td data-label="State">
                    <span className={`chip ${r.credit_status === 'Approved' ? 'ok' : r.credit_status === 'Pending' ? 'warn' : 'bad'}`}>
                      {r.credit_status === 'Approved' ? 'Counted' : r.credit_status === 'Pending' ? 'Waiting for approval' : 'Rejected'}
                    </span>
                    {r.sent_date && <div className="muted small">sent {when(r.sent_date)}</div>}
                  </td>
                  <td className="num">
                    <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                      <button type="button" className="secondary" disabled={busy}
                              onClick={() => download(`/api/invoices/${r.id}/pdf`, `${r.invoice_number}.pdf`).catch((e) => setError(e.message))}>PDF</button>
                      {r.credit_status === 'Approved' && (
                        <button type="button" className="secondary" disabled={busy} onClick={email(r)}>Email</button>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <p className="muted">No credit notes yet.</p>}
      </div>
    </>
  );
}
