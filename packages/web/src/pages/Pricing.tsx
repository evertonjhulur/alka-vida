import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Session } from '../lib/api';
import { money, toCents } from '../lib/format';

interface Tier { id: string; name: string; customerCount: number }
interface Product {
  id: string; name: string; size: string | null; bottlesPerCase: number;
  active: boolean; isReturnable: boolean;
  unit: 'case' | 'bottle'; listPriceCents: number;
  tierPrices: Record<string, number>;
}
interface Matrix { tiers: Tier[]; products: Product[] }

const NEW_PRODUCT = {
  name: '', size: '', bottlesPerCase: '24', listPrice: '', isReturnable: false,
};

export default function Pricing({ session }: { session: Session }) {
  const [matrix, setMatrix] = useState<Matrix | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [showProduct, setShowProduct] = useState(false);
  const [np, setNp] = useState({ ...NEW_PRODUCT });
  const [newTier, setNewTier] = useState('');

  /** Cell being edited: `${productId}:${tierId}` -> typed value. */
  const [edits, setEdits] = useState<Record<string, string>>({});

  async function load() {
    setMatrix(await api.get<Matrix>('/api/pricing'));
  }
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  if (error && !matrix) return <div className="notice error">{error}</div>;
  if (!matrix) return <p className="muted">Loading…</p>;

  async function addProduct(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const bpc = Number(np.bottlesPerCase) || 0;
      const price = toCents(np.listPrice || '0');
      await api.post('/api/products', {
        name: np.name,
        size: np.size || null,
        bottlesPerCase: bpc,
        // The price goes in the unit the product is actually sold in.
        pricePerCaseCents: bpc > 0 ? price : 0,
        pricePerBottleCents: bpc > 0 ? 0 : price,
        isReturnable: np.isReturnable,
      });
      setMsg(`${np.name} added.`);
      setNp({ ...NEW_PRODUCT });
      setShowProduct(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the product');
    } finally { setBusy(false); }
  }

  async function addTier(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/api/price-tiers', { name: newTier });
      setMsg(`Price list "${newTier}" created. Set its rates in the grid below.`);
      setNewTier('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the price list');
    } finally { setBusy(false); }
  }

  async function removeTier(t: Tier) {
    if (!window.confirm(`Delete the ${t.name} price list?`)) return;
    setBusy(true); setError(null);
    try {
      await api.del(`/api/price-tiers/${t.id}`);
      setMsg(`${t.name} deleted.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete');
    } finally { setBusy(false); }
  }

  /** Save one cell. An empty value clears the rate back to list price. */
  async function saveRate(product: Product, tier: Tier) {
    const key = `${product.id}:${tier.id}`;
    const typed = edits[key];
    if (typed === undefined) return;
    setBusy(true); setError(null);
    try {
      await api.put('/api/pricing/rate', {
        productId: product.id,
        priceTierId: tier.id,
        priceCents: typed.trim() === '' ? null : toCents(typed),
      });
      setEdits((cur) => {
        const next = { ...cur };
        delete next[key];
        return next;
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that price');
    } finally { setBusy(false); }
  }

  async function saveListPrice(product: Product) {
    const key = `${product.id}:list`;
    const typed = edits[key];
    if (typed === undefined || typed.trim() === '') return;
    setBusy(true); setError(null);
    try {
      const price = toCents(typed);
      await api.patch(`/api/products/${product.id}`, product.unit === 'case'
        ? { pricePerCaseCents: price }
        : { pricePerBottleCents: price });
      setEdits((cur) => { const n = { ...cur }; delete n[key]; return n; });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the list price');
    } finally { setBusy(false); }
  }

  async function toggleActive(product: Product) {
    setBusy(true); setError(null);
    try {
      await api.patch(`/api/products/${product.id}`, { active: !product.active });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the product');
    } finally { setBusy(false); }
  }

  const cased = matrix.products.filter((p) => p.unit === 'case');
  const individual = matrix.products.filter((p) => p.unit === 'bottle');

  /**
   * These render JSX and are CALLED as plain functions, not used as <Cell/>
   * components. A component declared inside another component is a new
   * component type on every render, so React unmounts and remounts its
   * inputs - the field would lose focus after each keystroke and the
   * save-on-blur would never fire.
   */
  const cell = (p: Product, t: Tier) => {
    const key = `${p.id}:${t.id}`;
    const set = p.tierPrices[t.id];
    const value = edits[key] ?? (set === undefined ? '' : (set / 100).toFixed(2));
    const dirty = edits[key] !== undefined;
    return (
      <td className="num" key={t.id}>
        <input
          type="number" step="0.01" min="0" style={{ width: 100 }}
          placeholder="list price"
          value={value}
          onChange={(e) => setEdits({ ...edits, [key]: e.target.value })}
          onBlur={() => { if (dirty) saveRate(p, t); }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
        {dirty && <div className="muted small">press Enter to save</div>}
      </td>
    );
  };

  const grid = (rows: Product[], title: string, note: string) => {
    if (rows.length === 0) return null;
    return (
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>{title}</h2>
        <p className="muted small">{note}</p>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th className="num">List price</th>
                {matrix!.tiers.map((t) => (
                  <th key={t.id} className="num">
                    {t.name}
                    <div className="muted small" style={{ fontWeight: 400 }}>
                      {t.customerCount} customer{t.customerCount === 1 ? '' : 's'}
                    </div>
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} style={{ opacity: p.active ? 1 : 0.5 }}>
                  <td>
                    <strong>{p.name}</strong>
                    <div className="muted small">
                      {p.size ?? ''}
                      {p.unit === 'case' ? ` · ${p.bottlesPerCase} per case` : ' · each'}
                      {p.isReturnable ? ' · returnable' : ''}
                      {!p.active ? ' · retired' : ''}
                    </div>
                  </td>
                  <td className="num">
                    <input type="number" step="0.01" min="0" style={{ width: 100 }}
                           value={edits[`${p.id}:list`]
                             ?? (p.listPriceCents / 100).toFixed(2)}
                           onChange={(e) => setEdits({
                             ...edits, [`${p.id}:list`]: e.target.value,
                           })}
                           onBlur={() => saveListPrice(p)}
                           onKeyDown={(e) => {
                             if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                           }} />
                  </td>
                  {matrix!.tiers.map((t) => cell(p, t))}
                  <td className="num">
                    {/* A product with no bill of materials cannot be costed or
                        produced, so the way in belongs next to the product. */}
                    <Link to={`/products/${p.id}/bom`}>Materials</Link>{' '}
                    <button className="secondary" disabled={busy}
                            onClick={() => toggleActive(p)}>
                      {p.active ? 'Retire' : 'Restore'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <>
      <h1>Products &amp; pricing</h1>
      <p className="subtitle">
        Each price list is a rate card. A customer is put on one, and pays those
        rates. Leave a cell blank and that customer pays the list price instead.
      </p>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      <div className="notice info">
        Changing a price here affects <strong>future orders only</strong>. Orders and
        invoices already raised keep the price they were agreed at.
      </div>

      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ marginTop: 0 }}>Price lists</h2>
          <form onSubmit={addTier} className="row" style={{ marginBottom: 0 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <input value={newTier} placeholder="e.g. Wholesale"
                     onChange={(e) => setNewTier(e.target.value)} />
            </div>
            <button disabled={busy || !newTier.trim()}>Add price list</button>
          </form>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {matrix.tiers.map((t) => (
            <span key={t.id} className="chip neutral" style={{ padding: '6px 12px' }}>
              {t.name} — {t.customerCount} customer{t.customerCount === 1 ? '' : 's'}
              {session.role === 'admin' && t.customerCount === 0 && (
                <button className="secondary"
                        style={{ marginLeft: 8, padding: '1px 7px', fontSize: 12 }}
                        disabled={busy} onClick={() => removeTier(t)}>×</button>
              )}
            </span>
          ))}
          {matrix.tiers.length === 0 && (
            <span className="muted">No price lists yet — everyone pays list price.</span>
          )}
        </div>
      </div>

      {grid(
        cased,
        'Case sales',
        'Sold by the case only. Rates below are the price for one full case.',
      )}
      {grid(
        individual,
        'Sold individually',
        'The 5-gallon line and anything else sold by the bottle. Rates below are the price for one bottle.',
      )}

      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ marginTop: 0 }}>Add a product</h2>
          <button className="secondary" onClick={() => setShowProduct(!showProduct)}>
            {showProduct ? 'Cancel' : 'New product'}
          </button>
        </div>

        {showProduct && (
          <form onSubmit={addProduct}>
            <div className="row">
              <div className="field" style={{ flex: '1 1 220px' }}>
                <label htmlFor="pn">Product name</label>
                <input id="pn" required style={{ width: '100%' }} value={np.name}
                       onChange={(e) => setNp({ ...np, name: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="ps">Size</label>
                <input id="ps" value={np.size} placeholder="500ml"
                       onChange={(e) => setNp({ ...np, size: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="pb">Bottles per case</label>
                <input id="pb" type="number" min="0" style={{ width: 130 }}
                       value={np.bottlesPerCase}
                       onChange={(e) => setNp({ ...np, bottlesPerCase: e.target.value })} />
                <div className="muted small">0 = sold individually</div>
              </div>
              <div className="field">
                <label htmlFor="pp">
                  List price {Number(np.bottlesPerCase) > 0 ? 'per case' : 'per bottle'}
                </label>
                <input id="pp" type="number" step="0.01" min="0" required
                       style={{ width: 140 }} value={np.listPrice}
                       onChange={(e) => setNp({ ...np, listPrice: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="pr">Returnable</label>
                <input id="pr" type="checkbox" checked={np.isReturnable}
                       style={{ width: 'auto' }}
                       onChange={(e) => setNp({ ...np, isReturnable: e.target.checked })} />
              </div>
              <div className="field"><button disabled={busy}>Add product</button></div>
            </div>
          </form>
        )}
        {!showProduct && (
          <p className="muted small">
            New products start on list price. Add their tier rates in the grids above.
          </p>
        )}
      </div>
    </>
  );
}
