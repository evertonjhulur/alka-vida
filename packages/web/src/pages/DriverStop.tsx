import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, getSession } from '../lib/api';
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
  delivery_sheet_id?: string;
  sheet_zone?: string | null;
  stop_count?: number;
  stop_position?: number;
  payment_terms?: string | null;
  invoice_cycle?: string | null;
  customer_notes?: string | null;
  driver_notes?: string | null;
  /** Always tax-inclusive: the invoice total, or the order total before one exists. */
  amountOwedCents: number;
  lines: StopLine[];
  openInvoices: OpenInvoice[];
}

/** How they paid, as big buttons. "Not paid" is the default on account. */
const PAY_WAYS: Array<[string, string]> = [
  ['', 'Not paid'], ['Cash', 'Cash'], ['Cheque', 'Cheque'], ['Card', 'Card'], ['Bank Transfer', 'Transfer'],
];
const OUTCOME_WORDS: Record<string, string> = {
  Delivered: 'Delivered', 'Customer Not Home': 'Not home', Refused: 'Refused',
  Rescheduled: 'Another day', Other: 'Not delivered',
};

/**
 * One stop, on the driver's phone (approved mockup, 29 Sep 2026).
 *
 * What was dropped (− / + per line, starting from the order), bottles back,
 * what to collect and how they paid, then one big Delivered button, with
 * Not home, Refused and Another day under it. Each of those records the
 * stop straight away; nothing about payment can stop a delivery being
 * recorded. The optional split of the cash across invoices is folded away
 * underneath.
 */
