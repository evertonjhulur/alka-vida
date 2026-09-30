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
}

interface Customer {
  id: string;
  name: string;
  phone: string | null;
  delivery_zone: string | null;
  price_tier: string | null;
  balance_cents: number | string | null;
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
  }, [customerId]);

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

  const priceOf = (p: Product) => (p.bottles_per_case > 0
    ? Number(p.price_per_case_cents) : Number(p.price_per_bottle_cents));

  /**
   * Live totals, mirroring the server calculation exactly: GCT is charged on
   * the POST-discount subtotal, so the figure shown is the real amount.
   */
  const totals = useMemo(() => {
    let subtotal = 0;
    for (const l of lines) {
      const p = productOf(l.productId);
      if (!p || l.qty <= 0) continue;
      subtotal += l.qty * priceOf(p);
    }
    const pct = Math.min(Math.max(Number(discount) || 0, 0), 100);
    const discountAmount = Math.round(subtotal * (pct / 100));
    const net = subtotal - discountAmount;
    const gct = Math.round(net * GCT_RATE);
    return { subtotal, discountAmount, gct, grandTotal: net + gct };
  }, [lines, discount, products]);

  const setQty = (id: string, qty: number) => setLines((cur) => cur.map((l) => (
    l.productId === id ? { ...l, qty: Math.max(0, Math.min(99999, Math.round(qty) || 0)) } : l)));
  const addProduct = (id: string) => setLines((cur) => [...cur, { productId: id, qty: 1 }]);
  const removeLine = (id: string) => setLines((cur) => cur.filter((l) => l.productId !== id));
  const notYet = products.filter((p) => !lines.some((l) => l.productId === p.id));

  const zone = history?.customer.delivery_zone ?? customer?.delivery_zone ?? null;
  const round = sheets?.find((s) => s.zone === zone && s.status === 'Open') ?? null;
  const canRepeat = deliveryMode !== 'Counter';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setResult(null); setWarnings([]);

    // The case-vs-bottle rule decides which field a quantity belongs in.
    const payloadLines = lines
      .filter((l) => l.qty > 0 && productOf(l.productId))
      .map((l) => (productOf(l.productId)!.bottles_per_case > 0
        ? { productId: l.productId, cases: l.qty }
        : { productId: l.productId, looseBottles: l.qty }));

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
          discountPercent: Number(discount) || 0,
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
          discountPercent: Number(discount) || 0,
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
    history?.customer.payment_terms ?? null,
    zone ? `${zone} zone` : 'No delivery zone',
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

            {deliveryMode !== 'Counter' ? (
              <div className="row" style={{ alignItems: 'center' }}>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label htmlFor="date">{deliveryMode === 'Pickup' ? 'Collect on' : 'Deliver on'}</label>
                  <input id="date" type="date" value={requestedDate} min={todayInJamaica()}
                         onChange={(e) => setRequestedDate(e.target.value)} />
                </div>
                {roundNote && <div className="small round-note">{roundNote}</div>}
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
                    <th className="num">{customer ? 'Their price' : 'Price'}</th>
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
                        <td data-label="Price" className="num">{money(priceOf(p))}</td>
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
                        <td data-label="Line total" className="num">{money(l.qty * priceOf(p))}</td>
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
                <input id="disc" type="number" min="0" max="100" step="0.01"
                       style={{ width: 64 }} value={discount}
                       onChange={(e) => setDiscount(e.target.value)} /> %
              </span>
            </div>
            {totals.discountAmount > 0 && (
              <div className="total-line muted"><span /><span>−{money(totals.discountAmount)}</span></div>
            )}
            {/* GCT is charged on the post-discount figure. */}
            <div className="total-line"><span>GCT 15%</span><span>{money(totals.gct)}</span></div>
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
                Invoiced from what is actually {deliveryMode === 'Pickup' ? 'collected' : 'delivered'}.
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
