import { Fragment, useEffect, useState } from 'react';
import { api, getSession } from '../lib/api';
import { money, date, when, todayInJamaica } from '../lib/format';

interface Product { id: string; name: string; bottles_per_case: number; is_bottle_charge?: boolean; is_returnable?: boolean }

interface Feasibility {
  canProduce: boolean;
  estimatedCostCents: number;
  /** 5-gallon products: the empties this run draws on (jug cycle, 3 Nov 2026). Never blocks. */
  empties: { onRecord: number; needed: number; short: number; material: string } | null;
  components: Array<{
    rawMaterialId: string; name: string; unitOfMeasure: string;
    required: number; onHand: number; shortfall: number; estimatedCostCents: number;
  }>;
}

interface Run {
  id: string; batch_date: string; operator: string | null; product_name: string | null;
  cases: number; loose_bottles: number; total_bottles: number;
  material_cost_cents: number; status: string; jugs_scrapped?: number;
  /** For the Edit panel (11 Nov 2026). */
  bottles_per_case?: number; is_returnable?: boolean;
}

export default function Production() {
  const [products, setProducts] = useState<Product[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [productId, setProductId] = useState('');
  const [cases, setCases] = useState('');
  const [loose, setLoose] = useState('');
  const [operator, setOperator] = useState('');
  /** The day it was made (team feedback, point 19); blank = today. */
  const [madeOn, setMadeOn] = useState('');
  /** 5-gallon runs: jugs taken from the empties but found unusable. */
  const [scrapped, setScrapped] = useState('');
  const [check, setCheck] = useState<Feasibility | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Delete… or Edit… open on a run (admins; 11 Nov 2026). */
  const [fixing, setFixing] = useState<{
    id: string; mode: 'delete' | 'edit'; reason: string;
    /** Refused because the bottles have gone out: offer "it was never made" (12 Nov 2026). */
    short?: boolean;
    date: string; operator: string; cases: string; loose: string; scrapped: string;
  } | null>(null);
  const isAdmin = getSession()?.role === 'admin';

  function openFix(r: Run, mode: 'delete' | 'edit') {
    setError(null); setMsg(null);
    setFixing({ id: r.id, mode, reason: '', date: String(r.batch_date).slice(0, 10), operator: r.operator ?? '',
      cases: String(Number(r.cases) || 0), loose: String(Number(r.loose_bottles) || 0), scrapped: String(Number(r.jugs_scrapped) || 0) });
  }

  async function saveFix() {
    if (!fixing) return;
    setBusy(true); setError(null); setMsg(null);
    try {
      if (fixing.mode === 'delete') {
        let r: { bottles: number; productName: string; stockAfter: number };
        try {
          r = await api.post(`/api/production/${fixing.id}/delete`, { reason: fixing.reason.trim(), evenIfShort: !!fixing.short });
        } catch (err) {
          const m = err instanceof Error ? err.message : '';
          if (!fixing.short && /cannot be deleted unless you confirm/.test(m)) {
            setFixing({ ...fixing, short: true });
            setError(m);
            return;
          }
          throw err;
        }
        setMsg(`Run deleted: ${r.bottles} ${r.productName} taken back off stock, and the materials (and any empties) put back.`
          + (r.stockAfter < 0 ? ` ${r.productName} stock is now ${r.stockAfter}: count it on Stock › Count to set the true figure.` : ''));
      } else {
        const r = await api.post<{ bottles: number; productName: string; redone: boolean }>(
          `/api/production/${fixing.id}/edit`, {
            productionDate: fixing.date || null, operator: fixing.operator,
            cases: Math.max(0, Math.round(Number(fixing.cases) || 0)),
            looseBottles: Math.max(0, Math.round(Number(fixing.loose) || 0)),
            jugsScrapped: Math.max(0, Math.round(Number(fixing.scrapped) || 0)),
            reason: fixing.reason.trim() || null,
          });
        setMsg(r.redone ? `Run changed to ${r.bottles} ${r.productName}; stock and materials adjusted to match.` : 'Run changed.');
      }
      setFixing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the run');
    } finally { setBusy(false); }
  }


  const product = products.find((p) => p.id === productId);
  const bpc = product ? Number(product.bottles_per_case) : 0;
  const isJug = !!product?.is_returnable;
  const bottles = bpc > 0
    ? (Number(cases) || 0) * bpc + (Number(loose) || 0)
    : (Number(loose) || 0);

  async function load() {
    // The bottle charge is a price, not something the plant makes.
    setProducts((await api.get<Product[]>('/api/products')).filter((p) => !p.is_bottle_charge));
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
      const result = await api.post<{
        bottlesProduced: number; materialCostCents: number;
        empties?: { drawn: number; scrapped: number; left: number } | null;
      }>(
        '/api/production',
        {
          productId,
          cases: Number(cases) || 0,
          looseBottles: Number(loose) || 0,
          operator: operator || undefined,
          productionDate: madeOn || null,
          jugsScrapped: isJug ? (Number(scrapped) || 0) : 0,
        },
      );
      const e = result.empties;
      setMsg(
        `Produced ${result.bottlesProduced} bottles. Materials cost ` +
        `${money(result.materialCostCents)}, drawn from the oldest stock batches first.` +
        (e ? ` ${e.drawn} empties used${e.scrapped ? ` (${e.scrapped} scrapped)` : ''}; ` +
          `${e.left} left on record${e.left < 0 ? ' - below zero: record the empties brought back, or count them' : ''}.` : ''),
      );
      setCases(''); setLoose(''); setMadeOn(''); setScrapped('');
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
        finished bottles to stock. A 5-gallon run also uses one empty jug per jug filled.
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
            <div className="field">
              <label htmlFor="pd">Production date</label>
              <input id="pd" type="date" value={madeOn} max={todayInJamaica()}
                     onChange={(e) => setMadeOn(e.target.value)} />
              <div className="muted small">Blank means today.</div>
            </div>
          </div>

          {isJug && (
            <div className="row">
              <div className="field">
                <label htmlFor="js">Jugs scrapped on this run</label>
                <input id="js" type="number" min="0" style={{ width: 150 }} value={scrapped}
                       onChange={(e) => setScrapped(e.target.value)} />
                <div className="muted small">Taken from the empties but found unusable: a business loss.</div>
              </div>
            </div>
          )}

          {bottles > 0 && (
            <p className="small">
              Total output: <strong>{bottles} bottles</strong>
            </p>
          )}

          {check?.empties && (() => {
            const need = check.empties.needed + (Number(scrapped) || 0);
            const short = Math.max(need - check.empties.onRecord, 0);
            return (
              <div className={`notice ${short > 0 ? 'warn' : 'info'}`}>
                This run uses <strong>{need}</strong> empt{need === 1 ? 'y' : 'ies'} from the{' '}
                {check.empties.material} ({check.empties.onRecord} on record).
                {short > 0 && (
                  <> That is {short} more than on record. It will still be saved — empties brought back
                    mid-round are recorded when the round is settled — but if the figure stays below zero,
                    count the empties.</>
                )}
              </div>
            );
          })()}

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
              {isAdmin && <th aria-label="Actions" />}
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <Fragment key={r.id}>
              <tr>
                <td>{when(r.batch_date)}</td>
                <td>{r.product_name ?? '—'}</td>
                <td className="muted">{r.operator ?? '—'}</td>
                <td className="num">
                  {Number(r.total_bottles)} bottles
                  {Number(r.cases) > 0 && (
                    <div className="muted small">{Number(r.cases)} cases</div>
                  )}
                  {Number(r.jugs_scrapped) > 0 && (
                    <div className="muted small">{Number(r.jugs_scrapped)} jugs scrapped</div>
                  )}
                </td>
                <td className="num">{money(Number(r.material_cost_cents))}</td>
                <td><span className="chip ok">{r.status}</span></td>
                {isAdmin && (
                  <td className="num tx-nowrap">
                    {r.status === 'Completed' && fixing?.id !== r.id && (
                      <>
                        <button type="button" className="as-link small" onClick={() => openFix(r, 'edit')}>Edit…</button>{' '}
                        <button type="button" className="link-button bad-text" onClick={() => openFix(r, 'delete')}>Delete…</button>
                      </>
                    )}
                  </td>
                )}
              </tr>
              {fixing?.id === r.id && (
                <tr>
                  <td colSpan={isAdmin ? 7 : 6}>
                    <div className="panel" style={{ margin: '4px 0 8px', background: 'var(--surface-2, #f7f9fc)' }}>
                      {fixing.mode === 'delete' ? (
                        <>
                          <strong>Delete this run?</strong>
                          <p className="small" style={{ margin: '4px 0 8px' }}>
                            {Number(r.total_bottles)} {r.product_name} come back off stock and the materials{r.is_returnable ? ' and empties' : ''} go
                            back. Use it for a run entered twice or by mistake.
                          </p>
                        </>
                      ) : (
                        <>
                          <strong>Change this run</strong>
                          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                            <div className="field"><label htmlFor="fx-date">Production date</label>
                              <input id="fx-date" type="date" max={todayInJamaica()} value={fixing.date}
                                     onChange={(e) => setFixing({ ...fixing, date: e.target.value })} /></div>
                            {Number(r.bottles_per_case) > 0 && (
                              <div className="field"><label htmlFor="fx-cases">Cases</label>
                                <input id="fx-cases" inputMode="numeric" style={{ width: 90 }} value={fixing.cases}
                                       onChange={(e) => setFixing({ ...fixing, cases: e.target.value })} /></div>
                            )}
                            <div className="field"><label htmlFor="fx-loose">{Number(r.bottles_per_case) > 0 ? 'Loose bottles' : 'Bottles'}</label>
                              <input id="fx-loose" inputMode="numeric" style={{ width: 90 }} value={fixing.loose}
                                     onChange={(e) => setFixing({ ...fixing, loose: e.target.value })} /></div>
                            {r.is_returnable && (
                              <div className="field"><label htmlFor="fx-scr">Jugs scrapped</label>
                                <input id="fx-scr" inputMode="numeric" style={{ width: 90 }} value={fixing.scrapped}
                                       onChange={(e) => setFixing({ ...fixing, scrapped: e.target.value })} /></div>
                            )}
                            <div className="field"><label htmlFor="fx-op">Operator</label>
                              <input id="fx-op" value={fixing.operator}
                                     onChange={(e) => setFixing({ ...fixing, operator: e.target.value })} /></div>
                          </div>
                          <p className="muted small" style={{ margin: '2px 0 6px' }}>
                            A new quantity adjusts stock and materials to match, as if it had been entered that way.
                            To change the product, delete the run and enter it again.
                          </p>
                        </>
                      )}
                      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                        <div className="field" style={{ flex: '1 1 260px' }}>
                          <label htmlFor="fx-why">{fixing.mode === 'delete' ? 'Why (required)' : 'Why (optional)'}</label>
                          <input id="fx-why" placeholder={fixing.mode === 'delete' ? 'e.g. entered twice' : 'e.g. wrong date'}
                                 value={fixing.reason} onChange={(e) => setFixing({ ...fixing, reason: e.target.value })} />
                        </div>
                        <button type="button" className={fixing.mode === 'delete' ? 'danger-soft' : undefined}
                                disabled={busy || (fixing.mode === 'delete' && !fixing.reason.trim())} onClick={saveFix}>
                          {fixing.mode === 'delete' ? (fixing.short ? 'It was never made: delete anyway' : 'Delete run') : 'Save changes'}</button>
                        <button type="button" className="secondary" onClick={() => setFixing(null)}>Cancel</button>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {runs.length === 0 && <p className="muted">No production runs recorded yet.</p>}
      </div>
    </>
  );
}
