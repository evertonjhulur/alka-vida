import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type Session } from '../lib/api';
import { money, date, statusTone } from '../lib/format';

interface Line {
  id: string; product_name: string; cases: number; loose_bottles: number;
  bottles_per_case: number; line_total_cents: number;
}
interface Payment {
  id: string; amount_cents: number; payment_date: string; method: string;
  status: string; is_reversal: boolean;
}
interface Invoice {
  invoiceId: string; invoiceNumber: string; customerId: string;
  invoice_date: string; due_date: string | null;
  subtotal_cents: number; discount_amount_cents: number; discount_status: string;
  gct_cents: number; grandTotalCents: number; amountPaidCents: number;
  balanceCents: number; status: string; lines: Line[]; payments: Payment[];
}

export default function InvoiceDetail({ session }: { session: Session }) {
  const { invoiceId } = useParams();
  const [inv, setInv] = useState<Invoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() { setInv(await api.get<Invoice>(`/api/invoices/${invoiceId}`)); }
  useEffect(() => { load().catch((e) => setError(e.message)); }, [invoiceId]);

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
        <table>
          <thead>
            <tr><th>Product</th><th>Quantity</th><th className="num">Line total</th></tr>
          </thead>
          <tbody>
            {inv.lines.map((l) => (
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
            {inv.payments.map((p) => (
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
        {inv.payments.length === 0 && <p className="muted">No payments recorded.</p>}
      </div>
    </>
  );
}
