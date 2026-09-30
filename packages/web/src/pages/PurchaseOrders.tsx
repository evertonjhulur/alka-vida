import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { money, toCents, date, when } from '../lib/format';

interface Supplier {
  id: string; name: string;
  materials: Array<{ rawMaterialId: string; name: string; unitOfMeasure: string }>;
}
interface PO {
  id: string; po_number: string; supplier_name: string; order_date: string;
  status: string; grand_total_cents: number; line_count: number;
}
interface POLine {
  id: string; raw_material_name: string; unit_of_measure: string;
  quantity_ordered: number; quantity_received: number; unit_cost_cents: number;
}
interface PODetail extends PO { lines: POLine[]; subtotal_cents: number; gct_cents: number }

interface DraftLine { rawMaterialId: string; qty: string; unitCost: string; autoPriced: boolean }

export default function PurchaseOrders() {
  const [orders, setOrders] = useState<PO[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [open, setOpen] = useState<PODetail | null>(null);
  const [receipts, setReceipts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [creating, setCreating] = useState(false);
  const [supplierId, setSupplierId] = useState('');
  const [expected, setExpected] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([
    { rawMaterialId: '', qty: '', unitCost: '', autoPriced: false },
  ]);

  async function load() {
    setOrders(await api.get<PO[]>('/api/purchase-orders'));
    setSuppliers(await api.get<Supplier[]>('/api/suppliers'));
  }
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  const supplier = suppliers.find((s) => s.id === supplierId);

  /**
   * Ask the server what this supplier charges for this quantity. The answer
   * comes from their volume price breaks, falling back to their standard
   * cost - the same lookup the server uses when the order is saved.
   */
  async function autoPrice(index: number, rawMaterialId: string, qty: string) {
    if (!supplierId || !rawMaterialId || !(Number(qty) > 0)) return;
    try {
      const { unitCostCents } = await api.get<{ unitCostCents: number }>(
        `/api/suppliers/${supplierId}/price?materialId=${rawMaterialId}&quantity=${Number(qty)}`,
      );
      setLines((cur) => cur.map((l, i) => i === index
        ? { ...l, unitCost: (unitCostCents / 100).toFixed(2), autoPriced: true }
        : l));
    } catch { /* leave the cost for manual entry */ }
  }

  function setLine(i: number, patch: Partial<DraftLine>) {
    setLines((cur) => cur.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  const subtotal = lines.reduce((s, l) => {
    const q = Number(l.qty) || 0;
    return s + Math.round(q * toCents(l.unitCost || '0'));
  }, 0);
  const gct = Math.round(subtotal * 0.15);

  async function createPO(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const payload = lines
        .filter((l) => l.rawMaterialId && Number(l.qty) > 0)
        .map((l) => ({
          rawMaterialId: l.rawMaterialId,
          quantityOrdered: Number(l.qty),
          // Send the cost only when it was overridden by hand; otherwise let
          // the server resolve it, so the saved price is authoritative.
          ...(l.autoPriced ? {} : { unitCostCents: toCents(l.unitCost || '0') }),
        }));
      if (payload.length === 0) throw new Error('Add at least one material line.');

      const po = await api.post<{ poNumber: string; grandTotalCents: number }>(
        '/api/purchase-orders',
        { supplierId, expectedDeliveryDate: expected || null, lines: payload },
      );
      setMsg(`Created ${po.poNumber} for ${money(po.grandTotalCents)}.`);
      setCreating(false);
      setLines([{ rawMaterialId: '', qty: '', unitCost: '', autoPriced: false }]);
      setSupplierId(''); setExpected('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the purchase order');
    } finally { setBusy(false); }
  }

  async function openPO(id: string) {
    if (open?.id === id) { setOpen(null); return; }
    const detail = await api.get<PODetail>(`/api/purchase-orders/${id}`);
    setOpen(detail);
    // Default each line to the quantity still outstanding.
    setReceipts(Object.fromEntries(detail.lines.map((l) => [
      l.id, String(Math.max(Number(l.quantity_ordered) - Number(l.quantity_received), 0)),
    ])));
  }

  async function receive() {
    if (!open) return;
    setBusy(true); setError(null);
    try {
      const result = await api.post<{ status: string; batchIds: string[] }>(
        `/api/purchase-orders/${open.id}/receive`,
        {
          receipts: Object.entries(receipts)
            .map(([poLineItemId, q]) => ({ poLineItemId, quantityReceived: Number(q) || 0 }))
            .filter((r) => r.quantityReceived > 0),
        },
      );
      setMsg(
        `Received. ${result.batchIds.length} stock batch(es) created at this order's ` +
        `prices — production will draw from them oldest first.`,
      );
      await load();
      await openPO(open.id);
      setOpen(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the receipt');
    } finally { setBusy(false); }
  }

  return (
    <>
      <h1>Purchase orders</h1>
      <p className="subtitle">
        Line prices come from the supplier's volume pricing and are frozen once the
        order is issued — later price changes never rewrite an existing order.
      </p>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ marginTop: 0 }}>Orders</h2>
          <button className="secondary" onClick={() => setCreating(!creating)}>
            {creating ? 'Cancel' : 'New purchase order'}
          </button>
        </div>

        {creating && (
          <form onSubmit={createPO} style={{ marginBottom: 18 }}>
            <div className="row">
              <div className="field" style={{ flex: '1 1 240px' }}>
                <label htmlFor="sup">Supplier</label>
                <select id="sup" required value={supplierId} style={{ width: '100%' }}
                        onChange={(e) => {
                          setSupplierId(e.target.value);
                          setLines([{ rawMaterialId: '', qty: '', unitCost: '', autoPriced: false }]);
                        }}>
                  <option value="">Select a supplier…</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="exp">Expected delivery</label>
                <input id="exp" type="date" value={expected}
                       onChange={(e) => setExpected(e.target.value)} />
              </div>
            </div>

            {supplier && supplier.materials.length === 0 && (
              <div className="notice warn">
                Nothing is recorded for {supplier.name} yet. Add what they sell and
                what they charge on the Suppliers screen, and their prices apply here.
              </div>
            )}

            {supplier && supplier.materials.length > 0 && (
              <>
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: '40%' }}>Material</th>
                      <th>Quantity</th><th>Cost each</th>
                      <th className="num">Line total</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => (
                      <tr key={i}>
                        <td>
                          <select value={l.rawMaterialId} style={{ width: '100%' }}
                                  onChange={(e) => {
                                    setLine(i, { rawMaterialId: e.target.value, autoPriced: false });
                                    autoPrice(i, e.target.value, l.qty);
                                  }}>
                            <option value="">Select a material…</option>
                            {supplier.materials.map((m) => (
                              <option key={m.rawMaterialId} value={m.rawMaterialId}>{m.name}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input type="number" min="1" style={{ width: 110 }} value={l.qty}
                                 onChange={(e) => setLine(i, { qty: e.target.value })}
                                 onBlur={(e) => autoPrice(i, l.rawMaterialId, e.target.value)} />
                        </td>
                        <td>
                          <input type="number" step="0.01" min="0" style={{ width: 110 }}
                                 value={l.unitCost}
                                 onChange={(e) => setLine(i, {
                                   unitCost: e.target.value, autoPriced: false,
                                 })} />
                          {l.autoPriced && (
                            <div className="muted small">from supplier pricing</div>
                          )}
                        </td>
                        <td className="num">
                          {money(Math.round((Number(l.qty) || 0) * toCents(l.unitCost || '0')))}
                        </td>
                        <td className="num">
                          {lines.length > 1 && (
                            <button type="button" className="danger-soft"
                                    onClick={() => setLines((c) => c.filter((_, x) => x !== i))}>
                              Remove
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div style={{ marginTop: 10 }}>
                  <button type="button" className="secondary"
                          onClick={() => setLines((c) => [
                            ...c, { rawMaterialId: '', qty: '', unitCost: '', autoPriced: false },
                          ])}>
                    Add line
                  </button>
                </div>

                <div style={{ maxWidth: 320, marginLeft: 'auto', marginTop: 12 }}>
                  <div className="total-line"><span>Subtotal</span><span>{money(subtotal)}</span></div>
                  <div className="total-line"><span>GCT 15%</span><span>{money(gct)}</span></div>
                  <div className="total-line grand">
                    <span>Order total</span><span>{money(subtotal + gct)}</span>
                  </div>
                  <button style={{ width: '100%', marginTop: 10 }} disabled={busy || !supplierId}>
                    {busy ? 'Saving…' : 'Create purchase order'}
                  </button>
                </div>
              </>
            )}
          </form>
        )}

        <table>
          <thead>
            <tr>
              <th>PO</th><th>Supplier</th><th>Ordered</th><th>Lines</th>
              <th>Status</th><th className="num">Total</th><th />
            </tr>
          </thead>
          <tbody>
            {orders.map((p) => (
              <tr key={p.id}>
                <td>{p.po_number}</td>
                <td>{p.supplier_name}</td>
                <td>{when(p.order_date)}</td>
                <td>{p.line_count}</td>
                <td>
                  <span className={`chip ${
                    p.status === 'Received' ? 'ok'
                    : p.status === 'Partially Received' ? 'warn' : 'neutral'}`}>
                    {p.status}
                  </span>
                </td>
                <td className="num">{money(Number(p.grand_total_cents))}</td>
                <td className="num">
                  <button className="secondary" onClick={() => openPO(p.id)}>
                    {open?.id === p.id ? 'Close' : 'Receive'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {orders.length === 0 && <p className="muted">No purchase orders yet.</p>}
      </div>

      {open && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Receive against {open.po_number}</h2>
          <p className="muted small">
            Each quantity received becomes its own stock batch at this order's price.
            Production draws from the oldest batch first.
          </p>
          <table>
            <thead>
              <tr>
                <th>Material</th><th className="num">Ordered</th>
                <th className="num">Already received</th>
                <th className="num">Cost each</th><th>Receiving now</th>
              </tr>
            </thead>
            <tbody>
              {open.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.raw_material_name}</td>
                  <td className="num">{Number(l.quantity_ordered)} {l.unit_of_measure}</td>
                  <td className="num">{Number(l.quantity_received)}</td>
                  <td className="num">{money(Number(l.unit_cost_cents))}</td>
                  <td>
                    <input type="number" min="0" style={{ width: 110 }}
                           value={receipts[l.id] ?? ''}
                           onChange={(e) => setReceipts({ ...receipts, [l.id]: e.target.value })} />
                    {' '}
                    {/* The common case is the whole outstanding quantity arriving;
                        the box stays for a short delivery. */}
                    <button type="button" className="secondary"
                            onClick={() => setReceipts({
                              ...receipts,
                              [l.id]: String(Math.max(
                                Number(l.quantity_ordered) - Number(l.quantity_received), 0)),
                            })}>
                      All
                    </button>
                    {Number(receipts[l.id] ?? 0)
                      > Number(l.quantity_ordered) - Number(l.quantity_received) && (
                      <div className="chip warn" style={{ marginTop: 4 }}>
                        more than ordered
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button disabled={busy} onClick={receive} style={{ marginTop: 12 }}>
            {busy ? 'Recording…' : 'Record receipt'}
          </button>
        </div>
      )}
    </>
  );
}
