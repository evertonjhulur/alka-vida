import { useEffect, useState } from 'react';
import { api, type Session } from '../lib/api';
import { money, date } from '../lib/format';

interface Material { id: string; name: string; quantity_on_hand: number; unit_of_measure: string }
interface FinishedGood { product_id: string; name: string; bottles_on_hand: number }

interface Audit {
  id: string; audit_date: string; item_type: string; item_name: string;
  system_qty: number; counted_qty: number; damaged_qty: number;
  discrepancy: number; status: string; notes: string | null;
}

export default function StockCount({ session }: { session: Session }) {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [goods, setGoods] = useState<FinishedGood[]>([]);
  const [audits, setAudits] = useState<Audit[]>([]);
  const [itemType, setItemType] = useState<'RawMaterial' | 'FinishedGoods'>('RawMaterial');
  const [itemId, setItemId] = useState('');
  const [counted, setCounted] = useState('');
  const [damaged, setDamaged] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setMaterials(await api.get<Material[]>('/api/raw-materials'));
    setGoods(await api.get<FinishedGood[]>('/api/finished-goods'));
    setAudits(await api.get<Audit[]>('/api/audits'));
  }
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  const systemQty = itemType === 'RawMaterial'
    ? Number(materials.find((m) => m.id === itemId)?.quantity_on_hand ?? 0)
    : Number(goods.find((g) => g.product_id === itemId)?.bottles_on_hand ?? 0);

  const usable = (Number(counted) || 0) - (Number(damaged) || 0);
  const discrepancy = itemId ? usable - systemQty : 0;

  async function submitCount(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setMsg(null);
    try {
      await api.post('/api/audits', {
        itemType, itemId,
        countedQty: Number(counted) || 0,
        damagedQty: Number(damaged) || 0,
        notes: notes || null,
      });
      setMsg('Count recorded. Stock has NOT changed yet — an administrator must reconcile it.');
      setCounted(''); setDamaged(''); setNotes(''); setItemId('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the count');
    } finally { setBusy(false); }
  }

  async function reconcile(id: string) {
    const why = window.prompt('Note for this adjustment (optional)') ?? undefined;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ adjusted: number; valueCents: number }>(
        `/api/audits/${id}/reconcile`, { notes: why },
      );
      setMsg(
        r.adjusted === 0
          ? 'Count matched the system. Nothing to adjust.'
          : `Stock adjusted by ${r.adjusted > 0 ? '+' : ''}${r.adjusted}, ` +
            `valued at ${money(r.valueCents)}.`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reconcile');
    } finally { setBusy(false); }
  }

  return (
    <>
      <h1>Stock count</h1>
      <p className="subtitle">
        Count what is physically there. Nothing moves until the count is reconciled,
        so a miscount can be corrected first.
      </p>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Record a count</h2>
        <form onSubmit={submitCount}>
          <div className="row">
            <div className="field">
              <label htmlFor="t">What are you counting?</label>
              <select id="t" value={itemType}
                      onChange={(e) => {
                        setItemType(e.target.value as 'RawMaterial' | 'FinishedGoods');
                        setItemId('');
                      }}>
                <option value="RawMaterial">Raw material</option>
                <option value="FinishedGoods">Finished goods</option>
              </select>
            </div>

            <div className="field" style={{ flex: '1 1 240px' }}>
              <label htmlFor="i">Item</label>
              <select id="i" required value={itemId} style={{ width: '100%' }}
                      onChange={(e) => setItemId(e.target.value)}>
                <option value="">Select…</option>
                {itemType === 'RawMaterial'
                  ? materials.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)
                  : goods.map((g) => (
                      <option key={g.product_id} value={g.product_id}>{g.name}</option>
                    ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="c">Total counted</label>
              <input id="c" type="number" min="0" required style={{ width: 130 }} value={counted}
                     onChange={(e) => setCounted(e.target.value)} />
            </div>

            <div className="field">
              <label htmlFor="d">Of those, damaged</label>
              <input id="d" type="number" min="0" style={{ width: 140 }} value={damaged}
                     onChange={(e) => setDamaged(e.target.value)} />
            </div>
          </div>

          {itemId && (
            <div style={{ maxWidth: 340 }}>
              <div className="total-line">
                <span>System says</span><span>{systemQty}</span>
              </div>
              <div className="total-line">
                <span>Usable counted</span><span>{usable}</span>
              </div>
              <div className="total-line grand">
                <span>Difference</span>
                <span>
                  {discrepancy === 0
                    ? <span className="chip ok">matches</span>
                    : <span className={`chip ${discrepancy < 0 ? 'bad' : 'warn'}`}>
                        {discrepancy > 0 ? '+' : ''}{discrepancy}
                      </span>}
                </span>
              </div>
            </div>
          )}

          <div className="field" style={{ marginTop: 10 }}>
            <label htmlFor="n">Notes</label>
            <textarea id="n" rows={2} style={{ width: '100%' }} value={notes}
                      onChange={(e) => setNotes(e.target.value)} />
          </div>

          <button disabled={busy || !itemId}>Record count</button>
        </form>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Counts</h2>
        {session.role !== 'admin' && (
          <div className="notice info">
            Counts can be recorded by anyone in the office, but only an administrator
            can apply one to stock — it writes off real value.
          </div>
        )}
        <table>
          <thead>
            <tr>
              <th>Date</th><th>Item</th><th className="num">System</th>
              <th className="num">Counted</th><th className="num">Damaged</th>
              <th className="num">Difference</th><th>Status</th>
              {session.role === 'admin' && <th />}
            </tr>
          </thead>
          <tbody>
            {audits.map((a) => (
              <tr key={a.id}>
                <td>{date(a.audit_date)}</td>
                <td>
                  {a.item_name}
                  <div className="muted small">
                    {a.item_type === 'RawMaterial' ? 'raw material' : 'finished goods'}
                  </div>
                </td>
                <td className="num">{Number(a.system_qty)}</td>
                <td className="num">{Number(a.counted_qty)}</td>
                <td className="num">{Number(a.damaged_qty) || '—'}</td>
                <td className="num">
                  {Number(a.discrepancy) === 0
                    ? <span className="muted">—</span>
                    : <span className={`chip ${Number(a.discrepancy) < 0 ? 'bad' : 'warn'}`}>
                        {Number(a.discrepancy) > 0 ? '+' : ''}{Number(a.discrepancy)}
                      </span>}
                </td>
                <td>
                  <span className={`chip ${a.status === 'Reconciled' ? 'ok' : 'neutral'}`}>
                    {a.status}
                  </span>
                </td>
                {session.role === 'admin' && (
                  <td className="num">
                    {a.status === 'Open' && (
                      <button disabled={busy} onClick={() => reconcile(a.id)}>
                        Apply to stock
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {audits.length === 0 && <p className="muted">No counts recorded yet.</p>}
      </div>
    </>
  );
}
