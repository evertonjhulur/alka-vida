import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { money, todayInJamaica, when } from '../lib/format';
import CustomerPicker, { type PickerCustomer } from './CustomerPicker';

/**
 * Statement… (UX review, 10-11 Oct 2026). Everton: "the customer screen
 * doesn't ask me to select dates in generating a statement". The customer
 * page had two Statement PDF buttons that behaved differently - the one at
 * the top built an all-time statement without asking - and the email was
 * hidden under More with no period at all. Now one button opens this: pick
 * the period (a quick choice or two dates), see what it comes to, then
 * download the PDF or email it.
 *
 * Without a customer (from the Invoices page) it asks which customer first.
 */
type Period = 'this-month' | 'last-month' | 'last-3' | 'this-year' | 'all' | 'custom';

const PERIODS: Array<[Period, string]> = [
  ['this-month', 'This month'],
  ['last-month', 'Last month'],
  ['last-3', 'Last 3 months'],
  ['this-year', 'This year'],
  ['all', 'Everything'],
  ['custom', 'Choose dates'],
];
const SHOW = ['All', 'Invoices', 'Payments'] as const;
const STATES = ['', 'Open', 'Paid', 'Partially paid', 'Overdue'] as const;

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The dates a quick choice stands for, counted in Jamaica. */
export function periodDates(p: Period, today = todayInJamaica()): { from: string; to: string } {
  const [y, m] = today.split('-').map(Number);
  switch (p) {
    case 'this-month': return { from: iso(y, m, 1), to: today };
    case 'last-month': {
      const ly = m === 1 ? y - 1 : y; const lm = m === 1 ? 12 : m - 1;
      return { from: iso(ly, lm, 1), to: iso(ly, lm, lastDay(ly, lm)) };
    }
    case 'last-3': {
      const back = m - 2; const fy = back <= 0 ? y - 1 : y; const fm = back <= 0 ? back + 12 : back;
      return { from: iso(fy, fm, 1), to: today };
    }
    case 'this-year': return { from: iso(y, 1, 1), to: today };
    default: return { from: '', to: '' };
  }
}

interface Preview { openingBalanceCents: number; closingBalanceCents: number; entries: unknown[] }

