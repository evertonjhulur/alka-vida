import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Session } from '../lib/api';
import { money, toCents } from '../lib/format';
import { ask, askText } from '../components/Dialog';
import { perUnit } from '../lib/charges';

interface Tier { id: string; name: string; customerCount: number }
interface Product {
  id: string; name: string; size: string | null; bottlesPerCase: number;
  active: boolean; isReturnable: boolean; isBottleCharge?: boolean;
  /** A charge or service, not water (25 Nov 2026). */
  isCharge?: boolean; chargeUnit?: string | null;
  unit: 'case' | 'bottle' | 'charge'; listPriceCents: number;
  tierPrices: Record<string, number>;
  brandId: string | null; brandName: string | null; brandType: string | null;
}
interface Brand {
  id: string; name: string; type: 'Owned' | 'Third-Party Co-Pack'; active: boolean;
  product_count: number; customers: Array<{ id: string; name: string }>;
}
const CO_PACK = 'Third-Party Co-Pack';
interface Matrix { tiers: Tier[]; products: Product[] }

const NEW_PRODUCT = {
  name: '', size: '', bottlesPerCase: '24', listPrice: '', isReturnable: false, brandId: '',
  /** Bottled water (made, stocked, delivered) or a charge or service (25 Nov 2026). */
  kind: 'water' as 'water' | 'charge',
  /** What a charge is counted in. */
  chargeUnit: 'case',
};
/** The usual units a charge is priced per; anything else can be typed. */
const CHARGE_UNITS = ['case', 'bottle', 'delivery', 'trip', 'hour', 'each'];

