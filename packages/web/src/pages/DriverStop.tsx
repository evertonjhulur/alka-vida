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
  /** The 5-gallon bottle sold on its own (bought for a shortfall in empties). */
  is_bottle_charge?: boolean;
  /** What was ordered; cases / loose_bottles above are what is still to come. */
  ordered_cases?: number;
  ordered_loose?: number;
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
  delivery_instructions?: string | null;
  order_notes?: string | null;
  customer_po?: string | null;
  sheet_date?: string | null;
  bottlesHeld?: number;
  order_id?: string | null;
  payment_only?: boolean;
  payment_amount_cents?: number;
  payment_method?: string | null;
  remainder_to?: string | null;
  /** 5-gallon empties the customer said they would hand over (point 13). */
  empties_expected?: number | null;
  bottleCharge?: { productId: string; name: string; priceCents: number } | null;
  accountBalanceCents?: number;
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
  Rescheduled: 'Another day', Other: 'Not delivered', 'Payment Only': 'Payment only, nothing delivered',
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
  const [emptiesTouched, setEmptiesTouched] = useState(false);
  const [notes, setNotes] = useState('');
  /** "Another day" (point 15): which day, and why. */
  const [moving, setMoving] = useState(false);
  const [moveTo, setMoveTo] = useState('');
  const [moveWhy, setMoveWhy] = useState('');
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  /** Partially delivered (point 9): the day the rest goes. */
  const [partial, setPartial] = useState(false);
  const [restOn, setRestOn] = useState('');
  /** The bottle charge for empties short at the door (point 13). */
  const [charge, setCharge] = useState(false);
  const [chargeQty, setChargeQty] = useState('');

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
  // A 5-gallon delivery is normally an exchange: full ones in, empties out,
  // up to what they are holding. Suggested, and the driver changes it.
  // What they said they would hand over, when they were asked (point 13).
  const expectedEmpties = stop.empties_expected ?? null;
  const emptiesShown = emptiesTouched ? empties
    : (carriesReturnables
      ? String(expectedEmpties ?? Math.min(Number(fullsShown) || 0, Math.max(stop.bottlesHeld ?? 0, 0))) : '');
  // Fewer empties than they said: the driver can add the bottle charge.
  const shortAtDoor = expectedEmpties !== null && emptiesShown !== ''
    ? Math.max(0, expectedEmpties - (Number(emptiesShown) || 0)) : 0;
  const chargeN = charge ? Math.max(0, Math.round(Number(chargeQty || shortAtDoor) || 0)) : 0;

  const collectedCents = method ? toCents(collected || '0') : 0;
  const allocatedCents = Object.values(alloc)
    .reduce((s, v) => s + toCents(v || '0'), 0);
  const overAllocated = allocatedCents > collectedCents;

  /**
   * Completing the stop. Payment details are sent along, but nothing about
   * them can prevent this from succeeding - a payment problem must never
   * block recording that goods were delivered.
   */
  async function record(outcome: string, extra: Record<string, unknown> = {}) {
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
        bottlesEmptiesPickedUp: Number(emptiesShown) || 0,
        bottlesLostDamaged: Number(lost) || 0,
        driverNotes: notes || null,
        bottlesCharged: outcome === 'Delivered' && chargeN > 0 ? chargeN : undefined,
        ...extra,
      });
      setSaved(`Recorded: ${extra.remainderTo ? 'Part delivered' : OUTCOME_WORDS[outcome] ?? outcome}`
        + (extra.remainderTo ? ` (the rest goes ${new Date(`${extra.remainderTo}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })})` : '')
        + (chargeN > 0 && outcome === 'Delivered' ? `, ${chargeN} bottle${chargeN === 1 ? '' : 's'} charged` : '')
        + (extra.rescheduleTo ? ` (moved to ${new Date(`${extra.rescheduleTo}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })})` : '')
        + `${paid > 0 ? `, ${money(paid)} ${method.toLowerCase()}` : ''}.`);
      setMoving(false); setPartial(false); setCharge(false);
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

  /*
   * A payment-only stop (point 10): the driver added it to take money where
   * there was nothing to deliver. Nothing to do here but say what was taken.
   */
  if (!stop.order_id) {
    return (
      <div className="stop-screen">
        <div className="stop-bar">
          <Link to={back}>‹ {office ? 'The round' : 'My route'}</Link>
          <strong>Payment only</strong>
          <span className="muted small">{stop.sheet_zone ?? ''}</span>
        </div>
        <section className="panel stop-who">
          <div className="stop-name">{stop.customer_name}</div>
          <div className="muted">{stop.delivery_address ?? ''}</div>
        </section>
        <section className="panel">
          <div className="collect-head">
            <h2 className="side-h" style={{ margin: 0 }}>Payment taken</h2>
            <div className="owed">{money(Number(stop.payment_amount_cents ?? 0))}</div>
          </div>
          <div className="muted small">
            {(stop.payment_method ?? 'Cash').toLowerCase()} · nothing delivered. It goes on their account when the office settles the round.
          </div>
        </section>
      </div>
    );
  }

  const remainderStop = stop.lines.some((l) => (l.ordered_cases ?? l.cases) !== l.cases
    || (l.ordered_loose ?? l.loose_bottles) !== l.loose_bottles);
  // Handing over less than is left on any line makes it a partial delivery.
  const handingLess = stop.lines.some((l) => {
    const left = l.bottles_per_case > 0 ? l.cases : l.loose_bottles;
    return Math.max(Math.round(Number(delivered[l.order_line_id] ?? 0)), 0) < left;
  });
  const tomorrowOf = (base: string) => {
    const d = new Date(`${base}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  };

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
            {stop.order_ref && <div className="muted small">{stop.order_ref}{stop.customer_po ? ` · PO ${stop.customer_po}` : ''}</div>}
          </div>
        </div>
        {(stop.delivery_instructions || stop.order_notes || stop.customer_notes) && (
          <div className="stop-notes" style={{ marginTop: 10 }}>
            {stop.delivery_instructions && <div><strong>Delivery notes:</strong> {stop.delivery_instructions}</div>}
            {stop.order_notes && !/^Standing order for/.test(stop.order_notes) && <div><strong>On this order:</strong> {stop.order_notes}</div>}
            {stop.customer_notes && <div><strong>Office notes:</strong> {stop.customer_notes}</div>}
          </div>
        )}
        <div className="stop-links">
          {stop.contact_phone && <a className="button-link secondary" href={`tel:${stop.contact_phone.replace(/[^\d+]/g, '')}`}>Call {stop.contact_phone}</a>}
          <button type="button" className="secondary" aria-expanded={notesOpen} onClick={() => setNotesOpen(!notesOpen)}>
            Add a note
          </button>
        </div>
        {notesOpen && (
          <div style={{ marginTop: 10 }}>
            <label htmlFor="notes">Your note (the office sees it)</label>
            <textarea id="notes" rows={2} style={{ width: '100%', boxSizing: 'border-box' }}
                      value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        )}
      </section>

      <section className="panel">
        <h2 className="side-h">What you dropped</h2>
        {remainderStop && (
          <div className="notice warn" style={{ margin: '0 0 8px' }}>
            The rest of an order that was part delivered. Only what is left is shown.
          </div>
        )}
        {stop.lines.map((l) => {
          const cased = l.bottles_per_case > 0;
          const ordered = cased ? l.cases : l.loose_bottles;
          const unit = cased ? (ordered === 1 ? 'case' : 'cases') : (ordered === 1 ? 'bottle' : 'bottles');
          return (
            <div key={l.order_line_id} className="drop-row">
              <div>
                <strong>{l.product_name.replace(/^Alka Vida\s+/i, '')}</strong>
                <div className="muted small">
                  {remainderStop ? `${ordered} ${unit} left to bring` : `ordered ${ordered} ${unit}`}
                  {l.is_bottle_charge ? ' · bought (short of empties)' : ''}
                </div>
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
                   value={emptiesShown} onChange={(e) => { setEmptiesTouched(true); setEmpties(e.target.value); }} />
            {expectedEmpties !== null ? (
              <div className="small"><strong>Expect {expectedEmpties} back</strong> (they said when ordering).</div>
            ) : carriesReturnables && (stop.bottlesHeld ?? 0) > 0 && (
              <div className="muted small">They have {stop.bottlesHeld} of our bottles.</div>
            )}
          </div>
          <div className="field">
            <label htmlFor="lost">Lost or damaged</label>
            <input id="lost" type="number" min="0" inputMode="numeric" placeholder="0"
                   value={lost} onChange={(e) => setLost(e.target.value)} />
          </div>
        </div>
        <p className="muted small" style={{ margin: 0 }}>Lost or damaged bottles are a business loss, never charged to the customer.</p>
        {carriesReturnables && stop.bottleCharge && !delivered_ && (shortAtDoor > 0 || charge) && (
          <div className="bottle-box">
            <label className="check" style={{ margin: 0 }}>
              <input type="checkbox" checked={charge} onChange={(e) => { setCharge(e.target.checked); setChargeQty(String(shortAtDoor || 1)); }} />
              <strong>{shortAtDoor > 0 ? `${shortAtDoor} empt${shortAtDoor === 1 ? 'y' : 'ies'} short.` : ''} Add the bottle charge</strong>
            </label>
            {charge && (
              <div className="row" style={{ alignItems: 'center', gap: 8, marginTop: 6 }}>
                <input type="number" min="1" inputMode="numeric" style={{ width: 80 }} aria-label="Bottles to charge"
                       value={chargeQty} onChange={(e) => setChargeQty(e.target.value)} />
                <span className="small">× {money(stop.bottleCharge.priceCents)} = <strong>{money(chargeN * stop.bottleCharge.priceCents)}</strong> + GCT, on today's invoice. The bottles are theirs to keep.</span>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="collect-head">
          <h2 className="side-h" style={{ margin: 0 }}>To collect</h2>
          <div className="owed">{money(stop.amountOwedCents)}</div>
        </div>
        {(stop.accountBalanceCents ?? 0) > 0 && (
          <div className="small">On their account altogether: <strong>{money(stop.accountBalanceCents!)}</strong></div>
        )}
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
          <button type="button" className="big-go" disabled={busy || partial} onClick={() => record('Delivered')}>
            {busy ? 'Saving…' : handingLess ? 'Delivered (they took less, nothing more to come)' : 'Delivered'}
          </button>
          <button type="button" className="secondary wide" style={{ marginTop: 8 }} disabled={busy} aria-expanded={partial}
                  onClick={() => { setPartial(!partial); if (!restOn) setRestOn(tomorrowOf(stop.sheet_date ?? new Date().toISOString().slice(0, 10))); }}>
            Partially delivered: the rest another day
          </button>
          {partial && (
            <section className="part-box">
              <h2 className="side-h" style={{ marginTop: 0 }}>Part delivered</h2>
              <p className="small" style={{ marginTop: 0 }}>
                Set <strong>What you dropped</strong> above to what you handed over. We invoice that now; the rest
                goes on the round for the day you pick, and is invoiced when it is delivered.
              </p>
              <div className="field">
                <label htmlFor="rest-day">When does the rest go?</label>
                <input id="rest-day" type="date" value={restOn} min={tomorrowOf(stop.sheet_date ?? new Date().toISOString().slice(0, 10))}
                       style={{ width: '100%', boxSizing: 'border-box' }} onChange={(e) => setRestOn(e.target.value)} />
              </div>
              {!handingLess && (
                <div className="notice warn" style={{ margin: '0 0 8px' }}>
                  Everything left is set to be handed over. Lower what you dropped above, or press Delivered.
                </div>
              )}
              <div className="row" style={{ gap: 8 }}>
                <button type="button" disabled={busy || !restOn || !handingLess}
                        onClick={() => record('Delivered', { remainderTo: restOn })}>
                  Record part delivery
                </button>
                <button type="button" className="secondary" onClick={() => setPartial(false)}>Cancel</button>
              </div>
            </section>
          )}
          <div className="not-delivered">
            <button type="button" className="secondary" disabled={busy} onClick={() => record('Customer Not Home')}>Not home</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => record('Refused')}>Refused</button>
            <button type="button" className="secondary" disabled={busy} aria-expanded={moving}
                    onClick={() => {
                      setMoving(!moving);
                      if (!moveTo) {
                        setMoveTo(tomorrowOf(stop.sheet_date ?? new Date().toISOString().slice(0, 10)));
                      }
                    }}>Another day</button>
            <button type="button" className="secondary" disabled={busy || !method || collectedCents <= 0}
                    title={method ? '' : 'Choose how they paid first'}
                    onClick={() => record('Payment Only')}>Payment only</button>
          </div>
          {!method && (
            <p className="muted small" style={{ textAlign: 'center', margin: '4px 0 0' }}>
              Took money but delivered nothing? Choose how they paid above, then Payment only.
            </p>
          )}
          {moving && (
            <section className="panel" style={{ marginTop: 10 }}>
              <h2 className="side-h">Deliver it another day</h2>
              <div className="field">
                <label htmlFor="mv-day">Which day?</label>
                <input id="mv-day" type="date" value={moveTo} min={new Date().toISOString().slice(0, 10)}
                       style={{ width: '100%', boxSizing: 'border-box' }} onChange={(e) => setMoveTo(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="mv-why">Why?</label>
                <input id="mv-why" value={moveWhy} placeholder="e.g. closed today, asked for Friday"
                       style={{ width: '100%', boxSizing: 'border-box' }} onChange={(e) => setMoveWhy(e.target.value)} />
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button type="button" disabled={busy || !moveTo}
                        onClick={() => record('Rescheduled', { rescheduleTo: moveTo, rescheduleReason: moveWhy || null, outcomeNotes: moveWhy || null })}>
                  Move it to that day
                </button>
                <button type="button" className="secondary" onClick={() => setMoving(false)}>Cancel</button>
              </div>
              <p className="muted small" style={{ marginBottom: 0 }}>It goes on that day's round for this area, and the office sees why.</p>
            </section>
          )}
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
