import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { money, date } from '../lib/format';

interface Order {
  id: string; order_number: string; customer_name: string; customer_id: string;
  order_date: string; requested_delivery_date: string | null;
  status: string; delivery_mode: string; grand_total_cents: number;
  discount_percent: number;
}
interface Product {
  id: string; product_id?: string; name: string; bottles_per_case: number;
  price_per_case_cents: number; price_per_bottle_cents: number;
}
interface OrderLine {
  id: string; product_id: string; product_name: string;
  bottles_per_case: number; cases: number; loose_bottles: number;
}

const GCT_RATE = 0.15;

export default function Orders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [editing, setEditing] = useState<Order | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [lines, setLines] = useState<Array<{ productId: string; qty: string }>>([]);
  const [reqDate, setReqDate] = useState('');
  const [discount, setDiscount] = useState('0');

  async function load() {
    const q = status ? `?status=${encodeURIComponent(status)}` : '';
    setOrders(await api.get<Order[]>(`/api/orders${q}`));
  }
  useEffect(() => { load().catch((e) => setError(e.message)); }, [status]);

  async function startEdit(o: Order) {
    setError(null); setMsg(null);
    try {
      // Price against this customer's own tier, so the edited total matches
      // what the server will save.
      const priced = await api.get<Product[]>(`/api/customers/${o.customer_id}/prices`);
      setProducts(priced.map((p) => ({ ...p, id: p.product_id ?? p.id })));

      const detail = await api.get<{ lines: OrderLine[] }>(`/api/orders/${o.id}`);
      setLines(detail.lines.map((l) => ({
        productId: l.product_id,
        qty: String(Number(l.bottles_per_case) > 0 ? l.cases : l.loose_bottles),
      })));
      setReqDate(o.requested_delivery_date?.slice(0, 10) ?? '');
      setDiscount(String(Number(o.discount_percent) || 0));
      setEditing(o);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open that order');
    }
  }

  const productOf = (id: string) => products.find((p) => p.id === id);

  const totals = (() => {
    let subtotal = 0;
    for (const l of lines) {
      const p = productOf(l.productId);
      const qty = Math.max(Math.round(Number(l.qty) || 0), 0);
      if (!p) continue;
      subtotal += Number(p.bottles_per_case) > 0
        ? qty * Number(p.price_per_case_cents)
        : qty * Number(p.price_per_bottle_cents);
    }
    const pct = Math.min(Math.max(Number(discount) || 0, 0), 100);
    const discountAmount = Math.round(subtotal * (pct / 100));
    const net = subtotal - discountAmount;
    const gct = Math.round(net * GCT_RATE);
    return { subtotal, discountAmount, gct, grandTotal: net + gct };
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
          return Number(p.bottles_per_case) > 0
            ? { productId: l.productId, cases: qty }
            : { productId: l.productId, looseBottles: qty };
        });
      if (payload.length === 0) throw new Error('An order needs at least one line.');

      const r = await api.patch<{ grandTotalCents: number }>(`/api/orders/${editing.id}`, {
        lines: payload,
        requestedDeliveryDate: reqDate || null,
        discountPercent: Number(discount) || 0,
      });
      setMsg(`${editing.order_number} updated. New total ${money(r.grandTotalCents)}.`);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the order');
    } finally { setBusy(false); }
  }

  async function cancel(o: Order) {
    if (!window.confirm(`Cancel ${o.order_number}? It will be removed from its route.`)) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/api/orders/${o.id}/cancel`, { reason: 'cancelled by office' });
      setMsg(`${o.order_number} cancelled.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel');
    } finally { setBusy(false); }
  }

  return (
    <>
      <h1>Orders</h1>
      <p className="subtitle">
        An order is a commitment to fulfil. Only a pending order can be changed —
        once delivered, the correction belongs on the invoice.
      </p>
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
                <label htmlFor="rd">Requested delivery date</label>
                <input id="rd" type="date" value={reqDate}
                       onChange={(e) => setReqDate(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="dp">Discount %</label>
                <input id="dp" type="number" min="0" max="100" step="0.01"
                       style={{ width: 100 }} value={discount}
                       onChange={(e) => setDiscount(e.target.value)} />
              </div>
            </div>

            <table>
              <thead>
                <tr>
                  <th style={{ width: '45%' }}>Product</th><th>Quantity</th>
                  <th className="num">Line total</th><th />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const p = productOf(l.productId);
                  const qty = Math.max(Math.round(Number(l.qty) || 0), 0);
                  const lineTotal = !p ? 0
                    : Number(p.bottles_per_case) > 0
                      ? qty * Number(p.price_per_case_cents)
                      : qty * Number(p.price_per_bottle_cents);
                  return (
                    <tr key={i}>
                      <td>
                        <select value={l.productId} style={{ width: '100%' }}
                                onChange={(e) => setLines(lines.map((x, j) =>
                                  j === i ? { productId: e.target.value, qty: '' } : x))}>
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
                      <td className="num">{money(lineTotal)}</td>
                      <td className="num">
                        {lines.length > 1 && (
                          <button type="button" className="secondary"
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
                      onClick={() => setLines([...lines, { productId: '', qty: '' }])}>
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

      <div className="panel">
        <div className="field" style={{ maxWidth: 220 }}>
          <label htmlFor="st">Status</label>
          <select id="st" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {['Pending', 'Partially Delivered', 'Delivered', 'Cancelled'].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        <table>
          <thead>
            <tr>
              <th>Order</th><th>Customer</th><th>Ordered</th><th>For</th>
              <th>Type</th><th>Status</th><th className="num">Total</th><th />
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td>{o.order_number}</td>
                <td>{o.customer_name}</td>
                <td>{date(o.order_date)}</td>
                <td>{date(o.requested_delivery_date)}</td>
                <td className="small muted">{o.delivery_mode}</td>
                <td>
                  <span className={`chip ${
                    o.status === 'Delivered' ? 'ok'
                    : o.status === 'Pending' ? 'neutral'
                    : o.status === 'Cancelled' ? 'muted' : 'warn'}`}>
                    {o.status}
                  </span>
                </td>
                <td className="num">{money(Number(o.grand_total_cents))}</td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>
                  {o.status === 'Pending' ? (
                    <>
                      <button className="secondary" onClick={() => startEdit(o)}>Edit</button>{' '}
                      <button className="secondary" disabled={busy}
                              onClick={() => cancel(o)}>Cancel</button>
                    </>
                  ) : (
                    <span className="muted small">
                      {o.status === 'Cancelled' ? '—' : 'invoiced'}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {orders.length === 0 && <p className="muted">No orders found.</p>}
      </div>
    </>
  );
}