export default function StatementDialog({
  customerId: given, customerName, customerEmail, onClose, onDone,
}: {
  customerId?: string;
  customerName?: string;
  customerEmail?: string | null;
  onClose: () => void;
  /** Told what happened, for the page's own notice. */
  onDone: (message: string) => void;
}) {
  const [customers, setCustomers] = useState<Array<PickerCustomer & { email?: string | null }>>([]);
  const [customerId, setCustomerId] = useState(given ?? '');
  const [period, setPeriod] = useState<Period>('this-month');
  const [from, setFrom] = useState(periodDates('this-month').from);
  const [to, setTo] = useState(periodDates('this-month').to);
  const [show, setShow] = useState<(typeof SHOW)[number]>('All');
  const [state, setState] = useState<(typeof STATES)[number]>('');
  const [emailing, setEmailing] = useState(false);
  const [sendTo, setSendTo] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!given) api.get<Array<PickerCustomer & { email?: string | null }>>('/api/customers').then(setCustomers).catch(() => {});
  }, [given]);

  // Escape closes, like the app's other dialogs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const choose = (p: Period) => {
    setPeriod(p);
    if (p !== 'custom') { const d = periodDates(p); setFrom(d.from); setTo(d.to); }
  };

  const params = () => {
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    if (show !== 'All') q.set('filter', show);
    if (state) q.set('status', state);
    return q;
  };

  const badRange = !!from && !!to && from > to;

  // What the statement comes to over the chosen period, so the dates are seen to matter.
  useEffect(() => {
    if (!customerId || badRange) { setPreview(null); return; }
    let live = true;
    api.get<Preview>(`/api/customers/${customerId}/statement?${params()}`)
      .then((p) => { if (live) setPreview(p); })
      .catch(() => { if (live) setPreview(null); });
    return () => { live = false; };
  }, [customerId, from, to, show, state]); // eslint-disable-line react-hooks/exhaustive-deps

  const picked = customers.find((c) => c.id === customerId);
  const name = customerName ?? picked?.name ?? 'customer';
  const email = customerEmail ?? picked?.email ?? null;
  const span = from || to
    ? `${from ? when(from) : 'the start'} to ${to ? when(to) : 'today'}`
    : 'everything to date';

  async function download() {
    setBusy(true); setError(null);
    try {
      const blob = await api.getBlob(`/api/customers/${customerId}/statement.pdf?${params()}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `statement-${name.replace(/\W+/g, '-')}${from ? `-${from}` : ''}${to ? `-to-${to}` : ''}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      onDone(`Statement for ${name}, ${span}, downloaded.`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not build the statement');
    } finally { setBusy(false); }
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ sentTo: string }>(`/api/customers/${customerId}/statement/email`, {
        from: from || undefined, to: to || undefined,
        filter: show !== 'All' ? show : undefined, status: state || undefined,
        sendTo: sendTo.trim() || undefined,
      });
      onDone(`Statement for ${name}, ${span}, emailed to ${r.sentTo}.`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the statement');
    } finally { setBusy(false); }
  }

  return (
    <div className="dialog-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="dialog statement-dialog" role="dialog" aria-modal="true" aria-labelledby="st-title"
            onSubmit={emailing ? send : (e) => { e.preventDefault(); download(); }}>
        <p id="st-title" className="dialog-q">Statement{given ? ` for ${name}` : ''}</p>

        {!given && (
          <div className="field">
            <label htmlFor="st-cust">Customer</label>
            <CustomerPicker id="st-cust" customers={customers} value={customerId}
                            onChange={setCustomerId} placeholder="Type a name or phone number" />
          </div>
        )}

        <fieldset className="st-periods">
          <legend>Period</legend>
          <div className="pills" style={{ margin: 0 }}>
            {PERIODS.map(([p, label]) => (
              <button key={p} type="button" className={`pill${period === p ? ' active' : ''}`}
                      aria-pressed={period === p} onClick={() => choose(p)}>
                {label}
              </button>
            ))}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <div className="field">
              <label htmlFor="st-from">From</label>
              <input id="st-from" type="date" value={from}
                     onChange={(e) => { setFrom(e.target.value); setPeriod('custom'); }} />
            </div>
            <div className="field">
              <label htmlFor="st-to">To</label>
              <input id="st-to" type="date" value={to} max={todayInJamaica()}
                     onChange={(e) => { setTo(e.target.value); setPeriod('custom'); }} />
            </div>
          </div>
          {badRange && <p className="small" style={{ color: 'var(--bad)', margin: 0 }}>The From date is after the To date.</p>}
        </fieldset>

        <details className="st-more">
          <summary>More choices</summary>
          <div className="row" style={{ marginTop: 8 }}>
            <div className="field">
              <label htmlFor="st-show">Show</label>
              <select id="st-show" value={show} onChange={(e) => setShow(e.target.value as typeof show)}>
                {SHOW.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="st-state">Invoices</label>
              <select id="st-state" value={state} onChange={(e) => setState(e.target.value as typeof state)}>
                {STATES.map((s) => <option key={s} value={s}>{s || 'Any state'}</option>)}
              </select>
            </div>
          </div>
        </details>

        {preview && (
          <p className="st-preview">
            {preview.entries.length} {preview.entries.length === 1 ? 'entry' : 'entries'}, {span}.{' '}
            {preview.closingBalanceCents < 0
              ? <>In credit <strong>{money(-preview.closingBalanceCents)}</strong>.</>
              : <>Balance due <strong>{money(preview.closingBalanceCents)}</strong>.</>}
          </p>
        )}

        {emailing && (
          <div className="field">
            <label htmlFor="st-sendto">Send to</label>
            <input id="st-sendto" type="email" value={sendTo} style={{ width: '100%' }}
                   placeholder={email || 'no address on file: type one'}
                   onChange={(e) => setSendTo(e.target.value)} autoFocus />
            <span className="muted small">Leave blank to use the address on the customer record.</span>
          </div>
        )}

        {error && <div className="notice error" style={{ marginTop: 10, marginBottom: 0 }}>{error}</div>}

        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
          {emailing ? (
            <>
              <button type="button" className="secondary" onClick={() => setEmailing(false)}>Back</button>
              <button disabled={busy || !customerId || badRange}>{busy ? 'Sending…' : 'Send'}</button>
            </>
          ) : (
            <>
              <button type="button" className="secondary" disabled={busy || !customerId || badRange}
                      onClick={() => setEmailing(true)}>Email it…</button>
              <button disabled={busy || !customerId || badRange}>{busy ? 'Building…' : 'Download PDF'}</button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
