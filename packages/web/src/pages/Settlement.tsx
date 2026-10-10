import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Session } from '../lib/api';
import { money, toCents, date, when } from '../lib/format';
import { ReturnsPanel, TruckTable, KIND_WORDS, collectionSummary, type Collection, type Truck } from '../components/Truck';

interface Allocation {
  invoiceId: string | null;
  invoiceNumber: string | null;
  amountCents: number;
}

interface OpenInvoice {
  invoiceId: string;
  invoiceNumber: string;
  balanceCents: number;
  grandTotalCents: number;
  invoiceDate: string;
  status: string;
}

interface StopRow {
  stopId: string;
  customerName: string;
  outcome: string;
  orderRef: string | null;
  paymentAfterDelivery?: boolean;
  note?: string | null;
  deliveredSummary: string;
  paymentMethod: string | null;
  bottlesDeliveredFull: number;
  bottlesEmptiesPickedUp: number;
  bottlesLostDamaged: number;
  collectedCents: number;
  expectedCents: number;
  varianceCents: number;
  allocations: Allocation[];
  openInvoices: OpenInvoice[];
  settled: boolean;
}

interface Review {
  sheetId: string;
  status: string;
  stops: StopRow[];
  totalCollectedCents: number;
  totalExpectedCents: number;
}

/** Per-stop working state for the cash split: invoiceId -> amount typed. */
type Split = Record<string, string>;

