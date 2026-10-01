import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { money, todayInJamaica, when } from '../lib/format';
import { downloadCsv, dollars } from '../lib/csv';

/**
 * Stock on hand (team feedback, 1 Oct 2026, point 20).
 *
 * Finished goods the way they sit on the floor: full cases, then the loose
 * bottles left from a run (which go into the next case run). Raw materials as
 * plain units, with how many cases each would make. Every movement below,
 * including what each delivery and counter sale took off.
 */

interface Snapshot {
  finishedGoods: Array<{
    productId: string; name: string; size: string | null; bottlesPerCase: number; bottles: number;
    cases: number | null; loose: number; isReturnable: boolean; lastCounted: string | null;
  }>;
  rawMaterials: Array<{
    id: string; name: string; unit: string; onHand: number; category: string | null;
    reorderPoint: number | null; lastCounted: string | null;
    makes: Array<{ productId: string; productName: string; perCase: number; cases: number; unit: string }>;
  }>;
}
interface Pool {
  label: string; clean_ready: number; filled_with_customer: number;
  returned_dirty: number; lost_damaged: number; in_circulation: number;
}
interface Txn {
  id: string; item_type: string; item_name: string; quantity: number;
  direction: string; reference: string | null; reference_type: string;
  txn_day: string; total_cost_cents: number | null; notes: string | null;
}

const WHY: Record<string, string> = {
  PurchaseOrder: 'Received from a supplier', ProductionBatch: 'Production run', Sale: 'Sold / delivered',
  CustomerOrder: 'Out to a customer', BottleReturn: 'Empties back', BottleWash: 'Washed', Adjustment: 'Stock count or correction',
  Manual: 'Entered by hand',
};

