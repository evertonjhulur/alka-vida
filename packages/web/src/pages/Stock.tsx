import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { money, date } from '../lib/format';

interface FinishedGood {
  product_id: string; name: string; size: string | null;
  bottles_per_case: number; bottles_on_hand: number; full_cases: number | null;
}
interface Pool {
  label: string; clean_ready: number; filled_with_customer: number;
  returned_dirty: number; lost_damaged: number; in_circulation: number;
}
interface Txn {
  id: string; item_type: string; item_name: string; quantity: number;
  direction: string; reference: string | null; reference_type: string;
  txn_date: string; total_cost_cents: number | null; notes: string | null;
}

export default function Stock() {
  const [goods, setGoods] = useState<FinishedGood[]>([]);
  const [pool, setPool] = useState<Pool[]>([]);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<FinishedGood[]>('/api/finished-goods').then(setGoods).catch((e) => setError(e.message));
    api.get<Pool[]>('/api/reports/bottle-pool').then(setPool).catch(() => {});
  }, []);

  useEffect(() => {
    const q = filter ? `?itemType=${filter}` : '';
    api.get<Txn[]>(`/api/inventory-transactions${q}`).then(setTxns).catch(() => {});
  }, [filter]);

  return (
    <>
      <h1>Stock on hand</h1>
      <p className="subtitle">
        Finished goods, the returnable bottle pool, and every stock movement.
      </p>
      {error && <div className="notice error">{error}</div>}

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Finished goods</h2>
        <table>
          <thead>
            <tr>
              <th>Product</th><th>Size</th>
              <th className="num">Bottles</th><th className="num">Whole cases</th>
            </tr>
          </thead>
          <tbody>
            {goods.map((g) => (
              <tr key={g.product_id}>
                <td>{g.name}</td>
                <td className="muted">{g.size ?? '—'}</td>
                <td className="num">{Number(g.bottles_on_hand)}</td>
                <td className="num">
                  {g.full_cases === null
                    ? <span className="muted">sold individually</span>
                    : Number(g.full_cases)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>5-gallon bottle pool</h2>
        <p className="muted small">
          Bottles reported lost or damaged are a business loss and are never charged
          to the customer.
        </p>
        <table>
          <thead>
            <tr>
              <th>Pool</th><th className="num">Clean, ready</th>
              <th className="num">Out with customers</th><th className="num">Returned dirty</th>
              <th className="num">Lost / damaged</th><th className="num">In circulation</th>
            </tr>
          </thead>
          <tbody>
            {pool.map((p) => (
              <tr key={p.label}>
                <td>{p.label}</td>
                <td className="num">{Number(p.clean_ready)}</td>
                <td className="num">{Number(p.filled_with_customer)}</td>
                <td className="num">{Number(p.returned_dirty)}</td>
                <td className="num">
                  <span className="chip warn">{Number(p.lost_damaged)}</span>
                </td>
                <td className="num">{Number(p.in_circulation)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {pool.length === 0 && <p className="muted">No bottle pool configured.</p>}
      </div>

      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ marginTop: 0 }}>Stock movements</h2>
          <div className="field" style={{ marginBottom: 0 }}>
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">All items</option>
              <option value="RawMaterial">Raw materials</option>
              <option value="FinishedGoods">Finished goods</option>
              <option value="BottlePool">Bottle pool</option>
            </select>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Date</th><th>Item</th><th>Movement</th>
              <th className="num">Quantity</th><th>Reason</th>
              <th className="num">Value</th>
            </tr>
          </thead>
          <tbody>
            {txns.map((t) => (
              <tr key={t.id}>
                <td>{date(t.txn_date)}</td>
                <td>
                  {t.item_name}
                  <div className="muted small">{t.item_type}</div>
                </td>
                <td>
                  <span className={`chip ${t.direction === 'in' ? 'ok' : 'warn'}`}>
                    {t.direction === 'in' ? 'received' : t.direction === 'out' ? 'used' : 'moved'}
                  </span>
                </td>
                <td className="num">{Number(t.quantity)}</td>
                <td className="small">
                  {t.reference_type}
                  {t.notes && <div className="muted">{t.notes}</div>}
                </td>
                <td className="num">
                  {t.total_cost_cents === null
                    ? <span className="muted">—</span>
                    : money(Number(t.total_cost_cents))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {txns.length === 0 && <p className="muted">No stock movements recorded yet.</p>}
      </div>
    </>
  );
}
