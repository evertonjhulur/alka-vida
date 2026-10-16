import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { money, toCents } from '../lib/format';
import { ask } from './Dialog';
import { PARISHES } from './CustomerForm';

/**
 * The two panels under a customer's Details (Everton, 30 Sep 2026):
 *   - other addresses: a billing address for paperwork, and extra delivery
 *     sites, each with its own zone;
 *   - special prices: this customer's own price for chosen products, over
 *     whatever price list they are on.
 */

interface Address {
  id: string; label: string; address_line1: string | null; address_line2: string | null;
  city: string | null; parish: string | null; is_billing: boolean; is_delivery: boolean;
  delivery_zone: string | null; route_sequence: number; contact_person: string | null; phone: string | null;
  delivery_instructions?: string | null;
}
interface Zone { id: string; name: string; retired_at: string | null; run_days: string[] | null }

const BLANK_ADDR = {
  label: '', addressLine1: '', addressLine2: '', city: '', parish: '',
  isBilling: false, isDelivery: true, deliveryZone: '', routeSequence: '0', contactPerson: '', phone: '',
  deliveryInstructions: '',
};

export function AddressesPanel({ customerId }: { customerId: string }) {
  const [rows, setRows] = useState<Address[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [f, setF] = useState({ ...BLANK_ADDR });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.get<Address[]>(`/api/customers/${customerId}/addresses`).then(setRows);
  useEffect(() => {
    load().catch((e) => setError(e.message));
    api.get<Zone[]>('/api/zones').then(setZones).catch(() => {});
  }, [customerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (a: Address | null) => {
    setError(null);
    setEditing(a ? a.id : 'new');
    setF(a ? {
      label: a.label, addressLine1: a.address_line1 ?? '', addressLine2: a.address_line2 ?? '',
      city: a.city ?? '', parish: a.parish ?? '', isBilling: a.is_billing, isDelivery: a.is_delivery,
      deliveryZone: a.delivery_zone ?? '', routeSequence: String(a.route_sequence ?? 0),
      contactPerson: a.contact_person ?? '', phone: a.phone ?? '',
      deliveryInstructions: a.delivery_instructions ?? '',
    } : { ...BLANK_ADDR });
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body = { ...f, routeSequence: Number(f.routeSequence) || 0 };
      if (editing === 'new') await api.post(`/api/customers/${customerId}/addresses`, body);
      else await api.patch(`/api/customers/${customerId}/addresses/${editing}`, body);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the address');
    } finally { setBusy(false); }
  }

  async function remove(a: Address) {
    if (!await ask(`Remove the address "${a.label}"? Orders that already went there are not changed.`,
      { confirmLabel: 'Remove it', cancelLabel: 'Keep it', danger: true })) return;
    try {
      await api.del(`/api/customers/${customerId}/addresses/${a.id}`);
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not remove it'); }
  }

  const line = (a: Address) => [a.address_line1, a.address_line2, a.city, a.parish].filter(Boolean).join(', ');

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Other addresses</h2>
        {!editing && <button type="button" className="secondary" onClick={() => open(null)}>Add an address</button>}
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        The address on the details above is their main one. Add a <strong>billing</strong> address
        when invoices and statements go somewhere else (head office), and extra <strong>delivery</strong>
        {' '}addresses for other sites; you choose which one when taking an order.
      </p>
      {error && <div className="notice error">{error}</div>}
      {rows.map((a) => (
        <div key={a.id} className="addr-card">
          <div className="panel-head" style={{ marginBottom: 0 }}>
            <div>
              <strong>{a.label}</strong>
              {a.is_billing && <span className="chip info">Billing</span>}
              {a.is_delivery && <span className="chip neutral">Delivery{a.delivery_zone ? ` · ${a.delivery_zone}` : ''}</span>}
              <div className="small">{line(a) || <span className="muted">no address</span>}</div>
              {(a.contact_person || a.phone) && (
                <div className="muted small">{[a.contact_person, a.phone].filter(Boolean).join(' · ')}</div>
              )}
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button type="button" className="secondary" onClick={() => open(a)}>Change</button>
              <button type="button" className="danger-soft" onClick={() => remove(a)}>Remove</button>
            </div>
          </div>
        </div>
      ))}
      {rows.length === 0 && !editing && <p className="muted small">None yet.</p>}

      {editing && (
        <form onSubmit={save} className="sub-panel">
          <div className="row">
            <div className="field">
              <label htmlFor="ad-label">Name for it *</label>
              <input id="ad-label" required value={f.label} placeholder="Head office, Warehouse…"
                     onChange={(e) => setF({ ...f, label: e.target.value })} />
            </div>
            <label className="check">
              <input type="checkbox" checked={f.isBilling} onChange={(e) => setF({ ...f, isBilling: e.target.checked })} />
              Billing (invoices and statements go here)
            </label>
            <label className="check">
              <input type="checkbox" checked={f.isDelivery} onChange={(e) => setF({ ...f, isDelivery: e.target.checked })} />
              Delivery (can be chosen for an order)
            </label>
          </div>
          <div className="row">
            <div className="field grow">
              <label htmlFor="ad-1">Address *</label>
              <input id="ad-1" required value={f.addressLine1} onChange={(e) => setF({ ...f, addressLine1: e.target.value })} />
            </div>
            <div className="field grow">
              <label htmlFor="ad-2">Address line 2</label>
              <input id="ad-2" value={f.addressLine2} onChange={(e) => setF({ ...f, addressLine2: e.target.value })} />
            </div>
          </div>
          <div className="row">
            <div className="field">
              <label htmlFor="ad-city">Town or district</label>
              <input id="ad-city" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="ad-parish">Parish</label>
              <select id="ad-parish" value={f.parish} onChange={(e) => setF({ ...f, parish: e.target.value })}>
                <option value="">Choose…</option>
                {PARISHES.map((p) => <option key={p}>{p}</option>)}
              </select>
            </div>
            {f.isDelivery && (
              <>
                <div className="field">
                  <label htmlFor="ad-zone">Delivery zone</label>
                  <select id="ad-zone" value={f.deliveryZone} onChange={(e) => setF({ ...f, deliveryZone: e.target.value })}>
                    <option value="">Same as their main address</option>
                    {zones.filter((z) => !z.retired_at).map((z) => (
                      <option key={z.id} value={z.name}>{z.name}{z.run_days?.length ? ` — ${z.run_days.join(', ')}` : ''}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="ad-seq">Visit order</label>
                  <input id="ad-seq" type="number" min="0" style={{ width: 90 }} value={f.routeSequence}
                         onChange={(e) => setF({ ...f, routeSequence: e.target.value })} />
                </div>
              </>
            )}
          </div>
          <div className="row">
            <div className="field">
              <label htmlFor="ad-contact">Contact there</label>
              <input id="ad-contact" value={f.contactPerson} onChange={(e) => setF({ ...f, contactPerson: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="ad-phone">Phone there</label>
              <input id="ad-phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
            </div>
            <div className="field grow">
              <label htmlFor="ad-di">Delivery notes</label>
              <input id="ad-di" value={f.deliveryInstructions} placeholder="Gate code, where to leave it"
                     onChange={(e) => setF({ ...f, deliveryInstructions: e.target.value })} />
            </div>
          </div>
          <div className="row">
            <button disabled={busy}>{busy ? 'Saving…' : 'Save address'}</button>
            <button type="button" className="secondary" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}

interface Special {
  product_id: string; name: string; bottles_per_case: number;
  price_per_case_cents: number; price_per_bottle_cents: number;
  usual_case_cents: number; usual_bottle_cents: number;
}
interface Product { id: string; name: string; bottles_per_case: number }

export function SpecialPricesPanel({ customerId, priceList, refresh = 0 }: { customerId: string; priceList: string | null; refresh?: number }) {
  const [rows, setRows] = useState<Special[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState('');
  const [price, setPrice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.get<Special[]>(`/api/customers/${customerId}/special-prices`).then(setRows);
  useEffect(() => {
    load().catch((e) => setError(e.message));
    // Only what this customer may buy (bottled brands, 16 Oct 2026).
    api.get<Array<Product & { product_id: string; is_bottle_charge?: boolean }>>(`/api/customers/${customerId}/prices`)
      .then((ps) => setProducts(ps.map((p) => ({ ...p, id: p.product_id })))).catch(() => {});
  }, [customerId, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const unitOf = (bpc: number) => (Number(bpc) > 0 ? 'case' : 'bottle');

  async function setOne(pid: string, cents: number | null) {
    setBusy(true); setError(null);
    try {
      await api.put(`/api/customers/${customerId}/special-prices`, { productId: pid, priceCents: cents });
      setProductId(''); setPrice('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the price');
    } finally { setBusy(false); }
  }

  const chosen = products.find((p) => p.id === productId);
  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Special prices</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        A price for this customer only, for the products you choose. Everything else comes from
        {priceList ? <> the <strong>{priceList}</strong> price list</> : ' list prices'}. New orders,
        quotes and their portal all use these; orders already taken keep their price.
      </p>
      {error && <div className="notice error">{error}</div>}
      {rows.length > 0 && (
        <table>
          <thead><tr><th>Product</th><th className="num">Their usual price</th><th className="num">Special price</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => {
              const cased = Number(r.bottles_per_case) > 0;
              return (
                <tr key={r.product_id}>
                  <td>{r.name} <span className="muted small">per {unitOf(r.bottles_per_case)}</span></td>
                  <td className="num muted">{money(Number(cased ? r.usual_case_cents : r.usual_bottle_cents))}</td>
                  <td className="num"><strong>{money(Number(cased ? r.price_per_case_cents : r.price_per_bottle_cents))}</strong></td>
                  <td className="num">
                    <button type="button" className="danger-soft" disabled={busy}
                            onClick={() => setOne(r.product_id, null)}>Remove</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <form className="row" style={{ marginTop: 10 }}
            onSubmit={(e) => { e.preventDefault(); if (productId && price) void setOne(productId, toCents(price)); }}>
        <div className="field">
          <label htmlFor="sp-p">Product</label>
          <select id="sp-p" value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">Choose…</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="sp-v">Price per {chosen ? unitOf(chosen.bottles_per_case) : 'unit'}</label>
          <input id="sp-v" type="number" min="0" step="0.01" className="price-input" value={price}
                 onChange={(e) => setPrice(e.target.value)} />
        </div>
        <div className="field">
          <button disabled={busy || !productId || price === ''}>Set special price</button>
        </div>
      </form>
    </div>
  );
}

interface Brand { id: string; name: string; type: string; active: boolean }

/**
 * Which bottled brands this customer may buy, and whether they buy ours
 * (Everton, 16 Oct 2026). Products bottled for a customer are never offered
 * to anybody else - on New order, quotes or the portal - and a customer who
 * buys only their own brands is not offered Alka Vida's.
 */
export function BrandsPanel({ customerId, onSaved }: { customerId: string; onSaved?: () => void }) {
  const [brands, setBrands] = useState<Brand[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [own, setOwn] = useState(true);
  const [saved, setSaved] = useState<{ picked: string[]; own: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get<Brand[]>('/api/brands'),
      api.get<{ buysOwnBrand: boolean; brands: Array<{ id: string }> }>(`/api/customers/${customerId}/brands`),
    ]).then(([all, mine]) => {
      setBrands(all);
      const ids = mine.brands.map((b) => b.id);
      setPicked(ids); setOwn(mine.buysOwnBrand);
      setSaved({ picked: ids, own: mine.buysOwnBrand });
    }).catch((e) => setError(e.message));
  }, [customerId]);

  const coPack = brands.filter((b) => b.type !== 'Owned' && (b.active || picked.includes(b.id)));
  const dirty = !!saved && (own !== saved.own || [...picked].sort().join() !== [...saved.picked].sort().join());

  async function save() {
    setBusy(true); setError(null); setMsg(null);
    try {
      await api.put(`/api/customers/${customerId}/brands`, { brandIds: picked, buysOwnBrand: own });
      setSaved({ picked, own });
      setMsg('Saved. Their order screens and portal now offer just these.');
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally { setBusy(false); }
  }

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>What they can order</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        Products we bottle for a customer are only ever offered to that customer. Tick the brands we
        bottle for them; brands are added on <a href="#/pricing">Products &amp; pricing</a>.
      </p>
      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}
      <label className="check" style={{ display: 'block', marginBottom: 10 }}>
        <input type="checkbox" checked={own} onChange={(e) => setOwn(e.target.checked)} />{' '}
        Can order Alka Vida products
      </label>
      <div className="field">
        <label>Brands we bottle for them</label>
        {coPack.length === 0 && <p className="muted small" style={{ margin: 0 }}>No bottled brands yet.</p>}
        {coPack.map((b) => (
          <label key={b.id} className="check" style={{ display: 'block' }}>
            <input type="checkbox" checked={picked.includes(b.id)}
                   onChange={(e) => setPicked((cur) => (e.target.checked ? [...cur, b.id] : cur.filter((x) => x !== b.id)))} />{' '}
            {b.name}{!b.active && <span className="muted small"> (retired)</span>}
          </label>
        ))}
      </div>
      {!own && picked.length === 0 && (
        <div className="notice warn">With neither ticked they will have nothing to order.</div>
      )}
      <button disabled={busy || !dirty} onClick={save}>Save</button>
    </div>
  );
}
