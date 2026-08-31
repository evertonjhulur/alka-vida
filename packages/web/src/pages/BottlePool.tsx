import { useEffect, useState } from 'react';
import { api, type Session } from '../lib/api';
import { date } from '../lib/format';

interface Pool {
  id: string; label: string;
  cleanReady: number; filledWithCustomer: number;
  returnedDirty: number; lostDamaged: number; inCirculation: number;
}
interface Holding {
  customer_id: string; name: string; phone: string | null; delivery_zone: string | null;
  delivered: number; returned: number; lost: number; holding: number;
}
interface Movement {
  id: string; quantity: number; direction: string; reference: string | null;
  reference_type: string; txn_date: string; notes: string | null;
}

export default function BottlePool({ session }: { session: Session }) {
  const [pools, setPools] = useState<Pool[]>([]);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [history, setHistory] = useState<Movement[]>([]);
  const [washed, setWashed] = useState('');
  const [scrapped, setScrapped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const data = await api.get<{ pools: Pool[]; holdings: Holding[]; history: Movement[] }>(
      '/api/bottle-pool',
    );
    setPools(data.pools);
    setHoldings(data.holdings);
    setHistory(data.history);
  }
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  const pool = pools[0];

  async function wash(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setMsg(null);
    try {
      await api.post('/api/bottle-pool/wash', {
        quantity: Number(washed) || 0,
        scrapped: Number(scrapped) || 0,
      });
      setMsg(
        `${Number(washed) || 0} bottles washed and back in clean stock` +
        (Number(scrapped) > 0 ? `, ${scrapped} scrapped as unusable.` : '.'),
      );
      setWashed(''); setScrapped('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the wash');
    } finally { setBusy(false); }
  }

  const totalOut = holdings.reduce((s, h) => s + Number(h.holding), 0);

  return (
    <>
      <h1>5-gallon bottle pool</h1>
      <p className="subtitle">
        Returnable bottles are company assets that keep circulating. This tracks
        where every one of them is.
      </p>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      {pool && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>{pool.label}</h2>

          {/* The exchange cycle, in the order a bottle actually travels. */}
          <div className="row" style={{ gap: 0, alignItems: 'stretch', flexWrap: 'nowrap', overflowX: 'auto' }}>
            <div className="pool-stage">
              <div className="pool-count">{pool.cleanReady}</div>
              <div className="pool-label">Clean, ready to fill</div>
            </div>
            <div className="pool-arrow">→</div>
            <div className="pool-stage">
              <div className="pool-count">{pool.filledWithCustomer}</div>
              <div className="pool-label">Out with customers</div>
            </div>
            <div className="pool-arrow">→</div>
            <div className="pool-stage">
              <div className="pool-count">{pool.returnedDirty}</div>
              <div className="pool-label">Returned, awaiting wash</div>
            </div>
            <div className="pool-arrow" title="washing returns bottles to clean stock">↺</div>
            <div className="pool-stage lost">
              <div className="pool-count">{pool.lostDamaged}</div>
              <div className="pool-label">Lost or damaged</div>
            </div>
          </div>

          <div className="total-line grand" style={{ maxWidth: 340 }}>
            <span>Bottles still in circulation</span>
            <span>{pool.inCirculation}</span>
          </div>
          <p className="muted small">
            Bottles reported lost or damaged are written off as a business loss.
            They are never charged to the customer.
          </p>
        </div>
      )}

      {pool && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Wash returned bottles</h2>
          <p className="muted small">
            Moves bottles from the returned pile back into clean, ready stock so
            they can go out again. Anything found unusable is scrapped instead.
          </p>
          <form onSubmit={wash}>
            <div className="row">
              <div className="field">
                <label htmlFor="w">Washed and returned to stock</label>
                <input id="w" type="number" min="0" style={{ width: 150 }}
                       value={washed} onChange={(e) => setWashed(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="s">Scrapped as unusable</label>
                <input id="s" type="number" min="0" style={{ width: 150 }}
                       value={scrapped} onChange={(e) => setScrapped(e.target.value)} />
              </div>
              <div className="field">
                <button disabled={busy || pool.returnedDirty === 0}>Record wash</button>
              </div>
            </div>
            {pool.returnedDirty === 0
              ? <p className="muted small">No bottles are waiting to be washed.</p>
              : <p className="muted small">{pool.returnedDirty} waiting to be washed.</p>}
          </form>
        </div>
      )}

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Who is holding bottles</h2>
        <p className="muted small">
          Delivered to each customer, less what they have handed back — who to
          chase for empties.
        </p>
        <table>
          <thead>
            <tr>
              <th>Customer</th><th>Zone</th>
              <th className="num">Delivered</th><th className="num">Returned</th>
              <th className="num">Lost</th><th className="num">Holding now</th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((h) => (
              <tr key={h.customer_id}>
                <td>
                  {h.name}
                  {h.phone && <div className="muted small">{h.phone}</div>}
                </td>
                <td className="muted">{h.delivery_zone ?? '—'}</td>
                <td className="num">{Number(h.delivered)}</td>
                <td className="num">{Number(h.returned)}</td>
                <td className="num">{Number(h.lost) || '—'}</td>
                <td className="num">
                  <strong>{Number(h.holding)}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {holdings.length === 0
          ? <p className="muted">No bottles have been delivered yet.</p>
          : (
            <div className="total-line grand">
              <span>Total out with customers</span><span>{totalOut}</span>
            </div>
          )}
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Movement history</h2>
        <table>
          <thead>
            <tr>
              <th>Date</th><th>Movement</th>
              <th className="num">Bottles</th><th>Details</th>
            </tr>
          </thead>
          <tbody>
            {history.map((m) => (
              <tr key={m.id}>
                <td>{date(m.txn_date)}</td>
                <td>
                  <span className={`chip ${
                    m.reference_type === 'BottleReturn' ? 'ok'
                    : m.reference_type === 'BottleWash' ? 'info'
                    : m.reference_type === 'Adjustment' ? 'warn' : 'neutral'}`}>
                    {m.reference_type === 'CustomerOrder' ? 'delivered'
                      : m.reference_type === 'BottleReturn' ? 'collected'
                      : m.reference_type === 'BottleWash' ? 'washed' : 'adjusted'}
                  </span>
                </td>
                <td className="num">{Number(m.quantity)}</td>
                <td className="small muted">{m.notes ?? m.reference}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {history.length === 0 && (
          <p className="muted">
            No movements recorded yet. Deliveries, collections and washes appear here.
          </p>
        )}
      </div>

      {session.role !== 'admin' && (
        <p className="muted small">
          Correcting the pool counts directly is restricted to administrators.
        </p>
      )}
    </>
  );
}
