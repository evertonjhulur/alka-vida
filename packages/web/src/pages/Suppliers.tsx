import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { money, toCents } from '../lib/format';
import { ask, askText } from '../components/Dialog';

interface SuppliedMaterial {
  rawMaterialId: string;
  name: string;
  unitOfMeasure: string;
  unitCostCents: number;
  priceBreaks: Array<{ minQty: number; unitCostCents: number }>;
  gctExempt?: boolean;
  envExempt?: boolean;
}

interface Supplier {
  id: string; name: string; contact_person: string | null;
  phone: string | null; email: string | null; address: string | null;
  notes: string | null; materials: SuppliedMaterial[];
}

interface Material {
  id: string; name: string; unit_of_measure: string; size_spec: string | null;
  retired_at: string | null;
}

interface PriceForm {
  rawMaterialId: string;
  cost: string;
  breaks: Array<{ minQty: string; cost: string }>;
  gctExempt: boolean;
  envExempt: boolean;
}

const BLANK_PRICE: PriceForm = {
  rawMaterialId: '', cost: '', breaks: [{ minQty: '', cost: '' }], gctExempt: false, envExempt: false,
};

/** A supplier's own details, as the add and edit forms hold them. */
interface Details {
  name: string; contactPerson: string; phone: string;
  email: string; address: string; notes: string;
}

const BLANK_DETAILS: Details = {
  name: '', contactPerson: '', phone: '', email: '', address: '', notes: '',
};

const detailsOf = (s: Supplier): Details => ({
  name: s.name,
  contactPerson: s.contact_person ?? '',
  phone: s.phone ?? '',
  email: s.email ?? '',
  address: s.address ?? '',
  notes: s.notes ?? '',
});