export default function Stock() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [pool, setPool] = useState<Pool[]>([]);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Snapshot>('/api/stock/snapshot').then(setSnap).catch((e) => setError(e.message));
    api.get<Pool[]>('/api/reports/bottle-pool').then(setPool).catch(() => {});
  }, []);

  useEffect(() => {
    const q = filter ? `?itemType=${filter}&limit=300` : '?limit=300';
    api.get<Txn[]>(`/api/inventory-transactions${q}`).then(setTxns).catch(() => {});
  }, [filter]);

  const categories = [...new Set((snap?.rawMaterials ?? []).map((m) => m.category ?? 'Other'))];

  function exportStock() {
    if (!snap) return;
    downloadCsv(`stock-on-hand-${todayInJamaica()}`, [
      ['Finished goods'],
      ['Product', 'Size', 'Bottles a case', 'Full cases', 'Loose bottles', 'Total bottles', 'Last counted'],
      ...snap.finishedGoods.map((g) => [g.name, g.size ?? '', g.bottlesPerCase || '', g.cases ?? '', g.loose, g.bottles, g.lastCounted ?? '']),
      [],
      ['Raw materials'],
      ['Material', 'Category', 'Unit', 'On hand', 'Reorder at', 'Would make', 'Last counted'],
      ...snap.rawMaterials.map((m) => [m.name, m.category ?? '', m.unit, m.onHand, m.reorderPoint ?? '',
        m.makes.map((x) => `${x.cases} ${x.unit} of ${x.productName}`).join('; '), m.lastCounted ?? '']),
    ]);
  }

  return (
    <>
      <div className="panel-head record-head">
        <div>
          <h1>Stock on hand</h1>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            Finished goods in cases and loose bottles, raw materials in units, and every movement.
          </p>
        </div>
        <div className="record-actions">
          <Link to="/stock-count"><button type="button">Count stock</button></Link>
          <button type="button" className="secondary" disabled={!snap} onClick={exportStock}>Export to Excel</button>
        </div>
      </div>
      {error && <div className="notice error">{error}</div>}

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Finished goods</h2>
        <table>
          <thead>
            <tr>
              <th>Product</th><th className="num">Full cases</th><th className="num">Loose bottles</th>
              <th className="num">In bottles</th><th>Last counted</th>
            </tr>
          </thead>
          <tbody>
            {(snap?.finishedGoods ?? []).map((g) => (
              <tr key={g.productId}>
                <td>{g.name}{g.size ? <span className="muted small"> · {g.size}</span> : null}
                  {g.bottlesPerCase > 0 && <div className="muted small">{g.bottlesPerCase} to a case</div>}</td>
                <td className="num"><strong>{g.cases === null ? '—' : g.cases}</strong></td>
                <td className="num">{g.bottlesPerCase > 0 ? (g.loose || '—') : <strong>{g.loose}</strong>}</td>
                <td className="num muted">{g.bottles < 0 ? <span className="chip bad">{g.bottles}</span> : g.bottles}</td>
                <td className="small">{g.lastCounted ? when(g.lastCounted) : <span className="muted">never</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Loose bottles are those left over from a production run; they go into the next case run.
          Production adds to these figures, and every delivery, collection and counter sale takes off what
          left. A figure below zero means more went out than was recorded as made: count it.
        </p>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Raw materials</h2>
        <table>
          <thead>
            <tr><th>Material</th><th className="num">On hand</th><th>Would make</th><th className="num">Reorder at</th><th>Last counted</th></tr>
          </thead>
          <tbody>
            {categories.map((cat) => (
              <Fragment key={cat}>
                <tr className="group-row"><td colSpan={5}><strong>{cat}</strong></td></tr>
                {(snap?.rawMaterials ?? []).filter((m) => (m.category ?? 'Other') === cat).map((m) => {
                  const low = m.reorderPoint !== null && m.onHand <= m.reorderPoint && m.reorderPoint > 0;
                  return (
                    <tr key={m.id}>
                      <td>{m.name}</td>
                      <td className="num"><strong>{Number(m.onHand).toLocaleString()}</strong> <span className="muted small">{m.unit}</span></td>
                      <td className="small">
                        {m.makes.length === 0 ? <span className="muted">not in a bill of materials</span>
                          : m.makes.map((x) => (
                            <div key={x.productId}>{x.cases.toLocaleString()} {x.unit} of {x.productName.replace(/^Alka Vida\s+/i, '')}</div>
                          ))}
                      </td>
                      <td className="num">{m.reorderPoint ? <span className={low ? 'chip warn' : ''}>{m.reorderPoint}</span> : '—'}</td>
                      <td className="small">{m.lastCounted ? when(m.lastCounted) : <span className="muted">never</span>}</td>
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>5-gallon bottle pool</h2>
          <Link className="small" to="/bottle-pool">Bottle pool, and how it is worked out</Link>
        </div>
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
                <td className="num"><span className="chip warn">{Number(p.lost_damaged)}</span></td>
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
          <div className="row" style={{ gap: 8 }}>
            <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Which items">
              <option value="">All items</option>
              <option value="RawMaterial">Raw materials</option>
              <option value="FinishedGoods">Finished goods</option>
              <option value="BottlePool">Bottle pool</option>
            </select>
            <button type="button" className="secondary" disabled={txns.length === 0} onClick={() => downloadCsv(
              `stock-movements-${todayInJamaica()}`,
              [['Date', 'Item', 'Kind', 'In / out', 'Quantity', 'Why', 'Reference', 'Note', 'Value'],
                ...txns.map((t) => [t.txn_day, t.item_name, t.item_type, t.direction, Number(t.quantity),
                  WHY[t.reference_type] ?? t.reference_type, t.reference ?? '', t.notes ?? '', dollars(t.total_cost_cents)])],
            )}>Export</button>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Date</th><th>Item</th><th>Movement</th>
              <th className="num">Quantity</th><th>Why</th>
              <th className="num">Value</th>
            </tr>
          </thead>
          <tbody>
            {txns.map((t) => (
              <tr key={t.id}>
                <td>{when(t.txn_day)}</td>
                <td>
                  {t.item_name}
                  <div className="muted small">{t.item_type === 'RawMaterial' ? 'raw material' : t.item_type === 'FinishedGoods' ? 'finished goods' : 'bottle pool'}</div>
                </td>
                <td>
                  <span className={`chip ${t.direction === 'in' ? 'ok' : 'warn'}`}>
                    {t.direction === 'in' ? 'in' : t.direction === 'out' ? 'out' : 'moved'}
                  </span>
                </td>
                <td className="num">{Number(t.quantity)}</td>
                <td className="small">
                  {WHY[t.reference_type] ?? t.reference_type}{t.reference ? ` · ${t.reference}` : ''}
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
