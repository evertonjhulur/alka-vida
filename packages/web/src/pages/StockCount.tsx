import { useEffect, useState } from 'react';
import { api, type Session } from '../lib/api';
import { date, todayInJamaica, when } from '../lib/format';
import { downloadCsv } from '../lib/csv';
import { ask, askText } from '../components/Dialog';

/**
 * Stock count (team feedback, 1 Oct 2026, point 20).
 *
 * One count sheet for everything: finished goods counted as full cases plus
 * loose bottles, raw materials in units. Type what is on the floor against
 * any line; the difference shows as you type, and any line that is out must
 * say why before it saves. Nothing changes stock until an administrator
 * applies the count. The variance report downloads the counts with their
 * differences and explanations.
 */

interface Snapshot {
  finishedGoods: Array<{
    productId: string; name: string; bottlesPerCase: number; bottles: number; cases: number | null; loose: number;
  }>;
  rawMaterials: Array<{ id: string; name: string; unit: string; onHand: number; category: string | null;
    makes: Array<{ productName: string; perCase: number; unit: string }> }>;
}

interface Audit {
  id: string; audit_date: string; item_type: string; item_name: string;
  system_qty: number; counted_qty: number; damaged_qty: number;
  discrepancy: number; status: string; notes: string | null;
  counted_cases: number | null; counted_loose: number | null; bottles_per_case: number | null;
  unit_of_measure: string | null; counted_by: string | null; reconciled_by: string | null; reconciled_at: string | null;
}

interface Movements {
  countedAt: string;
  netChange: number;
  movements: Array<{ at: string; direction: string; quantity: number; what: string }>;
}

/** A confirm the server refused because the count had gone stale. */
interface Blocked { auditId: string; message: string; movements: Movements | null }

/** What has been typed against one line of the sheet. */
interface Entry { cases: string; loose: string; units: string; damaged: string; note: string }
const BLANK: Entry = { cases: '', loose: '', units: '', damaged: '', note: '' };

/** "120 cs + 7" for a finished-goods figure in bottles. */
const asCases = (bottles: number, bpc: number | null | undefined) => {
  const n = Number(bottles);
  if (!bpc || bpc <= 0) return `${n}`;
  const sign = n < 0 ? '−' : '';
  const a = Math.abs(n);
  const c = Math.floor(a / bpc); const l = a % bpc;
  return `${sign}${c} cs${l ? ` + ${l}` : ''}`;
};

