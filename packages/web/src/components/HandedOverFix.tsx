import { useEffect, useState } from 'react';
import { api, getSession } from '../lib/api';
import { todayInJamaica } from '../lib/format';

/**
 * Correct what a delivered stop handed over (Everton, 19 Nov 2026): the
 * driver pressed Delivered for a whole order when part of it stayed on the
 * truck. Used on the stop page and on the round's settlement.
 *
 * Saving rebuilds the stop's invoice from what went out, puts goods back on
 * the shelf when the round had no truck loading, moves the full 5-gallon
 * bottles out with the 5-gallon lines, and sends the rest out on the day
 * chosen as "Rest of order". Office staff apply it at once until the round is
 * settled; after that it goes to an administrator.
 */

interface Line {
  order_line_id: string;
  product_name: string;
  bottles_per_case: number;
  /** What this stop could hand over: ordered, less other stops of the order. */
  cases: number;
  loose_bottles: number;
  is_bottle_charge?: boolean;
}
interface StopDetail {
  id: string;
  stop_outcome: string;
  sheet_date?: string | null;
  sheet_status?: string;
  settled_at?: string | null;
  lines: Line[];
  recordedLines?: Array<{ order_line_id: string; cases: number; loose_bottles: number }>;
}

const nextDay = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** The rest goes out after the round's day, and never in the past. */
function earliestRest(s: StopDetail): string {
  const today = todayInJamaica();
  const afterRound = s.sheet_date ? nextDay(String(s.sheet_date).slice(0, 10)) : today;
  return afterRound > today ? afterRound : today;
}

export default function HandedOverFix({ stopId, onDone, onCancel }: {
  stopId: string;
  onDone: (message: string) => void;
  onCancel?: () => void;
}) {
  const isAdmin = getSession()?.role === 'admin';
  const [stop, setStop] = useState<StopDetail | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [restOn, setRestOn] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<StopDetail>(`/api/stops/${stopId}`).then((s) => {
      setStop(s);
      const rec = new Map((s.recordedLines ?? []).map((r) => [r.order_line_id, r]));
      setQty(Object.fromEntries(s.lines.filter((l) => !l.is_bottle_charge).map((l) => {
        const r = rec.get(l.order_line_id);
        return [l.order_line_id, String(r ? (l.bottles_per_case > 0 ? Number(r.cases) : Number(r.loose_bottles)) : 0)];
      })));
      setRestOn(earliestRest(s));
    }).catch((e) => setError(e instanceof Error ? e.message : 'Could not load the stop'));
  }, [stopId]);

  if (error && !stop) return <div className="notice error">{error}</div>;
  if (!stop) return <p className="muted small">Loading…</p>;

  const settled = !!stop.settled_at || (stop.sheet_status ?? 'Open') !== 'Open';
  const appliesNow = isAdmin || !settled;
  const goods = stop.lines.filter((l) => !l.is_bottle_charge);
  const most = (l: Line) => (l.bottles_per_case > 0 ? Number(l.cases) : Number(l.loose_bottles));
  const entered = (l: Line) => Math.max(0, Math.round(Number(qty[l.order_line_id] ?? 0) || 0));
  const tooMany = goods.some((l) => entered(l) > most(l));
  const short = goods.some((l) => entered(l) < most(l));
  const nothing = goods.every((l) => entered(l) === 0);
  const minRest = earliestRest(stop);

  async function save() {
    setBusy(true); setError(null);
    try {
      const out = await api.post<{ applied: boolean }>(`/api/stops/${stopId}/correct`, {
        changes: {
          deliveredLines: goods.map((l) => (l.bottles_per_case > 0
            ? { orderLineId: l.order_line_id, cases: entered(l), looseBottles: 0 }
            : { orderLineId: l.order_line_id, cases: 0, looseBottles: entered(l) })),
          ...(short ? { restOn } : {}),
        },
        reason,
      });
      onDone(out.applied
        ? `What was handed over is corrected. The invoice, stock and bottles follow${short ? ', and the rest goes out on the day chosen' : ''}.`
        : 'Sent to an administrator to approve; nothing changes until they do.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the correction');
    } finally { setBusy(false); }
  }

  return (
    <div className="handed-over-fix">
      <h3 style={{ margin: '0 0 4px' }}>What was handed over</h3>
      <p className="muted small" style={{ marginTop: 0 }}>
        For when the driver recorded the whole order but part of it stayed behind (or the other way round).
        The invoice is rebuilt from what went out, goods not handed over go back on the shelf (on a loaded round
        they come back with the truck), and the full 5-gallons out follow the 5-gallon line.{' '}
        {appliesNow ? 'Your correction applies at once.' : 'The round is settled, so your correction goes to an administrator to approve.'}
      </p>
      {error && <div className="notice error">{error}</div>}
      <table>
        <thead><tr><th>Product</th><th className="num">Handed over</th><th className="num">Of</th></tr></thead>
        <tbody>
          {goods.map((l) => (
            <tr key={l.order_line_id}>
              <td>{l.product_name}</td>
              <td className="num">
                <input type="number" min="0" max={most(l)} inputMode="numeric" style={{ width: 80 }}
                       aria-label={`Handed over, ${l.product_name}`}
                       value={qty[l.order_line_id] ?? ''} disabled={busy}
                       onChange={(e) => setQty({ ...qty, [l.order_line_id]: e.target.value })} />
              </td>
              <td className="num small">{most(l)}{l.bottles_per_case > 0 ? ' cs' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {tooMany && <div className="notice error small">One line is more than the order has left for this stop.</div>}
      {nothing && <div className="notice warn small">Nothing handed over at all: if nothing went, an administrator uses Undo — delivered in error on the order instead.</div>}
      {short && !tooMany && !nothing && (
        <div className="field" style={{ marginTop: 8 }}>
          <label htmlFor={`rest-${stopId}`}>The rest goes out on</label>
          <input id={`rest-${stopId}`} type="date" min={minRest} value={restOn} disabled={busy}
                 onChange={(e) => setRestOn(e.target.value)} />
          <div className="muted small">It goes on that day's round as "Rest of order", invoiced when it is delivered.
            A customer with no delivery zone has it waiting for that day: add it to a round by hand.</div>
        </div>
      )}
      <div className="field">
        <label htmlFor={`why-${stopId}`}>Why (required)</label>
        <input id={`why-${stopId}`} style={{ width: '100%', boxSizing: 'border-box' }} value={reason} disabled={busy}
               placeholder="e.g. driver pressed Delivered; the 2 cases stayed on the truck"
               onChange={(e) => setReason(e.target.value)} />
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" disabled={busy || !reason.trim() || tooMany || nothing || (short && !restOn)} onClick={save}>
          {busy ? 'Saving…' : appliesNow ? 'Save what was handed over' : 'Send for approval'}
        </button>
        {onCancel && <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Close</button>}
      </div>
    </div>
  );
}