export default function Pricing({ session }: { session: Session }) {
  const [matrix, setMatrix] = useState<Matrix | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [showProduct, setShowProduct] = useState(false);
  const [np, setNp] = useState({ ...NEW_PRODUCT });
  const [newTier, setNewTier] = useState('');
  /** A new price list can start as a copy of another one's rates (19 Nov 2026). */
  const [copyFrom, setCopyFrom] = useState('');
  /** The "Move everyone on this list to…" panel, when open. */
  const [moving, setMoving] = useState<{ from: string; to: string } | null>(null);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [nb, setNb] = useState<{ name: string; type: string }>({ name: '', type: CO_PACK });

  /** Cell being edited: `${productId}:${tierId}` -> typed value. */
  const [edits, setEdits] = useState<Record<string, string>>({});

  async function load() {
    const [m, b] = await Promise.all([api.get<Matrix>('/api/pricing'), api.get<Brand[]>('/api/brands')]);
    setMatrix(m); setBrands(b);
  }
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  if (error && !matrix) return <div className="notice error">{error}</div>;
  if (!matrix) return <p className="muted">Loading…</p>;

  async function addProduct(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const charge = np.kind === 'charge';
      const bpc = charge ? 0 : Number(np.bottlesPerCase) || 0;
      const price = toCents(np.listPrice || '0');
      await api.post('/api/products', {
        name: np.name,
        size: charge ? null : np.size || null,
        bottlesPerCase: bpc,
        // The price goes in the unit the product is actually sold in.
        pricePerCaseCents: bpc > 0 ? price : 0,
        pricePerBottleCents: bpc > 0 ? 0 : price,
        isReturnable: charge ? false : np.isReturnable,
        isCharge: charge,
        chargeUnit: charge ? np.chargeUnit.trim() || 'each' : null,
        brandId: np.brandId || brands.find((b) => b.type === 'Owned' && b.active)?.id || null,
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
      const r = await api.post<{ ratesCopied: number }>('/api/price-tiers', { name: newTier, copyFrom: copyFrom || null });
      const src = matrix?.tiers.find((t) => t.id === copyFrom)?.name;
      setMsg(src
        ? `Price list "${newTier}" created with ${r.ratesCopied} rates copied from ${src}. Change any rate in the grid below.`
        : `Price list "${newTier}" created. Set its rates in the grid below.`);
      setNewTier(''); setCopyFrom('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the price list');
    } finally { setBusy(false); }
  }

  async function renameTier(t: Tier) {
    const name = await askText(`Rename the ${t.name} price list`, {
      label: 'New name', value: t.name, confirmLabel: 'Rename',
    });
    if (!name || name.trim() === t.name) return;
    setBusy(true); setError(null);
    try {
      await api.patch(`/api/price-tiers/${t.id}`, { name: name.trim() });
      setMsg(`${t.name} is now "${name.trim()}". Its customers and rates stay with it.`
        + (/^(retail|corporate)$/i.test(t.name) ? ` New sign-ups go to the list named "${t.name}", so make a new one with that name if they should keep landing there.` : ''));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rename the price list');
    } finally { setBusy(false); }
  }

  /** Everyone on one list to another - e.g. ending a held price (19 Nov 2026). */
  async function moveEveryone() {
    const t = matrix!.tiers.find((x) => x.id === moving?.from);
    const to = matrix!.tiers.find((x) => x.id === moving?.to);
    if (!t || !to) return;
    if (!(await ask(`Move all ${t.customerCount} customer${t.customerCount === 1 ? '' : 's'} on ${t.name} to ${to.name}? `
      + 'Inactive customers on it move too. New orders, quotes and standing-order runs use the new prices; '
      + 'orders already taken keep theirs.', { confirmLabel: `Move them to ${to.name}` }))) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ moved: number }>(`/api/price-tiers/${t.id}/move-customers`, { toTierId: to.id });
      setMsg(`${r.moved} customer${r.moved === 1 ? '' : 's'} moved from ${t.name} to ${to.name}.`);
      setMoving(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not move them');
    } finally { setBusy(false); }
  }

  async function removeTier(t: Tier) {
    if (!(await ask(`Delete the ${t.name} price list?`, { confirmLabel: 'Delete', danger: true }))) return;
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

  async function setBrand(product: Product, brandId: string) {
    setBusy(true); setError(null);
    try {
      await api.patch(`/api/products/${product.id}`, { brandId: brandId || null });
      const b = brands.find((x) => x.id === brandId);
      setMsg(b?.type === CO_PACK
        ? `${product.name} is now ${b.name}: only the customers it is bottled for will be offered it.`
        : `${product.name} brand changed.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the brand');
    } finally { setBusy(false); }
  }

  async function addBrand(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/api/brands', nb);
      setMsg(`${nb.name} added.` + (nb.type === CO_PACK ? ' Link it to the customer it is bottled for on their Details › Products & prices.' : ''));
      setNb({ name: '', type: CO_PACK });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the brand');
    } finally { setBusy(false); }
  }

  async function brandChange(b: Brand, change: { active?: boolean; name?: string }) {
    setBusy(true); setError(null);
    try {
      await api.patch(`/api/brands/${b.id}`, change);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the brand');
    } finally { setBusy(false); }
  }

  async function renameBrand(b: Brand) {
    const name = await askText(`Rename ${b.name}`, { label: 'Brand name', value: b.name, confirmLabel: 'Rename' });
    if (name && name.trim() && name.trim() !== b.name) await brandChange(b, { name: name.trim() });
  }

  const brandSelect = (p: Product) => (
    <select aria-label={`Brand of ${p.name}`} value={p.brandId ?? ''} disabled={busy}
            style={{ fontSize: 12, padding: '2px 4px', marginTop: 4 }}
            onChange={(e) => setBrand(p, e.target.value)}>
      <option value="">No brand (ours)</option>
      {brands.filter((b) => b.active || b.id === p.brandId).map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}{b.type === CO_PACK ? (p.unit === 'charge' ? ' — only that client sees it' : ' — bottled for a customer') : ''}
        </option>
      ))}
    </select>
  );

  async function changeUnit(product: Product) {
    const unit = await askText(`What is ${product.name} charged per?`, {
      label: 'Charged per (for example case, delivery, each)', value: product.chargeUnit ?? 'each', confirmLabel: 'Save',
    });
    if (!unit || !unit.trim() || unit.trim().toLowerCase() === (product.chargeUnit ?? '')) return;
    setBusy(true); setError(null);
    try {
      await api.patch(`/api/products/${product.id}`, { chargeUnit: unit.trim() });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the unit');
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
  const charges = matrix.products.filter((p) => p.unit === 'charge');

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
                      {p.unit === 'charge'
                        ? `Charge or service · ${perUnit(p.chargeUnit)}`
                        : <>{p.size ?? ''}{p.unit === 'case' ? ` · ${p.bottlesPerCase} per case` : ' · each'}</>}
                      {p.isReturnable ? ' · returnable' : ''}
                      {p.isBottleCharge ? ' · charged when a customer hands over fewer empties than the full 5-gallon bottles they take' : ''}
                      {!p.active ? ' · retired' : ''}
                    </div>
                    {!p.isBottleCharge && brandSelect(p)}
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
                        produced, so the way in belongs next to the product.
                        A charge is not made, so it has none. */}
                    {p.unit === 'charge' ? (
                      <button type="button" className="link-button" disabled={busy}
                              style={{ fontSize: 13, color: 'var(--brand)', marginRight: 6 }}
                              onClick={() => changeUnit(p)}>Change unit</button>
                    ) : <Link to={`/products/${p.id}/bom`}>Materials</Link>}{' '}
                    <button className={p.active ? 'danger-soft' : 'secondary'} disabled={busy}
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
      {session.role === 'admin' && (
        <p className="small"><Link to="/products/import">Upload products &amp; prices from the QuickBooks list</Link></p>
      )}

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
              <input value={newTier} placeholder="e.g. Wholesale" aria-label="Name of the new price list"
                     onChange={(e) => setNewTier(e.target.value)} />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <select value={copyFrom} aria-label="Start it as a copy of" onChange={(e) => setCopyFrom(e.target.value)}>
                <option value="">Start empty</option>
                {matrix.tiers.map((t) => <option key={t.id} value={t.id}>Copy the rates of {t.name}</option>)}
              </select>
            </div>
            <button disabled={busy || !newTier.trim()}>Add price list</button>
          </form>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {matrix.tiers.map((t) => (
            <span key={t.id} className="chip neutral" style={{ padding: '6px 12px' }}>
              {t.name} — {t.customerCount} customer{t.customerCount === 1 ? '' : 's'}
              <button type="button" className="link-button" style={{ marginLeft: 8, fontSize: 12, color: 'var(--brand)' }}
                      disabled={busy} onClick={() => renameTier(t)}>Rename</button>
              {session.role === 'admin' && t.customerCount > 0 && matrix.tiers.length > 1 && (
                <button type="button" className="link-button" style={{ marginLeft: 8, fontSize: 12, color: 'var(--brand)' }}
                        disabled={busy} onClick={() => setMoving({ from: t.id, to: '' })}>Move everyone…</button>
              )}
              {session.role === 'admin' && t.customerCount === 0 && (
                <button className="danger-soft"
                        style={{ marginLeft: 8, padding: '1px 7px', fontSize: 12 }}
                        disabled={busy} onClick={() => removeTier(t)}>×</button>
              )}
            </span>
          ))}
          {matrix.tiers.length === 0 && (
            <span className="muted">No price lists yet — everyone pays list price.</span>
          )}
        </div>
        {moving && (() => {
          const t = matrix.tiers.find((x) => x.id === moving.from);
          if (!t) return null;
          return (
            <div className="row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="move-to">Move everyone on {t.name} to</label>
                <select id="move-to" value={moving.to} onChange={(e) => setMoving({ ...moving, to: e.target.value })}>
                  <option value="">Choose a price list…</option>
                  {matrix.tiers.filter((x) => x.id !== t.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </div>
              <button type="button" disabled={busy || !moving.to} onClick={moveEveryone}>Move them</button>
              <button type="button" className="secondary" disabled={busy} onClick={() => setMoving(null)}>Cancel</button>
            </div>
          );
        })()}
      </div>

      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ marginTop: 0 }}>Brands</h2>
          <form onSubmit={addBrand} className="row" style={{ marginBottom: 0 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <input aria-label="New brand name" value={nb.name} placeholder="e.g. Cool Cool"
                     onChange={(e) => setNb({ ...nb, name: e.target.value })} />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <select aria-label="Whose brand" value={nb.type} onChange={(e) => setNb({ ...nb, type: e.target.value })}>
                <option value={CO_PACK}>Bottled for a customer</option>
                <option value="Owned">Our own</option>
              </select>
            </div>
            <button disabled={busy || !nb.name.trim()}>Add brand</button>
          </form>
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>
          Our own brands are offered to every customer. A brand we bottle for a customer is offered only to
          the customers it is linked to (their Details › Products &amp; prices) — never to anybody else,
          walk-ins included. Choose each product's brand under its name below.
        </p>
        <table>
          <thead><tr><th>Brand</th><th>Whose</th><th>Bottled for</th><th className="num">Products</th><th /></tr></thead>
          <tbody>
            {brands.map((b) => (
              <tr key={b.id} style={{ opacity: b.active ? 1 : 0.5 }}>
                <td><strong>{b.name}</strong>{!b.active && <span className="muted small"> · retired</span>}</td>
                <td>{b.type === CO_PACK ? <span className="chip info">Bottled for a customer</span> : <span className="chip ok">Ours</span>}</td>
                <td className="small">
                  {b.type !== CO_PACK ? <span className="muted">everyone</span>
                    : b.customers.length ? b.customers.map((c, i) => (
                      <span key={c.id}>{i > 0 && ', '}<Link to={`/customers/${c.id}?tab=details&part=products`}>{c.name}</Link></span>
                    )) : <span className="chip warn">nobody yet</span>}
                </td>
                <td className="num">{b.product_count}</td>
                <td className="num">
                  <button className="secondary" disabled={busy} onClick={() => renameBrand(b)}>Rename</button>{' '}
                  <button className={b.active ? 'danger-soft' : 'secondary'} disabled={busy}
                          onClick={() => brandChange(b, { active: !b.active })}>{b.active ? 'Retire' : 'Restore'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {brands.length === 0 && <p className="muted">No brands yet.</p>}
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
      {grid(
        charges,
        'Charges and services',
        'Not water: packaging, labour, delivery and the like. Rates are the price per unit shown under each name. '
        + 'Never stock: not made, counted or loaded on a truck. One on a client\'s brand is offered to that client only. '
        + 'The office adds these; customers cannot order them on the portal or website.',
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
            <div className="row" role="radiogroup" aria-label="Kind of product" style={{ gap: 18, marginBottom: 8 }}>
              <label className="check" style={{ margin: 0 }}>
                <input type="radio" name="pkind" checked={np.kind === 'water'} style={{ width: 'auto' }}
                       onChange={() => setNp({ ...np, kind: 'water' })} />
                Bottled water <span className="muted small">(made, stocked and delivered)</span>
              </label>
              <label className="check" style={{ margin: 0 }}>
                <input type="radio" name="pkind" checked={np.kind === 'charge'} style={{ width: 'auto' }}
                       onChange={() => setNp({ ...np, kind: 'charge' })} />
                Charge or service <span className="muted small">(packaging, labour, delivery… never stock)</span>
              </label>
            </div>
            <div className="row">
              <div className="field" style={{ flex: '1 1 220px' }}>
                <label htmlFor="pn">{np.kind === 'charge' ? 'Name on the invoice' : 'Product name'}</label>
                <input id="pn" required style={{ width: '100%' }} value={np.name}
                       placeholder={np.kind === 'charge' ? 'e.g. Coolant – labour & case packaging' : ''}
                       onChange={(e) => setNp({ ...np, name: e.target.value })} />
              </div>
              {np.kind === 'charge' ? (
                <div className="field">
                  <label htmlFor="pu">Charged per</label>
                  <input id="pu" list="charge-units" required style={{ width: 130 }} value={np.chargeUnit}
                         onChange={(e) => setNp({ ...np, chargeUnit: e.target.value })} />
                  <datalist id="charge-units">
                    {CHARGE_UNITS.map((u) => <option key={u} value={u} />)}
                  </datalist>
                  <div className="muted small">case, delivery, each…</div>
                </div>
              ) : (<>
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
              </>)}
              <div className="field">
                <label htmlFor="pp">
                  List price {np.kind === 'charge' ? perUnit(np.chargeUnit) : Number(np.bottlesPerCase) > 0 ? 'per case' : 'per bottle'}
                </label>
                <input id="pp" type="number" step="0.01" min="0" required
                       style={{ width: 140 }} value={np.listPrice}
                       onChange={(e) => setNp({ ...np, listPrice: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="pbr">Brand</label>
                <select id="pbr" value={np.brandId} onChange={(e) => setNp({ ...np, brandId: e.target.value })}>
                  <option value="">{brands.find((b) => b.type === 'Owned' && b.active)?.name ?? 'Ours'}</option>
                  {brands.filter((b) => b.active && b.type === CO_PACK).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} — {np.kind === 'charge' ? 'only that client sees it' : 'bottled for a customer'}
                    </option>
                  ))}
                </select>
                {np.kind === 'charge' && !np.brandId && (
                  <div className="muted small">Ours: any customer can be charged it</div>
                )}
              </div>
              {np.kind === 'water' && (
              <div className="field">
                <label htmlFor="pr">Returnable</label>
                <input id="pr" type="checkbox" checked={np.isReturnable}
                       style={{ width: 'auto' }}
                       onChange={(e) => setNp({ ...np, isReturnable: e.target.checked })} />
              </div>
              )}
              <div className="field"><button disabled={busy}>{np.kind === 'charge' ? 'Add charge' : 'Add product'}</button></div>
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
