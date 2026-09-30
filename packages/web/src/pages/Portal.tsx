import { Fragment, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, download, type Session } from '../lib/api';
import { money, date, statusTone, when } from '../lib/format';
import { StatementView } from './Statement';
import { ask, askText } from '../components/Dialog';

interface Row {
  invoice_id: string; invoice_number: string; invoice_date: string;
  grand_total_cents: number; balance_cents: number; status: string;
}

/** A product at THIS customer's own rate, from /api/customers/:id/prices. */
interface Priced {
  product_id: string; name: string; bottles_per_case: number;
  price_per_case_cents: number; price_per_bottle_cents: number;
  price_tier: string | null;
}

interface MyOrder {
  id: string; order_number: string; order_date: string;
  requested_delivery_date: string | null; status: string;
  delivery_mode: string; grand_total_cents: number; source: string;
}


/** One of the customer's own standing orders. */
interface Schedule {
  id: string; orderNumber: string; pattern: string;
  nextDeliveryDate: string | null; paused: boolean;
  occurrencesRaised: number; lineSummary: string;
}

const GCT_RATE = 0.15;
const PATTERNS = ['Weekly', 'Biweekly', 'Monthly'] as const;

type Tab = 'order' | 'orders' | 'repeats' | 'account' | 'quotes';

interface MyQuote {
  id: string; quote_number: string; quote_date: string; valid_until: string | null;
  status: string; grand_total_cents: number; lines_summary: string | null; expired: boolean;
}

