import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Session } from '../lib/api';
import { money, toCents, todayInJamaica, when } from '../lib/format';

/**
 * The 5-gallon jug cycle (Everton, 29 Oct and 3 Nov 2026).
 *
 *   empties at the plant -> production (wash + fill) -> full, in stock
 *        ^                                                 | delivered / collected
 *        +------------ empties back <---- out with customers
 *
 * Every figure here is read from its one home, so this screen and Stock
 * always agree: the empties ARE the raw material ticked as the returnable
 * jug, full jugs ARE the 5-gallon finished goods, and "out with customers"
 * IS the customer accounts. There is no wash stage: a washed jug is filled.
 */
interface Figures {
  jug: { id: string; name: string } | null;
  empties: number; full: number;
  fullProducts: Array<{ productId: string; name: string; bottles: number }>;
  withCustomers: number; lostOnRoad: number; scrapped: number; sold: number; inCycle: number;
}
interface Holding {
  customer_id: string; name: string; phone: string | null; delivery_zone: string | null;
  delivered: number; returned: number; lost: number; holding: number;
  /** Bought for empties short (7 Oct 2026): theirs, so not in Holding. */
  sold?: number;
  /** Opening balance of our bottles entered for them (28 Oct 2026). */
  opening?: number;
}
interface Movement {
  id: string; quantity: number; direction: string; reference: string | null;
  reference_type: string; txn_day: string; notes: string | null;
}
interface Supplier { id: string; name: string }

const KIND: Record<string, [string, string]> = {
  BottleReturn: ['empties back', 'ok'],
  ProductionBatch: ['filled', 'info'],
  JugsBought: ['bought', 'ok'],
  PurchaseOrder: ['received (PO)', 'ok'],
  JugsScrapped: ['scrapped', 'warn'],
  Adjustment: ['count / correction', 'neutral'],
};

