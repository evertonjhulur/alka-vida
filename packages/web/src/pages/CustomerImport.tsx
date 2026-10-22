import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { money } from '../lib/format';
import { ask } from '../components/Dialog';
import { readSheets } from '../lib/sheetfile';
import { readUpload, type ReadResult } from '../lib/customerUpload';

interface RowResult {
  row: number; name: string; action: 'create' | 'skip' | 'error';
  accountType: string | null; priceList: string | null; zone: string | null; days: string[];
  paymentTerms?: string | null; invoiceCycle?: string;
  brands: string[]; buysOwnBrand: boolean; balanceCents: number;
  balanceAs: 'items' | 'single' | 'none'; itemCount: number;
  errors: string[]; warnings: string[];
}
interface Result {
  dryRun: boolean; rows: RowResult[]; toCreate: number; toSkip: number; withErrors: number;
  newZones: string[]; newBrands: string[]; totalBalanceCents: number; created: number;
}
type Show = 'all' | 'problems' | 'notes' | 'create' | 'skip';

const todayJm = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Jamaica' }).format(new Date());

/**
 * Bringing customers across from QuickBooks (Everton, 16 Oct 2026).
 *
 * Choose the upload file - the Excel workbook as edited, or a CSV saved from
 * it - and "Check the file" shows, customer by customer, what will happen,
 * without changing anything. "Bring them in" then adds them all at once, or
 * none if anything is wrong. Customers already in the app are left alone, so
 * the file can be uploaded again after fixing a few rows.
 */
