import { Fragment, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { money, toCents, date } from '../lib/format';

interface SupplierRef { id: string; name: string; unitCostCents: number }

interface Material {
  id: string; name: string; category: string; size_spec: string | null;
  unit_of_measure: string; quantity_on_hand: number; reorder_point: number;
  needs_reorder: boolean; open_batches: number; blended_cost_cents: number;
  stock_value_cents: number; consigned: boolean; made_to_order: boolean;
  suppliers: SupplierRef[];
}

interface Batch {
  id: string; received_date: string; unit_cost_cents: number;
  quantity_received: number; quantity_remaining: number;
  status: string; supplier_name: string | null; po_number: string | null;
}

const CATEGORIES = ['Bottle', 'Cap', 'Handle', 'Label', 'Water'] as const;

/**
 * The sizes each category is actually stocked in.
 *
 * A fixed list rather than free text: "28mm", "28 mm" and "28MM" typed on
 * three different days become three materials that never group, never total
 * and never reorder together. A handle and water have one form, so no size.
 *
 * Which size fits which product is deliberately NOT recorded here - that
 * already lives in the bill of materials, and stating it twice guarantees
 * the two eventually disagree.
 */
const SIZES: Record<string, readonly string[]> = {
  Bottle: ['280ml', '500ml', '1.5L', '5L', '5gal'],
  Cap: ['28mm', '48mm', '55mm'],
  Label: ['280ml', '500ml', '1.5L', '5L', '5gal'],
  Handle: [],
  Water: [],
};

export default function RawMaterials() {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [showNew, setShowNew] = useState(false);
  const [nm, setNm] = useState({ name: '', category: 'Bottle', sizeSpec: '', unitOfMeasure: 'pcs', reorderPoint: '' });

  // "Used outside production" form, per material.
  const [useFor, setUseFor] = useState<string | null>(null);
  const [usage, setUsage] = useState({ quantity: '', reason: '' });

  // Supplier link form, per material.
  const [linkFor, setLinkFor] = useState<string | null>(null);
  const [link, setLink] = useState({ supplierId: '', cost: '', breaks: [{ minQty: '', cost: '' }] });

  async function load() {
    setMaterials(await api.get<Material[]>('/api/raw-materials'));
    setSuppliers(await api.get<Array<{ id: string; name: string }>>('/api/suppliers'));
  }
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  async function openBatches(id: string) {
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    setBatches(await api.get<Batch[]>(`/api/raw-materials/${id}/batches`));
  }

  async function createMaterial(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/api/raw-materials', {
        name: nm.name, category: nm.category, sizeSpec: nm.sizeSpec || null,
        unitOfMeasure: nm.unitOfMeasure || 'pcs',
        reorderPoint: Number(nm.reorderPoint) || 0,
      });
      setMsg(`Added ${nm.name}.`);
      setNm({ name: '', category: 'Bottle', sizeSpec: '', unitOfMeasure: 'pcs', reorderPoint: '' });
      setShowNew(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the material');
    } finally { setBusy(false); }
  }

  async function saveLink(materialId: string) {
    setBusy(true); setError(null);
    try {
      await api.post(`/api/suppliers/${link.supplierId}/materials`, {
        rawMaterialId: materialId,
        unitCostCents: toCents(link.cost || '0'),
        priceBreaks: link.breaks
          .filter((b) => Number(b.minQty) > 0 && b.cost !== '')
          .map((b) => ({ minQty: Number(b.minQty), unitCostCents: toCents(b.cost) })),
      });
      setMsg('Supplier pricing saved. It applies to future purchase orders only.');
      setLinkFor(null);
      setLink({ supplierId: '', cost: '', breaks: [{ minQty: '', cost: '' }] });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save supplier pricing');
    } finally { setBusy(false); }
  }

  /**
   * Material consumed outside a production run - 5gal labels applied to
   * rotated bottles being the case that needs it. The draw is ordinary FIFO,
   * so it is costed exactly the way production is.
   */
  async function recordUsage(materialId: string, name: string) {
    setBusy(true); setError(null);
    try {
      const out = await api.post<{ quantity: number; totalCostCents: number }>(
        `/api/raw-materials/${materialId}/issue`,
        { quantity: Number(usage.quantity), reason: usage.reason || null },
      );
      setMsg(`Recorded ${out.quantity} ${name} used, costing ${money(out.totalCostCents)}.`);
      setUseFor(null);
      setUsage({ quantity: '', reason: '' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the usage');
    } finally { setBusy(false); }
  }

  const lowStock = materials.filter((m) => m.needs_reorder);

  return (
    <>
      <h1>Raw materials</h1>
      <p className="subtitle">
        Stock, reorder levels, FIFO batches and who supplies each item.
      </p>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}
      {lowStock.length > 0 && (
        <div className="notice warn">
          {lowStock.length} material{lowStock.length === 1 ? ' is' : 's are'} at or below
          the reorder point: {lowStock.map((m) => m.name).join(', ')}.
        </div>
      )}

      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ marginTop: 0 }}>Materials</h2>
          <button className="secondary" onClick={() => setShowNew(!showNew)}>
            {showNew ? 'Cancel' : 'Add material'}
          </button>
        </div>

        {showNew && (
          <form onSubmit={createMaterial} style={{ marginBottom: 18 }}>
            <div className="row">
              <div className="field">
                <label htmlFor="mn">Name</label>
                <input id="mn" required value={nm.name}
                       onChange={(e) => setNm({ ...nm, name: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="mc">Category</label>
                <select id="mc" value={nm.category}
                        onChange={(e) => setNm({ ...nm, category: e.target.value, sizeSpec: '' })}>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="ms">Size</label>
                {(SIZES[nm.category] ?? []).length > 0 ? (
                  <select id="ms" value={nm.sizeSpec}
                          onChange={(e) => setNm({ ...nm, sizeSpec: e.target.value })}>
                    <option value="">Select a size…</option>
                    {SIZES[nm.category].map((z) => <option key={z} value={z}>{z}</option>)}
                  </select>
                ) : (
                  <input id="ms" placeholder="no size" value={nm.sizeSpec}
                         onChange={(e) => setNm({ ...nm, sizeSpec: e.target.value })} />
                )}
              </div>
              <div className="field">
                <label htmlFor="mu">Unit</label>
                <input id="mu" style={{ width: 80 }} value={nm.unitOfMeasure}
                       onChange={(e) => setNm({ ...nm, unitOfMeasure: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="mr">Reorder point</label>
                <input id="mr" type="number" min="0" style={{ width: 120 }} value={nm.reorderPoint}
                       onChange={(e) => setNm({ ...nm, reorderPoint: e.target.value })} />
              </div>
              <div className="field"><button disabled={busy}>Save</button></div>
            </div>
          </form>
        )}

        <table>
          <thead>
            <tr>
              <th>Material</th><th>Category</th>
              <th className="num">On hand</th><th className="num">Reorder at</th>
              <th className="num">Avg cost</th><th className="num">Stock value</th>
              <th>Suppliers</th><th />
            </tr>
          </thead>
          <tbody>
            {materials.map((m) => (
              // The key belongs on the list item itself. A bare fragment cannot
              // carry one, so React had no key for any of these rows.
              <Fragment key={m.id}>
                <tr>
                  <td>
                    <strong>{m.name}</strong>
                    {m.size_spec && <div className="muted small">{m.size_spec}</div>}
                    {m.consigned && <span className="chip info">consigned</span>}
                  </td>
                  <td>{m.category}</td>
                  <td className="num">
                    {Number(m.quantity_on_hand)} {m.unit_of_measure}
                    {m.needs_reorder && <div><span className="chip warn">reorder</span></div>}
                  </td>
                  <td className="num muted">{Number(m.reorder_point)}</td>
                  <td className="num">{money(Number(m.blended_cost_cents))}</td>
                  <td className="num">{money(Number(m.stock_value_cents))}</td>
                  <td className="small">
                    {m.suppliers.length === 0
                      ? <span className="muted">none linked</span>
                      : m.suppliers.map((s) => (
                          <div key={s.id}>{s.name} — {money(s.unitCostCents)}</div>
                        ))}
                    <button className="secondary" style={{ marginTop: 4, padding: '3px 8px' }}
                            onClick={() => setLinkFor(linkFor === m.id ? null : m.id)}>
                      {linkFor === m.id ? 'Cancel' : 'Add supplier'}
                    </button>
                  </td>
                  <td className="num">
                    <button className="secondary" onClick={() => openBatches(m.id)}>
                      {expanded === m.id ? 'Hide' : `Batches (${Number(m.open_batches)})`}
                    </button>{' '}
                    <button className="secondary"
                            onClick={() => {
                              setUseFor(useFor === m.id ? null : m.id);
                              setUsage({ quantity: '', reason: '' });
                            }}>
                      {useFor === m.id ? 'Cancel' : 'Record usage'}
                    </button>
                  </td>
                </tr>

                {useFor === m.id && (
                  <tr>
                    <td colSpan={8} style={{ background: '#f9fafb' }}>
                      <strong>Record {m.name} used outside production</strong>
                      <p className="muted small" style={{ marginTop: 4 }}>
                        For material applied by hand — 5gal labels on rotated bottles,
                        for instance. It is drawn from the oldest batch first and
                        costed at what was actually paid for it.
                      </p>
                      <div className="row" style={{ alignItems: 'flex-end' }}>
                        <div className="field">
                          <label>Quantity used ({m.unit_of_measure})</label>
                          <input type="number" min="1" step="1" style={{ width: 140 }}
                                 value={usage.quantity}
                                 onChange={(e) => setUsage({ ...usage, quantity: e.target.value })} />
                        </div>
                        <div className="field" style={{ flex: '1 1 280px' }}>
                          <label>What for</label>
                          <input style={{ width: '100%' }}
                                 placeholder="e.g. relabelled returned 5gal bottles"
                                 value={usage.reason}
                                 onChange={(e) => setUsage({ ...usage, reason: e.target.value })} />
                        </div>
                        <div className="field">
                          <button type="button"
                                  disabled={busy || !(Number(usage.quantity) > 0)}
                                  onClick={() => recordUsage(m.id, m.name)}>
                            Record usage
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}

                {linkFor === m.id && (
                  <tr>
                    <td colSpan={8} style={{ background: '#f9fafb' }}>
                      <strong>Supplier pricing for {m.name}</strong>
                      <p className="muted small" style={{ marginTop: 4 }}>
                        The standard cost applies at any quantity. Volume breaks override
                        it once the order reaches the minimum quantity.
                      </p>
                      <div className="row">
                        <div className="field">
                          <label htmlFor="ls">Supplier</label>
                          <select id="ls" value={link.supplierId}
                                  onChange={(e) => setLink({ ...link, supplierId: e.target.value })}>
                            <option value="">Select…</option>
                            {suppliers.map((s) => (
                              <option key={s.id} value={s.id}>{s.name}</option>
                            ))}
                          </select>
                        </div>
                        <div className="field">
                          <label htmlFor="lc">Standard cost per {m.unit_of_measure}</label>
                          <input id="lc" type="number" step="0.01" min="0" style={{ width: 140 }}
                                 value={link.cost}
                                 onChange={(e) => setLink({ ...link, cost: e.target.value })} />
                        </div>
                      </div>

                      <div className="small muted" style={{ marginBottom: 6 }}>Volume breaks</div>
                      {link.breaks.map((b, i) => (
                        <div className="row" key={i}>
                          <div className="field">
                            <label>From quantity</label>
                            <input type="number" min="1" style={{ width: 130 }} value={b.minQty}
                                   onChange={(e) => setLink({
                                     ...link,
                                     breaks: link.breaks.map((x, j) =>
                                       j === i ? { ...x, minQty: e.target.value } : x),
                                   })} />
                          </div>
                          <div className="field">
                            <label>Cost each</label>
                            <input type="number" step="0.01" min="0" style={{ width: 130 }} value={b.cost}
                                   onChange={(e) => setLink({
                                     ...link,
                                     breaks: link.breaks.map((x, j) =>
                                       j === i ? { ...x, cost: e.target.value } : x),
                                   })} />
                          </div>
                        </div>
                      ))}
                      <button className="secondary" type="button"
                              onClick={() => setLink({
                                ...link, breaks: [...link.breaks, { minQty: '', cost: '' }],
                              })}>
                        Add another break
                      </button>{' '}
                      <button disabled={busy || !link.supplierId} onClick={() => saveLink(m.id)}>
                        Save pricing
                      </button>
                    </td>
                  </tr>
                )}

                {expanded === m.id && (
                  <tr>
                    <td colSpan={8} style={{ background: '#f9fafb' }}>
                      <strong>FIFO batches — drawn oldest first</strong>
                      <table style={{ marginTop: 8 }}>
                        <thead>
                          <tr>
                            <th>Received</th><th>Supplier</th><th>PO</th>
                            <th className="num">Cost each</th>
                            <th className="num">Received</th><th className="num">Remaining</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {batches.map((b) => (
                            <tr key={b.id}>
                              <td>{date(b.received_date)}</td>
                              <td>{b.supplier_name ?? '—'}</td>
                              {/* Not every batch comes from a PO - opening stock and
                                  count adjustments legitimately have none. */}
                              <td className="small muted">{b.po_number ?? '—'}</td>
                              <td className="num">{money(Number(b.unit_cost_cents))}</td>
                              <td className="num">{Number(b.quantity_received)}</td>
                              <td className="num">{Number(b.quantity_remaining)}</td>
                              <td>
                                <span className={`chip ${b.status === 'Open' ? 'ok' : 'muted'}`}>
                                  {b.status}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {batches.length === 0 && <p className="muted">No batches received yet.</p>}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {materials.length === 0 && <p className="muted">No raw materials yet.</p>}
      </div>
    </>
  );
}
