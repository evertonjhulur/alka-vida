import { useEffect, useMemo, useState } from 'react';
import { api, idempotencyKey } from '../lib/api';
import { money } from '../lib/format';

interface Product {
  id: string;
  name: string;
  bottles_per_case: number;
  price_per_case_cents: number;
  price_per_bottle_cents: number;
}

interface Customer {
  id: string;
  name: string;
  delivery_zone: string | null;
  price_tier: string | null;
}

interface Line {
  productId: string;
  qty: string;
}

const GCT_RATE = 0.15;

export default function NewOrder() {
  const [products, setProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [deliveryMode, setDeliveryMode] =
    useState<'Delivery' | 'Pickup' | 'Counter'>('Delivery');
  const [method, setMethod] = useState('Cash');
  // A walk-in is often not on file yet, and a receipt needs a name to carry.
  const [quickAdd, setQuickAdd] = useState(false);
  const [walkIn, setWalkIn] = useState({ name: '', phone: '', email: '' });
  // toISOString() is UTC: after 7pm in Jamaica it prefills TOMORROW, and the
  // order lands on the wrong day's delivery sheet. en-CA gives YYYY-MM-DD in
  // the browser's own timezone, which is where the person typing is.
  const [requestedDate, setRequestedDate] = useState(
    new Date().toLocaleDateString('en-CA'),
  );
  const [discount, setDiscount] = useState('0');
  const [lines, setLines] = useState<Line[]>([{ productId: '', qty: '' }]);
  const [paidNow, setPaidNow] = useState('');
  const [tierName, setTierName] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<Product[]>('/api/products').then(setProducts).catch(() => {});
    api.get<Customer[]>('/api/customers').then(setCustomers).catch(() => {});
  }, []);

  // Re-price against the selected customer's tier. Without this the screen
  // previews list prices while the server saves tier prices, and staff would
  // quote a figure the customer is never actually charged.
  useEffect(() => {
    if (!customerId) {
      api.get<Product[]>('/api/products').then(setProducts).catch(() => {});
      setTierName(null);
      return;
    }
    api.get<Array<Product & { product_id: string; price_tier: string | null }>>(
      `/api/customers/${customerId}/prices`,
    )
      .then((rows) => {
        setProducts(rows.map((r) => ({ ...r, id: r.product_id })));
        setTierName(rows[0]?.price_tier ?? null);
      })
      .catch(() => {});
  }, [customerId]);

  const customer = customers.find((c) => c.id === customerId);
  const productOf = (id: string) => products.find((p) => p.id === id);

  /**
   * Live totals, mirroring the server calculation exactly: GCT is charged on
   * the POST-discount subtotal, so the figure shown at order entry is the
   * real tax-inclusive amount the customer will be asked for.
   *
   * Prices come from the customer own tier via /prices, so the figure shown
   * here matches what the server calculates when the order is saved.
   */
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

  const totals = useMemo(() => {
    let subtotal = 0;
    for (const l of lines) {
      const p = productOf(l.productId);
      const qty = Number(l.qty);
      if (!p || !Number.isFinite(qty) || qty <= 0) continue;
      subtotal += p.bottles_per_case > 0
        ? Math.round(qty) * p.price_per_case_cents
        : Math.round(qty) * p.price_per_bottle_cents;
    }
    const pct = Math.min(Math.max(Number(discount) || 0, 0), 100);
    const discountAmount = Math.round(subtotal * (pct / 100));
    const net = subtotal - discountAmount;
    const gct = Math.round(net * GCT_RATE);
    return { subtotal, discountAmount, gct, grandTotal: net + gct };
  }, [lines, discount, products]);

  function setLine(i: number, patch: Partial<Line>) {
    setLines((cur) => cur.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    setWarnings([]);

    // The case-vs-bottle rule decides which field a quantity belongs in.
    const payloadLines = lines
      .filter((l) => l.productId && Number(l.qty) > 0)
      .map((l) => {
        const p = productOf(l.productId)!;
        const qty = Math.round(Number(l.qty));
        return p.bottles_per_case > 0
          ? { productId: l.productId, cases: qty }
          : { productId: l.productId, looseBottles: qty };
      });

    if (payloadLines.length === 0) {
      setError('Add at least one product line.');
      setBusy(false);
      return;
    }

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
        setResult(
          `Counter sale complete. Invoice ${sale.invoiceNumber} for ` +
          `${money(sale.grandTotalCents)}. Balance ${money(sale.balanceCents)}.`,
        );
      } else {
        const order = await api.post<{
          orderNumber: string; grandTotalCents: number;
          deliverySheetId: string | null; warnings: string[];
        }>('/api/orders', {
          customerId,
          deliveryMode,
          requestedDeliveryDate: requestedDate,
          discountPercent: Number(discount) || 0,
          lines: payloadLines,
        });
        setWarnings(order.warnings ?? []);
        setResult(
          `Order ${order.orderNumber} created for ${money(order.grandTotalCents)}` +
          (order.deliverySheetId
            ? '. Added to the delivery sheet for that zone and date.'
            : '. Not routed — see the warning below.'),
        );
      }
      setLines([{ productId: '', qty: '' }]);
      setPaidNow('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the order');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>New order</h1>
      <p className="subtitle">
        An order is a commitment to fulfil. For a delivery, no invoice is raised until
        the goods are actually delivered.
      </p>

      {error && <div className="notice error">{error}</div>}
      {result && <div className="notice ok">{result}</div>}
      {warnings.map((w) => <div className="notice warn" key={w}>{w}</div>)}

      <form onSubmit={submit}>
        <div className="panel">
          <div className="row">
            <div className="field" style={{ flex: '1 1 260px' }}>
              <label htmlFor="cust">Customer</label>
              <select id="cust" value={customerId} required style={{ width: '100%' }}
                      onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">Select a customer…</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}{c.price_tier ? ` — ${c.price_tier}` : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="mode">Fulfilment</label>
              <select id="mode" value={deliveryMode}
                      onChange={(e) => setDeliveryMode(
                        e.target.value as 'Delivery' | 'Pickup' | 'Counter')}>
                <option value="Delivery">Delivery</option>
                <option value="Pickup">Pickup — collected later</option>
                <option value="Counter">Counter sale — paying now</option>
              </select>
            </div>

            {deliveryMode !== 'Counter' && (
              <div className="field">
                <label htmlFor="date">
                  {deliveryMode === 'Pickup' ? 'Collection date' : 'Requested date'}
                </label>
                <input id="date" type="date" value={requestedDate}
                       onChange={(e) => setRequestedDate(e.target.value)} />
              </div>
            )}

          </div>

          {deliveryMode === 'Counter' && (
            <div className="field" style={{ maxWidth: 260 }}>
              <label htmlFor="meth">Paid by</label>
              <select id="meth" value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="Cash">Cash</option>
                <option value="Card">Card</option>
                <option value="Bank Transfer">Bank Transfer</option>
                <option value="Cheque">Cheque</option>
                <option value="Other">Other</option>
              </select>
            </div>
          )}

          {deliveryMode === 'Counter' && !quickAdd && (
            <p className="muted small">
              Walk-in not on file?{' '}
              <button type="button" className="secondary"
                      onClick={() => setQuickAdd(true)}>Add them quickly</button>
            </p>
          )}

          {quickAdd && (
            <div className="panel" style={{ background: '#f9fafb' }}>
              <strong>New walk-in customer</strong>
              <p className="muted small" style={{ marginTop: 4 }}>
                Enough to issue a receipt. Anything else can be filled in later on
                the customer record.
              </p>
              <div className="row" style={{ alignItems: 'flex-end' }}>
                <div className="field">
                  <label>Name</label>
                  <input value={walkIn.name}
                         onChange={(e) => setWalkIn({ ...walkIn, name: e.target.value })} />
                </div>
                <div className="field">
                  <label>Phone</label>
                  <input value={walkIn.phone}
                         onChange={(e) => setWalkIn({ ...walkIn, phone: e.target.value })} />
                </div>
                <div className="field">
                  <label>Email</label>
                  <input type="email" value={walkIn.email}
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

          {deliveryMode === 'Delivery' && customer && !customer.delivery_zone && (
            <div className="notice warn">
              {customer.name} has no delivery zone set, so this order cannot be
              auto-routed onto a sheet. Set a zone on the customer record first.
            </div>
          )}
        </div>

        <div className="panel">
          <h2 style={{ marginTop: 0 }}>
            Products{' '}
            {customerId && (
              <span className="muted small" style={{ fontWeight: 400 }}>
                — priced at {tierName ? `the ${tierName} tier` : 'list price'}
              </span>
            )}
          </h2>
          <table>
            <thead>
              <tr>
                <th style={{ width: '50%' }}>Product</th>
                <th>Quantity</th>
                <th className="num">Line total</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const p = productOf(l.productId);
                const qty = Math.max(Math.round(Number(l.qty) || 0), 0);
                const lineTotal = !p ? 0
                  : p.bottles_per_case > 0
                    ? qty * p.price_per_case_cents
                    : qty * p.price_per_bottle_cents;
                return (
                  <tr key={i}>
                    <td>
                      <select value={l.productId} style={{ width: '100%' }}
                              onChange={(e) => setLine(i, { productId: e.target.value, qty: '' })}>
                        <option value="">Select a product…</option>
                        {products.map((prod) => (
                          <option key={prod.id} value={prod.id}>{prod.name}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      {/* The unit follows bottles_per_case: cased goods are sold
                          only by the case, the 5-gallon only by the bottle. */}
                      {p ? (
                        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                          <input type="number" min="1" step="1" style={{ width: 90 }}
                                 value={l.qty}
                                 onChange={(e) => setLine(i, { qty: e.target.value })} />
                          <span className="muted small">
                            {p.bottles_per_case > 0
                              ? `cases of ${p.bottles_per_case}`
                              : 'bottles'}
                          </span>
                        </span>
                      ) : <span className="muted small">—</span>}
                    </td>
                    <td className="num">{money(lineTotal)}</td>
                    <td className="num">
                      {lines.length > 1 && (
                        <button type="button" className="secondary"
                                onClick={() => setLines((c) => c.filter((_, x) => x !== i))}>
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ marginTop: 12 }}>
            <button type="button" className="secondary"
                    onClick={() => setLines((c) => [...c, { productId: '', qty: '' }])}>
              Add line
            </button>
          </div>
        </div>

        <div className="panel" style={{ maxWidth: 380, marginLeft: 'auto' }}>
          <div className="total-line"><span>Subtotal</span><span>{money(totals.subtotal)}</span></div>
          <div className="total-line">
            <span>
              Discount{' '}
              <input id="disc" type="number" min="0" max="100" step="0.01"
                     style={{ width: 70 }} value={discount}
                     aria-label="Discount percent"
                     onChange={(e) => setDiscount(e.target.value)} />
              <span className="muted small"> %</span>
            </span>
            <span>-{money(totals.discountAmount)}</span>
          </div>
          {/* GCT is charged on the post-discount figure. */}
          <div className="total-line"><span>GCT 15%</span><span>{money(totals.gct)}</span></div>
          <div className="total-line grand">
            <span>Total due</span><span>{money(totals.grandTotal)}</span>
          </div>

          {deliveryMode === 'Counter' && (
            <div className="field" style={{ marginTop: 14 }}>
              <label htmlFor="paid">Cash received now</label>
              <input id="paid" type="number" step="0.01" min="0" value={paidNow}
                     placeholder="0.00" style={{ width: '100%' }}
                     onChange={(e) => setPaidNow(e.target.value)} />
            </div>
          )}

          <button style={{ width: '100%', marginTop: 14 }} disabled={busy || !customerId}>
            {busy ? 'Saving…'
              : deliveryMode === 'Counter' ? 'Complete counter sale' : 'Create order'}
          </button>
        </div>
      </form>
    </>
  );
}
