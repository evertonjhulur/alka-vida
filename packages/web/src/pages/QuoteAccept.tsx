import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { money, when } from '../lib/format';
import Logo from '../components/Logo';

/**
 * The page the "accept this quote" link in a customer's email opens
 * (Everton, 30 Sep 2026). No sign-in: the unguessable link is the key, and
 * the page shows the quote and nothing else about the account.
 */

interface PublicQuote {
  quote_number: string; quote_date: string; valid_until: string | null; status: string;
  subtotal_cents: number; discount_amount_cents: number; gct_cents: number; gct_exempt: boolean;
  grand_total_cents: number; notes: string | null; delivery_mode: string; customer_name: string;
  lines: Array<{
    product_name: string; bottles_per_case: number; cases: number; loose_bottles: number;
    price_per_case_cents: number; price_per_bottle_cents: number; line_total_cents: number;
  }>;
}

export default function QuoteAccept() {
  const { token } = useParams();
  const [q, setQ] = useState<PublicQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/public/quote/${token}`).then(async (r) => {
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error ?? 'This link is not valid.');
      setQ(data);
    }).catch((e) => setError(e.message));
  }, [token]);

  async function answer(decision: 'Accepted' | 'Declined') {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/public/quote/${token}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision, reason: reason || undefined }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error ?? 'Something went wrong.');
      setDone(decision === 'Accepted'
        ? `Thank you. Quotation ${data.quoteNumber} is accepted. We will be in touch to arrange it.`
        : `Thank you for letting us know. Quotation ${data.quoteNumber} is marked declined.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally { setBusy(false); }
  }

  return (
    <div className="quote-public">
      <div style={{ marginBottom: 16 }}><Logo height={70} /></div>
      {error && <div className="notice error">{error}</div>}
      {done && <div className="notice ok">{done}</div>}
      {q && !done && (
        <div className="panel paper">
          <h1 style={{ marginTop: 0 }}>Quotation {q.quote_number}</h1>
          <p className="muted">For {q.customer_name} · {when(q.quote_date)}
            {q.valid_until && <> · valid until {when(q.valid_until)}</>}</p>
          <table className="paper-lines">
            <thead><tr><th>Item</th><th>Quantity</th><th className="num">Unit price</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {q.lines.map((l, i) => {
                const cased = Number(l.bottles_per_case) > 0;
                return (
                  <tr key={i}>
                    <td>{l.product_name}</td>
                    <td>{cased ? `${l.cases} case${Number(l.cases) === 1 ? "" : "s"}` : `${l.loose_bottles}`}</td>
                    <td className="num">{money(Number(cased ? l.price_per_case_cents : l.price_per_bottle_cents))}</td>
                    <td className="num">{money(Number(l.line_total_cents))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="paper-totals">
            <div className="total-line"><span>Subtotal</span><span>{money(Number(q.subtotal_cents))}</span></div>
            {Number(q.discount_amount_cents) > 0 && (
              <div className="total-line"><span>Discount</span><span>−{money(Number(q.discount_amount_cents))}</span></div>
            )}
            <div className="total-line"><span>{q.gct_exempt ? 'GCT (exempt)' : 'GCT 15%'}</span><span>{money(Number(q.gct_cents))}</span></div>
            <div className="total-line grand"><span>Total</span><span>{money(Number(q.grand_total_cents))}</span></div>
          </div>
          {q.notes && <p>{q.notes}</p>}
          <p className="muted small">{q.delivery_mode === 'Pickup' ? 'Collected from our plant.' : 'Delivered to you.'}</p>

          {q.status === 'Sent' ? (
            declining ? (
              <div className="sub-panel">
                <label htmlFor="why">Would you tell us why? (optional)</label>
                <input id="why" style={{ width: '100%' }} value={reason} onChange={(e) => setReason(e.target.value)} />
                <div className="row" style={{ marginTop: 10 }}>
                  <button className="danger-soft" disabled={busy} onClick={() => answer('Declined')}>Decline the quote</button>
                  <button className="secondary" onClick={() => setDeclining(false)}>Back</button>
                </div>
              </div>
            ) : (
              <div className="row">
                <button className="wide" disabled={busy} onClick={() => answer('Accepted')}>Accept this quote</button>
                <button className="secondary" disabled={busy} onClick={() => setDeclining(true)}>No, thank you</button>
              </div>
            )
          ) : (
            <div className="notice info">This quotation is {q.status === 'Converted' ? 'accepted and being arranged' : q.status.toLowerCase()}.</div>
          )}
        </div>
      )}
      <p className="muted small">Alka Vida · 1506 Investments Limited</p>
    </div>
  );
}