export default function StockCount({ session }: { session: Session }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [audits, setAudits] = useState<Audit[]>([]);
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  const [show, setShow] = useState<'FinishedGoods' | 'RawMaterial'>('FinishedGoods');
  const [range, setRange] = useState({ from: '', to: '' });
  const [problems, setProblems] = useState<Record<string, string>>({});

  async function load() {
    setSnap(await api.get<Snapshot>('/api/stock/snapshot'));
    const q = new URLSearchParams();
    if (range.from) q.set('from', range.from);
    if (range.to) q.set('to', range.to);
    setAudits(await api.get<Audit[]>(`/api/audits?${q.toString()}`));
  }
  useEffect(() => { load().catch((e) => setError(e.message)); }, [range.from, range.to]); // eslint-disable-line react-hooks/exhaustive-deps

  const entry = (id: string) => entries[id] ?? BLANK;
  const setEntry = (id: string, patch: Partial<Entry>) => setEntries({ ...entries, [id]: { ...entry(id), ...patch } });

  /** Counted, usable and the difference for a line, or null if nothing typed. */
  const figure = (kind: 'FinishedGoods' | 'RawMaterial', id: string) => {
    const e = entry(id);
    if (kind === 'FinishedGoods') {
      const g = snap!.finishedGoods.find((x) => x.productId === id)!;
      if (e.cases === '' && e.loose === '') return null;
      const counted = g.bottlesPerCase > 0 ? (Number(e.cases) || 0) * g.bottlesPerCase + (Number(e.loose) || 0)
        : (Number(e.loose) || 0) + (Number(e.cases) || 0);
      const usable = counted - (Number(e.damaged) || 0);
      return { counted, diff: usable - g.bottles };
    }
    const m = snap!.rawMaterials.find((x) => x.id === id)!;
    if (e.units === '') return null;
    const counted = Number(e.units) || 0;
    const usable = counted - (Number(e.damaged) || 0);
    return { counted, diff: Math.round((usable - m.onHand) * 1000) / 1000 };
  };

  const typed = snap ? [
    ...snap.finishedGoods.filter((g) => figure('FinishedGoods', g.productId)).map((g) => ({ kind: 'FinishedGoods' as const, id: g.productId })),
    ...snap.rawMaterials.filter((m) => figure('RawMaterial', m.id)).map((m) => ({ kind: 'RawMaterial' as const, id: m.id })),
  ] : [];
  const unexplained = typed.filter((t) => figure(t.kind, t.id)!.diff !== 0 && !entry(t.id).note.trim());

  async function saveSheet() {
    setBusy(true); setError(null); setMsg(null); setProblems({});
    try {
      const counts = typed.map((t) => {
        const e = entry(t.id);
        return t.kind === 'FinishedGoods'
          ? { itemType: t.kind, itemId: t.id, countedCases: Number(e.cases) || 0, countedLoose: Number(e.loose) || 0,
              damagedQty: Number(e.damaged) || 0, notes: e.note || null }
          : { itemType: t.kind, itemId: t.id, countedQty: Number(e.units) || 0,
              damagedQty: Number(e.damaged) || 0, notes: e.note || null };
      });
      const r = await api.post<{ saved: Array<{ itemId: string }>; problems: Array<{ itemId: string; message: string }> }>(
        '/api/audits/batch', { counts });
      const left: Record<string, Entry> = {};
      for (const p of r.problems) left[p.itemId] = entry(p.itemId);
      setEntries(left);
      setProblems(Object.fromEntries(r.problems.map((p) => [p.itemId, p.message])));
      setMsg(`${r.saved.length} count${r.saved.length === 1 ? '' : 's'} saved. Stock has NOT changed yet — `
        + `${session.role === 'admin' ? 'apply them below' : 'an administrator applies them'} once checked.`
        + (r.problems.length ? ` ${r.problems.length} could not be saved; see the lines marked.` : ''));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the counts');
    } finally { setBusy(false); }
  }

  /**
   * Confirm a count. Refused by the server when stock moved after the count
   * was taken, because confirming writes the counted figure outright; the
   * movements are then shown and it can be applied over them deliberately.
   */
  async function reconcile(id: string, evenThoughStockMoved = false) {
    const note = await askText('Apply this count?\n\nStock will be set to what was counted.', { label: 'Note for this adjustment (optional)', confirmLabel: 'Apply count' });
    if (note === null) return;
    const why = note.trim() || undefined;
    setBusy(true); setError(null); setBlocked(null);
    try {
      const r = await api.post<{ adjusted: number; valueCents: number; overrodeMovements: boolean }>(
        `/api/audits/${id}/reconcile`, { notes: why, evenThoughStockMoved });
      setMsg((r.adjusted === 0 ? 'Count matched the system. Nothing to adjust.'
        : `Stock adjusted by ${r.adjusted > 0 ? '+' : ''}${r.adjusted}.`)
        + (r.overrodeMovements ? ' Applied over later movements, as instructed.' : ''));
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not apply it';
      if (/moved since this count/.test(message)) {
        const m = await api.get<Movements>(`/api/audits/${id}/movements`).catch(() => null);
        setBlocked({ auditId: id, message, movements: m });
      } else setError(message);
    } finally { setBusy(false); }
  }

  /** The variance report (point 20.3): every count in the range, with its explanation. */
  function downloadReport() {
    downloadCsv(`stock-count-variances${range.from || range.to ? `-${range.from || 'start'}-to-${range.to || todayInJamaica()}` : ''}`, [
      ['Date', 'Item', 'Kind', 'Unit', 'System had', 'Counted', 'Counted (cases + loose)', 'Damaged', 'Difference',
        'Difference (cases + loose)', 'Explanation', 'Counted by', 'Status', 'Applied by', 'Applied on'],
      ...audits.map((a) => {
        const fg = a.item_type === 'FinishedGoods';
        const bpc = Number(a.bottles_per_case) || 0;
        return [
          date(a.audit_date), a.item_name, fg ? 'Finished goods' : 'Raw material',
          fg ? 'bottles' : (a.unit_of_measure ?? ''), Number(a.system_qty), Number(a.counted_qty),
          fg && bpc ? `${a.counted_cases ?? Math.floor(Number(a.counted_qty) / bpc)} cs + ${a.counted_loose ?? Number(a.counted_qty) % bpc}` : '',
          Number(a.damaged_qty), Number(a.discrepancy),
          fg && bpc ? asCases(Number(a.discrepancy), bpc) : '',
          (a.notes ?? '').trim(), a.counted_by ?? '', a.status, a.reconciled_by ?? '',
          a.reconciled_at ? date(a.reconciled_at) : '',
        ];
      }),
    ]);
  }

  const off = audits.filter((a) => Number(a.discrepancy) !== 0);

  return (
    <>
      <h1>Stock count</h1>
      <p className="subtitle">
        Type what is physically there against any line. Nothing moves until the count is applied,
        so a miscount can be put right first.
      </p>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      {blocked && (
        <div className="notice warn">
          <strong>This count is out of date.</strong>
          <p style={{ margin: '6px 0' }}>{blocked.message}</p>
          {blocked.movements && blocked.movements.movements.length > 0 && (
            <>
              <div className="small muted">Counted {when(blocked.movements.countedAt)}. Since then:</div>
              <table style={{ marginTop: 6, marginBottom: 8 }}>
                <thead><tr><th>When</th><th>Movement</th><th className="num">Quantity</th></tr></thead>
                <tbody>
                  {blocked.movements.movements.map((m, i) => (
                    <tr key={i}>
                      <td className="small">{when(m.at)}</td>
                      <td className="small">{m.what}</td>
                      <td className="num">{m.direction === 'out' ? '−' : '+'}{m.quantity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <button className="secondary" disabled={busy}
                  onClick={() => { setBlocked(null); setMsg('Count again to get a fresh figure.'); }}>
            Leave it — I will count again
          </button>{' '}
          <button disabled={busy}
                  onClick={async () => {
                    if (!await ask('Apply this count over the later movements?\n\nDo this only if the floor was counted AFTER those movements happened.',
                      { confirmLabel: 'Use this count' })) return;
                    reconcile(blocked.auditId, true);
                  }}>
            Apply anyway
          </button>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <h2>Count sheet</h2>
          <div className="seg" role="group" aria-label="What to count">
            <button type="button" className={show === 'FinishedGoods' ? 'active' : ''} onClick={() => setShow('FinishedGoods')}>Finished goods</button>
            <button type="button" className={show === 'RawMaterial' ? 'active' : ''} onClick={() => setShow('RawMaterial')}>Raw materials</button>
          </div>
        </div>
        {!snap ? <p className="muted">Loading…</p> : show === 'FinishedGoods' ? (
          <table className="count-sheet">
            <thead>
              <tr><th>Product</th><th className="num">System has</th><th>Full cases</th><th>Loose bottles</th>
                <th>Damaged</th><th className="num">Difference</th><th>Why it is out</th></tr>
            </thead>
            <tbody>
              {snap.finishedGoods.map((g) => {
                const f = figure('FinishedGoods', g.productId);
                const e = entry(g.productId);
                const offBy = f && f.diff !== 0;
                return (
                  <tr key={g.productId} className={offBy ? 'off' : undefined}>
                    <td>{g.name}{problems[g.productId] && <div className="small" style={{ color: 'var(--bad)' }}>{problems[g.productId]}</div>}</td>
                    <td className="num">{asCases(g.bottles, g.bottlesPerCase)}</td>
                    <td>{g.bottlesPerCase > 0
                      ? <input type="number" min="0" aria-label={`${g.name} full cases`} value={e.cases} onChange={(ev) => setEntry(g.productId, { cases: ev.target.value })} />
                      : <span className="muted small">—</span>}</td>
                    <td><input type="number" min="0" aria-label={`${g.name} ${g.bottlesPerCase > 0 ? 'loose bottles' : 'bottles'}`}
                               placeholder={g.bottlesPerCase > 0 ? '' : 'bottles'} value={e.loose}
                               onChange={(ev) => setEntry(g.productId, { loose: ev.target.value })} /></td>
                    <td><input type="number" min="0" aria-label={`${g.name} damaged`} value={e.damaged} onChange={(ev) => setEntry(g.productId, { damaged: ev.target.value })} /></td>
                    <td className="num">{!f ? <span className="muted">—</span> : f.diff === 0 ? <span className="chip ok">matches</span>
                      : <span className={`chip ${f.diff < 0 ? 'bad' : 'warn'}`}>{f.diff > 0 ? '+' : ''}{asCases(f.diff, g.bottlesPerCase)}</span>}</td>
                    <td>{offBy && (
                      <input className="note" aria-label={`Why ${g.name} is out`} required placeholder="Required: why is it out?"
                             value={e.note} onChange={(ev) => setEntry(g.productId, { note: ev.target.value })} />
                    )}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <table className="count-sheet">
            <thead>
              <tr><th>Material</th><th className="num">System has</th><th>Counted</th><th>Damaged</th>
                <th className="num">Difference</th><th>Why it is out</th></tr>
            </thead>
            <tbody>
              {snap.rawMaterials.map((m) => {
                const f = figure('RawMaterial', m.id);
                const e = entry(m.id);
                const offBy = f && f.diff !== 0;
                return (
                  <tr key={m.id} className={offBy ? 'off' : undefined}>
                    <td>{m.name}<div className="muted small">{m.category ?? ''}{m.makes[0] ? ` · ${m.makes[0].perCase} ${m.unit} a ${m.makes[0].unit === 'cases' ? 'case' : 'bottle'} of ${m.makes[0].productName.replace(/^Alka Vida\s+/i, '')}` : ''}</div>
                      {problems[m.id] && <div className="small" style={{ color: 'var(--bad)' }}>{problems[m.id]}</div>}</td>
                    <td className="num">{Number(m.onHand).toLocaleString()} <span className="muted small">{m.unit}</span></td>
                    <td><input type="number" min="0" step="any" aria-label={`${m.name} counted`} value={e.units} onChange={(ev) => setEntry(m.id, { units: ev.target.value })} /></td>
                    <td><input type="number" min="0" step="any" aria-label={`${m.name} damaged`} value={e.damaged} onChange={(ev) => setEntry(m.id, { damaged: ev.target.value })} /></td>
                    <td className="num">{!f ? <span className="muted">—</span> : f.diff === 0 ? <span className="chip ok">matches</span>
                      : <span className={`chip ${f.diff < 0 ? 'bad' : 'warn'}`}>{f.diff > 0 ? '+' : ''}{f.diff}</span>}</td>
                    <td>{offBy && (
                      <input className="note" aria-label={`Why ${m.name} is out`} required placeholder="Required: why is it out?"
                             value={e.note} onChange={(ev) => setEntry(m.id, { note: ev.target.value })} />
                    )}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="pay-foot" style={{ marginTop: 12 }}>
          <span className="small">
            {typed.length === 0 ? 'Type a count against any line.'
              : `${typed.length} line${typed.length === 1 ? '' : 's'} counted`}
            {unexplained.length > 0 && <strong style={{ color: 'var(--bad)' }}> · {unexplained.length} still need a reason</strong>}
          </span>
          <button disabled={busy || typed.length === 0 || unexplained.length > 0} onClick={saveSheet}>
            {busy ? 'Saving…' : `Save ${typed.length || ''} count${typed.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Counts and variances</h2>
          <button type="button" className="secondary" disabled={audits.length === 0} onClick={downloadReport}>
            Download variance report
          </button>
        </div>
        <div className="filter-row" style={{ marginBottom: 10 }}>
          <div className="field">
            <label htmlFor="cf">From</label>
            <input id="cf" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="ct">To</label>
            <input id="ct" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
          </div>
          <span className="muted small">{audits.length} count{audits.length === 1 ? '' : 's'}, {off.length} out</span>
        </div>
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
              <th className="num">Counted</th><th className="num">Difference</th><th>Why</th><th>Status</th>
              {session.role === 'admin' && <th />}
            </tr>
          </thead>
          <tbody>
            {audits.map((a) => {
              const fg = a.item_type === 'FinishedGoods';
              const bpc = Number(a.bottles_per_case) || 0;
              return (
                <tr key={a.id}>
                  <td>{when(a.audit_date)}<div className="muted small">{a.counted_by ?? ''}</div></td>
                  <td>{a.item_name}<div className="muted small">{fg ? 'finished goods' : 'raw material'}</div></td>
                  <td className="num">{fg ? asCases(Number(a.system_qty), bpc) : Number(a.system_qty)}</td>
                  <td className="num">{fg ? asCases(Number(a.counted_qty), bpc) : Number(a.counted_qty)}
                    {Number(a.damaged_qty) > 0 && <div className="muted small">{Number(a.damaged_qty)} damaged</div>}</td>
                  <td className="num">
                    {Number(a.discrepancy) === 0 ? <span className="muted">—</span>
                      : <span className={`chip ${Number(a.discrepancy) < 0 ? 'bad' : 'warn'}`}>
                          {Number(a.discrepancy) > 0 ? '+' : ''}{fg ? asCases(Number(a.discrepancy), bpc) : Number(a.discrepancy)}
                        </span>}
                  </td>
                  <td className="small" style={{ maxWidth: 260, whiteSpace: 'pre-line' }}>{a.notes ?? ''}</td>
                  <td>
                    <span className={`chip ${a.status === 'Reconciled' ? 'ok' : 'neutral'}`}>{a.status === 'Reconciled' ? 'Applied' : 'Not applied'}</span>
                    {a.reconciled_by && <div className="muted small">{a.reconciled_by}</div>}
                  </td>
                  {session.role === 'admin' && (
                    <td className="num">
                      {a.status === 'Open' && (
                        <button disabled={busy} onClick={() => reconcile(a.id)}>Apply to stock</button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        {audits.length === 0 && <p className="muted">No counts {range.from || range.to ? 'in these dates' : 'recorded yet'}.</p>}
      </div>
    </>
  );
}
