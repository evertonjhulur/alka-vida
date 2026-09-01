import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { money } from '../lib/format';

interface BomLine {
  id: string;
  raw_material_id: string;
  component_type: string;
  quantity: number;
  raw_material_name: string;
  unit_of_measure: string;
  quantity_on_hand: number;
}

interface Material {
  id: string; name: string; category: string; size_spec: string | null;
  unit_of_measure: string; blended_cost_cents: number;
}

interface Product {
  id: string; name: string; size: string | null; bottlesPerCase: number;
}

interface Draft { rawMaterialId: string; quantity: string }

export default function Bom() {
  const { productId = '' } = useParams();
  const [product, setProduct] = useState<Product | null>(null);
  const [lines, setLines] = useState<BomLine[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [draft, setDraft] = useState<Draft>({ rawMaterialId: '', quantity: '' });
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [bom, mats, matrix] = await Promise.all([
        api.get<BomLine[]>(`/api/products/${productId}/bom`),
        api.get<Material[]>('/api/raw-materials'),
        api.get<{ products: Product[] }>('/api/pricing'),
      ]);
      setLines(bom);
      setMaterials(mats);
      setProduct(matrix.products.find((p) => p.id === productId) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this bill of materials');
    }
  }, [productId]);

  useEffect(() => { load(); }, [load]);

  /**
   * The endpoint replaces the whole BOM, so every change sends the full set.
   * Component type follows the material's own category - there is no case
   * where a 28mm cap is anything other than a Cap.
   */
  async function save(next: Array<{ rawMaterialId: string; quantity: number }>, what: string) {
    setBusy(true); setError(null); setMsg(null);
    try {
      await api.put(`/api/products/${productId}/bom`, {
        lines: next.map((l) => ({
          rawMaterialId: l.rawMaterialId,
          componentType: materials.find((m) => m.id === l.rawMaterialId)?.category ?? 'Water',
          quantity: l.quantity,
        })),
      });
      setMsg(what);
      setDraft({ rawMaterialId: '', quantity: '' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the bill of materials');
    } finally { setBusy(false); }
  }

  const current = () => lines.map((l) => ({
    rawMaterialId: l.raw_material_id, quantity: Number(l.quantity),
  }));

  const add = () => {
    const material = materials.find((m) => m.id === draft.rawMaterialId);
    if (!material) return;
    if (lines.some((l) => l.raw_material_id === draft.rawMaterialId)) {
      setError(`${material.name} is already on this bill of materials.`);
      return;
    }
    save(
      [...current(), { rawMaterialId: draft.rawMaterialId, quantity: Number(draft.quantity) }],
      `${material.name} added.`,
    );
  };

  const remove = (line: BomLine) => save(
    current().filter((l) => l.rawMaterialId !== line.raw_material_id),
    `${line.raw_material_name} removed.`,
  );

  const changeQty = (line: BomLine, quantity: number) => save(
    current().map((l) =>
      l.rawMaterialId === line.raw_material_id ? { ...l, quantity } : l),
    `${line.raw_material_name} updated.`,
  );

  const costOf = (l: BomLine) => {
    const m = materials.find((x) => x.id === l.raw_material_id);
    return Math.round(Number(m?.blended_cost_cents ?? 0) * Number(l.quantity));
  };
  const perBottle = lines.reduce((sum, l) => sum + costOf(l), 0);
  const bpc = product?.bottlesPerCase ?? 0;

  if (error && !product) return <div className="notice error">{error}</div>;
  if (!product) return <p className="muted">Loading…</p>;

  const label = (m: Material) => (m.size_spec ? `${m.name} (${m.size_spec})` : m.name);

  return (
    <>
      <h1>Bill of materials — {product.name}</h1>
      <p className="subtitle">
        What one bottle consumes. Production explodes this against the run size and
        draws each material from its oldest batch first.{' '}
        <Link to="/pricing">Back to products</Link>
      </p>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}
      {lines.length === 0 && (
        <div className="notice warn">
          This product has no bill of materials, so it cannot be costed or produced.
        </div>
      )}

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Material</th><th>Type</th>
              <th className="num">Per bottle</th>
              <th className="num">Cost per bottle</th>
              <th className="num">In stock</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id}>
                <td><strong>{l.raw_material_name}</strong></td>
                <td>{l.component_type}</td>
                <td className="num">
                  <input type="number" min="0.0001" step="0.0001" style={{ width: 110 }}
                         defaultValue={Number(l.quantity)}
                         disabled={busy}
                         onBlur={(e) => {
                           const v = Number(e.target.value);
                           if (v > 0 && v !== Number(l.quantity)) changeQty(l, v);
                         }} />
                  <span className="muted small"> {l.unit_of_measure}</span>
                </td>
                <td className="num">{money(costOf(l))}</td>
                <td className="num muted">{Number(l.quantity_on_hand)}</td>
                <td className="num">
                  <button className="secondary" disabled={busy} onClick={() => remove(l)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {lines.length > 0 && (
          <div className="row" style={{ justifyContent: 'flex-end', gap: 28, marginTop: 10 }}>
            <div>
              <span className="muted small">Material cost per bottle</span>
              <div style={{ textAlign: 'right' }}><strong>{money(perBottle)}</strong></div>
            </div>
            {bpc > 0 && (
              <div>
                <span className="muted small">Per case of {bpc}</span>
                <div style={{ textAlign: 'right' }}>
                  <strong>{money(perBottle * bpc)}</strong>
                </div>
              </div>
            )}
          </div>
        )}
        {/* Costed from what is actually in stock, so a wrong quantity shows up
            as a wrong cost immediately rather than at the end of a run. */}
        <p className="muted small">
          Costed at the current average of open stock batches. Production is charged
          the real FIFO cost of the batches it actually draws.
        </p>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Add a component</h2>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: '1 1 300px' }}>
            <label htmlFor="bm">Material</label>
            <select id="bm" value={draft.rawMaterialId} style={{ width: '100%' }}
                    onChange={(e) => setDraft({ ...draft, rawMaterialId: e.target.value })}>
              <option value="">Select a material…</option>
              {materials.map((m) => (
                <option key={m.id} value={m.id}>{label(m)} — {m.category}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="bq">Quantity per bottle</label>
            <input id="bq" type="number" min="0.0001" step="0.0001" style={{ width: 150 }}
                   value={draft.quantity}
                   onChange={(e) => setDraft({ ...draft, quantity: e.target.value })} />
          </div>
          <div className="field">
            <button type="button"
                    disabled={busy || !draft.rawMaterialId || !(Number(draft.quantity) > 0)}
                    onClick={add}>
              Add
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