export default function Portal({ session }: { session: Session }) {
  /*
   * Which module this is comes from the address, not from state: each one is
   * its own item in the sidebar, so it has to survive a reload and a
   * bookmark, and the highlighted nav item has to agree with what is on
   * screen.
   */
  const { tab: fromUrl } = useParams();
  const navigate = useNavigate();
  const tab: Tab = (['order', 'orders', 'repeats', 'account', 'quotes'] as const)
    .includes(fromUrl as Tab) ? (fromUrl as Tab) : 'order';
  const setTab = (t: Tab) => navigate(`/portal/${t}`);

  const [rows, setRows] = useState<Row[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [prices, setPrices] = useState<Priced[]>([]);
  const [myOrders, setMyOrders] = useState<MyOrder[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [repeatFor, setRepeatFor] = useState<string | null>(null);
  const [quotes, setQuotes] = useState<MyQuote[]>([]);

  // How many of each product, keyed by product: every product is on the
  // screen with − / +, rather than a line to add and a product to choose.
  const [qty, setQty] = useState<Record<string, number>>({});
  const [mode, setMode] = useState<'Delivery' | 'Pickup'>('Delivery');
  const [wanted, setWanted] = useState('');
  const [notes, setNotes] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const customerId = session.customerId;

  async function load() {
    if (!customerId) return;
    setRows(await api.get<Row[]>('/api/invoices'));
    setMyOrders(await api.get<MyOrder[]>('/api/orders'));
    setSchedules(await api.get<Schedule[]>('/api/portal/recurring'));
    const b = await api.get<{ balanceCents: number }>(`/api/customers/${customerId}/balance`);
    setBalance(b.balanceCents);
    setPrices(await api.get<Priced[]>(`/api/customers/${customerId}/prices`));
    setQuotes(await api.get<MyQuote[]>('/api/quotations').catch(() => []));
  }

  /** Accept or decline a quote sent to them (Everton, 30 Sep 2026). */
  async function answerQuote(q: MyQuote, decision: 'Accepted' | 'Declined') {
    if (decision === 'Declined' && !await ask(`Decline quotation ${q.quote_number}?`,
      { confirmLabel: 'Decline it', cancelLabel: 'Keep it', danger: true })) return;
    await act(async () => {
      await api.post(`/api/portal/quotations/${q.id}/answer`, { decision });
      setPlaced(decision === 'Accepted'
        ? `Thank you. Quotation ${q.quote_number} is accepted; we will be in touch to arrange it.`
        : `Quotation ${q.quote_number} declined.`);
    }, 'Could not send your answer');
  }

  async function act(what: () => Promise<void>, fallback: string) {
    setBusy(true); setError(null); setPlaced(null);
    try {
      await what();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    } finally { setBusy(false); }
  }

  /** Cancel an order that has not gone out yet. */
  async function cancelOrder(o: MyOrder) {
    if (!await ask(
      `Cancel order ${o.order_number}?\n\nIt will not be delivered.`,
      { confirmLabel: 'Cancel the order', cancelLabel: 'Keep it', danger: true },
    )) return;
    await act(async () => {
      await api.post(`/api/portal/orders/${o.id}/cancel`, {});
      setPlaced(`Order ${o.order_number} has been cancelled.`);
    }, 'Could not cancel the order');
  }

  /** Turn a pending order into a repeat. */
  async function makeRepeat(o: MyOrder, pattern: string) {
    await act(async () => {
      await api.post(`/api/portal/orders/${o.id}/repeat`, { pattern });
      setPlaced(
        `${o.order_number} will now repeat ${pattern.toLowerCase()}. `
        + 'We raise each one for you a week before it is due.',
      );
      setRepeatFor(null);
      setTab('repeats');
    }, 'Could not set up the repeat');
  }

  async function pauseRepeat(s: Schedule) {
    await act(async () => {
      await api.post(`/api/portal/recurring/${s.id}/pause`, { paused: !s.paused });
      setPlaced(s.paused
        ? 'Your repeat order has started again.'
        : 'Your repeat order is paused. Nothing will be sent until you start it again.');
    }, 'Could not change the repeat');
  }

  async function stopRepeat(s: Schedule) {
    if (!await ask(
      'Stop this repeat order for good?\n\n'
      + 'Anything already delivered is unaffected. To pause it for a while instead, '
      + 'use Pause.',
      { confirmLabel: 'Stop it', cancelLabel: 'Keep it', danger: true },
    )) return;
    await act(async () => {
      await api.post(`/api/portal/recurring/${s.id}/cancel`, {});
      setPlaced('Your repeat order has been stopped.');
    }, 'Could not stop the repeat');
  }

  useEffect(() => { load().catch((e) => setError(e.message)); }, [customerId]);

  const productOf = (id: string) => prices.find((p) => p.product_id === id);

  const unitOf = (p: Priced) => (p.bottles_per_case > 0 ? 'case' : 'bottle');
  const rateOf = (p: Priced) => (p.bottles_per_case > 0
    ? Number(p.price_per_case_cents)
    : Number(p.price_per_bottle_cents));

  /**
   * The total this customer will actually be asked for, worked out the same
   * way the server does it: their own tier rate, with GCT on top. Nothing is
   * quoted here that the server would not charge - order entry once previewed
   * list prices while the server saved tier prices, and nobody noticed until
   * a customer queried an invoice.
   */
  const totals = useMemo(() => {
    let subtotal = 0;
    for (const p of prices) {
      const n = qty[p.product_id] ?? 0;
      if (n > 0) subtotal += n * rateOf(p);
    }
    const gct = Math.round(subtotal * GCT_RATE);
    return { subtotal, gct, grandTotal: subtotal + gct };
  }, [qty, prices]);

  const bump = (id: string, by: number) =>
    setQty((q) => ({ ...q, [id]: Math.max(0, Math.min(9999, (q[id] ?? 0) + by)) }));

  async function place(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setPlaced(null);

    // Whether a quantity means cases or loose bottles is the product's rule,
    // not the customer's.
    const payload = prices
      .filter((p) => (qty[p.product_id] ?? 0) > 0)
      .map((p) => (p.bottles_per_case > 0
        ? { productId: p.product_id, cases: qty[p.product_id] }
        : { productId: p.product_id, looseBottles: qty[p.product_id] }));

    if (payload.length === 0) {
      setError('Choose at least one product and say how many you want.');
      setBusy(false);
      return;
    }

    try {
      const order = await api.post<{ orderNumber: string; grandTotalCents: number }>(
        '/api/orders',
        {
          lines: payload,
          deliveryMode: mode,
          requestedDeliveryDate: wanted || null,
          notes: notes || null,
        },
      );
      setPlaced(
        `Thank you — order ${order.orderNumber} for ${money(order.grandTotalCents)} is in. `
        + (mode === 'Pickup'
          ? 'We will have it ready for you to collect.'
          : 'It will go out on the next round for your area.'),
      );
      setQty({});
      setWanted(''); setNotes('');
      await load();
      setTab('orders');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not place the order');
    } finally { setBusy(false); }
  }

  if (!customerId) {
    return <div className="notice error">This login is not linked to a customer account.</div>;
  }

  /**
   * Plain functions returning JSX, NOT nested components: a component
   * declared inside another gets a new type on every render, so the inputs
   * unmount and lose focus on every keystroke.
   */
  return (
    <>
      <h1>My account</h1>
      <p className="subtitle">Order water, and see what you owe.</p>

      {error && <div className="notice error">{error}</div>}
      {placed && <div className="notice ok">{placed}</div>}

      <div className="panel">
        <div className="muted small">Current balance</div>
        <div className="owed">{money(balance ?? 0)}</div>
      </div>

      {tab === 'order' && (
        <form onSubmit={place} className="portal-order">
          <div>
            <h2 style={{ margin: 0 }}>Order water</h2>
            <p className="muted small" style={{ margin: '4px 0 0' }}>
              Your {prices[0]?.price_tier ? `${prices[0].price_tier} ` : ''}prices. We confirm the amount
              from what is actually delivered.
            </p>
          </div>

          <section className="panel">
            {prices.map((p) => {
              const n = qty[p.product_id] ?? 0;
              const cased = p.bottles_per_case > 0;
              return (
                <div key={p.product_id} className={`drop-row${n > 0 ? ' picked' : ''}`}>
                  <div>
                    <strong>{p.name.replace(/^Alka Vida\s+/i, '')}</strong>
                    <div className="muted small">
                      {money(rateOf(p))} {cased ? `a case of ${p.bottles_per_case}` : 'a bottle'}
                      {n > 0 ? ` · ${money(n * rateOf(p))}` : ''}
                    </div>
                  </div>
                  <div className="stepper big">
                    <button type="button" className="secondary" disabled={n === 0}
                            aria-label={`Fewer ${p.name}${cased ? ' cases' : ''}`} onClick={() => bump(p.product_id, -1)}>−</button>
                    <input type="number" min="0" inputMode="numeric" aria-label={`How many ${p.name}${cased ? ' cases' : ' bottles'}`}
                           value={n || ''} placeholder="0"
                           onChange={(e) => setQty((q) => ({ ...q, [p.product_id]: Math.max(0, Math.round(Number(e.target.value) || 0)) }))} />
                    <button type="button" className="secondary"
                            aria-label={`More ${p.name}${cased ? ' cases' : ''}`} onClick={() => bump(p.product_id, 1)}>+</button>
                  </div>
                </div>
              );
            })}
          </section>

          <section className="panel">
            <div className="seg seg-even" role="group" aria-label="Delivery or collection">
              <button type="button" className={mode === 'Delivery' ? 'active' : ''} aria-pressed={mode === 'Delivery'}
                      onClick={() => setMode('Delivery')}>Deliver to me</button>
              <button type="button" className={mode === 'Pickup' ? 'active' : ''} aria-pressed={mode === 'Pickup'}
                      onClick={() => setMode('Pickup')}>I&rsquo;ll collect</button>
            </div>
            <div className="two" style={{ marginTop: 10 }}>
              <div className="field">
                <label htmlFor="wd">{mode === 'Pickup' ? 'When will you collect?' : 'When would you like it? (optional)'}</label>
                <input id="wd" type="date" value={wanted} onChange={(e) => setWanted(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="nt">Anything we should know?</label>
                <input id="nt" value={notes} placeholder="e.g. leave at the back gate"
                       onChange={(e) => setNotes(e.target.value)} />
              </div>
            </div>
            <p className="muted small" style={{ margin: 0 }}>
              {mode === 'Pickup' ? 'We will have it ready for you.' : 'Left blank, it goes on the next round for your area.'}
            </p>
          </section>

          <div className="portal-total">
            <span className="muted small">{money(totals.subtotal)} + GCT {money(totals.gct)}</span>
            <strong>{money(totals.grandTotal)}</strong>
          </div>
          <button className="wide big" disabled={busy || totals.grandTotal === 0}>
            {busy ? 'Placing…' : 'Place order'}
          </button>
        </form>
      )}

      {tab === 'orders' && (
        <div className="panel phone-cards">
          <h2 style={{ marginTop: 0 }}>My orders</h2>
          <table>
            <thead>
              <tr>
                <th>Order</th><th>Placed</th><th>Wanted</th>
                <th>How</th><th className="num">Total</th><th>Status</th><th />
              </tr>
            </thead>
            <tbody>
              {myOrders.map((o) => (
                <Fragment key={o.id}>
                  <tr>
                    {/* On a phone this row is a card: `lead` is its heading,
                        and each other cell prints its own column name. */}
                    <td className="lead">
                      <span>
                        {o.order_number}
                        {o.source === 'Portal' && (
                          <div className="muted small">placed by you</div>
                        )}
                      </span>
                      {/* The status sits beside the number on a card; the
                          table below keeps its own Status column. */}
                      <span className={`chip ${statusTone(o.status)} phone-only`}>
                        {o.status}
                      </span>
                    </td>
                    <td data-label="Placed">{when(o.order_date)}</td>
                    <td data-label="Wanted"
                        className={o.requested_delivery_date ? undefined : 'empty'}>
                      {o.requested_delivery_date ? when(o.requested_delivery_date) : '—'}
                    </td>
                    <td data-label="How" className="small">
                      {o.delivery_mode === 'Pickup' ? 'Collection' : 'Delivery'}
                    </td>
                    <td data-label="Total" className="num money">
                      {money(Number(o.grand_total_cents))}
                    </td>
                    <td className="on-desktop">
                      <span className={`chip ${statusTone(o.status)}`}>{o.status}</span>
                    </td>
                    <td className="num actions">
                      {/* Only an order that has not gone out can be changed.
                          Once it is delivered it has been invoiced. */}
                      {/* Nothing at all once it has gone out, so the cell is
                          genuinely empty and the card drops the row. The
                          status is already on the line above. */}
                      {o.status === 'Pending' && (
                        <>
                          <button className="secondary" disabled={busy}
                                  onClick={() => setRepeatFor(repeatFor === o.id ? null : o.id)}>
                            {repeatFor === o.id ? 'Cancel' : 'Repeat this'}
                          </button>{' '}
                          <button className="danger-soft" disabled={busy}
                                  onClick={() => cancelOrder(o)}>
                            Cancel order
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                  {repeatFor === o.id && (
                    <tr>
                      <td colSpan={7} style={{ background: '#f9fafb' }}>
                        <strong>Get this order again, regularly</strong>
                        <p className="muted small" style={{ marginTop: 4 }}>
                          We will raise the same order for you each time, about a week
                          before it is due, at whatever your prices are on the day. You
                          can pause or stop it whenever you like.
                        </p>
                        {PATTERNS.map((p) => (
                          <span key={p}>
                            <button type="button" disabled={busy}
                                    onClick={() => makeRepeat(o, p)}>
                              {p === 'Weekly' ? 'Every week'
                                : p === 'Biweekly' ? 'Every two weeks' : 'Every month'}
                            </button>{' '}
                          </span>
                        ))}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          {myOrders.length === 0 && (
            <p className="muted">
              No orders yet. Use <strong>Place an order</strong> to make your first one.
            </p>
          )}
          <p className="muted small">
            The total shown is what we expect. The invoice is raised when the water is
            actually delivered, from the quantity delivered on the day.
          </p>
        </div>
      )}

      {tab === 'repeats' && (
        <div className="panel phone-cards">
          <h2 style={{ marginTop: 0 }}>Repeat orders</h2>
          <p className="muted small">
            An order we send you regularly without you having to ask. Set one up from
            <strong> My orders</strong> — place the order you want, then choose
            “Repeat this”.
          </p>
          <table>
            <thead>
              <tr>
                <th>What</th><th>How often</th><th>Next one</th>
                <th className="num">Sent so far</th><th>Status</th><th />
              </tr>
            </thead>
            <tbody>
              {schedules.map((s) => (
                <tr key={s.id}>
                  <td className="lead">
                    <span>
                      {s.lineSummary || s.orderNumber}
                      <div className="muted small">from {s.orderNumber}</div>
                    </span>
                    <span className={`chip ${s.paused ? 'warn' : 'ok'} phone-only`}>
                      {s.paused ? 'Paused' : 'Running'}
                    </span>
                  </td>
                  <td data-label="How often">
                    {s.pattern === 'Weekly' ? 'Every week'
                      : s.pattern === 'Biweekly' ? 'Every two weeks' : 'Every month'}
                  </td>
                  <td data-label="Next one"
                      className={s.nextDeliveryDate ? undefined : 'empty'}>
                    {s.nextDeliveryDate ? when(s.nextDeliveryDate) : '—'}
                  </td>
                  <td data-label="Sent so far" className="num">{s.occurrencesRaised}</td>
                  <td className="on-desktop">
                    <span className={`chip ${s.paused ? 'warn' : 'ok'}`}>
                      {s.paused ? 'Paused' : 'Running'}
                    </span>
                  </td>
                  <td className="num actions">
                    <button className="secondary" disabled={busy}
                            onClick={() => pauseRepeat(s)}>
                      {s.paused ? 'Start again' : 'Pause'}
                    </button>{' '}
                    <button className="danger-soft" disabled={busy}
                            onClick={() => stopRepeat(s)}>
                      Stop for good
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {schedules.length === 0 && (
            <p className="muted">
              You have no repeat orders. Place an order, then choose “Repeat this”
              against it in My orders.
            </p>
          )}
          <p className="muted small">
            Pausing keeps the arrangement but sends nothing until you start it again.
            Missed weeks are not made up afterwards.
          </p>
        </div>
      )}

      {tab === 'quotes' && (
        <div className="panel phone-cards">
          <h2 style={{ marginTop: 0 }}>Quotes from us</h2>
          <table>
            <thead><tr><th>Quote</th><th>What</th><th>Valid until</th><th className="num">Total</th><th /></tr></thead>
            <tbody>
              {quotes.map((q) => (
                <tr key={q.id}>
                  <td className="lead"><span>{q.quote_number}</span><span className="muted small">{when(q.quote_date)}</span></td>
                  <td data-label="What" className="small">{q.lines_summary}</td>
                  <td data-label="Valid until">{q.valid_until ? when(q.valid_until) : '—'}</td>
                  <td data-label="Total" className="num money">{money(Number(q.grand_total_cents))}</td>
                  <td className="num">
                    <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                      <button type="button" className="secondary" disabled={busy}
                              onClick={() => download(`/api/quotations/${q.id}/pdf`, `${q.quote_number}.pdf`).catch((e) => setError(e.message))}>PDF</button>
                      {q.status === 'Sent' && !q.expired ? (
                        <>
                          <button type="button" className="approve-soft" disabled={busy} onClick={() => answerQuote(q, 'Accepted')}>Accept</button>
                          <button type="button" className="danger-soft" disabled={busy} onClick={() => answerQuote(q, 'Declined')}>Decline</button>
                        </>
                      ) : (
                        <span className="chip neutral">{q.expired ? 'Expired' : q.status === 'Converted' ? 'Accepted, ordered' : q.status}</span>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {quotes.length === 0 && <p className="muted">No quotes yet.</p>}
        </div>
      )}

      {tab === 'account' && (
        <>
          <div className="panel phone-cards">
            <h2 style={{ marginTop: 0 }}>Invoices</h2>
            <table>
              <thead>
                <tr>
                  <th>Invoice</th><th>Date</th><th className="num">Total</th>
                  <th className="num">Balance</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.invoice_id}>
                    <td className="lead">
                      <span>{r.invoice_number}</span>
                      <span className={`chip ${statusTone(r.status)} phone-only`}>
                        {r.status}
                      </span>
                    </td>
                    <td data-label="Date">{when(r.invoice_date)}</td>
                    <td data-label="Total" className="num">
                      {money(Number(r.grand_total_cents))}
                    </td>
                    {/* What they still owe is the number that matters here. */}
                    <td data-label="Balance" className="num money">
                      {money(Number(r.balance_cents))}
                    </td>
                    <td className="on-desktop">
                      <span className={`chip ${statusTone(r.status)}`}>{r.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <p className="muted">No invoices yet.</p>}
          </div>

          <h2>Statement</h2>
          <StatementView customerId={customerId} />
        </>
      )}
    </>
  );
}
