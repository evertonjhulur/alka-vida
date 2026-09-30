import { Fragment, useEffect, useState } from 'react';
import { api, type Session } from '../lib/api';
import { money, toCents, date, when } from '../lib/format';
import { ask, askText } from '../components/Dialog';

interface SupplierRef { id: string; name: string; unitCostCents: number }

interface Material {
  id: string; name: string; category: string; size_spec: string | null;
  unit_of_measure: string; quantity_on_hand: number; reorder_point: number;
  needs_reorder: boolean; open_batches: number; blended_cost_cents: number;
  stock_value_cents: number; unit_cost_cents: number;
  consigned: boolean; made_to_order: boolean; notes: string | null;
  retired_at: string | null;
  suppliers: SupplierRef[];
}

interface Batch {
  id: string; received_date: string; unit_cost_cents: number;
  quantity_received: number; quantity_remaining: number;
  status: string; supplier_name: string | null; po_number: string | null;
}

/**
 * Categories and the sizes under them are data the office manages, not a list
 * in this file. Adding a material the business has never bought before, or a
 * new bottle size, must not need a code change - what a water company buys
 * changes far more often than its software does.
 */
interface Category {
  id: string; name: string; retired_at: string | null;
  material_count: number; live_material_count: number;
  sizes: string[];
}

/** The parts of a material that can be corrected after the fact. */
interface EditDraft {
  name: string; category: string; sizeSpec: string; unitOfMeasure: string;
  reorderPoint: string; unitCost: string; consigned: boolean;
  madeToOrder: boolean; notes: string;
}

const draftOf = (m: Material): EditDraft => ({
  name: m.name,
  category: m.category,
  sizeSpec: m.size_spec ?? '',
  unitOfMeasure: m.unit_of_measure,
  reorderPoint: String(Number(m.reorder_point)),
  unitCost: (Number(m.unit_cost_cents) / 100).toFixed(2),
  consigned: m.consigned,
  madeToOrder: m.made_to_order,
  notes: m.notes ?? '',
});

