import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { money } from '../lib/format';
import { ask } from '../components/Dialog';
import { readSheets } from '../lib/sheetfile';
import { readProductUpload, type ProductReadResult } from '../lib/productUpload';

/*
 * Products and prices from the QuickBooks list (Everton, 25 Oct 2026).
 * Choose the "Products & Prices" workbook; it is checked first and nothing is
 * saved until "Bring them in". Upload the customers first, so the bottling
 * clients and the customers with special prices are there. The rules are in
 * services/productimport.ts.
 */

interface ProductRowResult {
  row: number; name: string; action: 'create' | 'update' | 'error';
  brand: string | null; ownBrand: boolean; bottledFor: string | null; size: string | null;
  cased: boolean; bottlesPerCase: number; returnable: boolean; bottleCharge: boolean;
  listPriceCents: number; tierPrices: Record<string, number>; errors: string[]; warnings: string[];
}
interface SpecialRowResult { row: number; customer: string; product: string; priceCents: number; action: 'set' | 'error'; errors: string[] }
interface Result {
  dryRun: boolean; products: ProductRowResult[]; specials: SpecialRowResult[]; tiers: string[];
  newBrands: string[]; toCreate: number; toUpdate: number; withErrors: number; done: number;
}

export default function ProductImport() {
  const [fileName, setFileName] = useState('');
  const [read, setRead] = useState<ProductReadResult | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [done, setDone] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = (r: ProductReadResult, dryRun: boolean) =>
    api.post<Result>('/api/products/import', { products: r.products, specials: r.specials, dryRun });

  async function choose(file: File | undefined) {
    setRead(null); setResult(null); setDone(null); setError(null);
    if (!file) return;
    setFileName(file.name);
    setBusy(true);
    try {
      const r = readProductUpload(await readSheets(file));
      setRead(r);
      if (r.problems.length === 0) setResult(await send(r, true));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That file could not be read');
    } finally { setBusy(false); }
  }

  async function bringIn() {
    if (!read || !result) return;
    const ok = await ask(`Bring in ${result.toCreate} new product${result.toCreate === 1 ? '' : 's'}`
      + (result.toUpdate ? `, update ${result.toUpdate}` : '')
      + ` and set ${result.specials.length} special price${result.specials.length === 1 ? '' : 's'}?`, { confirmLabel: 'Bring them in' });
    if (!ok) return;
    setBusy(true); setError(null);
    try {
      setDone(await send(read, false));
      setResult(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nothing was brought in');
    } finally { setBusy(false); }
  }

  const tiers = result?.tiers ?? read?.tierColumns ?? [];
  const priceOf = (r: ProductRowResult, tier: string) => (tier in r.tierPrices ? money(r.tierPrices[tier]) : '—');

  return (
    <>
      <h1>Upload products &amp; prices</h1>
      <p className="subtitle">
        Products, the price-tier prices and customers' special prices from the QuickBooks list. Prices exclude GCT.
        Upload the customers first, so the bottling clients are already in the app.
      </p>
      <p className="small"><Link to="/pricing">← Products &amp; pricing</Link></p>
      {error && <div className="notice error">{error}</div>}
      {done && (
        <div className="notice ok">
          {done.toCreate} product{done.toCreate === 1 ? '' : 's'} added{done.toUpdate ? `, ${done.toUpdate} updated` : ''},
          {' '}{done.specials.length} special price{done.specials.length === 1 ? '' : 's'} set.{' '}
          <Link to="/pricing">See Products &amp; pricing</Link>
        </div>
      )}

      <div className="panel">
        <div className="field">
          <label htmlFor="pu-file">Products &amp; Prices file (.xlsx)</label>
          <input id="pu-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                 disabled={busy} onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ''; }} />
          {fileName && <div className="muted small">{fileName}{read ? ` · ${read.products.length} products, ${read.specials.length} special prices` : ''}</div>}
        </div>
        {read && read.problems.length > 0 && <div className="notice error">{read.problems.map((p) => <div key={p}>{p}</div>)}</div>}
        {busy && <p className="muted">Checking…</p>}
      </div>

      {result && (
        <>
          <div className="panel">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h2 style={{ marginTop: 0 }}>What will happen</h2>
                <div className="row" style={{ gap: 8 }}>
                  <span className="chip ok">{result.toCreate} to add</span>
                  {result.toUpdate > 0 && <span className="chip info">{result.toUpdate} to update</span>}
                  <span className="chip info">{result.specials.length} special prices</span>
                  {result.withErrors > 0 && <span className="chip bad">{result.withErrors} with a problem</span>}
                </div>
                {result.newBrands.length > 0 && <p className="small">New brands: <strong>{result.newBrands.join(', ')}</strong>.</p>}
              </div>
              <div style={{ textAlign: 'right' }}>
                <button className="go" disabled={busy || result.withErrors > 0} onClick={bringIn}>Bring them in</button>
                {result.withErrors > 0 && <div className="muted small">Fix the rows with a problem and choose the file again.</div>}
              </div>
            </div>
            <div style={{ overflowX: 'auto', marginTop: 10 }}>
              <table>
                <thead>
                  <tr><th>Product</th><th>Brand · for</th><th>Sold</th><th className="num">List</th>
                    {tiers.map((t) => <th key={t} className="num">{t}</th>)}<th>Notes</th></tr>
                </thead>
                <tbody>
                  {result.products.map((r) => (
                    <tr key={r.row}>
                      <td><strong>{r.name}</strong>
                        {r.action === 'update' && <div><span className="chip info">already here — update</span></div>}
                        {r.action === 'error' && <div><span className="chip bad">problem</span></div>}</td>
                      <td className="small">{r.brand ?? '—'}{r.bottledFor ? <div className="muted">for {r.bottledFor} only</div> : null}</td>
                      <td className="small">{r.bottleCharge ? 'Bottle charge' : r.cased ? `Case of ${r.bottlesPerCase}` : r.returnable ? 'By the bottle (returnable)' : 'By the bottle'}</td>
                      <td className="num">{money(r.listPriceCents)}</td>
                      {tiers.map((t) => <td key={t} className="num">{priceOf(r, t)}</td>)}
                      <td className="small">
                        {r.errors.map((m) => <div key={m} style={{ color: 'var(--bad)' }}>{m}</div>)}
                        {r.warnings.map((m) => <div key={m} className="muted">{m}</div>)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {result.specials.length > 0 && (
            <div className="panel">
              <h2 style={{ marginTop: 0 }}>Special prices</h2>
              <table>
                <thead><tr><th>Customer</th><th>Product</th><th className="num">Price</th><th>Notes</th></tr></thead>
                <tbody>
                  {result.specials.map((s) => (
                    <tr key={s.row}>
                      <td>{s.customer}</td><td>{s.product}</td><td className="num">{money(s.priceCents)}</td>
                      <td className="small">{s.errors.map((m) => <div key={m} style={{ color: 'var(--bad)' }}>{m}</div>)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
