import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { money, date, day, relDay, toCents, todayInJamaica } from '../lib/format';

/**
 * Orders: what is waiting, and what happened to the rest.
 *
 * Rebuilt from the approved mockup (29 Sep 2026). Each row says where the
 * order stands in words ("Collect today", "On a round", "Missed yesterday")
 * instead of the bare database status, what is on it, and the round it is
 * on. The everyday action sits on the row (Collected, for a collection);
 * the rest are under ⋯, with Cancel in red. Nothing uses browser pop-ups
 * any more: each action opens a small panel under its row.
 */

interface Order {
  id: string; order_number: string; customer_name: string; customer_id: string;
  order_date: string; requested_delivery_date: string | null;
  status: string; delivery_mode: string; grand_total_cents: number;
  discount_percent: number; source: string;
  discount_fixed_cents?: number; gct_exempt?: boolean;
  is_recurring: boolean; recurrence_pattern: string | null; parent_recurring_id: string | null;
  customer_zone: string | null; today: string; lines_summary: string | null;
  stop_id: string | null; stop_outcome: string | null; sheet_id: string | null;
  sheet_zone: string | null; sheet_date: string | null; sheet_status: string | null;
  sheet_started: boolean | null;
  customer_po?: string | null; address_id?: string | null; needs_review?: boolean;
  /** Moves and part deliveries (7 Oct 2026, points 8 and 9). */
  events?: Array<{ kind: string; from: string; to: string; reason: string | null }>;
  remaining_summary?: string | null;
}
interface Addr { id: string; label: string; address_line1: string | null; is_delivery: boolean }
interface Product {
  id: string; product_id?: string; name: string; bottles_per_case: number;
  price_per_case_cents: number; price_per_bottle_cents: number;
}
interface OrderLine {
  id: string; product_id: string; product_name: string;
  bottles_per_case: number; cases: number; loose_bottles: number;
  price_per_case_cents: number; price_per_bottle_cents: number;
}

type Show = 'waiting' | 'delivered' | 'cancelled' | 'all';
type When = 'any' | 'today' | 'week' | 'late' | 'range';
type Panel = 'collect' | 'repeat' | 'offround' | 'cancel';

const GCT_RATE = 0.15;

const OUTCOME: Record<string, string> = {
  'Customer Not Home': 'not home', Refused: 'refused', Rescheduled: 'rescheduled', Other: 'not delivered',
  'Payment Only': 'paid, nothing delivered',
};

/** Where an order stands, in the words the office uses. */
function standing(o: Order, today: string): { label: string; tone: string } {
  if (o.status === 'Cancelled') return { label: 'Cancelled', tone: 'muted' };
  if (o.status === 'Delivered') {
    return {
      label: o.delivery_mode === 'Pickup' ? 'Collected'
        : o.delivery_mode === 'Counter' ? 'Sold' : 'Delivered',
      tone: 'ok',
    };
  }
  if (o.status === 'Partially Delivered') {
    return { label: o.requested_delivery_date ? `Part delivered · rest ${day(o.requested_delivery_date)}` : 'Part delivered', tone: 'warn' };
  }
  if (o.needs_review) return { label: 'Needs approval', tone: 'warn' };

  const forDay = o.requested_delivery_date ? date(o.requested_delivery_date) : null;
  if (o.delivery_mode === 'Pickup') {
    if (forDay === today) return { label: 'Collect today', tone: 'info' };
    if (forDay && forDay < today) return { label: 'Not collected yet', tone: 'warn' };
    return { label: 'To collect', tone: 'neutral' };
  }
  if (o.stop_outcome && OUTCOME[o.stop_outcome]) {
    return { label: `Missed ${relDay(o.sheet_date, today)}`, tone: 'bad' };
  }
  if (o.stop_id && o.sheet_status === 'Open') {
    if (o.sheet_started) return { label: 'On the road', tone: 'info' };
    if (o.sheet_date && date(o.sheet_date) < today) return { label: 'Late', tone: 'bad' };
    return { label: 'On a round', tone: 'info' };
  }
  return { label: 'Needs a round', tone: 'warn' };
}

