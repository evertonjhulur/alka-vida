import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type Session } from '../lib/api';
import { money, toCents } from '../lib/format';

interface Allocation {
  invoiceId: string | null;
  invoiceNumber: string | null;
  amountCents: number;
}

interface StopRow {
  stopId: string;
  customerName: string;
  outcome: string;
  orderRef: string | null;
  deliveredSummary: string;
  paymentMethod: string | null;
  collectedCents: number;
  expectedCents: number;
  varianceCents: number;
  allocations: Allocation[];
  settled: boolean;
}

interface Review {
  sheetId: string;
  status: string;
  stops: StopRow[];
  totalCollectedCents: number;
  totalExpectedCents: number;
}

export default function Settlement({ session }: { session: Session }) {
  const { sheetId } = useParams();
  const [review, setReview] = useState<Review | null>(null);
  const [actualCash, setActualCash] = useState('');
  const [bottlesBack, setBottlesBack] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setReview(await api.get<Review>(`/api/delivery-sheets/${sheetId}/settlement`));
  }
  useEffect(() => { load().catch((e) => setError(e.message)); }, [sheetId]);

  if (error && !review) return <div className="notice error">{error}</div>;
  if (!review) return <p className="muted">Loading…</p>;

  const recorded = review.totalCollectedCents;
  const handedIn = actualCash === '' ? null : toCents(actualCash);
  const variance = handedIn === null ? null : handedIn - recorded;
  const locked = review.status === 'Completed';

  async function settle() {
    setBusy(true);
    setError(null);
    try {
      const out = await api.post<{
        paymentIds: string[]; cashVarianceCents: number;
      }>(`/api/delivery-sheets/${sheetId}/settle`, {
        actualCashCents: handedIn ?? 0,
        bottleActualReturned: bottlesBack === '' ? undefined : Number(bottlesBack),
        settlementNotes: notes || null,
      });
      setDone(
        `Route closed. ${out.paymentIds.length} payment(s) created. ` +
        `Cash variance ${money(out.cashVarianceCents)}.`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not settle the route');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Route settlement</h1>
      <p className="subtitle">
        Review every stop before closing. Confirming here is what turns the
        driver's collected cash into real payments.
      </p>

      {error && <div className="notice error">{error}</div>}
      {done && <div className="notice ok">{done}</div>}
      {locked && (
        <div className="notice info">
          This route is closed and locked. Any further correction must go through a
          payment reversal, reassignment, or an invoice edit.
        </div>
      )}

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Stops</h2>
        {/* Per-stop rather than one route-wide number, so any discrepancy
            traces back to a specific stop. */}
        <table>
          <thead>
            <tr>
              <th>Customer</th>
              <th>Outcome</th>
              <th>Delivered</th>
              <th>Method</th>
              <th className="num">Expected</th>
              <th className="num">Collected</th>
              <th className="num">Variance</th>
              <th>Suggested split</th>
            </tr>
          </thead>
          <tbody>
            {review.stops.map((s) => (
              <tr key={s.stopId}>
                <td>{s.customerName}</td>
                <td>
                  <span className={`chip ${s.outcome === 'Delivered' ? 'ok' : 'neutral'}`}>
                    {s.outcome}
                  </span>
                </td>
                <td className="small muted">{s.deliveredSummary || '—'}</td>
                <td className="small">{s.paymentMethod ?? '—'}</td>
                <td className="num">{money(s.expectedCents)}</td>
                <td className="num">{money(s.collectedCents)}</td>
                <td className="num">
                  {s.varianceCents === 0
                    ? <span className="muted">—</span>
                    : <span className="chip warn">{money(s.varianceCents)}</span>}
                </td>
                <td className="small">
                  {s.allocations.length === 0
                    ? <span className="muted">unallocated</span>
                    : s.allocations.map((a, i) => (
                        <div key={i}>
                          {a.invoiceNumber ?? 'unattached'} — {money(a.amountCents)}
                        </div>
                      ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {review.stops.length === 0 && <p className="muted">No stops on this sheet.</p>}
      </div>

      {!locked && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Cash and bottle reconciliation</h2>
          <div className="row">
            <div className="field">
              <label htmlFor="cash">Physical cash handed in</label>
              <input id="cash" type="number" step="0.01" min="0" placeholder="0.00"
                     style={{ width: 160 }} value={actualCash}
                     onChange={(e) => setActualCash(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="bottles">Empty bottles returned</label>
              <input id="bottles" type="number" min="0" style={{ width: 140 }}
                     value={bottlesBack} onChange={(e) => setBottlesBack(e.target.value)} />
            </div>
          </div>

          <div className="total-line">
            <span>Recorded across stops</span><span>{money(recorded)}</span>
          </div>
          <div className="total-line">
            <span>Handed in</span>
            <span>{handedIn === null ? '—' : money(handedIn)}</span>
          </div>
          <div className="total-line grand">
            <span>Driver variance</span>
            <span>{variance === null ? '—' : money(variance)}</span>
          </div>

          {variance !== null && variance !== 0 && (
            <div className="notice warn">
              This is a difference between what the driver recorded collecting and
              what they physically handed in. It is a matter to take up with the
              driver — it never touches a customer's account or any invoice.
            </div>
          )}

          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="notes">Settlement notes</label>
            <textarea id="notes" rows={2} style={{ width: '100%' }}
                      value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          <button disabled={busy || handedIn === null} onClick={settle}>
            {busy ? 'Settling…' : 'Confirm and close route'}
          </button>
          {session.role !== 'admin' && (
            <p className="muted small" style={{ marginTop: 8 }}>
              You can adjust how cash is split across invoices. Correcting what a
              driver recorded — the method, amount or quantities — is admin-only.
            </p>
          )}
        </div>
      )}
    </>
  );
}
