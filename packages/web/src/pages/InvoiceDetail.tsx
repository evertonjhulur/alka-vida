import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, download, type Session } from '../lib/api';
import { money, toCents, date, statusTone } from '../lib/format';

interface Line {
  id: string; product_id: string; product_name: string; cases: number;
  loose_bottles: number; bottles_per_case: number; line_total_cents: number;
  price_per_case_cents: number; price_per_bottle_cents: number;
}
interface Payment {
  id: string; amount_cents: number; payment_date: string; method: string;
  status: string; is_reversal: boolean; reference: string | null;
}
interface CustomerRef {
  id: string; name: string; email: string | null; phone: string | null;
  delivery_address: string | null; payment_terms: string | null;
  delivery_zone: string | null;
}
interface OrderRef {
  id: string; order_number: string; delivery_mode: string;
  order_date: string; requested_delivery_date: string | null; status: string;
}
interface Invoice {
  invoiceId: string; invoiceNumber: string; customerId: string;
  invoice_date: string; due_date: string | null;
  subtotal_cents: number; discount_amount_cents: number; discount_status: string;
  discount_percent: number;
  gct_cents: number; grandTotalCents: number; amountPaidCents: number;
  balanceCents: number; status: string; lines: Line[]; payments: Payment[];
  // Optional on purpose: an older server does not send these, and a screen
  // that assumes them turns a version mismatch into a blank page.
  customer?: CustomerRef; orders?: OrderRef[];
}

const METHODS = ['Cash', 'Card', 'Bank Transfer', 'Cheque', 'Other'] as const;