export default function Suppliers() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ ...BLANK_DETAILS });

  /** Which supplier's price form is open, and what is in it. */
  const [pricingFor, setPricingFor] = useState<string | null>(null);
  const [price, setPrice] = useState<PriceForm>({ ...BLANK_PRICE });

  /** Which supplier's details are being corrected, and what is in the form. */
  const [editFor, setEditFor] = useState<string | null>(null);
  const [ed, setEd] = useState<Details>({ ...BLANK_DETAILS });

  async function load() {
    setSuppliers(await api.get<Supplier[]>('/api/suppliers'));
    // The FULL list. Only the picker hides withdrawn materials - this list is
    // also how the form reads a material's unit, and a supplier's existing
    // pricing for a withdrawn material still has to describe itself.
    setMaterials(await api.get<Material[]>('/api/raw-materials'));
  }
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/api/suppliers', form);
      setMsg(`Added ${form.name}.`);
      setForm({ ...BLANK_DETAILS });
      setShowNew(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the supplier');
    } finally { setBusy(false); }
  }

  /**
   * Save only what actually changed, so an empty box means "clear this" and
   * an untouched one is not sent at all.
   */
  async function saveDetails(s: Supplier) {
    const was = detailsOf(s);
    const patch: Record<string, unknown> = {};
    (Object.keys(was) as Array<keyof Details>).forEach((k) => {
      if (ed[k] !== was[k]) patch[k] = ed[k];
    });

    if (Object.keys(patch).length === 0) {
      setEditFor(null); setMsg('Nothing was changed.');
      return;
    }
    setBusy(true); setError(null); setMsg(null);
    try {
      await api.patch(`/api/suppliers/${s.id}`, patch);
      setMsg(`${ed.name} saved.`);
      setEditFor(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the supplier');
    } finally { setBusy(false); }
  }

  /** Open the form blank to add, or filled to correct what is already there. */
  function openPricing(supplierId: string, existing?: SuppliedMaterial) {
    if (pricingFor === supplierId && !existing) { setPricingFor(null); return; }
    setPricingFor(supplierId);
    setError(null);
    setPrice(existing
      ? {
          rawMaterialId: existing.rawMaterialId,
          cost: (existing.unitCostCents / 100).toFixed(2),
          breaks: existing.priceBreaks.length
            ? existing.priceBreaks.map((b) => ({
                minQty: String(b.minQty), cost: (b.unitCostCents / 100).toFixed(2),
              }))
            : [{ minQty: '', cost: '' }],
          gctExempt: !!existing.gctExempt,
          envExempt: !!existing.envExempt,
        }
      : { ...BLANK_PRICE, breaks: [{ minQty: '', cost: '' }] });
  }

  async function savePricing(supplierId: string) {
    setBusy(true); setError(null);
    try {
      await api.post(`/api/suppliers/${supplierId}/materials`, {
        rawMaterialId: price.rawMaterialId,
        unitCostCents: toCents(price.cost || '0'),
        priceBreaks: price.breaks
          .filter((b) => Number(b.minQty) > 0 && b.cost !== '')
          .map((b) => ({ minQty: Number(b.minQty), unitCostCents: toCents(b.cost) })),
        gctExempt: price.gctExempt,
        envExempt: price.envExempt,
      });
      setMsg('Pricing saved. Purchase orders raised from now on will use it.');
      setPricingFor(null);
      setPrice({ ...BLANK_PRICE });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the pricing');
    } finally { setBusy(false); }
  }

  async function unlink(supplierId: string, materialId: string, materialName: string) {
    if (!(await ask(`Stop buying ${materialName} from this supplier?`, { confirmLabel: 'Stop buying', danger: true }))) return;
    setBusy(true);
    try {
      await api.del(`/api/suppliers/${supplierId}/materials/${materialId}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the material');
    } finally { setBusy(false); }
  }

  const materialLabel = (m: Material) =>
    m.size_spec ? `${m.name} (${m.size_spec})` : m.name;

  /**
   * The six fields a supplier has, shared by the add form and the edit form
   * so the two cannot drift apart.
   *
   * A plain function returning JSX, NOT a nested component, and the ids are
   * prefixed per form so two of them can be open at once without colliding.
   */
  const detailFields = (idPrefix: string, v: Details, set: (d: Details) => void) => (
    <>
      <div className="row">
        <div className="field">
          <label htmlFor={`${idPrefix}-name`}>Name</label>
          <input id={`${idPrefix}-name`} required value={v.name}
                 onChange={(e) => set({ ...v, name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-contact`}>Contact person</label>
          <input id={`${idPrefix}-contact`} value={v.contactPerson}
                 onChange={(e) => set({ ...v, contactPerson: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-phone`}>Phone</label>
          <input id={`${idPrefix}-phone`} value={v.phone}
                 onChange={(e) => set({ ...v, phone: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-email`}>Email</label>
          <input id={`${idPrefix}-email`} type="email" value={v.email}
                 onChange={(e) => set({ ...v, email: e.target.value })} />
        </div>
      </div>
      <div className="row">
        <div className="field" style={{ flex: '1 1 320px' }}>
          <label htmlFor={`${idPrefix}-address`}>Address</label>
          <input id={`${idPrefix}-address`} style={{ width: '100%' }} value={v.address}
                 onChange={(e) => set({ ...v, address: e.target.value })} />
        </div>
        <div className="field" style={{ flex: '1 1 320px' }}>
          <label htmlFor={`${idPrefix}-notes`}>Notes</label>
          <input id={`${idPrefix}-notes`} style={{ width: '100%' }} value={v.notes}
                 placeholder="delivery days, minimum order, payment terms…"
                 onChange={(e) => set({ ...v, notes: e.target.value })} />
        </div>
      </div>
    </>
  );

  /**
   * A plain function returning JSX, NOT a nested component: a component
   * declared inside another gets a new type on every render, so the inputs
   * unmount and lose focus on each keystroke.
   */
  const pricingForm = (s: Supplier) => {
    const chosen = materials.find((m) => m.id === price.rawMaterialId);
    const unit = chosen?.unit_of_measure ?? 'unit';
    return (
      <div className="panel" style={{ background: '#f9fafb' }}>
        <strong>What {s.name} sells, and at what price</strong>
        <p className="muted small" style={{ marginTop: 4 }}>
          The standard cost applies at any quantity. A volume break overrides it
          once the order reaches its minimum — a purchase order takes the best
          break for the quantity ordered and freezes that price on the line.
        </p>

        <div className="row">
          <div className="field" style={{ flex: '1 1 260px' }}>
            <label htmlFor={`m-${s.id}`}>Material</label>
            <select id={`m-${s.id}`} value={price.rawMaterialId} style={{ width: '100%' }}
                    onChange={(e) => setPrice({ ...price, rawMaterialId: e.target.value })}>
              <option value="">Select a material…</option>
              {/* Pricing is for what you will buy next, so a material
                  withdrawn from use is not offered - unless it is the one
                  already loaded into this form for correction. */}
              {materials
                .filter((m) => !m.retired_at || m.id === price.rawMaterialId)
                .map((m) => (
                  <option key={m.id} value={m.id}>{materialLabel(m)}</option>
                ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`c-${s.id}`}>Standard cost per {unit}</label>
            <input id={`c-${s.id}`} type="number" step="0.01" min="0" style={{ width: 150 }}
                   value={price.cost}
                   onChange={(e) => setPrice({ ...price, cost: e.target.value })} />
          </div>
        </div>

        <div className="row" style={{ marginBottom: 6 }}>
          <label className="check">
            <input type="checkbox" checked={price.gctExempt}
                   onChange={(e) => setPrice({ ...price, gctExempt: e.target.checked })} />
            GCT exempt (no GCT on this from them)
          </label>
          <label className="check">
            <input type="checkbox" checked={price.envExempt}
                   onChange={(e) => setPrice({ ...price, envExempt: e.target.checked })} />
            Env exempt (no Environmental Levy)
          </label>
        </div>

        <div className="small muted" style={{ marginBottom: 6 }}>
          Volume breaks — leave blank if they charge one price
        </div>
        {price.breaks.map((b, i) => (
          <div className="row" key={i}>
            <div className="field">
              <label>From quantity</label>
              <input type="number" min="1" style={{ width: 140 }} value={b.minQty}
                     onChange={(e) => setPrice({
                       ...price,
                       breaks: price.breaks.map((x, j) =>
                         j === i ? { ...x, minQty: e.target.value } : x),
                     })} />
            </div>
            <div className="field">
              <label>Cost each</label>
              <input type="number" step="0.01" min="0" style={{ width: 140 }} value={b.cost}
                     onChange={(e) => setPrice({
                       ...price,
                       breaks: price.breaks.map((x, j) =>
                         j === i ? { ...x, cost: e.target.value } : x),
                     })} />
            </div>
            {price.breaks.length > 1 && (
              <div className="field">
                <label>&nbsp;</label>
                <button type="button" className="secondary"
                        onClick={() => setPrice({
                          ...price, breaks: price.breaks.filter((_, j) => j !== i),
                        })}>
                  Remove
                </button>
              </div>
            )}
          </div>
        ))}

        <button type="button" className="secondary"
                onClick={() => setPrice({
                  ...price, breaks: [...price.breaks, { minQty: '', cost: '' }],
                })}>
          Add another break
        </button>{' '}
        <button type="button" disabled={busy || !price.rawMaterialId}
                onClick={() => savePricing(s.id)}>
          Save pricing
        </button>{' '}
        <button type="button" className="secondary" onClick={() => setPricingFor(null)}>
          Cancel
        </button>
      </div>
    );
  };

  return (
    <>
      <h1>Suppliers</h1>
      <p className="subtitle">
        Who supplies each raw material, at what price, and at what volumes.
        Purchase orders price their lines from this.
      </p>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ marginTop: 0 }}>All suppliers</h2>
          <button className="secondary" onClick={() => setShowNew(!showNew)}>
            {showNew ? 'Cancel' : 'Add supplier'}
          </button>
        </div>

        {showNew && (
          <form onSubmit={create} style={{ marginBottom: 16 }}>
            {detailFields('new', form, setForm)}
            <div className="row">
              <div className="field"><button disabled={busy}>Save</button></div>
            </div>
          </form>
        )}
      </div>

      {suppliers.map((s) => (
        <div className="panel" key={s.id}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <h2 style={{ marginTop: 0, marginBottom: 2 }}>{s.name}</h2>
              <p className="muted small" style={{ margin: 0 }}>
                {[s.contact_person, s.phone, s.email, s.address].filter(Boolean).join(' · ')
                  || 'No contact details'}
              </p>
              {s.notes && <p className="muted small" style={{ margin: '2px 0 0' }}>{s.notes}</p>}
            </div>
            <div>
              <button className="secondary" disabled={busy}
                      onClick={() => {
                        const next = editFor === s.id ? null : s.id;
                        setEditFor(next);
                        if (next) setEd(detailsOf(s));
                      }}>
                {editFor === s.id ? 'Cancel' : 'Edit details'}
              </button>{' '}
              <button className="secondary" disabled={busy}
                      onClick={() => openPricing(s.id)}>
                {pricingFor === s.id ? 'Close' : 'Add a material'}
              </button>
            </div>
          </div>

          {editFor === s.id && (
            <div className="panel" style={{ background: '#f9fafb', marginTop: 12 }}>
              <strong>Edit {s.name}</strong>
              <p className="muted small" style={{ marginTop: 4 }}>
                Emptying a box clears that detail. What this supplier sells, and
                at what price, is the table below — changing it here is not
                possible and never affects a purchase order already raised.
              </p>
              {detailFields(`e-${s.id}`, ed, setEd)}
              <div className="row">
                <div className="field">
                  <button type="button" disabled={busy || !ed.name.trim()}
                          onClick={() => saveDetails(s)}>
                    Save changes
                  </button>
                </div>
              </div>
            </div>
          )}

          <table style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>Material</th>
                <th className="num">Standard cost</th>
                <th>Taxes</th>
                <th>Volume breaks</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {s.materials.map((m) => (
                <tr key={m.rawMaterialId}>
                  <td>{m.name}</td>
                  <td className="num">{money(m.unitCostCents)} / {m.unitOfMeasure}</td>
                  <td className="small">
                    {m.gctExempt ? <span className="chip neutral">GCT exempt</span> : 'GCT'}{' '}
                    {m.envExempt ? <span className="chip neutral">Env exempt</span> : '· Env'}
                  </td>
                  <td className="small">
                    {m.priceBreaks.length === 0
                      ? <span className="muted">one price at any quantity</span>
                      : m.priceBreaks.map((b, i) => (
                          <div key={i}>
                            {b.minQty.toLocaleString()}+ → {money(b.unitCostCents)}
                          </div>
                        ))}
                  </td>
                  <td className="num">
                    <button className="secondary" disabled={busy}
                            onClick={() => openPricing(s.id, m)}>
                      Edit price
                    </button>{' '}
                    <button className="danger-soft" disabled={busy}
                            onClick={() => unlink(s.id, m.rawMaterialId, m.name)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {s.materials.length === 0 && (
            <p className="muted">
              Nothing recorded yet. Add what {s.name} sells and what they charge —
              purchase orders to them price themselves from it.
            </p>
          )}

          {pricingFor === s.id && pricingForm(s)}
        </div>
      ))}

      {suppliers.length === 0 && (
        <div className="panel"><p className="muted">No suppliers yet.</p></div>
      )}
    </>
  );
}
