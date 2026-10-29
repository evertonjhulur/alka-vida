import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { when } from '../lib/format';
import { ask } from '../components/Dialog';
import { readSheets } from '../lib/sheetfile';
import { readOpeningBottles, type OpeningReadResult } from '../lib/openingBottlesUpload';

/*
 * Opening balances of OUR 5-gallon bottles with customers (Everton,
 * 28 Oct 2026): "I now need to update bottles owned by us on the customer
 * accounts." The workbook comes from the bottle-ownership review of the 2026
 * delivery sheet. Checked first; nothing is saved until "Bring them in".
 * Bringing a file in again replaces each customer's opening balance; 0 removes
 * it. One customer can also be set or corrected on their Bottles tab.
 * Rules: services/bottles.ts (uploadOpeningBottles).
 */

interface RowResult {
  row: number; customer: string; customerId: string | null; matchedName: string | null;
  inactive: boolean; was: number; now: number;
  action: 'set' | 'change' | 'remove' | 'same' | 'error'; errors: string[];
}
interface Result {
  dryRun: boolean; asOf: string; rows: RowResult[]; withErrors: number;
  toSet: number; toRemove: number; bottles: number; done: number;
}

const ACTION: Record<RowResult['action'], [string, string]> = {
  set: ['ok', 'new'], change: ['info', 'changes'], remove: ['warn', 'removed'], same: ['neutral', 'no change'], error: ['bad', 'problem'],
};

export default function OpeningBottlesUpload() {
  const [fileName, setFileName] = useState('');
  const [read, setRead] = useState<OpeningReadResult | null>(null);
  const [asOf, setAsOf] = useState('2026-10-23');
  const [result, setResult] = useState<Result | null>(null);
  const [done, setDone] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = (r: OpeningReadResult, day: string, dryRun: boolean) =>
    api.post<Result>('/api/bottle-pool/opening-upload', { rows: r.rows, asOf: day, dryRun });

  async function check(r: OpeningReadResult, day: string) {
    setBusy(true); setError(null); setResult(null);
    try { setResult(await send(r, day, true)); }
    catch (e) { setError(e instanceof Error ? e.message : 'The file could not be checked'); }
    finally { setBusy(false); }
  }

  async function choose(file: File | undefined) {
    setRead(null); setResult(null); setDone(null); setError(null);
    if (!file) return;
    setFileName(file.name);
    try {
      const r = readOpeningBottles(await readSheets(file));
      setRead(r);
      const day = r.asOf || asOf;
      if (r.asOf) setAsOf(r.asOf);
      if (r.problems.length === 0) await check(r, day);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That file could not be read');
    }
  }

  async function bringIn() {
    if (!read || !result) return;
    const ok = await ask(`Set the opening balance of our bottles for ${result.toSet} customer${result.toSet === 1 ? '' : 's'}`
      + (result.toRemove ? ` and remove it for ${result.toRemove}` : '')
      + `, as at ${when(asOf)} (${result.bottles.toLocaleString('en-JM')} bottles in all)?`, { confirmLabel: 'Bring them in' });
    if (!ok) return;
    setBusy(true); setError(null);
    try { setDone(await send(read, asOf, false)); setResult(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Nothing was brought in'); }
    finally { setBusy(false); }
  }

  const changing = result ? result.rows.filter((r) => r.action !== 'same').length : 0;

  return (
    <>
      <h1>Opening balances of our bottles</h1>
      <p className="subtitle">
        How many of <strong>our</strong> 5-gallon bottles each customer already had when the app started. Bottles a
        customer owns are not entered. Each balance counts towards what they hold of ours, shows as their opening
        balance (never as a delivery), and deliveries since then add to it.
      </p>
      <p className="small"><Link to="/bottle-pool">← Bottle pool</Link></p>
      {error && <div className="notice error">{error}</div>}
      {done && (
        <div className="notice ok">
          Opening balances brought in for {done.done} customer{done.done === 1 ? '' : 's'}: {done.bottles.toLocaleString('en-JM')} of our
          bottles, as at {when(done.asOf)}. <Link to="/bottle-pool">See who is holding bottles</Link>
        </div>
      )}

      <div className="panel">
        <div className="row">
          <div className="field">
            <label htmlFor="ob-file">Opening bottles file (.xlsx or .csv)</label>
            <input id="ob-file" type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
                   disabled={busy} onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ''; }} />
            {fileName && <div className="muted small">{fileName}{read ? ` · ${read.rows.length} customers on "${read.sheet}"` : ''}</div>}
          </div>
          <div className="field">
            <label htmlFor="ob-asof">Counts are as at</label>
            <input id="ob-asof" type="date" value={asOf} disabled={busy}
                   onChange={(e) => { setAsOf(e.target.value); if (read && read.problems.length === 0) void check(read, e.target.value); }} />
            <div className="muted small">The day before the app's first deliveries, so those add on top.</div>
          </div>
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Columns: <strong>Customer Name</strong> (exactly as in the app) and <strong>Our Bottles</strong>. Other columns are ignored.
        </p>
        {read && read.problems.length > 0 && <div className="notice error">{read.problems.map((p) => <div key={p}>{p}</div>)}</div>}
        {busy && <p className="muted">Checking…</p>}
      </div>

      {result && (
        <div className="panel">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <h2 style={{ marginTop: 0 }}>What will happen</h2>
              <div className="row" style={{ gap: 8 }}>
                <span className="chip ok">{result.toSet} to set</span>
                {result.toRemove > 0 && <span className="chip warn">{result.toRemove} to remove</span>}
                <span className="chip info">{result.bottles.toLocaleString('en-JM')} of our bottles</span>
                {result.withErrors > 0 && <span className="chip bad">{result.withErrors} with a problem</span>}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <button className="go" disabled={busy || result.withErrors > 0 || changing === 0} onClick={bringIn}>Bring them in</button>
              {result.withErrors > 0 && <div className="muted small">Fix the rows with a problem and choose the file again.</div>}
              {result.withErrors === 0 && changing === 0 && <div className="muted small">Nothing to change: these balances are already in.</div>}
            </div>
          </div>
          <div style={{ overflowX: 'auto', marginTop: 10 }}>
            <table>
              <thead><tr><th>Customer</th><th className="num">Now in the app</th><th className="num">From the file</th><th>Notes</th></tr></thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.row}>
                    <td><strong>{r.matchedName ?? r.customer}</strong>
                      {r.inactive && <span className="chip neutral" style={{ marginLeft: 6 }}>inactive</span>}</td>
                    <td className="num">{r.was || '—'}</td>
                    <td className="num"><strong>{r.action === 'error' ? '—' : r.now}</strong></td>
                    <td className="small">
                      <span className={`chip ${ACTION[r.action][0]}`}>{ACTION[r.action][1]}</span>
                      {r.errors.map((m) => <div key={m} style={{ color: 'var(--bad)' }}>{m}</div>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
