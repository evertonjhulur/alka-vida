import { useEffect, useMemo, useState } from 'react';
import { api, type Session } from '../lib/api';
import { money, date, statusTone } from '../lib/format';
import { StatementView } from './Statement';

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

interface Line { productId: string; qty: string }

const GCT_RATE = 0.15;
const BLANK_LINE: Line = { productId: '', qty: '' };

type Tab = 'order' | 'orders' | 'account';

export default function Portal({ session }: { session: Session }) {
  const [tab, setTab] = useState<Tab>('order');

  const [rows, setRows] = useState<Row[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [prices, setPrices] = useState<Priced[]>([]);
  const [myOrders, setMyOrders] = useState<MyOrder[]>([]);

  const [lines, setLines] = useState<Line[]>([{ ...BLANK_LINE }]);
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
    const b = await api.get<{ balanceCents: number }>(`/api/customers/${customerId}/balance`);
    setBalance(b.balanceCents);
    setPrices(await api.get<Priced[]>(`/api/customers/${customerId}/prices`));
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
    for (const l of lines) {
      const p = productOf(l.productId);
      const qty = Number(l.qty);
      if (!p || !Number.isFinite(qty) || qty <= 0) continue;
      subtotal += Math.round(qty) * rateOf(p);
    }
    const gct = Math.round(subtotal * GCT_RATE);
    return { subtotal, gct, grandTotal: subtotal + gct };
  }, [lines, prices]);

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function place(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setPlaced(null);

    // Whether a quantity means cases or loose bottles is the product's rule,
    // not the customer's.
    const payload = lines
      .filter((l) => l.productId && Number(l.qty) > 0)
      .map((l) => {
        const p = productOf(l.productId)!;
        const qty = Math.round(Number(l.qty));
        return p.bottles_per_case > 0
          ? { productId: l.productId, cases: qty }
          : { productId: l.productId, looseBottles: qty };
      });

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
      setLines([{ ...BLANK_LINE }]);
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
  const tabButton = (id: Tab, label: string) => (
    <button className={tab === id ? '' : 'secondary'} onClick={() => setTab(id)}>
      {label}
    </button>
  );

  const orderLine = (l: Line, i: number) => {
    const p = productOf(l.productId);
    return (
      <div className="row" key={i} style={{ alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: '1 1 280px' }}>
          <label htmlFor={`p${i}`}>Product</label>
          <select id={`p${i}`} value={l.productId} style={{ width: '100%' }}
                  onChange={(e) => setLine(i, { productId: e.target.value })}>
            <option value="">Choose…</option>
            {prices.map((x) => (
              <option key={x.product_id} value={x.product_id}>
                {x.name} — {money(rateOf(x))} per {unitOf(x)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`q${i}`}>How many {p ? `${unitOf(p)}s` : ''}</label>
          <input id={`q${i}`} type="number" min="1" step="1" style={{ width: 130 }}
                 value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} />
        </div>
        <div className="field">
          <div className="muted">
            {p && Number(l.qty) > 0 ? money(Math.round(Number(l.qty)) * rateOf(p)) : ''}
          </div>
        </div>
        {lines.length > 1 && (
          <div className="field">
            <button type="button" className="secondary"
                    onClick={() => setLines(lines.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        )}
      </div>
    );
  };

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

      <div className="row" style={{ marginBottom: 16 }}>
        {tabButton('order', 'Place an order')}{' '}
        {tabButton('orders', `My orders${myOrders.length ? ` (${myOrders.length})` : ''}`)}{' '}
        {tabButton('account', 'Invoices & statement')}
      </div>

      {tab === 'order' && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Place an order</h2>
          <p className="muted small">
            These are your own agreed rates
            {prices[0]?.price_tier ? ` (${prices[0].price_tier})` : ''}. The total
            below includes GCT. We confirm the exact amount when it is delivered,
            from what actually goes off the truck.
          </p>

          <form onSubmit={place}>
            {lines.map(orderLine)}

            <button type="button" className="secondary"
                    onClick={() => setLines([...lines, { ...BLANK_LINE }])}>
              Add another product
            </button>

            <div className="row" style={{ marginTop: 16 }}>
              <div className="field">
                <label htmlFor="dm">How would you like it?</label>
                <select id="dm" value={mode}
                        onChange={(e) => setMode(e.target.value as 'Delivery' | 'Pickup')}>
                  <option value="Delivery">Delivered to me</option>
                  <option value="Pickup">I will collect it</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="wd">
                  {mode === 'Pickup' ? 'When will you collect?' : 'When would you like it?'}
                </label>
                <input id="wd" type="date" value={wanted}
                       onChange={(e) => setWanted(e.target.value)} />
              </div>
              <div className="field" style={{ flex: '1 1 280px' }}>
                <label htmlFor="nt">Anything we should know?</label>
                <input id="nt" style={{ width: '100%' }} value={notes}
                       placeholder="e.g. leave at the back gate"
                       onChange={(e) => setNotes(e.target.value)} />
              </div>
            </div>

            <div className="panel" style={{ background: '#f9fafb', marginTop: 12 }}>
              <div className="total-line">
                <span>Subtotal</span><span>{money(totals.subtotal)}</span>
              </div>
              <div className="total-line">
                <span>GCT 15%</span><span>{money(totals.gct)}</span>
              </div>
              <div className="total-line">
                <strong>Total</strong><strong>{money(totals.grandTotal)}</strong>
              </div>
            </div>

            <button disabled={busy || totals.grandTotal === 0} style={{ marginTop: 12 }}>
              {busy ? 'Placing…' : 'Place order'}
            </button>
          </form>
        </div>
      )}

      {tab === 'orders' && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>My orders</h2>
          <table>
            <thead>
              <tr>
                <th>Order</th><th>Placed</th><th>Wanted</th>
                <th>How</th><th className="num">Total</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {myOrders.map((o) => (
                <tr key={o.id}>
                  <td>
                    {o.order_number}
                    {o.source === 'Portal' && <div className="muted small">placed by you</div>}
                  </td>
                  <td>{date(o.order_date)}</td>
                  <td>{o.requested_delivery_date ? date(o.requested_delivery_date) : '—'}</td>
                  <td className="small">
                    {o.delivery_mode === 'Pickup' ? 'Collection' : 'Delivery'}
                  </td>
                  <td className="num">{money(Number(o.grand_total_cents))}</td>
                  <td><span className={`chip ${statusTone(o.status)}`}>{o.status}</span></td>
                </tr>
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

      {tab === 'account' && (
        <>
          <div className="panel">
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
                    <td>{r.invoice_number}</td>
                    <td>{date(r.invoice_date)}</td>
                    <td className="num">{money(Number(r.grand_total_cents))}</td>
                    <td className="num">{money(Number(r.balance_cents))}</td>
                    <td><span className={`chip ${statusTone(r.status)}`}>{r.status}</span></td>
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
