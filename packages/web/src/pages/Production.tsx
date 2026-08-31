import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { money, date } from '../lib/format';

interface Product { id: string; name: string; bottles_per_case: number }

interface Feasibility {
  canProduce: boolean;
  estimatedCostCents: number;
  components: Array<{
    rawMaterialId: string; name: string; unitOfMeasure: string;
    required: number; onHand: number; shortfall: number; estimatedCostCents: number;
  }>;
}

interface Run {
  id: string; batch_date: string; operator: string | null; product_name: string | null;
  cases: number; loose_bottles: number; total_bottles: number;
  material_cost_cents: number; status: string;
}

export default function Production() {
  const [products, setProducts] = useState<Product[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [productId, setProductId] = useState('');
  const [cases, setCases] = useState('');
  const [loose, setLoose] = useState('');
  const [operator, setOperator] = useState('');
  const [check, setCheck] = useState<Feasibility | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const product = products.find((p) => p.id === productId);
  const bpc = product ? Number(product.bottles_per_case) : 0;
  const bottles = bpc > 0
    ? (Number(cases) || 0) * bpc + (Number(loose) || 0)
    : (Number(loose) || 0);

  async function load() {
    setProducts(await api.get<Product[]>('/api/products'));
    setRuns(await api.get<Run[]>('/api/production'));
  }
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  // Check the bill of material against stock before anything is committed.
  useEffect(() => {
    if (!productId || bottles <= 0) { setCheck(null); return; }
    api.get<Feasibility>(`/api/production/feasibility?productId=${productId}&bottles=${bottles}`)
      .then(setCheck)
      .catch(() => setCheck(null));
  }, [productId, bottles]);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setMsg(null);
    try {
      const result = await api.post<{ bottlesProduced: number; materialCostCents: number }>(
        '/api/production',
        {
          productId,
          cases: Number(cases) || 0,
          looseBottles: Number(loose) || 0,
          operator: operator || undefined,
        },
      );
      setMsg(
        `Produced ${result.bottlesProduced} bottles. Materials cost ` +
        `${money(result.materialCostCents)}, drawn from the oldest stock batches first.`,
      );
      setCases(''); setLoose('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the production run');
    } finally { setBusy(false); }
  }

  return (
    <>
      <h1>Production</h1>
      <p className="subtitle">
        A run consumes raw materials from the oldest batches first and adds the
        finished bottles to stock.
      </p>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>New production run</h2>
        <form onSubmit={run}>
          <div className="row">
            <div className="field" style={{ flex: '1 1 240px' }}>
              <label htmlFor="p">Product</label>
              <select id="p" required value={productId} style={{ width: '100%' }}
                      onChange={(e) => { setProductId(e.target.value); setCases(''); setLoose(''); }}>
                <option value="">Select a product…</option>
                {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>

            {product && bpc > 0 && (
              <div className="field">
                <label htmlFor="c">Cases produced</label>
                <input id="c" type="number" min="0" style={{ width: 120 }} value={cases}
                       onChange={(e) => setCases(e.target.value)} />
                <div className="muted small">{bpc} bottles per case</div>
              </div>
            )}

            <div className="field">
              <label htmlFor="l">
                {bpc > 0 ? 'Loose bottles (part case)' : 'Bottles produced'}
              </label>
              <input id="l" type="number" min="0" style={{ width: 150 }} value={loose}
                     onChange={(e) => setLoose(e.target.value)} />
            </div>

            <div className="field">
              <label htmlFor="op">Operator</label>
              <input id="op" value={operator} onChange={(e) => setOperator(e.target.value)} />
            </div>
          </div>

          {bottles > 0 && (
            <p className="small">
              Total output: <strong>{bottles} bottles</strong>
            </p>
          )}

          {check && (
            <>
              <h2>Materials required</h2>
              <table>
                <thead>
                  <tr>
                    <th>Material</th><th className="num">Needed</th>
                    <th className="num">In stock</th><th className="num">Short by</th>
                    <th className="num">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {check.components.map((c) => (
                    <tr key={c.rawMaterialId}>
                      <td>{c.name}</td>
                      <td className="num">{c.required} {c.unitOfMeasure}</td>
                      <td className="num">{c.onHand}</td>
                      <td className="num">
                        {c.shortfall > 0
                          ? <span className="chip bad">{c.shortfall}</span>
                          : <span className="muted">—</span>}
                      </td>
                      <td className="num">{money(c.estimatedCostCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="total-line grand" style={{ maxWidth: 320, marginLeft: 'auto' }}>
                <span>Estimated material cost</span>
                <span>{money(check.estimatedCostCents)}</span>
              </div>

              {check.components.length === 0 && (
                <div className="notice warn">
                  This product has no bill of material, so nothing can be costed or
                  consumed. Set one up before running production.
                </div>
              )}
              {!check.canProduce && check.components.length > 0 && (
                <div className="notice warn">
                  There is not enough stock for this run. Receive more of the short
                  materials, or reduce the quantity.
                </div>
              )}
            </>
          )}

          <button disabled={busy || !check?.canProduce} style={{ marginTop: 12 }}>
            {busy ? 'Recording…' : 'Record production run'}
          </button>
        </form>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Recent runs</h2>
        <table>
          <thead>
            <tr>
              <th>Date</th><th>Product</th><th>Operator</th>
              <th className="num">Output</th><th className="num">Material cost</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>{date(r.batch_date)}</td>
                <td>{r.product_name ?? '—'}</td>
                <td className="muted">{r.operator ?? '—'}</td>
                <td className="num">
                  {Number(r.total_bottles)} bottles
                  {Number(r.cases) > 0 && (
                    <div className="muted small">{Number(r.cases)} cases</div>
                  )}
                </td>
                <td className="num">{money(Number(r.material_cost_cents))}</td>
                <td><span className="chip ok">{r.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        {runs.length === 0 && <p className="muted">No production runs recorded yet.</p>}
      </div>
    </>
  );
}