export default function Settlement({ session }: { session: Session }) {
  const { sheetId } = useParams();
  const [review, setReview] = useState<Review | null>(null);
  const [actualCash, setActualCash] = useState('');
  const [cashTouched, setCashTouched] = useState(false);
  const [bottlesBack, setBottlesBack] = useState('');
  const [notes, setNotes] = useState('');
  const [openStop, setOpenStop] = useState<string | null>(null);
  const [split, setSplit] = useState<Split>({});
  const [fix, setFix] = useState({
    collected: '', delivered: '', empties: '', lost: '', reason: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The truck and the collection stops (10 Oct 2026, points 3 and 4). */
  const [round, setRound] = useState<{ truck: Truck | null; collections: Collection[]; stops: Array<{ bottles_empties_picked_up?: number }> } | null>(null);
  const [restock, setRestock] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    const r = await api.get<Review>(`/api/delivery-sheets/${sheetId}/settlement`);
    setReview(r);
    const sh = await api.get<{ truck: Truck | null; collections: Collection[]; stops: Array<{ bottles_empties_picked_up?: number }> }>(`/api/delivery-sheets/${sheetId}`);
    setRound(sh);
    if (sh.truck?.emptiesBack != null) setBottlesBack((cur) => (cur === '' ? String(sh.truck!.emptiesBack) : cur));
    // The cash handed in is almost always exactly what the driver recorded
    // collecting, so start there and let it be overridden. Only prefill until
    // the person actually types - never overwrite what they entered.
    setActualCash((cur) => (cashTouched ? cur : (r.totalCollectedCents / 100).toFixed(2)));
    return r;
  }, [sheetId, cashTouched]);

  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  if (error && !review) return <div className="notice error">{error}</div>;
  if (!review) return <p className="muted">Loading…</p>;

  const truck = round?.truck ?? null;
  const collections = round?.collections ?? [];
  const emptiesRecorded = (round?.stops ?? []).reduce((t, s) => t + Number(s.bottles_empties_picked_up ?? 0), 0)
    + collections.filter((c) => c.kind === 'Empties' && c.status === 'Collected').reduce((t, c) => t + Number(c.empties_count), 0);
  const undecided = collections.filter((c) => c.kind === 'Returns' && c.status === 'Collected' && !c.credit_decision);
  const truckOut = !!truck && !truck.returnedAt;
  const unconfirmedAdds = (truck?.additions ?? []).filter((a) => !a.driverConfirmedAt).length;
  const recorded = review.totalCollectedCents;
  const handedIn = actualCash === '' ? null : toCents(actualCash);
  const variance = handedIn === null ? null : handedIn - recorded;
  const locked = review.status === 'Completed';
  const isAdmin = session.role === 'admin';

  /** Open a stop's panel, seeded with whatever split is already saved. */
  function openPanel(s: StopRow) {
    if (openStop === s.stopId) { setOpenStop(null); return; }
    setOpenStop(s.stopId);
    setError(null); setMsg(null);
    const seeded: Split = {};
    for (const a of s.allocations) {
      if (a.invoiceId) seeded[a.invoiceId] = (a.amountCents / 100).toFixed(2);
    }
    setSplit(seeded);
    setFix({
      collected: (s.collectedCents / 100).toFixed(2),
      delivered: String(s.bottlesDeliveredFull),
      empties: String(s.bottlesEmptiesPickedUp),
      lost: String(s.bottlesLostDamaged),
      reason: '',
    });
  }

  const allocatedIn = (s: StopRow) =>
    s.openInvoices.reduce((sum, i) => sum + toCents(split[i.invoiceId] || '0'), 0);

  /**
   * Ticking an invoice pays it in full when the cash stretches that far, and
   * whatever is left when it does not. That is the whole point of the
   * checkbox: typing a figure is only needed to fine-tune a partial.
   */
  function toggleInvoice(s: StopRow, inv: OpenInvoice, on: boolean) {
    setSplit((cur) => {
      const next = { ...cur };
      if (!on) { delete next[inv.invoiceId]; return next; }
      const usedElsewhere = s.openInvoices
        .filter((i) => i.invoiceId !== inv.invoiceId)
        .reduce((sum, i) => sum + toCents(next[i.invoiceId] || '0'), 0);
      const left = Math.max(s.collectedCents - usedElsewhere, 0);
      next[inv.invoiceId] = (Math.min(inv.balanceCents, left) / 100).toFixed(2);
      return next;
    });
  }

  async function saveSplit(s: StopRow) {
    setBusy(true); setError(null); setMsg(null);
    try {
      await api.post(`/api/stops/${s.stopId}/adjust-allocation`, {
        allocations: Object.entries(split)
          .filter(([, v]) => toCents(v) > 0)
          .map(([invoiceId, v]) => ({ invoiceId, amountCents: toCents(v) })),
      });
      setMsg(
        'Split saved against this stop. It creates no payment yet — the route ' +
        'settlement below is what turns it into money on the account.',
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the split');
    } finally { setBusy(false); }
  }

  async function submitCorrection(s: StopRow) {
    setBusy(true); setError(null); setMsg(null);
    try {
      const out = await api.post<{ applied: boolean }>(`/api/stops/${s.stopId}/correct`, {
        changes: {
          paymentAmountCents: toCents(fix.collected),
          bottlesDeliveredFull: Number(fix.delivered) || 0,
          bottlesEmptiesPickedUp: Number(fix.empties) || 0,
          bottlesLostDamaged: Number(fix.lost) || 0,
        },
        reason: fix.reason,
      });
      setMsg(out.applied
        ? `Correction applied to ${s.customerName}.`
        : `Correction sent to an administrator for approval. Nothing has changed on ` +
          `this stop until they approve it.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the correction');
    } finally { setBusy(false); }
  }

  async function decide(c: Collection, creditNote: boolean) {
    setBusy(true); setError(null); setMsg(null);
    try {
      const out = await api.post<{ creditNoteNumber: string | null; approvalRequestId: string | null }>(
        `/api/collections/${c.id}/decision`, { creditNote, restock: !!restock[c.id] });
      setMsg(creditNote
        ? `Credit note ${out.creditNoteNumber ?? ''} raised for ${c.customer_name}${out.approvalRequestId ? '; it counts once an administrator approves it' : ''}.`
        : `No credit note for ${c.customer_name}'s returned goods.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the decision');
    } finally { setBusy(false); }
  }

  async function settle() {
    setBusy(true); setError(null);
    try {
      const out = await api.post<{ paymentIds: string[]; cashVarianceCents: number }>(
        `/api/delivery-sheets/${sheetId}/settle`, {
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
    } finally { setBusy(false); }
  }

  /**
   * Plain functions returning JSX, NOT nested components: a component declared
   * inside another gets a new type each render, so every input under it
   * unmounts mid-keystroke and loses focus.
   */
  const cashPanel = (s: StopRow) => {
    const allocated = allocatedIn(s);
    const left = s.collectedCents - allocated;
    return (
      <>
        <h3 style={{ marginBottom: 4 }}>Apply the {money(s.collectedCents)} collected</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          Tick an invoice to pay it in full, or for whatever cash is left if it
          does not stretch. Only a partial payment needs a figure typed.
        </p>
        {s.openInvoices.length === 0 && (
          <p className="muted">This customer has nothing outstanding.</p>
        )}
        {s.openInvoices.length > 0 && (
          <table>
            <thead>
              <tr>
                <th style={{ width: 40 }} />
                <th>Invoice</th><th>Date</th>
                <th className="num">Invoice total</th>
                <th className="num">Owing</th>
                <th className="num">Applying</th>
              </tr>
            </thead>
            <tbody>
              {s.openInvoices.map((inv) => {
                const ticked = toCents(split[inv.invoiceId] || '0') > 0;
                const applying = toCents(split[inv.invoiceId] || '0');
                return (
                  <tr key={inv.invoiceId}>
                    <td>
                      <input type="checkbox" checked={ticked} disabled={busy || s.settled}
                             onChange={(e) => toggleInvoice(s, inv, e.target.checked)} />
                    </td>
                    <td>
                      {inv.invoiceNumber}
                      {ticked && applying < inv.balanceCents && (
                        <div><span className="chip warn">part payment</span></div>
                      )}
                    </td>
                    <td className="small muted">{when(inv.invoiceDate)}</td>
                    <td className="num muted">{money(inv.grandTotalCents)}</td>
                    <td className="num">{money(inv.balanceCents)}</td>
                    <td className="num">
                      <input type="number" step="0.01" min="0" style={{ width: 120 }}
                             disabled={busy || s.settled}
                             value={split[inv.invoiceId] ?? ''}
                             placeholder="0.00"
                             onChange={(e) => setSplit({
                               ...split, [inv.invoiceId]: e.target.value,
                             })} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <div className="total-line">
          <span>Collected at this stop</span><span>{money(s.collectedCents)}</span>
        </div>
        <div className="total-line">
          <span>Applied to invoices</span><span>{money(allocated)}</span>
        </div>
        <div className="total-line grand">
          <span>{left < 0 ? 'Over-applied' : 'Left unapplied'}</span>
          <span>{money(Math.abs(left))}</span>
        </div>

        {left < 0 && (
          <div className="notice error">
            More has been applied than was collected at this stop. Reduce a figure
            before saving.
          </div>
        )}
        {left > 0 && (
          <div className="notice info">
            {money(left)} will be recorded as a payment on the account without
            being attached to a specific invoice.
          </div>
        )}

        {!s.settled && !locked && (
          <button type="button" disabled={busy || left < 0} onClick={() => saveSplit(s)}>
            Save this split
          </button>
        )}
      </>
    );
  };

  const correctionPanel = (s: StopRow) => (
    <>
      <h3 style={{ marginTop: 20, marginBottom: 4 }}>Confirm or correct what was recorded</h3>
      <p className="muted small" style={{ marginTop: 0 }}>
        {isAdmin
          ? 'As an administrator your correction applies immediately.'
          : 'Your correction is sent to an administrator to approve — nothing changes until they do.'}
      </p>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="field">
          <label>Cash collected</label>
          <input type="number" step="0.01" min="0" style={{ width: 130 }}
                 value={fix.collected} disabled={busy}
                 onChange={(e) => setFix({ ...fix, collected: e.target.value })} />
        </div>
        <div className="field">
          <label>Bottles delivered</label>
          <input type="number" min="0" style={{ width: 110 }} value={fix.delivered}
                 disabled={busy}
                 onChange={(e) => setFix({ ...fix, delivered: e.target.value })} />
        </div>
        <div className="field">
          <label>Empties collected</label>
          <input type="number" min="0" style={{ width: 110 }} value={fix.empties}
                 disabled={busy}
                 onChange={(e) => setFix({ ...fix, empties: e.target.value })} />
        </div>
        <div className="field">
          <label>Lost or damaged</label>
          <input type="number" min="0" style={{ width: 110 }} value={fix.lost}
                 disabled={busy}
                 onChange={(e) => setFix({ ...fix, lost: e.target.value })} />
        </div>
      </div>
      <div className="field">
        <label>Why (required)</label>
        <input style={{ width: '100%' }} value={fix.reason} disabled={busy}
               placeholder="e.g. driver miscounted the empties at the gate"
               onChange={(e) => setFix({ ...fix, reason: e.target.value })} />
      </div>
      <button type="button" disabled={busy || !fix.reason.trim()}
              onClick={() => submitCorrection(s)}>
        {isAdmin ? 'Apply correction' : 'Send correction for approval'}
      </button>
    </>
  );

  return (
    <>
      <h1>Route settlement</h1>
      <p className="subtitle">
        Confirm every stop before closing. Settling is what turns the driver's
        collected cash into real payments on customer accounts.
      </p>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}
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
              <th>Customer</th><th>Outcome</th><th>Delivered</th>
              <th className="num">Expected</th>
              <th className="num">Collected</th>
              <th className="num">Variance</th>
              <th>Applied to</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {review.stops.map((s) => (
              <tr key={s.stopId}>
                <td>
                  <strong>{s.customerName}</strong>
                  <div className="muted small">{s.paymentAfterDelivery ? (s.note ?? 'Payment after delivery') : s.orderRef ?? s.note ?? '—'}</div>
                </td>
                <td>
                  <span className={`chip ${s.outcome === 'Delivered' ? 'ok' : s.outcome === 'Payment Only' ? 'info' : 'neutral'}`}>
                    {s.outcome === 'Payment Only' ? 'Payment only' : s.outcome}
                  </span>
                </td>
                <td className="small muted">{s.deliveredSummary || '—'}</td>
                <td className="num">{money(s.expectedCents)}</td>
                <td className="num">{money(s.collectedCents)}</td>
                <td className="num">
                  {s.varianceCents === 0
                    ? <span className="muted">—</span>
                    : <span className="chip warn">{money(s.varianceCents)}</span>}
                </td>
                <td className="small">
                  {s.allocations.length === 0
                    ? <span className="muted">not applied yet</span>
                    : s.allocations.map((a, i) => (
                        <div key={i}>
                          {a.invoiceNumber ?? 'on account'} — {money(a.amountCents)}
                        </div>
                      ))}
                </td>
                <td className="num">
                  <button className="secondary" onClick={() => openPanel(s)}>
                    {openStop === s.stopId ? 'Close' : 'Open'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {review.stops.length === 0 && <p className="muted">No stops on this sheet.</p>}
      </div>

      {review.stops.filter((s) => s.stopId === openStop).map((s) => (
        <div className="panel" key={s.stopId}>
          <h2 style={{ marginTop: 0 }}>{s.customerName}</h2>
          {s.settled && (
            <div className="notice info">This stop has already been settled.</div>
          )}
          {cashPanel(s)}
          {!s.settled && !locked && correctionPanel(s)}
        </div>
      ))}

      {truck && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>The truck</h2>
          <TruckTable truck={truck} />
          {truckOut && !locked && (
            <>
              <div className="notice warn" style={{ marginTop: 10 }}>
                Count what came back on the truck before closing: full goods go back on the warehouse stock.
              </div>
              <ReturnsPanel sheetId={sheetId!} truck={truck} expectedEmpties={emptiesRecorded}
                            onDone={(m) => { setMsg(m); load(); }} />
            </>
          )}
        </div>
      )}

      {collections.length > 0 && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Collection stops</h2>
          <p className="muted small" style={{ marginTop: 0 }}>
            Settling puts collected empties back into the bottle pool. Returned goods need your decision first.
            Anything not visited is closed as not collected.
          </p>
          <table>
            <thead><tr><th>Who</th><th>What</th><th>Status</th><th>When settled</th></tr></thead>
            <tbody>
              {collections.map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.kind === 'Supplier' ? c.supplier_name : c.customer_name}</strong><div className="muted small">{KIND_WORDS[c.kind]}</div></td>
                  <td className="small">{collectionSummary(c)}</td>
                  <td><span className={`chip ${c.status === 'Collected' ? 'ok' : c.status === 'Pending' ? 'neutral' : 'warn'}`}>{c.status === 'Pending' ? 'Not visited' : c.status}</span></td>
                  <td className="small">
                    {c.kind === 'Empties' && c.status === 'Collected' && `${c.empties_count} back into the pool`}
                    {c.kind === 'Supplier' && c.status === 'Collected' && (c.purchase_order_id
                      ? <>Receive on <Link to={`/purchase-orders?po=${c.purchase_order_id}`}>{c.po_number}</Link>{c.received_at ? ' (done)' : ''}</>
                      : 'Nothing moves: receive it on a PO')}
                    {c.kind === 'Returns' && c.status === 'Collected' && (c.credit_decision ? (
                      <>{c.credit_decision}{c.credit_note_number ? ` ${c.credit_note_number}${c.credit_status === 'Pending' ? ' (awaiting approval)' : ''}` : ''}{c.restock ? '; back in stock' : '; not restocked'}</>
                    ) : !locked && (
                      <div>
                        <label className="check" style={{ margin: '0 0 6px' }}>
                          <input type="checkbox" checked={!!restock[c.id]} onChange={(e) => setRestock({ ...restock, [c.id]: e.target.checked })} />
                          Put the goods back in stock
                        </label>
                        <button type="button" disabled={busy} onClick={() => decide(c, true)}>Raise a credit note</button>{' '}
                        <button type="button" className="secondary" disabled={busy} onClick={() => decide(c, false)}>No credit note</button>
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!locked && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Cash and bottle reconciliation</h2>
          <div className="row">
            <div className="field">
              <label htmlFor="cash">Physical cash handed in</label>
              <input id="cash" type="number" step="0.01" min="0" placeholder="0.00"
                     style={{ width: 160 }} value={actualCash}
                     onChange={(e) => { setCashTouched(true); setActualCash(e.target.value); }} />
              <span className="muted small">defaults to what the driver recorded</span>
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
                      placeholder={variance ? 'Explain the difference' : ''}
                      value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          {(truckOut || undecided.length > 0 || unconfirmedAdds > 0) && (
            <div className="notice warn">
              {truckOut ? 'Count what came back on the truck first (above). ' : ''}
              {unconfirmedAdds ? 'The driver has not confirmed what was added to the load: they confirm it on My route, or cancel it on the round page. ' : ''}
              {undecided.length ? `Decide on the goods returned by ${undecided.map((c) => c.customer_name).join(', ')}.` : ''}
            </div>
          )}
          <button disabled={busy || handedIn === null || truckOut || undecided.length > 0 || unconfirmedAdds > 0} onClick={settle}>
            {busy ? 'Settling…' : 'Confirm and close route'}
          </button>
        </div>
      )}
    </>
  );
}