export default function CustomerImport() {
  const [fileName, setFileName] = useState('');
  const [read, setRead] = useState<ReadResult | null>(null);
  const [asOf, setAsOf] = useState(todayJm());
  const [hold, setHold] = useState(true);
  const [result, setResult] = useState<Result | null>(null);
  const [done, setDone] = useState<Result | null>(null);
  const [show, setShow] = useState<Show>('all');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function choose(file: File | undefined) {
    setRead(null); setResult(null); setDone(null); setError(null);
    if (!file) return;
    setFileName(file.name);
    setBusy(true);
    try {
      const r = readUpload(await readSheets(file));
      setRead(r);
      if (r.asOf) setAsOf(r.asOf);
      if (r.problems.length === 0) await check(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That file could not be read');
    } finally { setBusy(false); }
  }

  const send = (r: ReadResult, dryRun: boolean) =>
    api.post<Result>('/api/customers/import', { rows: r.rows, asOf, holdAutoEmails: hold, dryRun });

  async function check(r = read) {
    if (!r) return;
    setBusy(true); setError(null);
    try {
      const res = await send(r, true);
      setResult(res);
      setShow(res.withErrors ? 'problems' : 'all');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check the file');
    } finally { setBusy(false); }
  }

  async function bringIn() {
    if (!read || !result) return;
    const ok = await ask(
      `Bring in ${result.toCreate} customer${result.toCreate === 1 ? '' : 's'}, with opening balances totalling ` +
      `${money(result.totalBalanceCents)} as at ${asOf}?` +
      (result.newZones.length ? ` ${result.newZones.length} new zone(s) will be added to the zone list.` : ''),
      { confirmLabel: 'Bring them in' },
    );
    if (!ok) return;
    setBusy(true); setError(null);
    try {
      const res = await send(read, false);
      setDone(res);
      setResult(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nothing was brought in');
    } finally { setBusy(false); }
  }

  const rows = (result?.rows ?? []).filter((r) => (
    show === 'all' ? true
      : show === 'problems' ? r.action === 'error'
        : show === 'notes' ? r.warnings.length > 0 && r.action !== 'skip'
          : r.action === show));

  return (
    <>
      <h1>Upload customers</h1>
      <p className="subtitle">
        Bring customers across from QuickBooks with what they owe. Order history stays in QuickBooks;
        each open invoice comes in with its QuickBooks number and dates, and an unapplied payment comes
        in as credit on the account.
      </p>
      <p className="small"><Link to="/customers">← Customers</Link></p>

      {error && <div className="notice error">{error}</div>}
      {done && (
        <div className="notice ok">
          {done.created} customer{done.created === 1 ? '' : 's'} brought in
          {done.toSkip ? `, ${done.toSkip} already here left as they were` : ''}. Opening balances total{' '}
          <strong>{money(done.totalBalanceCents)}</strong>.
          {done.newZones.length > 0 && <> New zones added: {done.newZones.join(', ')} — set their days on{' '}
            <Link to="/zones">Delivery zones</Link>.</>}
          {' '}<Link to="/customers">Go to Customers</Link>
        </div>
      )}

      <div className="panel">
        <div className="row">
          <div className="field" style={{ flex: '1 1 300px' }}>
            <label htmlFor="up-file">Upload file (.xlsx or .csv)</label>
            <input id="up-file" type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                   disabled={busy} onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ''; }} />
            {fileName && <div className="muted small">{fileName}{read ? ` · ${read.rows.length} customers on “${read.sheet}”` : ''}
              {read?.withItems ? ` · open items for ${read.withItems}` : ''}</div>}
          </div>
          <div className="field">
            <label htmlFor="up-asof">Balances as of</label>
            <input id="up-asof" type="date" value={asOf} onChange={(e) => { setAsOf(e.target.value); setResult(null); }} />
          </div>
          <div className="field" style={{ flex: '1 1 260px' }}>
            <label className="check">
              <input type="checkbox" checked={hold} onChange={(e) => { setHold(e.target.checked); setResult(null); }} />{' '}
              Hold automatic statements and reminders for them
            </label>
            <div className="muted small">So nobody is emailed the day they arrive. Turn them on per customer
              (Details › Emails) when you are ready.</div>
          </div>
        </div>
        {read && read.problems.length > 0 && (
          <div className="notice error">{read.problems.map((p) => <div key={p}>{p}</div>)}</div>
        )}
        {read && read.ignored.length > 0 && (
          <p className="muted small">Columns not used: {read.ignored.join(', ')}.</p>
        )}
        {read && read.problems.length === 0 && !result && !done && (
          <button disabled={busy} onClick={() => check()}>{busy ? 'Checking…' : 'Check the file'}</button>
        )}
      </div>

      {result && (
        <div className="panel">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <h2 style={{ marginTop: 0 }}>What will happen</h2>
              <div className="row" style={{ gap: 8 }}>
                <span className="chip ok">{result.toCreate} to add</span>
                {result.toSkip > 0 && <span className="chip neutral">{result.toSkip} already here — left alone</span>}
                {result.withErrors > 0 && <span className="chip bad">{result.withErrors} with a problem</span>}
                <span className="chip info">Opening balances {money(result.totalBalanceCents)}</span>
              </div>
              {result.newZones.length > 0 && (
                <p className="small">New zones to be added: <strong>{result.newZones.join(', ')}</strong>.
                  Check none is a misspelling of a zone you already have.</p>
              )}
              {result.newBrands.length > 0 && (
                <p className="small">New bottled brands to be added: <strong>{result.newBrands.join(', ')}</strong>.</p>
              )}
            </div>
            <div style={{ textAlign: 'right' }}>
              <button className="go" disabled={busy || result.withErrors > 0 || result.toCreate === 0} onClick={bringIn}>
                Bring them in
              </button>
              {result.withErrors > 0 && <div className="muted small">Fix the rows with a problem and choose the file again.</div>}
            </div>
          </div>

          <div className="row" style={{ marginTop: 6 }}>
            <div className="field" style={{ marginBottom: 6 }}>
              <label htmlFor="up-show">Show</label>
              <select id="up-show" value={show} onChange={(e) => setShow(e.target.value as Show)}>
                <option value="all">All rows ({result.rows.length})</option>
                <option value="problems">With a problem ({result.withErrors})</option>
                <option value="notes">With a note</option>
                <option value="create">To add ({result.toCreate})</option>
                <option value="skip">Already here ({result.toSkip})</option>
              </select>
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr><th>Row</th><th>Customer</th><th>Type · terms</th><th>Zone · days</th><th>Brands</th>
                  <th className="num">Opening balance</th><th>Notes</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.row} style={{ opacity: r.action === 'skip' ? 0.6 : 1 }}>
                    <td className="muted">{r.row}</td>
                    <td>
                      <strong>{r.name || '—'}</strong>
                      {r.action === 'skip' && <div><span className="chip neutral">already here</span></div>}
                      {r.action === 'error' && <div><span className="chip bad">problem</span></div>}
                    </td>
                    <td>{r.accountType ?? ''}{r.priceList ? <div className="muted small">{r.priceList} prices</div> : null}
                      {(r.paymentTerms || (r.invoiceCycle && r.invoiceCycle !== 'PerDelivery')) && (
                        <div className="muted small">{r.invoiceCycle === 'Monthly' ? 'Monthly invoice' : r.invoiceCycle === 'Weekly' ? 'Weekly invoice' : r.paymentTerms}</div>
                      )}</td>
                    <td>{r.zone ?? <span className="muted">—</span>}
                      {r.days.length > 0 && <div className="muted small">{r.days.join(', ')}</div>}</td>
                    <td className="small">
                      {r.brands.join(', ')}
                      {!r.buysOwnBrand && <div className="muted">own brands only</div>}
                    </td>
                    <td className="num">
                      {money(r.balanceCents)}
                      {r.balanceAs === 'items' && <div className="muted small">{r.itemCount} QuickBooks item{r.itemCount === 1 ? '' : 's'}</div>}
                      {r.balanceAs === 'single' && <div className="muted small">one line</div>}
                    </td>
                    <td className="small">
                      {r.errors.map((m) => <div key={m} style={{ color: 'var(--bad)' }}>{m}</div>)}
                      {r.warnings.map((m) => <div key={m} className="muted">{m}</div>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <p className="muted">Nothing to show.</p>}
          </div>
        </div>
      )}
    </>
  );
}