/** "5 x Alka Vida 5 Gallon" reads as "5 x 5 Gallon": every product is Alka Vida. */
const short = (summary: string | null) => (summary ?? '—').replace(/Alka Vida\s+/gi, '');

function howLabel(o: Order): string {
  if (o.delivery_mode === 'Pickup') return 'Collection';
  if (o.delivery_mode === 'Counter') return 'Counter sale';
  if (o.sheet_zone) return `${o.sheet_zone} round`;
  return o.customer_zone ? `Delivery · ${o.customer_zone}` : 'Delivery';
}

function origin(o: Order): string {
  if (o.parent_recurring_id) return 'raised by standing order';
  if (o.is_recurring) return `repeats ${(o.recurrence_pattern ?? '').toLowerCase()}`.trim();
  return `${o.source === 'Portal' ? 'ordered online' : 'placed'} ${day(o.order_date)}`;
}

export default function Orders() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [orders, setOrders] = useState<Order[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [find, setFind] = useState(params.get('find') ?? '');
  const [show, setShow] = useState<Show>(params.get('find') ? 'all' : 'waiting');
  /** A date range (team feedback, point 10.1), on the delivery date or the day placed. */
  const [range, setRange] = useState({ from: '', to: '', by: 'delivery' as 'delivery' | 'placed' });
  const [poEdit, setPoEdit] = useState('');
  const [addrEdit, setAddrEdit] = useState('');
  const [addrs, setAddrs] = useState<Addr[]>([]);
  const [empties, setEmpties] = useState('');
  const [how, setHow] = useState('');
  const [when, setWhen] = useState<When>('any');
  const [limit, setLimit] = useState(50);

  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [open, setOpen] = useState<{ id: string; kind: Panel } | null>(null);
  const [paidNow, setPaidNow] = useState('');
  const [paidHow, setPaidHow] = useState('Cash');
  const [repeatEvery, setRepeatEvery] = useState('Weekly');

  const [editing, setEditing] = useState<Order | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  /** price: the unit price in dollars as typed, '' = their usual price. */
  const [lines, setLines] = useState<Array<{ productId: string; qty: string; price: string }>>([]);
  const [reqDate, setReqDate] = useState('');
  const [discount, setDiscount] = useState('0');
  const [discountAs, setDiscountAs] = useState<'%' | '$'>('%');
  const [chargeGct, setChargeGct] = useState(true);

  async function load() {
    // A date range asks the server, so orders older than the latest 500 are
    // found too; otherwise the latest 500 are filtered here.
    const q = when === 'range' && (range.from || range.to)
      ? `&from=${range.from}&to=${range.to}&dateBy=${range.by}` : '';
    setOrders(await api.get<Order[]>(`/api/orders?limit=500${q}`));
  }
  useEffect(() => { load().catch((e) => setError(e.message)); }, [when, range.from, range.to, range.by]); // eslint-disable-line react-hooks/exhaustive-deps

  // A click anywhere else closes the ⋯ menu.
  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menuFor]);

  async function startEdit(o: Order) {
    setError(null); setMsg(null);
    try {
      // Price against this customer's own tier, so the edited total matches
      // what the server will save.
      const priced = await api.get<Product[]>(`/api/customers/${o.customer_id}/prices`);
      setProducts(priced.map((p) => ({ ...p, id: p.product_id ?? p.id })));

      const detail = await api.get<{ lines: OrderLine[] }>(`/api/orders/${o.id}`);
      // Each line keeps the price it was taken at (repricing never rewrites
      // an order), shown so it can be seen and changed.
      setLines(detail.lines.map((l) => {
        const cased = Number(l.bottles_per_case) > 0;
        return {
          productId: l.product_id,
          qty: String(cased ? l.cases : l.loose_bottles),
          price: (Number(cased ? l.price_per_case_cents : l.price_per_bottle_cents) / 100).toFixed(2),
        };
      }));
      setReqDate(o.requested_delivery_date?.slice(0, 10) ?? '');
      const fixed = Number(o.discount_fixed_cents) || 0;
      setDiscountAs(fixed > 0 ? '$' : '%');
      setDiscount(fixed > 0 ? (fixed / 100).toFixed(2) : String(Number(o.discount_percent) || 0));
      setChargeGct(!o.gct_exempt);
      setPoEdit(o.customer_po ?? '');
      setAddrEdit(o.address_id ?? '');
      setAddrs(await api.get<Addr[]>(`/api/customers/${o.customer_id}/addresses`).catch(() => []));
      setEditing(o);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open that order');
    }
  }

  const productOf = (id: string) => products.find((p) => p.id === id);
  const usualOf = (p: Product) => (Number(p.bottles_per_case) > 0
    ? Number(p.price_per_case_cents) : Number(p.price_per_bottle_cents));
  const unitOf = (l: { productId: string; price: string }) => {
    const p = productOf(l.productId);
    if (!p) return 0;
    return l.price.trim() === '' ? usualOf(p) : Math.max(0, Math.round(Number(l.price) * 100) || 0);
  };

  const totals = (() => {
    let subtotal = 0;
    for (const l of lines) {
      const qty = Math.max(Math.round(Number(l.qty) || 0), 0);
      subtotal += qty * unitOf(l);
    }
    const fixed = discountAs === '$' ? Math.max(0, Math.round((Number(discount) || 0) * 100)) : 0;
    const pct = discountAs === '%' ? Math.min(Math.max(Number(discount) || 0, 0), 100) : 0;
    const discountAmount = fixed > 0 ? Math.min(fixed, subtotal) : Math.round(subtotal * (pct / 100));
    const net = subtotal - discountAmount;
    const gct = chargeGct ? Math.round(net * GCT_RATE) : 0;
    return { subtotal, discountAmount, gct, grandTotal: net + gct, fixed, pct };
  })();

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setBusy(true); setError(null);
    try {
      const payload = lines
        .filter((l) => l.productId && Number(l.qty) > 0)
        .map((l) => {
          const p = productOf(l.productId)!;
          const qty = Math.round(Number(l.qty));
          const unit = unitOf(l);
          return Number(p.bottles_per_case) > 0
            ? { productId: l.productId, cases: qty, pricePerCaseCents: unit }
            : { productId: l.productId, looseBottles: qty, pricePerBottleCents: unit };
        });
      if (payload.length === 0) throw new Error('An order needs at least one line.');

      const r = await api.patch<{ grandTotalCents: number; warnings?: string[] }>(`/api/orders/${editing.id}`, {
        lines: payload,
        requestedDeliveryDate: reqDate || null,
        discountPercent: totals.pct,
        discountFixedCents: totals.fixed,
        gctExempt: !chargeGct,
        customerPo: poEdit,
        ...(editing.delivery_mode === 'Delivery' ? { addressId: addrEdit || null } : {}),
      });
      const moved = reqDate && reqDate !== (editing.requested_delivery_date ?? '').slice(0, 10);
      setMsg(`${editing.order_number} updated. New total ${money(r.grandTotalCents)}.`
        + (moved && editing.delivery_mode === 'Delivery' ? ` It is now on the round for ${day(reqDate)}.` : '')
        + (r.warnings?.length ? ` ${r.warnings.join(' ')}` : ''));
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the order');
    } finally { setBusy(false); }
  }

  /**
   * Hand a pickup order over: this is the moment it becomes a bill, exactly
   * as a delivery does when the stop is marked Delivered. Payment is optional
   * - collecting on account is normal for a corporate customer.
   */
  async function collect(o: Order) {
    await act(async () => {
      const out = await api.post<{ invoiceNumber: string | null; balanceCents: number }>(
        `/api/orders/${o.id}/collect`,
        { amountPaidCents: toCents(paidNow || '0'), method: paidHow, emptiesReturned: Number(empties) || 0 },
      );
      return out.invoiceNumber
        ? `${o.order_number} collected. Invoice ${out.invoiceNumber} raised, balance ${money(out.balanceCents)}.`
        : `${o.order_number} collected. It goes on their weekly/monthly invoice; `
          + `anything paid now is on their account.`;
    }, 'Could not record the collection');
  }

  /**
   * Turn this order into a standing order. It stays exactly as it is and
   * becomes the first delivery of the series; Alka Vida raises the ones after
   * it automatically.
   */
  async function makeStanding(o: Order) {
    await act(async () => {
      const r = await api.post<{ nextDeliveryDate: string }>(
        `/api/orders/${o.id}/recurring`, { pattern: repeatEvery },
      );
      return `${o.customer_name} now repeats ${repeatEvery.toLowerCase()}. ` +
        `The next one is for ${day(r.nextDeliveryDate)} and will be raised automatically.`;
    }, 'Could not set up the repeat');
  }

  async function cancel(o: Order) {
    await act(async () => {
      await api.post(`/api/orders/${o.id}/cancel`, { reason: 'cancelled by office' });
      return `${o.order_number} cancelled.`;
    }, 'Could not cancel');
  }

  /** Off the round, still waiting: it can go on another round or be collected. */
  async function offRound(o: Order) {
    await act(async () => {
      await api.del(`/api/stops/${o.stop_id}`);
      return `${o.order_number} taken off the ${o.sheet_zone} round. It is still waiting.`;
    }, 'Could not take it off the round');
  }

  async function act(what: () => Promise<string>, fallback: string) {
    setBusy(true); setError(null); setMsg(null);
    try {
      setMsg(await what());
      setOpen(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    } finally { setBusy(false); }
  }

  const openPanel = (o: Order, kind: Panel) => {
    setMenuFor(null);
    setError(null);
    if (kind === 'collect') { setPaidNow(''); setPaidHow('Cash'); setEmpties(''); }
    if (kind === 'repeat') setRepeatEvery('Weekly');
    setOpen(open?.id === o.id && open.kind === kind ? null : { id: o.id, kind });
  };

  // ---- what is shown ----
  const today = orders[0]?.today ? date(orders[0].today) : todayInJamaica();
  const waiting = (o: Order) => o.status === 'Pending' || o.status === 'Partially Delivered';
  const weekEnd = (() => {
    const d = new Date(`${today}T12:00:00Z`);
    const toSunday = (7 - d.getUTCDay()) % 7;
    d.setUTCDate(d.getUTCDate() + toSunday);
    return d.toISOString().slice(0, 10);
  })();
  const needle = find.trim().toLowerCase();
  const byStatus = (o: Order) => (show === 'waiting' ? waiting(o)
    : show === 'delivered' ? o.status === 'Delivered'
      : show === 'cancelled' ? o.status === 'Cancelled' : true);
  const forDay = (o: Order) => (o.requested_delivery_date ? date(o.requested_delivery_date) : date(o.order_date));
  const byWhen = (o: Order) => {
    const d = forDay(o);
    if (when === 'today') return d === today;
    if (when === 'week') return d >= today && d <= weekEnd;
    if (when === 'late') return d < today && waiting(o);
    if (when === 'range') {
      const d2 = range.by === 'placed' ? date(o.order_date) : d;
      return (!range.from || d2 >= range.from) && (!range.to || d2 <= range.to);
    }
    return true;
  };
  const shown = orders
    .filter((o) => byStatus(o) && byWhen(o)
      && (how === '' || o.delivery_mode === how)
      && (!needle || o.order_number.toLowerCase().includes(needle)
        || o.customer_name.toLowerCase().includes(needle)))
    .sort((a, b) => (show === 'waiting'
      ? forDay(a).localeCompare(forDay(b)) || a.order_number.localeCompare(b.order_number)
      : 0));
  const page = shown.slice(0, limit);
  const count = (f: Show) => orders.filter((o) => (f === 'waiting' ? waiting(o)
    : f === 'delivered' ? o.status === 'Delivered'
      : f === 'cancelled' ? o.status === 'Cancelled' : true)).length;

  const pill = (key: Show, label: string, withCount = false) => (
    <button type="button" className={`pill${show === key ? ' active' : ''}`}
            aria-pressed={show === key} onClick={() => { setShow(key); setLimit(50); }}>
      {label}{withCount ? ` · ${count(key)}` : ''}
    </button>
  );

  const menu = (o: Order) => {
    const onRound = !!o.stop_id && o.sheet_status === 'Open' && o.stop_outcome === 'Pending'
      && !o.sheet_started;
    return (
      <div className="deskbar-pop deskbar-pop-right row-menu" role="menu">
        <button role="menuitem" className="pop-item pop-button"
                onClick={() => { setMenuFor(null); startEdit(o); }}>Change the order</button>
        {!o.is_recurring && !o.parent_recurring_id && o.delivery_mode !== 'Counter' && (
          <button role="menuitem" className="pop-item pop-button"
                  onClick={() => openPanel(o, 'repeat')}>Make it a standing order</button>
        )}
        {onRound && (
          <button role="menuitem" className="pop-item pop-button"
                  onClick={() => openPanel(o, 'offround')}>Take it off the round</button>
        )}
        <div className="pop-rule" />
        <button role="menuitem" className="pop-item pop-button pop-danger"
                onClick={() => openPanel(o, 'cancel')}>Cancel order</button>
      </div>
    );
  };

  const panelFor = (o: Order) => {
    if (!open || open.id !== o.id) return null;
    const close = (
      <button type="button" className="secondary" onClick={() => setOpen(null)}>Close</button>
    );
    let body: ReactNode = null;
    if (open.kind === 'collect') {
      body = (
        <>
          <div className="field">
            <label htmlFor={`paid-${o.id}`}>Paid now</label>
            <input id={`paid-${o.id}`} inputMode="decimal" placeholder="0.00" style={{ width: 130 }}
                   value={paidNow} onChange={(e) => setPaidNow(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`how-${o.id}`}>How</label>
            <select id={`how-${o.id}`} value={paidHow} onChange={(e) => setPaidHow(e.target.value)}>
              {['Cash', 'Card', 'Bank Transfer'].map((m) => <option key={m}>{m}</option>)}
            </select>
          </div>
          <div className="field">
            <button type="button" className="secondary"
                    onClick={() => setPaidNow((Number(o.grand_total_cents) / 100).toFixed(2))}>
              Paid in full
            </button>
          </div>
          {/gallon/i.test(o.lines_summary ?? '') && (
            <div className="field">
              <label htmlFor={`emp-${o.id}`}>5-gal empties handed in</label>
              <input id={`emp-${o.id}`} type="number" min="0" style={{ width: 90 }} value={empties}
                     onChange={(e) => setEmpties(e.target.value)} />
            </div>
          )}
          <div className="field">
            <button disabled={busy} onClick={() => collect(o)}>
              {busy ? 'Saving…' : `${o.order_number} collected`}
            </button>
          </div>
          <div className="field">{close}</div>
          <p className="muted small order-panel-note">
            Leave “Paid now” blank to put it on their account. The invoice is raised now.
          </p>
        </>
      );
    } else if (open.kind === 'repeat') {
      body = (
        <>
          <div className="field">
            <label htmlFor={`every-${o.id}`}>Repeat</label>
            <select id={`every-${o.id}`} value={repeatEvery}
                    onChange={(e) => setRepeatEvery(e.target.value)}>
              <option value="Weekly">Every week</option>
              <option value="Biweekly">Every two weeks</option>
              <option value="Monthly">Every month</option>
            </select>
          </div>
          <div className="field">
            <button disabled={busy} onClick={() => makeStanding(o)}>Make it a standing order</button>
          </div>
          <div className="field">{close}</div>
          <p className="muted small order-panel-note">
            This order stays as it is and becomes the first one. The next are raised
            automatically; pause or end them under Standing orders.
          </p>
        </>
      );
    } else if (open.kind === 'offround') {
      body = (
        <>
          <p className="order-panel-note" style={{ margin: 0 }}>
            Take {o.order_number} off the {o.sheet_zone} round for {day(o.sheet_date)}?
            The order stays waiting.
          </p>
          <div className="field">
            <button className="danger-soft" disabled={busy} onClick={() => offRound(o)}>
              Take it off
            </button>
          </div>
          <div className="field">{close}</div>
        </>
      );
    } else {
      body = (
        <>
          <p className="order-panel-note" style={{ margin: 0 }}>
            Cancel {o.order_number} for {o.customer_name}
            {o.stop_id && o.sheet_status === 'Open' ? `? It comes off the ${o.sheet_zone} round too.` : '?'}
          </p>
          <div className="field">
            <button className="danger-soft" disabled={busy} onClick={() => cancel(o)}>
              Cancel the order
            </button>
          </div>
          <div className="field"><button type="button" className="secondary" onClick={() => setOpen(null)}>Keep it</button></div>
        </>
      );
    }
    return (
      <tr className="order-panel-row">
        <td colSpan={7}><div className="order-panel">{body}</div></td>
      </tr>
    );
  };

  return (
    <>
      <div className="panel-head record-head">
        <div>
          <h1>Orders</h1>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            Only a waiting order can be changed. Once delivered, a correction goes on the invoice.
          </p>
        </div>
        <div className="record-actions">
          <button onClick={() => navigate('/orders/new')}>New order</button>
        </div>
      </div>
      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      {editing && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>
            Edit {editing.order_number} — {editing.customer_name}
          </h2>
          <form onSubmit={saveEdit}>
            <div className="row">
              <div className="field">
                <label htmlFor="rd">Delivery date</label>
                <input id="rd" type="date" value={reqDate}
                       onChange={(e) => setReqDate(e.target.value)} />
                {editing.delivery_mode === 'Delivery' && (
                  <div className="muted small">A new date moves it to that day's round.</div>
                )}
              </div>
              {editing.delivery_mode === 'Delivery' && (
                <div className="field">
                  <label htmlFor="ad">Deliver to</label>
                  <select id="ad" value={addrEdit} onChange={(e) => setAddrEdit(e.target.value)}>
                    <option value="">Main address</option>
                    {addrs.filter((a) => a.is_delivery).map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                  </select>
                </div>
              )}
              <div className="field">
                <label htmlFor="po">Customer's PO no.</label>
                <input id="po" style={{ width: 130 }} value={poEdit} onChange={(e) => setPoEdit(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="dp">Discount</label>
                <span className="money-toggle" role="group" aria-label="Discount as">
                  {(['%', '$'] as const).map((k) => (
                    <button key={k} type="button" className={discountAs === k ? 'on' : ''}
                            onClick={() => { setDiscountAs(k); setDiscount('0'); }}>{k === '%' ? '%' : '$ amount'}</button>
                  ))}
                </span>{' '}
                <input id="dp" type="number" min="0" max={discountAs === '%' ? 100 : undefined} step="0.01"
                       style={{ width: 100 }} value={discount}
                       onChange={(e) => setDiscount(e.target.value)} />
              </div>
              <label className="check">
                <input type="checkbox" checked={chargeGct} onChange={(e) => setChargeGct(e.target.checked)} />
                Charge GCT
              </label>
            </div>

            <table>
              <thead>
                <tr>
                  <th style={{ width: '38%' }}>Product</th><th>Quantity</th>
                  <th className="num">Unit price</th>
                  <th className="num">Line total</th><th />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const p = productOf(l.productId);
                  const qty = Math.max(Math.round(Number(l.qty) || 0), 0);
                  const lineTotal = !p ? 0 : qty * unitOf(l);
                  return (
                    <tr key={i}>
                      <td>
                        <select value={l.productId} style={{ width: '100%' }}
                                onChange={(e) => setLines(lines.map((x, j) =>
                                  j === i ? { productId: e.target.value, qty: '', price: '' } : x))}>
                          <option value="">Select a product…</option>
                          {products.map((pr) => (
                            <option key={pr.id} value={pr.id}>{pr.name}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        {p ? (
                          <>
                            <input type="number" min="1" style={{ width: 90 }} value={l.qty}
                                   onChange={(e) => setLines(lines.map((x, j) =>
                                     j === i ? { ...x, qty: e.target.value } : x))} />
                            <span className="muted small" style={{ marginLeft: 6 }}>
                              {Number(p.bottles_per_case) > 0
                                ? `cases of ${p.bottles_per_case}` : 'bottles'}
                            </span>
                          </>
                        ) : <span className="muted small">—</span>}
                      </td>
                      <td className="num">
                        {p && (
                          <>
                            <input type="number" min="0" step="0.01" className="price-input"
                                   aria-label={`Unit price of ${p.name}`}
                                   value={l.price === '' ? (usualOf(p) / 100).toFixed(2) : l.price}
                                   onChange={(e) => setLines(lines.map((x, j) =>
                                     j === i ? { ...x, price: e.target.value } : x))} />
                            <div className="muted small">per {Number(p.bottles_per_case) > 0 ? 'case' : 'bottle'}</div>
                          </>
                        )}
                      </td>
                      <td className="num">{money(lineTotal)}</td>
                      <td className="num">
                        {lines.length > 1 && (
                          <button type="button" className="danger-soft"
                                  onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div style={{ marginTop: 10 }}>
              <button type="button" className="secondary"
                      onClick={() => setLines([...lines, { productId: '', qty: '', price: '' }])}>
                Add line
              </button>
            </div>

            <div style={{ maxWidth: 320, marginLeft: 'auto', marginTop: 12 }}>
              <div className="total-line"><span>Subtotal</span><span>{money(totals.subtotal)}</span></div>
              <div className="total-line">
                <span>Discount</span><span>-{money(totals.discountAmount)}</span>
              </div>
              <div className="total-line"><span>GCT 15%</span><span>{money(totals.gct)}</span></div>
              <div className="total-line grand">
                <span>Total due</span><span>{money(totals.grandTotal)}</span>
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <button disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>{' '}
              <button type="button" className="secondary" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="panel" style={{ padding: 0 }}>
        <div className="list-filters">
          <div className="field">
            <label htmlFor="find">Find an order</label>
            <input id="find" type="search" placeholder="Order number or customer"
                   value={find} onChange={(e) => { setFind(e.target.value); setLimit(50); }} />
          </div>
          <div className="pills" role="group" aria-label="Status">
            {pill('waiting', 'Waiting', true)}
            {pill('delivered', 'Delivered')}
            {pill('cancelled', 'Cancelled')}
            {pill('all', 'All')}
          </div>
          <div className="field">
            <label htmlFor="kind">How</label>
            <select id="kind" value={how} onChange={(e) => setHow(e.target.value)}>
              <option value="">Any way</option>
              <option value="Delivery">Delivery</option>
              <option value="Pickup">Collection</option>
              <option value="Counter">Counter sale</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="when">For</label>
            <select id="when" value={when} onChange={(e) => setWhen(e.target.value as When)}>
              <option value="any">Any day</option>
              <option value="today">Today</option>
              <option value="week">This week</option>
              <option value="late">Late (before today)</option>
              <option value="range">Dates…</option>
            </select>
          </div>
          {when === 'range' && (
            <>
              <div className="field">
                <label htmlFor="rfrom">From</label>
                <input id="rfrom" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="rto">To</label>
                <input id="rto" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="rby">By</label>
                <select id="rby" value={range.by} onChange={(e) => setRange({ ...range, by: e.target.value as 'delivery' | 'placed' })}>
                  <option value="delivery">Delivery date</option>
                  <option value="placed">Day placed</option>
                </select>
              </div>
            </>
          )}
        </div>

        <table className="orders-table">
          <thead>
            <tr>
              <th>Order</th><th>Customer</th><th>Delivery date</th><th>How</th>
              <th>Status</th><th className="num">Total</th><th />
            </tr>
          </thead>
          <tbody>
            {page.map((o) => {
              const st = standing(o, today);
              const pending = o.status === 'Pending';
              return (
                <Fragment key={o.id}>
                  <tr className={open?.id === o.id ? 'is-open' : undefined}>
                    <td data-label="Order">
                      <strong>{o.order_number}</strong>
                      <div className="muted small">{origin(o)}</div>
                      {o.customer_po && <div className="muted small">PO {o.customer_po}</div>}
                    </td>
                    <td data-label="Customer">
                      <Link to={`/customers/${o.customer_id}?tab=orders`}>{o.customer_name}</Link>
                      <div className="muted small">{short(o.lines_summary)}</div>
                      {(o.events?.length ?? 0) > 0 && (
                        <ul className="order-events">
                          {o.events!.map((ev, k) => (
                            <li key={k} className={ev.kind === 'Part delivered' ? 'part' : undefined}>
                              {ev.kind === 'Rescheduled'
                                ? `Rescheduled from ${day(ev.from)} to ${day(ev.to)}${ev.reason ? ` (${ev.reason})` : ''}`
                                : `Part delivered ${day(ev.from)}; rest ${day(ev.to)}`}
                            </li>
                          ))}
                        </ul>
                      )}
                      {o.status === 'Partially Delivered' && o.remaining_summary && (
                        <div className="small" style={{ color: 'var(--warn)' }}>Still to go: {short(o.remaining_summary)}</div>
                      )}
                    </td>
                    <td data-label="Delivery date">{o.delivery_mode === 'Counter' ? day(o.order_date) : day(o.requested_delivery_date)}</td>
                    <td data-label="How">{howLabel(o)}</td>
                    <td data-label="Status"><span className={`chip ${st.tone}`}>{st.label}</span></td>
                    <td data-label="Total" className="num">{money(Number(o.grand_total_cents))}</td>
                    <td className="num order-actions">
                      {pending ? (
                        <>
                          {/* A pickup is billed when the customer actually takes it,
                              the same rule a delivery follows at the stop. */}
                          {o.delivery_mode === 'Pickup' && (
                            <button disabled={busy} onClick={() => openPanel(o, 'collect')}>Collected</button>
                          )}
                          <span className="deskbar-menu">
                            <button type="button" className="secondary more-button"
                                    aria-label={`More for ${o.order_number}`}
                                    aria-haspopup="true" aria-expanded={menuFor === o.id}
                                    onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === o.id ? null : o.id); }}>
                              ⋯
                            </button>
                            {menuFor === o.id && menu(o)}
                          </span>
                        </>
                      ) : (
                        <span className="muted small">
                          {o.status === 'Cancelled' ? '' : 'invoiced'}
                        </span>
                      )}
                    </td>
                  </tr>
                  {panelFor(o)}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {shown.length === 0 && (
          <p className="muted" style={{ padding: '14px 16px', margin: 0 }}>
            {orders.length === 0 ? 'No orders yet.' : 'No orders match.'}
          </p>
        )}
        <div className="list-foot">
          <span>
            {page.length} of {shown.length} {show === 'waiting' ? 'waiting · soonest first' : 'shown · newest first'}
          </span>
          {shown.length > page.length && (
            <button type="button" className="secondary" onClick={() => setLimit(limit + 50)}>Show more</button>
          )}
        </div>
      </div>
    </>
  );
}
