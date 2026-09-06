import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { money, toCents } from '../lib/format';

interface StopLine {
  order_line_id: string;
  product_name: string;
  bottles_per_case: number;
  cases: number;
  loose_bottles: number;
  /** A 5-gallon bottle goes out on loan and has to come back. */
  is_returnable: boolean;
  total_bottles: number;
}

interface OpenInvoice {
  invoiceId: string;
  invoiceNumber: string;
  balanceCents: number;
  /** The invoice raised by this very delivery. Listed first by the server. */
  isThisDelivery?: boolean;
}

interface Stop {
  id: string;
  customer_name: string;
  delivery_address: string | null;
  contact_phone: string | null;
  order_ref: string | null;
  stop_outcome: string;
  invoice_id: string | null;
  /** Always tax-inclusive: the invoice total, or the order total before one exists. */
  amountOwedCents: number;
  lines: StopLine[];
  openInvoices: OpenInvoice[];
}

const OUTCOMES = [
  'Delivered', 'Customer Not Home', 'Refused', 'Rescheduled', 'Other',
] as const;

export default function DriverStop() {
  const { stopId } = useParams();
  const navigate = useNavigate();

  const [stop, setStop] = useState<Stop | null>(null);
  const [outcome, setOutcome] = useState<string>('Delivered');
  const [delivered, setDelivered] = useState<Record<string, string>>({});
  const [collected, setCollected] = useState('');
  const [method, setMethod] = useState('Cash');
  const [empties, setEmpties] = useState('');
  const [lost, setLost] = useState('');
  const [notes, setNotes] = useState('');
  const [alloc, setAlloc] = useState<Record<string, string>>({});

  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allocError, setAllocError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Bottles delivered: follows the lines until the driver overrides it. */
  const [fulls, setFulls] = useState('');
  const [fullsTouched, setFullsTouched] = useState(false);

  async function load() {
    const s = await api.get<Stop>(`/api/stops/${stopId}`);
    setStop(s);
    setDelivered(Object.fromEntries(
      s.lines.map((l) => [
        l.order_line_id,
        String(l.bottles_per_case > 0 ? l.cases : l.loose_bottles),
      ]),
    ));
  }

  useEffect(() => { load().catch((e) => setError(e.message)); }, [stopId]);

  if (error && !stop) return <div className="notice error">{error}</div>;
  if (!stop) return <p className="muted">Loading…</p>;

  /*
   * How many returnable bottles this stop is putting out.
   *
   * Taken from the quantities the driver has just entered above, NOT from the
   * order, so reducing a line reduces the bottles with it. Until now there was
   * no field for this at all - the column existed, the API accepted it, and
   * the screen never sent it, so every delivery recorded zero bottles going
   * out and the pool quietly understated what was with customers.
   */
  const carriesReturnables = stop.lines.some((l) => l.is_returnable);
  const bottlesFromLines = stop.lines
    .filter((l) => l.is_returnable)
    .reduce((sum, l) => {
      const entered = Number(delivered[l.order_line_id]);
      const qty = Number.isFinite(entered) ? entered : 0;
      // A returnable sold by the case still puts out that many bottles.
      return sum + qty * (l.bottles_per_case > 0 ? l.bottles_per_case : 1);
    }, 0);
  const fullsShown = fullsTouched ? fulls : String(bottlesFromLines);

  const collectedCents = toCents(collected || '0');
  const allocatedCents = Object.values(alloc)
    .reduce((s, v) => s + toCents(v || '0'), 0);
  const overAllocated = allocatedCents > collectedCents;

  /**
   * Completing the stop. Payment details are sent along, but nothing about
   * them can prevent this from succeeding - a payment problem must never
   * block recording that goods were delivered.
   */
  async function completeStop(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const deliveredLines = stop!.lines.map((l) => {
        const qty = Math.max(Math.round(Number(delivered[l.order_line_id] ?? 0)), 0);
        return l.bottles_per_case > 0
          ? { orderLineId: l.order_line_id, cases: qty, looseBottles: 0 }
          : { orderLineId: l.order_line_id, cases: 0, looseBottles: qty };
      });

      await api.post(`/api/stops/${stop!.id}/outcome`, {
        outcome,
        outcomeNotes: notes || null,
        deliveredLines: outcome === 'Delivered' ? deliveredLines : undefined,
        paymentReceived: collectedCents > 0,
        paymentMethod: collectedCents > 0 ? method : null,
        paymentAmountCents: collectedCents,
        // What actually went out on loan. Without this the pool never learns
        // the bottles left the truck.
        bottlesDeliveredFull: Number(fullsShown) || 0,
        bottlesEmptiesPickedUp: Number(empties) || 0,
        bottlesLostDamaged: Number(lost) || 0,
        driverNotes: notes || null,
      });
      setSaved('Stop recorded.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the stop');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Saving the suggested split is a SEPARATE action from completing the stop.
   * If it fails validation, the completed delivery above still stands.
   */
  async function saveAllocation() {
    setBusy(true);
    setAllocError(null);
    try {
      const allocations = Object.entries(alloc)
        .map(([invoiceId, v]) => ({ invoiceId, amountCents: toCents(v || '0') }))
        .filter((a) => a.amountCents > 0);
      await api.post(`/api/stops/${stop!.id}/allocation`, { allocations });
      setSaved('Suggested split saved. It becomes real money at route settlement.');
    } catch (err) {
      setAllocError(err instanceof Error ? err.message : 'Could not save the split');
    } finally {
      setBusy(false);
    }
  }

  /*
   * Straight from the server, today's delivery first.
   *
   * This screen used to bolt a "Today's delivery" row on the front itself,
   * using the amount owed for the stop, while the server supplied the real
   * invoice balances for every other row. Two sources for one list is how a
   * part-paid invoice comes to show two different balances depending on which
   * row you read.
   */
  const invoicesToAllocate: OpenInvoice[] = stop.openInvoices;

  /** Fill an invoice up to its balance, or as far as the cash reaches. */
  function applyUpTo(inv: OpenInvoice, on: boolean) {
    setAlloc((current) => {
      const next = { ...current };
      if (!on) {
        delete next[inv.invoiceId];
        return next;
      }
      const spentElsewhere = Object.entries(next)
        .filter(([id]) => id !== inv.invoiceId)
        .reduce((s, [, v]) => s + toCents(v || '0'), 0);
      const room = Math.max(collectedCents - spentElsewhere, 0);
      const amount = Math.min(inv.balanceCents, room);
      if (amount <= 0) return next;
      next[inv.invoiceId] = (amount / 100).toFixed(2);
      return next;
    });
  }

  return (
    <>
      <button className="secondary" onClick={() => navigate('/route')}>← Back to route</button>

      <h1 style={{ marginTop: 16 }}>{stop.customer_name}</h1>
      <p className="subtitle">
        {stop.delivery_address ?? 'No address on file'}
        {stop.contact_phone ? ` · ${stop.contact_phone}` : ''}
        {stop.order_ref ? ` · ${stop.order_ref}` : ''}
      </p>

      {error && <div className="notice error">{error}</div>}
      {saved && <div className="notice ok">{saved}</div>}

      <div className="panel">
        <div className="muted small">Amount owed (includes GCT)</div>
        <div className="owed">{money(stop.amountOwedCents)}</div>
        <div className="muted small" style={{ marginTop: 4 }}>
          Current outcome: <strong>{stop.stop_outcome}</strong>
        </div>
      </div>

      <form onSubmit={completeStop}>
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>What happened</h2>
          <div className="field">
            <label htmlFor="out">Outcome</label>
            <select id="out" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              {OUTCOMES.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>

          {outcome === 'Delivered' && (
            <>
              <h2>Quantities delivered</h2>
              <table>
                <thead>
                  <tr><th>Product</th><th>Ordered</th><th>Delivered</th></tr>
                </thead>
                <tbody>
                  {stop.lines.map((l) => (
                    <tr key={l.order_line_id}>
                      <td>{l.product_name}</td>
                      <td className="muted">
                        {l.bottles_per_case > 0
                          ? `${l.cases} cases`
                          : `${l.loose_bottles} bottles`}
                      </td>
                      <td>
                        <input type="number" min="0" step="1" style={{ width: 90 }}
                               value={delivered[l.order_line_id] ?? ''}
                               onChange={(e) => setDelivered((d) => ({
                                 ...d, [l.order_line_id]: e.target.value,
                               }))} />
                        <span className="muted small" style={{ marginLeft: 6 }}>
                          {l.bottles_per_case > 0 ? 'cases' : 'bottles'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <div className="row" style={{ marginTop: 14 }}>
            {/*
              * Only shown when this stop actually carries returnables. It
              * follows the delivered quantities above until the driver types
              * over it, so the common case is right without anyone doing
              * anything - and a short delivery is still one edit away.
              */}
            {carriesReturnables && (
              <div className="field">
                <label htmlFor="fulls">5-gallon bottles delivered</label>
                <input id="fulls" type="number" min="0" style={{ width: 120 }}
                       value={fullsShown}
                       onChange={(e) => { setFullsTouched(true); setFulls(e.target.value); }} />
              </div>
            )}
            <div className="field">
              <label htmlFor="empties">Empties picked up</label>
              <input id="empties" type="number" min="0" style={{ width: 120 }}
                     value={empties} onChange={(e) => setEmpties(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="lost">Bottles lost / damaged</label>
              <input id="lost" type="number" min="0" style={{ width: 120 }}
                     value={lost} onChange={(e) => setLost(e.target.value)} />
            </div>
          </div>
          <p className="muted small">
            Lost or damaged bottles are recorded as a business loss. They are never
            charged to the customer.
          </p>

          <h2>Payment collected</h2>
          <div className="row">
            <div className="field">
              <label htmlFor="amt">Amount collected</label>
              <input id="amt" type="number" step="0.01" min="0" placeholder="0.00"
                     style={{ width: 150 }} value={collected}
                     onChange={(e) => setCollected(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="meth">Method</label>
              <select id="meth" value={method} onChange={(e) => setMethod(e.target.value)}>
                {['Cash', 'Card', 'Bank Transfer', 'Cheque', 'Other'].map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          </div>
          {method === 'Bank Transfer' && (
            <div className="notice info">
              The delivery proceeds normally. The invoice stays open until the office
              confirms the transfer has cleared.
            </div>
          )}

          <div className="field">
            <label htmlFor="notes">Notes</label>
            <textarea id="notes" rows={2} style={{ width: '100%' }}
                      value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          <button disabled={busy}>{busy ? 'Saving…' : `Mark stop ${outcome}`}</button>
          <p className="muted small" style={{ marginTop: 8 }}>
            Recording the stop always succeeds, whatever the payment situation.
          </p>
        </div>
      </form>

      {invoicesToAllocate.length > 0 && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Suggested split of the cash (optional)</h2>
          <p className="muted small">
            This is a suggestion for the office. It creates no payment and changes no
            balance until the route is settled.
          </p>
          {allocError && <div className="notice error">{allocError}</div>}

          <table>
            <thead>
              <tr>
                <th className="num">Pay off</th>
                <th>Invoice</th>
                <th className="num">Balance</th>
                <th className="num">Apply</th>
              </tr>
            </thead>
            <tbody>
              {invoicesToAllocate.map((inv) => {
                const applied = toCents(alloc[inv.invoiceId] || '0');
                return (
                  <tr key={inv.invoiceId}>
                    {/* Ticking fills this invoice up to its balance, or as far
                        as the cash reaches. The box below stays editable for a
                        part payment. */}
                    <td className="num">
                      <input type="checkbox" style={{ width: 22, height: 22 }}
                             checked={applied > 0 && applied >= inv.balanceCents}
                             onChange={(e) => applyUpTo(inv, e.target.checked)} />
                    </td>
                    <td>
                      {inv.invoiceNumber}
                      {inv.isThisDelivery && (
                        <div className="muted small">today&rsquo;s delivery</div>
                      )}
                    </td>
                    <td className="num">{money(inv.balanceCents)}</td>
                    <td className="num">
                      <input type="number" step="0.01" min="0" style={{ width: 120 }}
                             value={alloc[inv.invoiceId] ?? ''}
                             onChange={(e) => setAlloc((a) => ({
                               ...a, [inv.invoiceId]: e.target.value,
                             }))} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="total-line" style={{ marginTop: 10 }}>
            <span>Collected</span><span>{money(collectedCents)}</span>
          </div>
          <div className="total-line">
            <span>Allocated</span><span>{money(allocatedCents)}</span>
          </div>
          <div className="total-line">
            <span>Left unallocated</span>
            <span>{money(Math.max(collectedCents - allocatedCents, 0))}</span>
          </div>

          {overAllocated && (
            <div className="notice warn">
              You have split more than you collected. Adjust the amounts above —
              this does not affect the delivery you already recorded.
            </div>
          )}

          <button className="secondary" disabled={busy || overAllocated}
                  onClick={saveAllocation}>
            Save suggested split
          </button>
        </div>
      )}
    </>
  );
}