export default function DriverStop() {
  const { stopId } = useParams();
  const office = ['admin', 'user'].includes(getSession()?.role ?? '');

  const [stop, setStop] = useState<Stop | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [delivered, setDelivered] = useState<Record<string, string>>({});
  const [collected, setCollected] = useState('');
  const [method, setMethod] = useState('');
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

  const collectedCents = method ? toCents(collected || '0') : 0;
  const allocatedCents = Object.values(alloc)
    .reduce((s, v) => s + toCents(v || '0'), 0);
  const overAllocated = allocatedCents > collectedCents;

  /**
   * Completing the stop. Payment details are sent along, but nothing about
   * them can prevent this from succeeding - a payment problem must never
   * block recording that goods were delivered.
   */
  async function record(outcome: string) {
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
      const paid = method ? collectedCents : 0;

      await api.post(`/api/stops/${stop!.id}/outcome`, {
        outcome,
        outcomeNotes: notes || null,
        deliveredLines: outcome === 'Delivered' ? deliveredLines : undefined,
        paymentReceived: paid > 0,
        paymentMethod: paid > 0 ? method : null,
        paymentAmountCents: paid,
        // What actually went out on loan. Without this the pool never learns
        // the bottles left the truck.
        bottlesDeliveredFull: outcome === 'Delivered' ? Number(fullsShown) || 0 : 0,
        bottlesEmptiesPickedUp: Number(empties) || 0,
        bottlesLostDamaged: Number(lost) || 0,
        driverNotes: notes || null,
      });
      setSaved(`Recorded: ${OUTCOME_WORDS[outcome] ?? outcome}${paid > 0 ? `, ${money(paid)} ${method.toLowerCase()}` : ''}.`);
      window.scrollTo({ top: 0, behavior: 'smooth' });
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

  const back = office && stop.delivery_sheet_id ? `/delivery/${stop.delivery_sheet_id}` : '/route';
  const onCycle = stop.invoice_cycle === 'Weekly' || stop.invoice_cycle === 'Monthly';
  const onTerms = onCycle || (!!stop.payment_terms && !/cash on delivery/i.test(stop.payment_terms));
  const done = stop.stop_outcome !== 'Pending';
  // A delivered stop has raised its invoice and moved bottles; recording it
  // again from here would move them twice. Not home -> Delivered is fine.
  const delivered_ = stop.stop_outcome === 'Delivered';
  const step = (id: string, by: number) => setDelivered((d) => ({
    ...d, [id]: String(Math.max((Math.round(Number(d[id]) || 0)) + by, 0)),
  }));

  return (
    <div className="stop-screen">
      <div className="stop-bar">
        <Link to={back}>‹ {office ? 'The round' : 'My route'}</Link>
        {stop.stop_count ? <strong>Stop {stop.stop_position} of {stop.stop_count}</strong> : <span />}
        <span className="muted small">{stop.sheet_zone ?? ''}</span>
      </div>

      {error && <div className="notice error">{error}</div>}
      {saved && (
        <div className="notice ok">
          {saved} <Link to={back}>Back to {office ? 'the round' : 'my route'}</Link>
        </div>
      )}
      {done && !saved && (
        <div className="notice info">
          Already recorded as <strong>{OUTCOME_WORDS[stop.stop_outcome] ?? stop.stop_outcome}</strong>.
          {delivered_ ? ' To change a delivered stop, the office corrects it on the round.'
            : ' If you went back and they took it, record it again below.'}
        </div>
      )}

      <section className="panel stop-who">
        <div className="stop-who-top">
          {stop.stop_position ? <span className="stop-no big">{stop.stop_position}</span> : null}
          <div>
            <div className="stop-name">{stop.customer_name}</div>
            <div className="muted">{stop.delivery_address ?? 'No address on file'}</div>
            {stop.order_ref && <div className="muted small">{stop.order_ref}</div>}
          </div>
        </div>
        <div className="stop-links">
          {stop.contact_phone && <a className="button-link secondary" href={`tel:${stop.contact_phone.replace(/[^\d+]/g, '')}`}>Call {stop.contact_phone}</a>}
          <button type="button" className="secondary" aria-expanded={notesOpen} onClick={() => setNotesOpen(!notesOpen)}>
            Notes for this stop{stop.customer_notes ? ' •' : ''}
          </button>
        </div>
        {notesOpen && (
          <div style={{ marginTop: 10 }}>
            {stop.customer_notes && <p className="notice info" style={{ margin: '0 0 8px' }}>{stop.customer_notes}</p>}
            <label htmlFor="notes">Your note (the office sees it)</label>
            <textarea id="notes" rows={2} style={{ width: '100%', boxSizing: 'border-box' }}
                      value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        )}
      </section>

      <section className="panel">
        <h2 className="side-h">What you dropped</h2>
        {stop.lines.map((l) => {
          const cased = l.bottles_per_case > 0;
          const ordered = cased ? l.cases : l.loose_bottles;
          return (
            <div key={l.order_line_id} className="drop-row">
              <div>
                <strong>{l.product_name.replace(/^Alka Vida\s+/i, '')}</strong>
                <div className="muted small">ordered {ordered} {cased ? (ordered === 1 ? 'case' : 'cases') : (ordered === 1 ? 'bottle' : 'bottles')}</div>
              </div>
              <div className="stepper big">
                <button type="button" className="secondary" aria-label={`One fewer ${l.product_name}`}
                        onClick={() => step(l.order_line_id, -1)}>−</button>
                <input type="number" min="0" inputMode="numeric" aria-label={`${l.product_name} dropped`}
                       value={delivered[l.order_line_id] ?? ''}
                       onChange={(e) => setDelivered((d) => ({ ...d, [l.order_line_id]: e.target.value }))} />
                <button type="button" className="secondary" aria-label={`One more ${l.product_name}`}
                        onClick={() => step(l.order_line_id, 1)}>+</button>
              </div>
            </div>
          );
        })}
        <div className="two" style={{ marginTop: 12 }}>
          {/*
            * Only shown when this stop carries returnables. It follows the
            * quantities above until the driver types over it.
            */}
          {carriesReturnables && (
            <div className="field">
              <label htmlFor="fulls">Full bottles out</label>
              <input id="fulls" type="number" min="0" inputMode="numeric" value={fullsShown}
                     onChange={(e) => { setFullsTouched(true); setFulls(e.target.value); }} />
            </div>
          )}
          <div className="field">
            <label htmlFor="empties">Empties picked up</label>
            <input id="empties" type="number" min="0" inputMode="numeric" placeholder="0"
                   value={empties} onChange={(e) => setEmpties(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="lost">Lost or damaged</label>
            <input id="lost" type="number" min="0" inputMode="numeric" placeholder="0"
                   value={lost} onChange={(e) => setLost(e.target.value)} />
          </div>
        </div>
        <p className="muted small" style={{ margin: 0 }}>Lost or damaged bottles are a business loss, never charged to the customer.</p>
      </section>

      <section className="panel">
        <div className="collect-head">
          <h2 className="side-h" style={{ margin: 0 }}>To collect</h2>
          <div className="owed">{money(stop.amountOwedCents)}</div>
        </div>
        <div className="muted small">
          incl. GCT · {onCycle ? `billed ${stop.invoice_cycle!.toLowerCase()}, so paying now is optional`
            : onTerms ? `on ${stop.payment_terms} terms, so paying now is optional` : 'cash on delivery'}
        </div>
        <div className="seg pay-ways" role="group" aria-label="How they paid">
          {PAY_WAYS.map(([v, label]) => (
            <button key={label} type="button" className={method === v ? 'active' : ''} aria-pressed={method === v}
                    onClick={() => {
                      setMethod(v);
                      if (v && !collected) setCollected((stop.amountOwedCents / 100).toFixed(2));
                    }}>{label}</button>
          ))}
        </div>
        {method && (
          <div className="field" style={{ marginTop: 10 }}>
            <label htmlFor="amt">Amount taken</label>
            <input id="amt" inputMode="decimal" style={{ width: '100%', boxSizing: 'border-box' }}
                   value={collected} onChange={(e) => setCollected(e.target.value)} />
          </div>
        )}
        {method === 'Bank Transfer' && (
          <div className="notice info" style={{ marginTop: 8 }}>
            The invoice stays open until the office sees the transfer has cleared.
          </div>
        )}
      </section>

      {!delivered_ && (
        <>
          <button type="button" className="big-go" disabled={busy} onClick={() => record('Delivered')}>
            {busy ? 'Saving…' : 'Delivered'}
          </button>
          <div className="not-delivered">
            <button type="button" className="secondary" disabled={busy} onClick={() => record('Customer Not Home')}>Not home</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => record('Refused')}>Refused</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => record('Rescheduled')}>Another day</button>
          </div>
          <p className="muted small" style={{ textAlign: 'center' }}>
            Recording the stop always works, whatever happens with the money.
          </p>
        </>
      )}

      {invoicesToAllocate.length > 0 && collectedCents > 0 && (
        <details className="panel">
          <summary style={{ cursor: 'pointer' }}><strong>Split the cash across invoices (optional)</strong></summary>
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
        </details>
      )}
    </div>
  );
}