export default function BottlePool({ session }: { session: Session }) {
  const [fig, setFig] = useState<Figures | null>(null);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [history, setHistory] = useState<Movement[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canAct = session.role === 'admin' || session.role === 'user';

  // New jugs bought without a PO
  const [qty, setQty] = useState('');
  const [cost, setCost] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [boughtOn, setBoughtOn] = useState('');
  const [note, setNote] = useState('');
  // Scrapped at the plant, outside a run
  const [scrapQty, setScrapQty] = useState('');
  const [scrapWhy, setScrapWhy] = useState('');

  async function load() {
    const data = await api.get<{ figures: Figures; holdings: Holding[]; history: Movement[] }>('/api/bottle-pool');
    setFig(data.figures);
    setHoldings(data.holdings);
    setHistory(data.history);
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
    if (canAct) api.get<Supplier[]>('/api/suppliers').then(setSuppliers).catch(() => setSuppliers([]));
  }, [canAct]);

  async function act(what: string, fn: () => Promise<void>) {
    setBusy(true); setError(null); setMsg(null);
    try { await fn(); await load(); } catch (e) { setError(e instanceof Error ? e.message : what); } finally { setBusy(false); }
  }

  const bought = (e: React.FormEvent) => {
    e.preventDefault();
    void act('Could not record the jugs bought', async () => {
      const n = Number(qty) || 0;
      await api.post('/api/bottle-pool/jugs-bought', {
        quantity: n,
        unitCostCents: cost.trim() ? toCents(cost) : null,
        supplierId: supplierId || null,
        boughtOn: boughtOn || null,
        notes: note || null,
      });
      setMsg(`${n} new jug${n === 1 ? '' : 's'} added to the empties.`);
      setQty(''); setCost(''); setSupplierId(''); setBoughtOn(''); setNote('');
    });
  };

  const scrap = (e: React.FormEvent) => {
    e.preventDefault();
    void act('Could not record the jugs scrapped', async () => {
      const n = Number(scrapQty) || 0;
      await api.post('/api/bottle-pool/scrap', { quantity: n, reason: scrapWhy });
      setMsg(`${n} jug${n === 1 ? '' : 's'} scrapped and taken off the empties.`);
      setScrapQty(''); setScrapWhy('');
    });
  };

  const traced = holdings.reduce((s, h) => s + Number(h.holding), 0);
  const lost = fig ? fig.lostOnRoad + fig.scrapped : 0;
  const unitCost = cost.trim() ? toCents(cost) : 0;

  return (
    <>
      <h1>5-gallon jug cycle</h1>
      <p className="subtitle">
        Empties come back or are bought, production washes and fills them, full jugs go out, and empties
        come back again. These figures are the same ones Stock shows.
      </p>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      {fig && !fig.jug && (
        <div className="notice warn">
          No raw material is ticked as the returnable 5-gallon jug, so the empties cannot be tracked.
          Open <Link to="/materials">Raw materials</Link>, edit "5 Gal (19L) Bottle" and tick
          "This is the returnable 5-gallon jug".
        </div>
      )}

      {fig && (
        <div className="panel">
          {/* The cycle, in the order a jug actually travels. */}
          <div className="row" style={{ gap: 0, alignItems: 'stretch', flexWrap: 'nowrap', overflowX: 'auto' }}>
            <div className="pool-stage">
              <div className="pool-count" style={fig.empties < 0 ? { color: 'var(--bad, #b42318)' } : undefined}>{fig.empties}</div>
              <div className="pool-label">Empties at the plant</div>
            </div>
            <div className="pool-arrow" title="production washes and fills them">→</div>
            <div className="pool-stage">
              <div className="pool-count">{fig.full}</div>
              <div className="pool-label">Full, in stock</div>
            </div>
            <div className="pool-arrow" title="delivered or collected">→</div>
            <div className="pool-stage">
              <div className="pool-count">{fig.withCustomers}</div>
              <div className="pool-label">Out with customers</div>
            </div>
            <div className="pool-arrow" title="empties back">↺</div>
            <div className="pool-stage lost">
              <div className="pool-count">{lost}</div>
              <div className="pool-label">Lost or scrapped</div>
            </div>
          </div>

          <div className="total-line grand" style={{ maxWidth: 360 }}>
            <span>Jugs in the cycle</span><span>{fig.inCycle.toLocaleString('en-JM')}</span>
          </div>
          {fig.empties < 0 && (
            <div className="notice warn">
              The empties are below zero: more jugs were filled than empties on record. Usually empties brought
              back mid-round that are recorded when the round is settled. If it stays below zero, count the
              empties on <Link to="/stock-count">Stock › Count</Link>.
            </div>
          )}

          <details className="explain">
            <summary style={{ cursor: 'pointer' }}><strong>Where these numbers come from</strong></summary>
            <ol>
              <li><strong>Empties at the plant</strong> is the stock of <em>{fig.jug?.name ?? 'the jug material'}</em>
                {' '}on Stock. It goes <em>up</em> with every empty a driver, the counter or a collection takes back,
                and with new jugs received on a purchase order or bought without one (below). It goes <em>down</em>
                {' '}with every 5-gallon production run (one per jug filled) and every jug scrapped. Correct it by
                counting it on <Link to="/stock-count">Stock › Count</Link>.</li>
              <li><strong>Full, in stock</strong> is the finished goods of
                {' '}{fig.fullProducts.map((p) => p.name).join(', ') || 'the 5-gallon product'}: up with production,
                down with every delivery, collection and counter sale.</li>
              <li><strong>Out with customers</strong> is the total of the customer accounts below: our jugs on loan,
                from the opening balances of 23 Oct 2026 onwards. Jugs customers own or bought are not ours and
                are not counted.</li>
              <li><strong>Lost or scrapped</strong> is jugs reported lost on the road ({fig.lostOnRoad}) and scrapped
                at the plant ({fig.scrapped}). A business loss, never charged to the customer.</li>
            </ol>
            <p className="small" style={{ marginBottom: 0 }}>
              A new jug's price is recorded once, on its purchase. Filling it adds no jug cost to the water.
            </p>
          </details>
        </div>
      )}

      {fig?.jug && canAct && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>New jugs bought without a purchase order</h2>
          <p className="muted small">
            When jugs are bought by hand (bottles running low, a new customer). Jugs on a purchase order go in
            when the PO is received.
          </p>
          <form onSubmit={bought}>
            <div className="row">
              <div className="field">
                <label htmlFor="nq">New jugs</label>
                <input id="nq" type="number" min="1" required style={{ width: 110 }} value={qty}
                       onChange={(e) => setQty(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="nc">Cost per jug (J$)</label>
                <input id="nc" inputMode="decimal" style={{ width: 120 }} value={cost} placeholder="optional"
                       onChange={(e) => setCost(e.target.value)} />
                {unitCost > 0 && Number(qty) > 0 && (
                  <div className="muted small">{money(unitCost * Number(qty))} in all</div>
                )}
              </div>
              <div className="field">
                <label htmlFor="ns">Bought from</label>
                <select id="ns" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                  <option value="">—</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="nd">Bought on</label>
                <input id="nd" type="date" value={boughtOn} max={todayInJamaica()}
                       onChange={(e) => setBoughtOn(e.target.value)} />
                <div className="muted small">Blank means today.</div>
              </div>
              <div className="field" style={{ flex: '1 1 200px' }}>
                <label htmlFor="nn">Note</label>
                <input id="nn" style={{ width: '100%' }} value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
              <div className="field">
                <button className="go" disabled={busy || !(Number(qty) > 0)}>Add to the empties</button>
              </div>
            </div>
          </form>

          <h2>Jugs scrapped at the plant</h2>
          <p className="muted small">
            Jugs found unusable outside a production run. On a run, use "Jugs scrapped on this run" on Production.
          </p>
          <form onSubmit={scrap}>
            <div className="row">
              <div className="field">
                <label htmlFor="sq">Jugs scrapped</label>
                <input id="sq" type="number" min="1" required style={{ width: 110 }} value={scrapQty}
                       onChange={(e) => setScrapQty(e.target.value)} />
              </div>
              <div className="field" style={{ flex: '1 1 260px' }}>
                <label htmlFor="sw">Why</label>
                <input id="sw" required style={{ width: '100%' }} value={scrapWhy}
                       onChange={(e) => setScrapWhy(e.target.value)} />
              </div>
              <div className="field">
                <button className="danger-soft" disabled={busy || !(Number(scrapQty) > 0) || !scrapWhy.trim()}>
                  Scrap
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Out with customers</h2>
        <p className="muted small">
          Their opening balance of our jugs, plus what was delivered, less what they handed back — who to chase
          for empties.
        </p>
        {session.role === 'admin' && (
          <p className="small">
            <Link to="/bottle-pool/opening">Upload opening balances of our bottles</Link>
            <span className="muted"> — or set one customer's on their Bottles tab.</span>
          </p>
        )}
        <table>
          <thead>
            <tr>
              <th>Customer</th><th>Zone</th>
              <th className="num">Opening</th><th className="num">Delivered</th><th className="num">Returned</th>
              <th className="num">Lost</th><th className="num">Bought (theirs)</th><th className="num">Holding now</th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((h) => (
              <tr key={h.customer_id}>
                <td>
                  <Link to={`/customers/${h.customer_id}?tab=bottles`}>{h.name}</Link>
                  {h.phone && <div className="muted small">{h.phone}</div>}
                </td>
                <td className="muted">{h.delivery_zone ?? '—'}</td>
                <td className="num">{Number(h.opening) || '—'}</td>
                <td className="num">{Number(h.delivered)}</td>
                <td className="num">{Number(h.returned)}</td>
                <td className="num">{Number(h.lost) || '—'}</td>
                <td className="num">{Number(h.sold) || '—'}</td>
                <td className="num"><strong>{Number(h.holding)}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
        {holdings.length === 0
          ? <p className="muted">No jugs are out with customers yet.</p>
          : (
            <div className="total-line grand">
              <span>Total out with customers</span><span>{traced.toLocaleString('en-JM')}</span>
            </div>
          )}
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Empties: movement history</h2>
        <table>
          <thead>
            <tr><th>Date</th><th>Movement</th><th className="num">Jugs</th><th>Details</th></tr>
          </thead>
          <tbody>
            {history.map((m) => {
              const [label, tone] = KIND[m.reference_type] ?? [m.reference_type, 'neutral'];
              return (
                <tr key={m.id}>
                  <td>{when(m.txn_day)}</td>
                  <td><span className={`chip ${tone}`}>{label}</span></td>
                  <td className="num">{m.direction === 'out' ? '−' : '+'}{Number(m.quantity)}</td>
                  <td className="small muted">{m.notes ?? m.reference}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {history.length === 0 && (
          <p className="muted">No movements yet. Empties back, production runs, jugs bought and counts appear here.</p>
        )}
      </div>
    </>
  );
}