export default function InvoiceDetail({ session }: { session: Session }) {
  const { invoiceId } = useParams();
  const [inv, setInv] = useState<Invoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mailReady, setMailReady] = useState(false);
  const [pay, setPay] = useState({ open: false, amount: '', method: 'Cash', reference: '' });
  const [edit, setEdit] = useState<{ open: boolean; discount: string; reason: string;
    qty: Record<string, string> }>({ open: false, discount: '', reason: '', qty: {} });

  async function load() { setInv(await api.get<Invoice>(`/api/invoices/${invoiceId}`)); }
  useEffect(() => { load().catch((e) => setError(e.message)); }, [invoiceId]);
  useEffect(() => {
    api.get<{ configured: boolean }>('/api/settings/mail')
      .then((r) => setMailReady(r.configured)).catch(() => setMailReady(false));
  }, []);

  if (error && !inv) return <div className="notice error">{error}</div>;
  if (!inv) return <p className="muted">Loading…</p>;

  async function reverse(paymentId: string) {
    setBusy(true);
    try {
      const reason = window.prompt('Reason for reversing (optional)') ?? undefined;
      await api.post(`/api/payments/${paymentId}/reverse`, { reason });
      setMsg('Payment reversed. The original entry stays visible alongside its reversal.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reverse');
    } finally { setBusy(false); }
  }

  /** The document, as the customer would receive it. */
  async function downloadPdf() {
    setBusy(true); setError(null);
    try {
      await download(`/api/invoices/${inv!.invoiceId}/pdf`, `${inv!.invoiceNumber}.pdf`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not download the invoice');
    } finally { setBusy(false); }
  }

  /**
   * Sending is confirmed every time. This leaves the business and reaches a
   * customer - it should never happen on a stray click.
   */
  async function sendEmail() {
    const to = window.prompt(
      `Email ${inv!.invoiceNumber} to:`, inv!.customer?.email ?? '',
    );
    if (to === null || !to.trim()) return;
    setBusy(true); setError(null); setMsg(null);
    try {
      const out = await api.post<{ sentTo: string }>(
        `/api/invoices/${inv!.invoiceId}/email`, { to: to.trim() });
      setMsg(`Invoice sent to ${out.sentTo}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the invoice');
    } finally { setBusy(false); }
  }

  async function recordPayment() {
    setBusy(true); setError(null); setMsg(null);
    try {
      await api.post('/api/payments/receive', {
        customerId: inv!.customerId,
        amountCents: toCents(pay.amount),
        method: pay.method,
        reference: pay.reference || null,
        allocations: [{ invoiceId: inv!.invoiceId, amountCents: toCents(pay.amount) }],
      });
      setMsg(`Payment of ${money(toCents(pay.amount))} recorded against this invoice.`);
      setPay({ open: false, amount: '', method: 'Cash', reference: '' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record the payment');
    } finally { setBusy(false); }
  }

  /** Admin only. Editing an issued invoice always demands a reason. */
  async function saveEdit() {
    setBusy(true); setError(null); setMsg(null);
    try {
      await api.patch(`/api/invoices/${inv!.invoiceId}`, {
        discountPercent: Number(edit.discount) || 0,
        reason: edit.reason,
        lines: inv!.lines.map((l) => {
          const typed = Number(edit.qty[l.id]);
          const qty = Number.isFinite(typed) ? typed
            : Number(l.bottles_per_case) > 0 ? Number(l.cases) : Number(l.loose_bottles);
          return {
            productId: l.product_id,
            cases: Number(l.bottles_per_case) > 0 ? qty : 0,
            looseBottles: Number(l.bottles_per_case) > 0 ? 0 : qty,
            pricePerCaseCents: Number(l.price_per_case_cents),
            pricePerBottleCents: Number(l.price_per_bottle_cents),
          };
        }),
      });
      setMsg('Invoice updated. The change is recorded against your name.');
      setEdit({ open: false, discount: '', reason: '', qty: {} });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not edit the invoice');
    } finally { setBusy(false); }
  }

  function openEdit() {
    setEdit({
      open: true,
      discount: String(Number(inv!.discount_percent) || 0),
      reason: '',
      qty: Object.fromEntries(inv!.lines.map((l) => [
        l.id, String(Number(l.bottles_per_case) > 0 ? l.cases : l.loose_bottles),
      ])),
    });
  }

  return (
    <>
      <h1>{inv.invoiceNumber}</h1>
      <p className="subtitle">
        {date(inv.invoice_date)}
        {inv.due_date ? ` · due ${date(inv.due_date)}` : ''}
        {' · '}<span className={`chip ${statusTone(inv.status)}`}>{inv.status}</span>
      </p>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}
      {inv.discount_status === 'Pending' && (
        <div className="notice warn">
          A discount on this invoice is awaiting approval. Until it is approved the
          full amount remains owed.
        </div>
      )}

      <div className="panel">
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="secondary" disabled={busy} onClick={downloadPdf}>
            Download PDF
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={sendEmail}>
            Send by email
          </button>
          <button type="button" className="secondary" disabled={busy}
                  onClick={() => setPay({ ...pay, open: !pay.open, amount: '' })}>
            {pay.open ? 'Cancel payment' : 'Record payment'}
          </button>
          {session.role === 'admin' && (
            <button type="button" className="secondary" disabled={busy}
                    onClick={() => (edit.open ? setEdit({ ...edit, open: false }) : openEdit())}>
              {edit.open ? 'Cancel edit' : 'Edit invoice'}
            </button>
          )}
        </div>
        {!mailReady && (
          <p className="muted small">
            Sending is not set up on this machine yet — Send by email will explain
            what is needed. Download works regardless.
          </p>
        )}
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Billed to</h2>
        <div className="row">
          <div style={{ flex: '1 1 260px' }}>
            <strong>{inv.customer?.name ?? 'Customer details unavailable'}</strong>
            <div className="muted small">
              {[inv.customer?.delivery_address, inv.customer?.phone, inv.customer?.email]
                .filter(Boolean).join(' · ') || 'No contact details on file'}
            </div>
            <div className="muted small">
              {inv.customer?.payment_terms ?? 'No payment terms set'}
              {inv.customer?.delivery_zone ? ` · ${inv.customer.delivery_zone}` : ''}
            </div>
            <div style={{ marginTop: 6 }}>
              <Link to="/statement">Statement</Link>
            </div>
          </div>
          <div style={{ flex: '1 1 260px' }}>
            <strong>From</strong>
            {(inv.orders ?? []).length === 0 && (
              <div className="muted small">No order linked — raised directly.</div>
            )}
            {(inv.orders ?? []).map((o) => (
              <div key={o.id} className="small">
                {o.order_number} · {o.delivery_mode} · ordered {date(o.order_date)}
                {o.requested_delivery_date
                  ? ` · for ${date(o.requested_delivery_date)}` : ''}
              </div>
            ))}
          </div>
        </div>
      </div>

      {pay.open && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Record a payment against this invoice</h2>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div className="field">
              <label>Amount</label>
              <input type="number" step="0.01" min="0" style={{ width: 150 }}
                     value={pay.amount} disabled={busy}
                     onChange={(e) => setPay({ ...pay, amount: e.target.value })} />
              <span className="muted small">balance {money(inv.balanceCents)}</span>
            </div>
            <div className="field">
              <label>Method</label>
              <select value={pay.method} disabled={busy}
                      onChange={(e) => setPay({ ...pay, method: e.target.value })}>
                {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Reference</label>
              <input value={pay.reference} disabled={busy}
                     onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
            </div>
            <div className="field">
              <button type="button" disabled={busy || toCents(pay.amount) <= 0}
                      onClick={recordPayment}>Record</button>
            </div>
          </div>
          <p className="muted small">
            Anything above the balance is recorded as a payment on the account, not
            as a credit on this invoice.
          </p>
        </div>
      )}

      {edit.open && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Edit this invoice</h2>
          <p className="muted small" style={{ marginTop: 0 }}>
            Changing an issued invoice is recorded against your name, and a credit
            note is raised automatically if the total goes down.
          </p>
          <table>
            <thead>
              <tr><th>Product</th><th>Quantity</th></tr>
            </thead>
            <tbody>
              {(inv.lines ?? []).map((l) => (
                <tr key={l.id}>
                  <td>{l.product_name}</td>
                  <td>
                    <input type="number" min="0" style={{ width: 110 }}
                           value={edit.qty[l.id] ?? ''} disabled={busy}
                           onChange={(e) => setEdit({
                             ...edit, qty: { ...edit.qty, [l.id]: e.target.value },
                           })} />
                    <span className="muted small">
                      {' '}{Number(l.bottles_per_case) > 0 ? 'cases' : 'bottles'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div className="field">
              <label>Discount %</label>
              <input type="number" min="0" max="100" step="0.01" style={{ width: 110 }}
                     value={edit.discount} disabled={busy}
                     onChange={(e) => setEdit({ ...edit, discount: e.target.value })} />
            </div>
            <div className="field" style={{ flex: '1 1 300px' }}>
              <label>Why (required)</label>
              <input style={{ width: '100%' }} value={edit.reason} disabled={busy}
                     onChange={(e) => setEdit({ ...edit, reason: e.target.value })} />
            </div>
            <div className="field">
              <button type="button" disabled={busy || !edit.reason.trim()}
                      onClick={saveEdit}>Save changes</button>
            </div>
          </div>
        </div>
      )}

      <div className="panel">
        <table>
          <thead>
            <tr><th>Product</th><th>Quantity</th><th className="num">Line total</th></tr>
          </thead>
          <tbody>
            {(inv.lines ?? []).map((l) => (
              <tr key={l.id}>
                <td>{l.product_name}</td>
                <td>{Number(l.bottles_per_case) > 0
                  ? `${l.cases} cases` : `${l.loose_bottles} bottles`}</td>
                <td className="num">{money(Number(l.line_total_cents))}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ maxWidth: 320, marginLeft: 'auto', marginTop: 14 }}>
          <div className="total-line">
            <span>Subtotal</span><span>{money(Number(inv.subtotal_cents))}</span>
          </div>
          <div className="total-line">
            <span>Discount</span><span>-{money(Number(inv.discount_amount_cents))}</span>
          </div>
          <div className="total-line">
            <span>GCT 15%</span><span>{money(Number(inv.gct_cents))}</span>
          </div>
          <div className="total-line grand">
            <span>Total</span><span>{money(inv.grandTotalCents)}</span>
          </div>
          <div className="total-line"><span>Paid</span><span>{money(inv.amountPaidCents)}</span></div>
          <div className="total-line grand">
            <span>Balance</span><span>{money(inv.balanceCents)}</span>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Payments</h2>
        <p className="muted small">
          The paid figure is always the sum of confirmed payments below — it is never
          set directly.
        </p>
        <table>
          <thead>
            <tr>
              <th>Date</th><th>Method</th><th>Status</th>
              <th className="num">Amount</th>{session.role === 'admin' && <th />}
            </tr>
          </thead>
          <tbody>
            {(inv.payments ?? []).map((p) => (
              <tr key={p.id}>
                <td>{date(p.payment_date)}</td>
                <td>{p.method}</td>
                <td>
                  <span className={`chip ${p.is_reversal ? 'bad'
                    : p.status === 'Confirmed' ? 'ok' : 'neutral'}`}>
                    {p.is_reversal ? 'Reversal' : p.status}
                  </span>
                </td>
                <td className="num">{money(Number(p.amount_cents))}</td>
                {session.role === 'admin' && (
                  <td className="num">
                    {!p.is_reversal && (
                      <button className="secondary" disabled={busy}
                              onClick={() => reverse(p.id)}>Reverse</button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {(inv.payments ?? []).length === 0 && <p className="muted">No payments recorded.</p>}
      </div>
    </>
  );
}
