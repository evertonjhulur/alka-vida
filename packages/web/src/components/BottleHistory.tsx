import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { todayInJamaica, when } from '../lib/format';
import { downloadCsv } from '../lib/csv';

/**
 * A customer's 5-gallon bottle movement, line by line, and the way to correct
 * their balance (Everton, 20 Nov 2026): "Can I see the bottle movement per
 * client under their bottle details? also ability to edit their bottle
 * balance if needs be?"
 *
 * Every line that moved the count of OUR bottles they hold - the opening
 * balance, deliveries on a round, counter sales and collected orders, empties
 * collected, jugs they bought, and adjustments - with the running balance,
 * newest first. Administrators can set what they actually have; the
 * difference goes in as an adjustment with a reason, and can be removed if it
 * was entered in error.
 */

export interface BottleMove {
  source: 'stop' | 'move';
  id: string;
  day: string;
  kind: 'Opening' | 'Delivery' | 'Counter' | 'Collection' | 'Bought' | 'Adjustment' | 'Other';
  what: string;
  detail: string | null;
  orderId: string | null;
  orderNumber: string | null;
  delivered: number; returned: number; lost: number; sold: number;
  change: number;
  balance: number;
  by: string | null;
}

const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');
const FIRST = 25;

export default function BottleHistory({ customerId, customerName, isAdmin, held, version, onChanged }: {
  customerId: string;
  customerName: string;
  isAdmin: boolean;
  /** Ours with them now, from the summary above. */
  held: number;
  /** Bump to reload (after a jug sale or opening balance change). */
  version: number;
  onChanged: () => void;
}) {
  const [moves, setMoves] = useState<BottleMove[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Adjust form
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState('');
  const [asOf, setAsOf] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  // Removing an adjustment
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeWhy, setRemoveWhy] = useState('');

  async function load() {
    try {
      setMoves(await api.get<BottleMove[]>(`/api/customers/${customerId}/bottle-moves`));
      setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load the bottle history'); }
  }
  useEffect(() => { load(); }, [customerId, version]); // eslint-disable-line react-hooks/exhaustive-deps

  function start() {
    setQty(String(held)); setAsOf(todayInJamaica()); setReason('');
    setFormErr(null); setMsg(null); setOpen(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setFormErr(null);
    try {
      const r = await api.post<{ was: number; now: number; change: number; asOf: string }>(
        `/api/customers/${customerId}/bottle-adjustments`, { holding: Number(qty), asOf, reason });
      setMsg(r.change === 0
        ? `Nothing to change: ${r.now} already on record as at ${when(r.asOf)}.`
        : `Balance adjusted from ${r.was} to ${r.now} (${signed(r.change)}) as at ${when(r.asOf)}.`);
      setOpen(false);
      await load(); onChanged();
    } catch (e2) {
      setFormErr(e2 instanceof Error ? e2.message : 'Could not adjust the balance');
    } finally { setBusy(false); }
  }

  async function remove(id: string) {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ removed: number }>(
        `/api/customers/${customerId}/bottle-adjustments/${id}/remove`, { reason: removeWhy });
      setMsg(`Adjustment of ${signed(r.removed)} removed.`);
      setRemoving(null); setRemoveWhy('');
      await load(); onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not remove the adjustment');
    } finally { setBusy(false); }
  }

  const newest = moves ? [...moves].reverse() : [];
  const shown = all ? newest : newest.slice(0, FIRST);
  const change = qty === '' ? 0 : Number(qty) - held;

  function exportList() {
    downloadCsv(`bottles-${customerName.replace(/[^\w-]+/g, '-').toLowerCase()}-${todayInJamaica()}`, [
      ['Date', 'What', 'Details', 'Order', 'Full out', 'Empties back', 'Lost', 'Bought', 'Change', 'Ours with them', 'By'],
      ...(moves ?? []).map((m) => [
        m.day, m.what, m.detail, m.orderNumber, m.delivered || '', m.returned || '', m.lost || '', m.sold || '',
        m.change, m.balance, m.by,
      ]),
    ]);
  }

  return (
    <div style={{ marginTop: 18 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 style={{ margin: 0 }}>Bottle movement</h3>
        <div className="row" style={{ gap: 8 }}>
          {moves && moves.length > 0 && (
            <button type="button" className="secondary" onClick={exportList}>Export to Excel</button>
          )}
          {isAdmin && !open && (
            <button type="button" className="secondary" onClick={start}>Adjust balance</button>
          )}
        </div>
      </div>

      {msg && <div className="notice ok" style={{ marginTop: 8 }}>{msg}</div>}
      {err && <div className="notice error" style={{ marginTop: 8 }}>{err}</div>}

      {open && (
        <form onSubmit={save} className="panel" style={{ marginTop: 8 }}>
          <p className="muted small" style={{ marginTop: 0 }}>
            How many of <strong>our</strong> bottles they actually have. The difference from the {held} on
            record goes in as an adjustment with your reason. Leave out bottles they own. This does not move the
            empties at the plant (count those on Stock › Count).
          </p>
          <div className="row">
            <div className="field">
              <label htmlFor="ba-q">They actually have</label>
              <input id="ba-q" type="number" min="0" step="1" style={{ width: 120 }} value={qty}
                     onChange={(e) => setQty(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="ba-d">As at</label>
              <input id="ba-d" type="date" value={asOf} max={todayInJamaica()}
                     onChange={(e) => setAsOf(e.target.value)} required />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 220 }}>
              <label htmlFor="ba-r">Reason</label>
              <input id="ba-r" value={reason} placeholder="e.g. Driver counted 6 at their office"
                     onChange={(e) => setReason(e.target.value)} required />
            </div>
          </div>
          {qty !== '' && Number.isInteger(Number(qty)) && asOf === todayInJamaica() && (
            <p className="small" style={{ marginTop: 0 }}>
              {change === 0 ? 'Same as on record: nothing will change.'
                : <>Records an adjustment of <strong>{signed(change)}</strong> ({held} → {qty}).</>}
            </p>
          )}
          {formErr && <div className="notice error">{formErr}</div>}
          <div className="row" style={{ gap: 8 }}>
            <button className="go" disabled={busy || qty === '' || !reason.trim()}>Save adjustment</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}

      {moves === null && !err && <p className="muted small">Loading…</p>}
      {moves && moves.length === 0 && <p className="muted small">No bottle movements recorded yet.</p>}
      {moves && moves.length > 0 && (
        <>
          <table style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>Date</th><th>What</th><th>Order</th>
                <th className="num">Full out</th><th className="num">Empties back</th>
                <th className="num">Change</th><th className="num">Ours with them</th>
                {isAdmin && <th />}
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => (
                <tr key={`${m.source}-${m.id}`}>
                  <td>{when(m.day)}</td>
                  <td>
                    {m.kind === 'Adjustment' ? <strong>{m.what}</strong> : m.what}
                    {m.lost > 0 && <span className="muted"> · {m.lost} lost or damaged</span>}
                    {m.sold > 0 && <span className="muted"> · {m.sold} bought</span>}
                    {(m.detail || m.by) && (
                      <div className="muted small">
                        {m.detail}{m.detail && m.by ? ' · ' : ''}{m.by ? `by ${m.by}` : ''}
                      </div>
                    )}
                    {removing === m.id && (
                      <div className="row" style={{ gap: 6, marginTop: 6 }}>
                        <input value={removeWhy} placeholder="Why (optional)" style={{ flex: 1, minWidth: 160 }}
                               onChange={(e) => setRemoveWhy(e.target.value)} />
                        <button type="button" className="danger-soft" disabled={busy} onClick={() => remove(m.id)}>
                          Remove
                        </button>
                        <button type="button" className="secondary" disabled={busy}
                                onClick={() => { setRemoving(null); setRemoveWhy(''); }}>Keep</button>
                      </div>
                    )}
                  </td>
                  <td>
                    {m.orderNumber
                      ? <Link to={`/orders?find=${m.orderNumber}`}>{m.orderNumber}</Link>
                      : <span className="muted">—</span>}
                  </td>
                  <td className="num">{m.delivered || ''}</td>
                  <td className="num">{m.returned || ''}</td>
                  <td className="num">{signed(m.change)}</td>
                  <td className="num"><strong>{m.balance}</strong></td>
                  {isAdmin && (
                    <td className="num">
                      {m.kind === 'Adjustment' && removing !== m.id && (
                        <button type="button" className="as-link small" style={{ color: 'var(--bad)' }}
                                onClick={() => { setRemoving(m.id); setRemoveWhy(''); setMsg(null); }}>
                          Remove
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {newest.length > FIRST && (
            <button type="button" className="as-link small" style={{ marginTop: 6 }} onClick={() => setAll(!all)}>
              {all ? `Show the latest ${FIRST}` : `Show all ${newest.length} lines`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