export default function RawMaterials({ session }: { session: Session }) {
  const isAdmin = session.role === 'admin';

  const [materials, setMaterials] = useState<Material[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [showNew, setShowNew] = useState(false);
  const [nm, setNm] = useState({
    name: '', category: '', sizeSpec: '', unitOfMeasure: 'pcs', reorderPoint: '',
  });

  // Correcting an existing material, per material.
  const [editFor, setEditFor] = useState<string | null>(null);
  const [ed, setEd] = useState<EditDraft | null>(null);

  // "Used outside production" form, per material.
  const [useFor, setUseFor] = useState<string | null>(null);
  const [usage, setUsage] = useState({ quantity: '', reason: '' });

  // Supplier link form, per material.
  const [linkFor, setLinkFor] = useState<string | null>(null);
  const [link, setLink] = useState({ supplierId: '', cost: '', breaks: [{ minQty: '', cost: '' }] });

  // Categories and sizes, admin only.
  const [showCats, setShowCats] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  const [newCat, setNewCat] = useState({ name: '', sizes: '' });
  const [catEdit, setCatEdit] = useState<string | null>(null);
  const [catDraft, setCatDraft] = useState({ name: '', sizes: '' });

  async function load() {
    const [mats, cats, sups] = await Promise.all([
      api.get<Material[]>('/api/raw-materials'),
      api.get<Category[]>('/api/material-categories'),
      api.get<Array<{ id: string; name: string }>>('/api/suppliers'),
    ]);
    setMaterials(mats);
    setCategories(cats);
    setSuppliers(sups);
    // A brand new material is filed under the first category still in use.
    setNm((n) => (n.category ? n : { ...n, category: cats.find((c) => !c.retired_at)?.name ?? '' }));
  }
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  /** Wraps the repeated try/catch/reload so each action reads as what it does. */
  async function run(whenItFails: string, fn: () => Promise<string | null>) {
    setBusy(true); setError(null); setMsg(null);
    try {
      const said = await fn();
      if (said) setMsg(said);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : whenItFails);
    } finally { setBusy(false); }
  }

  const liveCategories = categories.filter((c) => !c.retired_at);
  const sizesFor = (name: string) => categories.find((c) => c.name === name)?.sizes ?? [];

  async function openBatches(id: string) {
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    setBatches(await api.get<Batch[]>(`/api/raw-materials/${id}/batches`));
  }

  async function createMaterial(e: React.FormEvent) {
    e.preventDefault();
    await run('Could not add the material', async () => {
      await api.post('/api/raw-materials', {
        name: nm.name, category: nm.category, sizeSpec: nm.sizeSpec || null,
        unitOfMeasure: nm.unitOfMeasure || 'pcs',
        reorderPoint: Number(nm.reorderPoint) || 0,
      });
      const added = nm.name;
      setNm({
        name: '', category: nm.category, sizeSpec: '', unitOfMeasure: 'pcs', reorderPoint: '',
      });
      setShowNew(false);
      return `Added ${added}.`;
    });
  }

  /**
   * Save only what actually changed.
   *
   * Sending the whole form back would mean re-sending the category on every
   * edit, and a material whose category has since been withdrawn could then
   * never be corrected at all - the save would be refused over a field the
   * person never touched.
   */
  async function saveEdit(m: Material) {
    if (!ed) return;
    const was = draftOf(m);
    const patch: Record<string, unknown> = {};
    if (ed.name !== was.name) patch.name = ed.name;
    if (ed.category !== was.category) patch.category = ed.category;
    if (ed.sizeSpec !== was.sizeSpec) patch.sizeSpec = ed.sizeSpec;
    if (ed.unitOfMeasure !== was.unitOfMeasure) patch.unitOfMeasure = ed.unitOfMeasure;
    if (ed.reorderPoint !== was.reorderPoint) patch.reorderPoint = Number(ed.reorderPoint) || 0;
    if (ed.unitCost !== was.unitCost) patch.unitCostCents = toCents(ed.unitCost || '0');
    if (ed.consigned !== was.consigned) patch.consigned = ed.consigned;
    if (ed.madeToOrder !== was.madeToOrder) patch.madeToOrder = ed.madeToOrder;
    if (ed.notes !== was.notes) patch.notes = ed.notes;

    if (Object.keys(patch).length === 0) {
      setEditFor(null); setEd(null); setMsg('Nothing was changed.');
      return;
    }
    const named = ed.name;
    await run('Could not save the material', async () => {
      await api.patch(`/api/raw-materials/${m.id}`, patch);
      setEditFor(null); setEd(null);
      return `${named} saved.`;
    });
  }

  /**
   * One button. A material nothing has ever used is genuinely deleted; one
   * that carries history is withdrawn from use instead, and the server says
   * which happened and why.
   */
  async function removeMaterial(m: Material) {
    if (!await ask(
      `Delete ${m.name}?\n\n` +
      `If it has ever been bought, counted or put on a product's recipe it ` +
      `cannot be deleted outright — that would take away the cost of work ` +
      `already done with it. It will be withdrawn from use instead, keeping ` +
      `its history and stock value.`,
      { confirmLabel: 'Delete', danger: true },
    )) return;

    await run('Could not remove the material', async () => {
      const out = await api.del<{ deleted: boolean; name: string; reasons: string[] }>(
        `/api/raw-materials/${m.id}`,
      );
      return out.deleted
        ? `${out.name} deleted. Nothing had ever used it.`
        : `${out.name} withdrawn from use rather than deleted, because ` +
          `${out.reasons.join('; ')}. Its history and stock value are untouched.`;
    });
  }

  async function recordUsage(materialId: string, name: string) {
    await run('Could not record the usage', async () => {
      const out = await api.post<{ quantity: number; totalCostCents: number }>(
        `/api/raw-materials/${materialId}/issue`,
        { quantity: Number(usage.quantity), reason: usage.reason || null },
      );
      setUseFor(null);
      setUsage({ quantity: '', reason: '' });
      return `Recorded ${out.quantity} ${name} used, costing ${money(out.totalCostCents)}.`;
    });
  }

  async function saveLink(materialId: string) {
    await run('Could not save supplier pricing', async () => {
      await api.post(`/api/suppliers/${link.supplierId}/materials`, {
        rawMaterialId: materialId,
        unitCostCents: toCents(link.cost || '0'),
        priceBreaks: link.breaks
          .filter((b) => Number(b.minQty) > 0 && b.cost !== '')
          .map((b) => ({ minQty: Number(b.minQty), unitCostCents: toCents(b.cost) })),
      });
      setLinkFor(null);
      setLink({ supplierId: '', cost: '', breaks: [{ minQty: '', cost: '' }] });
      return 'Supplier pricing saved. It applies to future purchase orders only.';
    });
  }

  /* ---------------- categories and sizes ---------------- */

  const parseSizes = (text: string) => text.split(',').map((s) => s.trim()).filter(Boolean);

  async function addCategory(e: React.FormEvent) {
    e.preventDefault();
    const named = newCat.name;
    await run('Could not add the category', async () => {
      await api.post('/api/material-categories', {
        name: newCat.name, sizes: parseSizes(newCat.sizes),
      });
      setNewCat({ name: '', sizes: '' });
      return `Category ${named} added.`;
    });
  }

  async function saveCategory(c: Category) {
    const renamed = catDraft.name !== c.name;
    const named = catDraft.name;
    await run('Could not save the category', async () => {
      await api.patch(`/api/material-categories/${c.id}`, {
        name: catDraft.name, sizes: parseSizes(catDraft.sizes),
      });
      setCatEdit(null);
      return renamed
        ? `Renamed to ${named}. Its materials and their recipes were renamed with it.`
        : `${named} saved.`;
    });
  }

  async function removeCategory(c: Category) {
    if (!await ask(
      `Delete the category ${c.name}?\n\n` +
      `A category with materials filed under it is withdrawn from use rather ` +
      `than deleted, so nothing is left orphaned.`,
      { confirmLabel: 'Delete', danger: true },
    )) return;
    await run('Could not remove the category', async () => {
      const out = await api.del<{ deleted: boolean; name: string; materialCount: number }>(
        `/api/material-categories/${c.id}`,
      );
      return out.deleted
        ? `Category ${out.name} deleted.`
        : `Category ${out.name} withdrawn from use — ${out.materialCount} material(s) ` +
          `are still filed under it. It will not be offered for anything new.`;
    });
  }

  const live = materials.filter((m) => !m.retired_at);
  const retired = materials.filter((m) => m.retired_at);
  const lowStock = live.filter((m) => m.needs_reorder);

  /**
   * The size field. A category with a known set of sizes offers exactly
   * those; one without takes free text. A size already on the material is
   * always offered even if it has since been dropped from the list, so
   * editing something else about the material never silently changes it.
   *
   * Written as a plain function called as {sizeField(...)}, NOT a component:
   * a component declared inside another is a new type on every render, and
   * the input would lose focus on every keystroke.
   */
  function sizeField(
    id: string, category: string, value: string, onChange: (v: string) => void,
  ) {
    const known = sizesFor(category);
    const options = value && !known.includes(value) ? [...known, value] : known;
    return options.length > 0 ? (
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">No size</option>
        {options.map((z) => <option key={z} value={z}>{z}</option>)}
      </select>
    ) : (
      <input id={id} placeholder="no size" value={value}
             onChange={(e) => onChange(e.target.value)} />
    );
  }

  function categoryOptions(current: string) {
    const names = liveCategories.map((c) => c.name);
    // Keep a withdrawn category selectable while it is the material's own, so
    // the dropdown shows the truth rather than jumping to another category.
    const all = current && !names.includes(current) ? [...names, current] : names;
    return all.map((c) => (
      <option key={c} value={c}>
        {c}{names.includes(c) ? '' : ' (withdrawn)'}
      </option>
    ));
  }

  function materialRow(m: Material) {
    return (
      <Fragment key={m.id}>
        <tr>
          <td>
            <strong>{m.name}</strong>
            {m.size_spec && <div className="muted small">{m.size_spec}</div>}
            {m.consigned && <span className="chip info">consigned</span>}
            {m.retired_at && <span className="chip muted">withdrawn from use</span>}
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
            {!m.retired_at && (
              <button className="secondary" style={{ marginTop: 4, padding: '3px 8px' }}
                      onClick={() => setLinkFor(linkFor === m.id ? null : m.id)}>
                {linkFor === m.id ? 'Cancel' : 'Add supplier'}
              </button>
            )}
          </td>
          <td className="num">
            <button className="secondary" onClick={() => openBatches(m.id)}>
              {expanded === m.id ? 'Hide' : `Batches (${Number(m.open_batches)})`}
            </button>{' '}
            {m.retired_at ? (
              isAdmin && (
                <button className="secondary" disabled={busy}
                        onClick={() => run('Could not bring it back', async () => {
                          await api.post(`/api/raw-materials/${m.id}/restore`);
                          return `${m.name} is back in use.`;
                        })}>
                  Bring back
                </button>
              )
            ) : (
              <>
                <button className="secondary"
                        onClick={() => {
                          const next = editFor === m.id ? null : m.id;
                          setEditFor(next);
                          setEd(next ? draftOf(m) : null);
                        }}>
                  {editFor === m.id ? 'Cancel' : 'Edit'}
                </button>{' '}
                <button className="secondary"
                        onClick={() => {
                          setUseFor(useFor === m.id ? null : m.id);
                          setUsage({ quantity: '', reason: '' });
                        }}>
                  {useFor === m.id ? 'Cancel' : 'Record usage'}
                </button>{' '}
                {isAdmin && (
                  <button className="danger-soft" disabled={busy}
                          onClick={() => removeMaterial(m)}>
                    Delete
                  </button>
                )}
              </>
            )}
          </td>
        </tr>

        {editFor === m.id && ed && (
          <tr>
            <td colSpan={8} style={{ background: '#f9fafb' }}>
              <strong>Edit {m.name}</strong>
              <p className="muted small" style={{ marginTop: 4 }}>
                The reference cost is a guide figure only. Changing it never
                restates stock you already hold — that is costed at what was
                actually paid for each batch.
              </p>
              <div className="row">
                <div className="field">
                  <label htmlFor="en">Name</label>
                  <input id="en" value={ed.name}
                         onChange={(e) => setEd({ ...ed, name: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="ec">Category</label>
                  <select id="ec" value={ed.category}
                          onChange={(e) => setEd({ ...ed, category: e.target.value, sizeSpec: '' })}>
                    {categoryOptions(ed.category)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="es">Size</label>
                  {sizeField('es', ed.category, ed.sizeSpec, (v) => setEd({ ...ed, sizeSpec: v }))}
                </div>
                <div className="field">
                  <label htmlFor="eu">Unit</label>
                  <input id="eu" style={{ width: 80 }} value={ed.unitOfMeasure}
                         onChange={(e) => setEd({ ...ed, unitOfMeasure: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="er">Reorder point</label>
                  <input id="er" type="number" min="0" style={{ width: 120 }}
                         value={ed.reorderPoint}
                         onChange={(e) => setEd({ ...ed, reorderPoint: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="ex">Reference cost</label>
                  <input id="ex" type="number" step="0.01" min="0" style={{ width: 130 }}
                         value={ed.unitCost}
                         onChange={(e) => setEd({ ...ed, unitCost: e.target.value })} />
                </div>
              </div>
              <div className="row" style={{ alignItems: 'flex-end' }}>
                <div className="field" style={{ flex: '1 1 320px' }}>
                  <label htmlFor="eo">Notes</label>
                  <input id="eo" style={{ width: '100%' }} value={ed.notes}
                         onChange={(e) => setEd({ ...ed, notes: e.target.value })} />
                </div>
                <div className="field">
                  <label>
                    <input type="checkbox" checked={ed.consigned}
                           onChange={(e) => setEd({ ...ed, consigned: e.target.checked })} />
                    {' '}Consigned
                  </label>
                </div>
                <div className="field">
                  <label>
                    <input type="checkbox" checked={ed.madeToOrder}
                           onChange={(e) => setEd({ ...ed, madeToOrder: e.target.checked })} />
                    {' '}Made to order
                  </label>
                </div>
                <div className="field">
                  <button type="button" disabled={busy || !ed.name.trim()}
                          onClick={() => saveEdit(m)}>
                    Save changes
                  </button>
                </div>
              </div>
            </td>
          </tr>
        )}

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
                      <td>{when(b.received_date)}</td>
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
    );
  }

  function materialsTable(rows: Material[]) {
    return (
      <table>
        <thead>
          <tr>
            <th>Material</th><th>Category</th>
            <th className="num">On hand</th><th className="num">Reorder at</th>
            <th className="num">Avg cost</th><th className="num">Stock value</th>
            <th>Suppliers</th><th />
          </tr>
        </thead>
        <tbody>{rows.map(materialRow)}</tbody>
      </table>
    );
  }

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

      {isAdmin && (
        <div className="panel">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ marginTop: 0 }}>Categories and sizes</h2>
            <button className="secondary" onClick={() => setShowCats(!showCats)}>
              {showCats ? 'Hide' : 'Manage'}
            </button>
          </div>

          {showCats && (
            <>
              <p className="muted small">
                Categories group the materials you buy and drive the reorder list.
                The sizes under a category are the only ones offered when a material
                is added, which is what stops the same 28mm cap being entered three
                different ways. Leave the sizes blank for a category that has none —
                water and handles, for instance — and the size becomes free text.
              </p>

              <table>
                <thead>
                  <tr>
                    <th>Category</th><th>Sizes</th>
                    <th className="num">Materials</th><th />
                  </tr>
                </thead>
                <tbody>
                  {categories.map((c) => (
                    <Fragment key={c.id}>
                      <tr>
                        <td>
                          <strong>{c.name}</strong>
                          {c.retired_at && <span className="chip muted">withdrawn</span>}
                        </td>
                        <td className="small">
                          {c.sizes.length === 0
                            ? <span className="muted">free text</span>
                            : c.sizes.join(', ')}
                        </td>
                        <td className="num">{Number(c.material_count)}</td>
                        <td className="num">
                          {c.retired_at ? (
                            <button className="secondary" disabled={busy}
                                    onClick={() => run('Could not bring it back', async () => {
                                      await api.post(`/api/material-categories/${c.id}/restore`);
                                      return `Category ${c.name} is back in use.`;
                                    })}>
                              Bring back
                            </button>
                          ) : (
                            <>
                              <button className="secondary"
                                      onClick={() => {
                                        const next = catEdit === c.id ? null : c.id;
                                        setCatEdit(next);
                                        setCatDraft({ name: c.name, sizes: c.sizes.join(', ') });
                                      }}>
                                {catEdit === c.id ? 'Cancel' : 'Edit'}
                              </button>{' '}
                              <button className="danger-soft" disabled={busy}
                                      onClick={() => removeCategory(c)}>
                                Delete
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                      {catEdit === c.id && (
                        <tr>
                          <td colSpan={4} style={{ background: '#f9fafb' }}>
                            <div className="row" style={{ alignItems: 'flex-end' }}>
                              <div className="field">
                                <label htmlFor="cn">Name</label>
                                <input id="cn" value={catDraft.name}
                                       onChange={(e) =>
                                         setCatDraft({ ...catDraft, name: e.target.value })} />
                              </div>
                              <div className="field" style={{ flex: '1 1 320px' }}>
                                <label htmlFor="cs">Sizes, separated by commas</label>
                                <input id="cs" style={{ width: '100%' }}
                                       placeholder="e.g. 280ml, 500ml, 1.5L"
                                       value={catDraft.sizes}
                                       onChange={(e) =>
                                         setCatDraft({ ...catDraft, sizes: e.target.value })} />
                              </div>
                              <div className="field">
                                <button type="button" disabled={busy || !catDraft.name.trim()}
                                        onClick={() => saveCategory(c)}>
                                  Save
                                </button>
                              </div>
                            </div>
                            <p className="muted small">
                              Renaming carries the new name across to every material in
                              this category and to the recipes using them. Dropping a
                              size stops it being offered from now on; materials that
                              already carry it keep it.
                            </p>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>

              <form onSubmit={addCategory} style={{ marginTop: 12 }}>
                <div className="row" style={{ alignItems: 'flex-end' }}>
                  <div className="field">
                    <label htmlFor="ncn">New category</label>
                    <input id="ncn" required value={newCat.name} placeholder="e.g. Carton"
                           onChange={(e) => setNewCat({ ...newCat, name: e.target.value })} />
                  </div>
                  <div className="field" style={{ flex: '1 1 320px' }}>
                    <label htmlFor="ncs">Sizes, separated by commas</label>
                    <input id="ncs" style={{ width: '100%' }}
                           placeholder="leave blank for a free-text size"
                           value={newCat.sizes}
                           onChange={(e) => setNewCat({ ...newCat, sizes: e.target.value })} />
                  </div>
                  <div className="field"><button disabled={busy}>Add category</button></div>
                </div>
              </form>
            </>
          )}
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
                  {liveCategories.map((c) => (
                    <option key={c.id} value={c.name}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="ms">Size</label>
                {sizeField('ms', nm.category, nm.sizeSpec, (v) => setNm({ ...nm, sizeSpec: v }))}
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
              <div className="field"><button disabled={busy || !nm.category}>Save</button></div>
            </div>
            {liveCategories.length === 0 && (
              <p className="muted small">
                There are no categories in use. Add one under Categories and sizes first.
              </p>
            )}
          </form>
        )}

        {materialsTable(live)}
        {live.length === 0 && <p className="muted">No raw materials yet.</p>}
      </div>

      {retired.length > 0 && (
        <div className="panel">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ marginTop: 0 }}>Withdrawn from use ({retired.length})</h2>
            <button className="secondary" onClick={() => setShowRetired(!showRetired)}>
              {showRetired ? 'Hide' : 'Show'}
            </button>
          </div>
          <p className="muted small">
            These keep their history and stock value but are not offered for new
            purchase orders, recipes or usage.
          </p>
          {showRetired && materialsTable(retired)}
        </div>
      )}
    </>
  );
}
