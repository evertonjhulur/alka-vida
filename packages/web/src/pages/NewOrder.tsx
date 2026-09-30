import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, idempotencyKey } from '../lib/api';
import { money, day, date, todayInJamaica } from '../lib/format';
import CustomerPicker from '../components/CustomerPicker';

/**
 * New order, rebuilt from the approved mockup (29 Sep 2026).
 *
 * Left: who it is for (with what they owe and their terms, so nobody has to
 * look it up while on the phone), how it goes out, the date and which round
 * that puts it on, then what they want with − / + steppers and one-tap "Add"
 * buttons for the products not on the order yet. Right: "Repeat this order"
 * and the totals, GCT on the discounted figure exactly as the server does.
 */

interface Product {
  id: string;
  name: string;
  bottles_per_case: number;
  price_per_case_cents: number;
  price_per_bottle_cents: number;
  is_returnable?: boolean;
  special_price?: boolean;
}

interface Customer {
  id: string;
  name: string;
  phone: string | null;
  delivery_zone: string | null;
  price_tier: string | null;
  balance_cents: number | string | null;
  delivery_days?: string[] | null;
  zone_run_days?: string[] | null;
  invoice_cycle?: string | null;
  gct_exempt?: boolean;
}

interface Address {
  id: string; label: string; is_delivery: boolean; delivery_zone: string | null;
  address_line1: string | null; city: string | null;
}

interface History {
  customer: { payment_terms: string | null; price_tier_name: string | null; delivery_zone: string | null };
  invoices: Array<{ status: string; balance_cents: string }>;
  balanceCents: number;
}

interface Sheet {
  id: string; zone: string; delivery_date: string; status: string;
  started_at: string | null; stop_count: number;
}

interface Line {
  productId: string;
  qty: number;
  /** A price typed for this order only, in cents; null = their usual price. */
  price: number | null;
}

type Mode = 'Delivery' | 'Pickup' | 'Counter';
type Pattern = 'Weekly' | 'Biweekly' | 'Monthly';

const GCT_RATE = 0.15;
const MODES: Array<[Mode, string]> = [
  ['Delivery', 'We deliver'],
  ['Pickup', 'They collect'],
  ['Counter', 'Counter sale, paid now'],
];
const PATTERNS: Array<[Pattern, string]> = [
  ['Weekly', 'Every week'],
  ['Biweekly', 'Every 2 weeks'],
  ['Monthly', 'Every month'],
];

const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekdayOf = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
};
const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
/** The first date on or after `from` that falls on one of `days`. */
const nextRunDate = (from: string, days: string[]) => {
  if (!days.length) return from;
  for (let i = 0; i < 7; i++) {
    const d = addDays(from, i);
    if (days.includes(weekdayOf(d))) return d;
  }
  return from;
};

/** "Alka Vida 500ml" reads as "500ml": every product is Alka Vida. */
const shortName = (n: string) => n.replace(/^Alka Vida\s+/i, '');

/** The same rule as the server's nextOccurrence: +7, +14, or +1 month clamped. */
function nextAfter(iso: string, p: Pattern): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (p !== 'Monthly') {
    const t = new Date(Date.UTC(y, m - 1, d + (p === 'Weekly' ? 7 : 14)));
    return t.toISOString().slice(0, 10);
  }
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

export default function NewOrder() {
  // Arriving from "+ New > Counter sale" (?mode=Counter) or from a customer's
  // page (?customer=<id>) starts the form there instead of blank.
  const [params] = useSearchParams();
  const startMode = params.get('mode');
  const [products, setProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState(params.get('customer') ?? '');
  const [history, setHistory] = useState<History | null>(null);
  const [deliveryMode, setDeliveryMode] =
    useState<Mode>(startMode === 'Counter' || startMode === 'Pickup' ? startMode : 'Delivery');
  const [method, setMethod] = useState('Cash');
  // A walk-in is often not on file yet, and a receipt needs a name to carry.
  const [quickAdd, setQuickAdd] = useState(false);
  const [walkIn, setWalkIn] = useState({ name: '', phone: '', email: '' });
  // Jamaica's day, not UTC: after 7pm UTC is already tomorrow.
  const [requestedDate, setRequestedDate] = useState(todayInJamaica());
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [discount, setDiscount] = useState('0');
  const [discountAs, setDiscountAs] = useState<'%' | '$'>('%');
  const [chargeGct, setChargeGct] = useState(true);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [addressId, setAddressId] = useState('');
  const [repeatDays, setRepeatDays] = useState<string[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [paidNow, setPaidNow] = useState('');
  const [repeat, setRepeat] = useState(false);
  const [pattern, setPattern] = useState<Pattern>('Weekly');
  const [result, setResult] = useState<{ text: string; customerId: string } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<Product[]>('/api/products').then(setProducts).catch(() => {});
    api.get<Customer[]>('/api/customers').then(setCustomers).catch(() => {});
  }, []);

  const customer = customers.find((c) => c.id === customerId);

  // Re-price against the selected customer's tier, and read what they owe.
  useEffect(() => {
    setHistory(null);
    if (!customerId) {
      api.get<Product[]>('/api/products').then(setProducts).catch(() => {});
      return;
    }
    api.get<Array<Product & { product_id: string }>>(`/api/customers/${customerId}/prices`)
      .then((rows) => setProducts(rows.map((r) => ({ ...r, id: r.product_id }))))
      .catch(() => {});
    api.get<History>(`/api/customers/${customerId}/history`).then(setHistory).catch(() => {});
    api.get<Address[]>(`/api/customers/${customerId}/addresses`)
      .then((a) => setAddresses(a.filter((x) => x.is_delivery))).catch(() => setAddresses([]));
    setAddressId('');
  }, [customerId]);

  // A new customer brings their own GCT position, delivery days and the next
  // day their round runs (Everton, 30 Sep 2026).
  useEffect(() => {
    const c = customers.find((x) => x.id === customerId);
    if (!c) return;
    setChargeGct(!c.gct_exempt);
    const days = (c.delivery_days?.length ? c.delivery_days : c.zone_run_days) ?? [];
    setRepeatDays(days.length ? [...days] : []);
    if (deliveryMode === 'Delivery' && days.length) {
      setRequestedDate(nextRunDate(todayInJamaica(), days));
    }
  }, [customerId, customers.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Which round the date puts it on.
  useEffect(() => {
    setSheets(null);
    if (deliveryMode !== 'Delivery' || !requestedDate) return;
    api.get<Sheet[]>(`/api/delivery-sheets?date=${requestedDate}`).then(setSheets).catch(() => {});
  }, [deliveryMode, requestedDate]);

  const productOf = (id: string) => products.find((p) => p.id === id);

  /** Put a walk-in on file: a receipt has to carry a name, phone and email. */
  async function addWalkIn() {
    setBusy(true); setError(null);
    try {
      const made = await api.post<{ id: string }>('/api/customers', {
        name: walkIn.name, phone: walkIn.phone, email: walkIn.email,
      });
      setCustomers(await api.get<Customer[]>('/api/customers'));
      setCustomerId(made.id);
      setQuickAdd(false);
      setWalkIn({ name: '', phone: '', email: '' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the customer');
    } finally { setBusy(false); }
  }

  const listPriceOf = (p: Product) => (p.bottles_per_case > 0
    ? Number(p.price_per_case_cents) : Number(p.price_per_bottle_cents));
  /** The price on this line: typed for this order, else their usual. */
  const priceOf = (p: Product, l?: Line) => (l?.price ?? listPriceOf(p));

  /**
   * Live totals, mirroring the server calculation exactly: GCT is charged on
   * the POST-discount subtotal, so the figure shown is the real amount.
   */
  const totals = useMemo(() => {
    let subtotal = 0;
    for (const l of lines) {
      const p = productOf(l.productId);
      if (!p || l.qty <= 0) continue;
      subtotal += l.qty * priceOf(p, l);
    }
    const fixed = discountAs === '$' ? Math.max(0, Math.round((Number(discount) || 0) * 100)) : 0;
    const pct = discountAs === '%' ? Math.min(Math.max(Number(discount) || 0, 0), 100) : 0;
    const discountAmount = fixed > 0 ? Math.min(fixed, subtotal) : Math.round(subtotal * (pct / 100));
    const net = subtotal - discountAmount;
    const gct = chargeGct ? Math.round(net * GCT_RATE) : 0;
    return { subtotal, discountAmount, gct, grandTotal: net + gct, fixed, pct };
  }, [lines, discount, discountAs, chargeGct, products]);

  const setQty = (id: string, qty: number) => setLines((cur) => cur.map((l) => (
    l.productId === id ? { ...l, qty: Math.max(0, Math.min(99999, Math.round(qty) || 0)) } : l)));
  const setPrice = (id: string, typed: string) => setLines((cur) => cur.map((l) => {
    if (l.productId !== id) return l;
    const p = productOf(id);
    if (typed.trim() === '') return { ...l, price: null };
    const cents = Math.max(0, Math.round(Number(typed) * 100) || 0);
    return { ...l, price: p && cents === listPriceOf(p) ? null : cents };
  }));
  const addProduct = (id: string) => setLines((cur) => [...cur, { productId: id, qty: 1, price: null }]);
  const removeLine = (id: string) => setLines((cur) => cur.filter((l) => l.productId !== id));
  const notYet = products.filter((p) => !lines.some((l) => l.productId === p.id));

  const address = addresses.find((a) => a.id === addressId) ?? null;
  const zone = address?.delivery_zone ?? history?.customer.delivery_zone ?? customer?.delivery_zone ?? null;
  const zoneDays = address ? [] : (customer?.zone_run_days ?? []);
  const offDay = deliveryMode === 'Delivery' && zoneDays.length > 0 && requestedDate
    && !zoneDays.includes(weekdayOf(requestedDate));
  const round = sheets?.find((s) => s.zone === zone && s.status === 'Open') ?? null;
  const canRepeat = deliveryMode !== 'Counter';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setResult(null); setWarnings([]);

    // The case-vs-bottle rule decides which field a quantity belongs in.
    // A price typed on a line travels with it as an override; otherwise the
    // server charges their usual price, exactly as shown.
    const payloadLines = lines
      .filter((l) => l.qty > 0 && productOf(l.productId))
      .map((l) => {
        const cased = productOf(l.productId)!.bottles_per_case > 0;
        const price = l.price === null ? {}
          : cased ? { pricePerCaseCents: l.price } : { pricePerBottleCents: l.price };
        return cased
          ? { productId: l.productId, cases: l.qty, ...price }
          : { productId: l.productId, looseBottles: l.qty, ...price };
      });
    const money_ = {
      discountPercent: totals.pct,
      discountFixedCents: totals.fixed,
      gctExempt: !chargeGct,
    };

    if (payloadLines.length === 0) {
      setError('Add at least one product.');
      setBusy(false);
      return;
    }

    const who = customer?.name ?? 'the customer';
    try {
      if (deliveryMode === 'Counter') {
        // A counter sale creates the invoice and payment in one motion.
        const sale = await api.post<{
          invoiceNumber: string; grandTotalCents: number; balanceCents: number;
        }>('/api/counter-sale', {
          customerId,
          lines: payloadLines,
          ...money_,
          amountPaidCents: paidNow ? Math.round(Number(paidNow) * 100) : 0,
          method,
          idempotencyKey: idempotencyKey('counter'),
        });
        setResult({
          customerId,
          text: `Counter sale for ${who} done. Invoice ${sale.invoiceNumber} for ` +
            `${money(sale.grandTotalCents)}, balance ${money(sale.balanceCents)}.`,
        });
      } else {
        const order = await api.post<{
          id: string; orderNumber: string; grandTotalCents: number;
          deliverySheetId: string | null; warnings: string[];
        }>('/api/orders', {
          customerId,
          deliveryMode,
          requestedDeliveryDate: requestedDate,
          addressId: deliveryMode === 'Delivery' ? (addressId || null) : null,
          ...money_,
          lines: payloadLines,
        });
        const warn = [...(order.warnings ?? [])];
        let repeatText = '';
        if (repeat) {
          try {
            const r = await api.post<{ nextDeliveryDate: string }>(
              `/api/orders/${order.id}/recurring`, { pattern },
            );
            repeatText = ` It repeats ${PATTERNS.find(([p]) => p === pattern)![1].toLowerCase()}; ` +
              `the next is for ${day(r.nextDeliveryDate)}.`;
            /*
             * Several days a week (Everton, 30 Sep 2026): this order is the
             * standing order for its own day; each other day chosen gets its
             * own weekly standing order, starting on the next such day.
             */
            if (pattern === 'Weekly') {
              const others = repeatDays.filter((d) => d !== weekdayOf(requestedDate));
              const extra: string[] = [];
              for (const d of others) {
                const first = nextRunDate(addDays(requestedDate, 1), [d]);
                const o2 = await api.post<{ id: string }>('/api/orders', {
                  customerId, deliveryMode, requestedDeliveryDate: first,
                  addressId: deliveryMode === 'Delivery' ? (addressId || null) : null,
                  ...money_, lines: payloadLines,
                });
                await api.post(`/api/orders/${o2.id}/recurring`, { pattern: 'Weekly' });
                extra.push(`${d} (first ${day(first)})`);
              }
              if (extra.length) repeatText += ` Also every ${extra.join(', ')}.`;
            }
          } catch (err) {
            warn.push(`The order was made, but it could not be set to repeat: ${
              err instanceof Error ? err.message : 'unknown error'}. Use ⋯ on Orders to try again.`);
          }
        }
        setWarnings(warn);
        setResult({
          customerId,
          text: `Order ${order.orderNumber} for ${who}, ${money(order.grandTotalCents)}` +
            (deliveryMode === 'Pickup' ? `, to collect ${day(requestedDate)}.`
              : order.deliverySheetId ? `, on the ${zone ?? ''} round for ${day(requestedDate)}.`
                : '. It is not on a round yet.') + repeatText,
        });
      }
      setLines([]);
      setPaidNow('');
      setDiscount('0');
      setDiscountAs('%');
      setRepeat(false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the order');
    } finally {
      setBusy(false);
    }
  }

  // ---- the customer line under the name ----
  const open = history?.invoices.filter((i) => Number(i.balance_cents) > 0) ?? [];
  const late = open.filter((i) => i.status === 'Overdue');
  const owes = history?.balanceCents ?? Number(customer?.balance_cents ?? 0);
  const summary = customer ? [
    history?.customer.price_tier_name ? `${history.customer.price_tier_name} price list`
      : customer.price_tier ? `${customer.price_tier} price list` : 'List prices',
    customer.invoice_cycle === 'Weekly' ? 'invoiced weekly'
      : customer.invoice_cycle === 'Monthly' ? 'invoiced monthly'
        : history?.customer.payment_terms ?? null,
    zone ? `${zone} zone${customer.zone_run_days?.length ? ` (${customer.zone_run_days.join(', ')})` : ''}` : 'No delivery zone',
    customer.gct_exempt ? 'GCT exempt' : null,
  ].filter(Boolean).join(' · ') : '';

  const roundNote = (() => {
    if (deliveryMode !== 'Delivery' || !customer) return null;
    if (!zone) {
      return <span className="bad-text">No delivery zone on file, so this cannot go on a round. Set one on their Details tab.</span>;
    }
    if (!sheets) return null;
    if (round?.started_at) {
      return <>The {zone} round for {day(requestedDate)} is already on the road; this is added to it ({round.stop_count} stops).</>;
    }
    if (round) {
      return <>Goes on the {zone} round for {day(requestedDate)} ({round.stop_count} {round.stop_count === 1 ? 'stop' : 'stops'} so far).</>;
    }
    return <>Starts the {zone} round for {day(requestedDate)}. Nothing else is on it yet.</>;
  })();

  return (
    <>
      <Link to="/orders" className="back-link">← Orders</Link>
      <h1>New order</h1>

      {error && <div className="notice error">{error}</div>}
      {result && (
        <div className="notice ok">
          {result.text}{' '}
          <Link to={`/customers/${result.customerId}?tab=orders`}>See their orders</Link>
        </div>
      )}
      {warnings.map((w) => <div className="notice warn" key={w}>{w}</div>)}

      <form onSubmit={submit} className="order-grid">
        <div className="order-main">
          <section className="panel">
            <div className="field" style={{ maxWidth: 520 }}>
              <label htmlFor="cust">Customer</label>
              <CustomerPicker id="cust" customers={customers} value={customerId}
                              onChange={setCustomerId} />
              {customer && (
                <div className="muted small cust-summary">
                  {summary}
                  {history && (
                    <> · {owes > 0
                      ? <>owes <strong className="ink">{money(owes)}</strong>{late.length
                        ? <strong className="bad-text">, {late.length} late</strong> : ', none late'}</>
                      : owes < 0 ? <>in credit {money(-owes)}</> : 'owes nothing'}</>
                  )}
                  {' · '}<Link to={`/customers/${customer.id}`}>open</Link>
                </div>
              )}
            </div>

            <div className="field">
              <span className="label">How it goes out</span>
              <div className="seg" role="group" aria-label="How it goes out">
                {MODES.map(([m, label]) => (
                  <button key={m} type="button" className={deliveryMode === m ? 'active' : ''}
                          aria-pressed={deliveryMode === m}
                          onClick={() => { setDeliveryMode(m); if (m === 'Counter') setRepeat(false); }}>
                    {label}
                  </button>
                ))}
              </div>
              {/* Kept for anything that reads the mode by its old id. */}
              <input type="hidden" id="mode" value={deliveryMode} />
            </div>

            {deliveryMode === 'Delivery' && addresses.length > 0 && (
              <div className="field">
                <label htmlFor="addr">Deliver to</label>
                <select id="addr" value={addressId} onChange={(e) => setAddressId(e.target.value)}>
                  <option value="">Main address{customer?.delivery_zone ? ` (${customer.delivery_zone})` : ''}</option>
                  {addresses.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}{a.address_line1 ? `, ${a.address_line1}` : ''}{a.delivery_zone ? ` (${a.delivery_zone})` : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {deliveryMode !== 'Counter' ? (
              <div className="row" style={{ alignItems: 'center' }}>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label htmlFor="date">{deliveryMode === 'Pickup' ? 'Collect on' : 'Deliver on'}</label>
                  <input id="date" type="date" value={requestedDate} min={todayInJamaica()}
                         onChange={(e) => setRequestedDate(e.target.value)} />
                </div>
                {roundNote && <div className="small round-note">{roundNote}</div>}
                {offDay && (
                  <div className="notice warn" style={{ margin: 0, flexBasis: '100%' }}>
                    The {zone} round runs {zoneDays.join(', ')}, not {weekdayOf(requestedDate)}.{' '}
                    <button type="button" className="as-link"
                            onClick={() => setRequestedDate(nextRunDate(requestedDate, zoneDays))}>
                      Move it to {day(nextRunDate(requestedDate, zoneDays))}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <>
                {!quickAdd && (
                  <p className="muted small" style={{ margin: 0 }}>
                    Walk-in not on file?{' '}
                    <button type="button" className="secondary" onClick={() => setQuickAdd(true)}>
                      Add them quickly
                    </button>
                  </p>
                )}
                {quickAdd && (
                  <div className="sub-panel">
                    <strong>New walk-in customer</strong>
                    <p className="muted small" style={{ marginTop: 4 }}>
                      Enough to issue a receipt. The rest can be filled in later.
                    </p>
                    <div className="row">
                      <div className="field">
                        <label htmlFor="wi-name">Name</label>
                        <input id="wi-name" value={walkIn.name}
                               onChange={(e) => setWalkIn({ ...walkIn, name: e.target.value })} />
                      </div>
                      <div className="field">
                        <label htmlFor="wi-phone">Phone</label>
                        <input id="wi-phone" value={walkIn.phone}
                               onChange={(e) => setWalkIn({ ...walkIn, phone: e.target.value })} />
                      </div>
                      <div className="field">
                        <label htmlFor="wi-email">Email</label>
                        <input id="wi-email" type="email" value={walkIn.email}
                               onChange={(e) => setWalkIn({ ...walkIn, email: e.target.value })} />
                      </div>
                      <div className="field">
                        <button type="button"
                                disabled={busy || !walkIn.name.trim() || !walkIn.phone.trim()
                                          || !walkIn.email.trim()}
                                onClick={addWalkIn}>
                          Add and select
                        </button>{' '}
                        <button type="button" className="secondary"
                                onClick={() => setQuickAdd(false)}>Cancel</button>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>

          <section className="panel">
            <h2 style={{ marginTop: 0 }}>What they want</h2>
            {lines.length > 0 && (
              <table className="lines-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="num">{customer ? 'Unit price (theirs)' : 'Unit price'}</th>
                    <th>How many</th>
                    <th className="num">Line total</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => {
                    const p = productOf(l.productId);
                    if (!p) return null;
                    const cased = p.bottles_per_case > 0;
                    return (
                      <tr key={l.productId}>
                        <td data-label="Product">
                          <strong>{shortName(p.name)}</strong>
                          <div className="muted small">
                            {cased ? `by the case of ${p.bottles_per_case}` : 'by the bottle'}
                            {p.is_returnable ? ' · returnable' : ''}
                          </div>
                        </td>
                        <td data-label="Unit price" className="num">
                          <input type="number" min="0" step="0.01" inputMode="decimal"
                                 className={`price-input${l.price !== null ? ' changed' : ''}`}
                                 aria-label={`Price per ${cased ? 'case' : 'bottle'} of ${p.name}`}
                                 value={(priceOf(p, l) / 100).toFixed(2)}
                                 onChange={(e) => setPrice(l.productId, e.target.value)} />
                          <div className="muted small">
                            per {cased ? 'case' : 'bottle'}
                            {p.special_price && l.price === null && ' · special price'}
                            {l.price !== null && (
                              <> · <button type="button" className="as-link small"
                                           onClick={() => setPrice(l.productId, '')}>
                                usual {money(listPriceOf(p))}</button></>
                            )}
                          </div>
                        </td>
                        <td data-label="How many">
                          <span className="stepper">
                            <button type="button" className="secondary" aria-label={`Fewer ${p.name}`}
                                    disabled={l.qty <= 1} onClick={() => setQty(l.productId, l.qty - 1)}>−</button>
                            <input type="number" min="1" step="1" inputMode="numeric"
                                   aria-label={`How many ${p.name}${cased ? ', in cases' : ', in bottles'}`}
                                   value={l.qty || ''} onChange={(e) => setQty(l.productId, Number(e.target.value))} />
                            <button type="button" className="secondary" aria-label={`More ${p.name}`}
                                    onClick={() => setQty(l.productId, l.qty + 1)}>+</button>
                          </span>
                          <span className="muted small unit">{cased ? 'cs' : 'btl'}</span>
                        </td>
                        <td data-label="Line total" className="num">{money(l.qty * priceOf(p, l))}</td>
                        <td className="num">
                          <button type="button" className="danger-soft"
                                  onClick={() => removeLine(l.productId)}>Remove</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {lines.length === 0 && (
              <p className="muted" style={{ marginTop: 0 }}>Nothing yet. Tap a product to add it.</p>
            )}
            {notYet.length > 0 && (
              <div className="add-row">
                <span className="muted small">Add:</span>
                {notYet.map((p) => (
                  <button key={p.id} type="button" className="secondary" onClick={() => addProduct(p.id)}>
                    + {shortName(p.name)}
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>

        <aside className="order-side">
          {canRepeat && (
            <section className="panel">
              <div className="switch-row">
                <div>
                  <strong>Repeat this order</strong>
                  <div className="muted small">Raised for them automatically, a week before each date.</div>
                </div>
                <button type="button" role="switch" aria-checked={repeat} aria-label="Repeat this order"
                        className={`switch${repeat ? ' on' : ''}`} onClick={() => setRepeat(!repeat)}>
                  <span />
                </button>
              </div>
              {repeat && (
                <>
                  <div className="seg seg-small" role="group" aria-label="How often">
                    {PATTERNS.map(([p, label]) => (
                      <button key={p} type="button" className={pattern === p ? 'active' : ''}
                              aria-pressed={pattern === p} onClick={() => setPattern(p)}>{label}</button>
                    ))}
                  </div>
                  {pattern === 'Weekly' && (
                    <div style={{ marginTop: 10 }}>
                      <span className="label">On these days</span>
                      <div className="day-picks" role="group" aria-label="Repeat on these days">
                        {WEEK.map((d) => {
                          const on = repeatDays.includes(d) || d === weekdayOf(requestedDate);
                          return (
                            <button key={d} type="button" aria-pressed={on}
                                    className={`day-pick${on ? ' on' : ''}`}
                                    disabled={d === weekdayOf(requestedDate)}
                                    onClick={() => setRepeatDays((cur) => (cur.includes(d)
                                      ? cur.filter((x) => x !== d) : WEEK.filter((x) => x === d || cur.includes(x))))}>
                              {d}
                            </button>
                          );
                        })}
                      </div>
                      <div className="muted small" style={{ marginTop: 4 }}>
                        {weekdayOf(requestedDate)} is this order's own day. Each other day becomes
                        its own weekly standing order with the same products.
                      </div>
                    </div>
                  )}
                  {requestedDate && (
                    <div className="muted small" style={{ marginTop: 8 }}>
                      Next after this: {day(nextAfter(date(requestedDate), pattern))}
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          <section className="panel totals-card">
            <div className="total-line"><span>Subtotal</span><span>{money(totals.subtotal)}</span></div>
            <div className="total-line">
              <label htmlFor="disc" style={{ margin: 0, color: 'inherit', fontSize: 'inherit' }}>Discount</label>
              <span>
                <span className="money-toggle" role="group" aria-label="Discount as">
                  {(['%', '$'] as const).map((k) => (
                    <button key={k} type="button" className={discountAs === k ? 'on' : ''}
                            aria-pressed={discountAs === k}
                            onClick={() => { setDiscountAs(k); setDiscount('0'); }}>{k === '%' ? '%' : '$ amount'}</button>
                  ))}
                </span>{' '}
                <input id="disc" type="number" min="0" max={discountAs === '%' ? 100 : undefined} step="0.01"
                       style={{ width: 84 }} value={discount}
                       onChange={(e) => setDiscount(e.target.value)} />
              </span>
            </div>
            {totals.discountAmount > 0 && (
              <div className="total-line muted"><span /><span>−{money(totals.discountAmount)}</span></div>
            )}
            {/* GCT is charged on the post-discount figure. */}
            <div className="total-line">
              <label className="check" style={{ margin: 0 }}>
                <input type="checkbox" checked={chargeGct} onChange={(e) => setChargeGct(e.target.checked)} />
                GCT 15%
              </label>
              <span>{chargeGct ? money(totals.gct) : 'none'}</span>
            </div>
            {!chargeGct && (
              <div className="muted small">{customer?.gct_exempt ? 'They are GCT exempt.' : 'No GCT on this order.'}</div>
            )}
            <div className="total-line grand"><span>Total</span><span>{money(totals.grandTotal)}</span></div>

            {deliveryMode === 'Counter' ? (
              <div className="row" style={{ marginTop: 12 }}>
                <div className="field" style={{ flex: 1 }}>
                  <label htmlFor="meth">Paid by</label>
                  <select id="meth" value={method} style={{ width: '100%' }}
                          onChange={(e) => setMethod(e.target.value)}>
                    {['Cash', 'Card', 'Bank Transfer', 'Cheque', 'Other'].map((m) => <option key={m}>{m}</option>)}
                  </select>
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label htmlFor="paid">Received now</label>
                  <input id="paid" type="number" step="0.01" min="0" value={paidNow}
                         placeholder={(totals.grandTotal / 100).toFixed(2)} style={{ width: '100%' }}
                         onChange={(e) => setPaidNow(e.target.value)} />
                </div>
              </div>
            ) : (
              <p className="muted small" style={{ margin: '8px 0 0' }}>
                {customer?.invoice_cycle === 'Weekly' || customer?.invoice_cycle === 'Monthly'
                  ? <>Goes on their {customer.invoice_cycle.toLowerCase()} invoice, from what is actually {deliveryMode === 'Pickup' ? 'collected' : 'delivered'}.</>
                  : <>Invoiced from what is actually {deliveryMode === 'Pickup' ? 'collected' : 'delivered'}.</>}
              </p>
            )}

            <button className="wide" style={{ marginTop: 12 }}
                    disabled={busy || !customerId || lines.every((l) => l.qty <= 0)}>
              {busy ? 'Saving…'
                : deliveryMode === 'Counter' ? 'Complete counter sale'
                  : repeat ? 'Create standing order' : 'Create order'}
            </button>
            {!customerId && <p className="muted small" style={{ margin: '6px 0 0' }}>Choose the customer first.</p>}
          </section>
        </aside>
      </form>
    </>
  );
}
