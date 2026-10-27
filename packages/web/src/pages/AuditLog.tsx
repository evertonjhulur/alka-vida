import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Session } from '../lib/api';
import { money, todayInJamaica, when } from '../lib/format';
import { downloadCsv } from '../lib/csv';
import { MultiStatusSelect } from '../components/ListTools';

/**
 * Audit log (Everton, 15 Oct 2026: "where to view the audit trail?").
 *
 * Every change anyone makes is already written down by the server - who,
 * when, what they did and to what, with the details. This is where it is
 * read: newest first, filtered by date, person, kind of record and action,
 * or by a word (an order or invoice number, a customer's name). Admin only.
 * Settings › Audit log.
 */

interface Entry {
  id: string; ts: string; user_id: string | null; user_name: string;
  action: string; entity_type: string; entity_id: string | null; entity_label: string | null;
  details: Record<string, unknown> | null;
  /** In plain words, and a readable name for the record (27 Oct 2026). */
  summary?: string; record?: string | null;
}
interface Filters { types: string[]; people: Array<{ id: string; name: string }>; actions: string[] }

const ACTION_WORDS: Record<string, string> = {
  create: 'Created', update: 'Changed', delete: 'Deleted', deliver: 'Delivered',
  receive: 'Received', pay: 'Payment', finalize: 'Settled / closed', adjust: 'Adjusted',
};
const ACTION_TONE: Record<string, string> = {
  create: 'ok', update: 'info', delete: 'bad', deliver: 'ok', receive: 'ok', pay: 'ok', finalize: 'neutral', adjust: 'warn',
};
const TYPE_WORDS: Record<string, string> = {
  CustomerOrder: 'Order', DeliverySheet: 'Delivery round', DeliveryStop: 'Delivery stop', InventoryAudit: 'Stock count',
  ApprovalRequest: 'Approval', PriceTier: 'Price list', RoundCollection: 'Collection stop', CustomerApplication: 'Sign-up request',
  User: 'Login', NewsPost: 'News post', Broadcast: 'Message to customers', RecurringRun: 'Standing orders run',
};
/** "CustomerOrder" → "Order", "RawMaterial" → "Raw material". */
export const typeWords = (t: string) => TYPE_WORDS[t]
  ?? t.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

/** Where the record lives in the app, when it has a page. */
function linkFor(e: Entry): string | null {
  // A deleted record has no page any more (27 Oct 2026: the deleted round's link went nowhere).
  if (!e.entity_id || e.action === 'delete') return null;
  switch (e.entity_type) {
    case 'Customer': return `/customers/${e.entity_id}`;
    case 'Invoice': return `/invoices/${e.entity_id}`;
    case 'CustomerOrder': return e.entity_label ? `/orders?find=${encodeURIComponent(e.entity_label)}` : null;
    case 'DeliverySheet': return `/delivery/${e.entity_id}`;
    case 'Quotation': return `/quotes/${e.entity_id}`;
    case 'PurchaseOrder': return `/purchase-orders?po=${e.entity_id}`;
    case 'Employee': return `/employees/${e.entity_id}`;
    case 'Product': return `/products/${e.entity_id}/bom`;
    default: return null;
  }
}

/** "paymentAmountCents" → "Payment amount", a cents figure as dollars. */
function detailPairs(d: Record<string, unknown> | null): Array<[string, string]> {
  if (!d || typeof d !== 'object') return [];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return Object.entries(d)
    // Internal ids mean nothing to a reader; the record column already says which.
    .filter(([k, v]) => v !== null && v !== undefined && v !== '' && !/Ids?$/.test(k) && !(typeof v === 'string' && uuid.test(v)))
    .map(([k, v]) => {
    const cents = /Cents$/.test(k) && typeof v === 'number';
    const key = k.replace(/Cents$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
    const val = cents ? money(v as number)
      : typeof v === 'boolean' ? (v ? 'yes' : 'no')
        : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return [key, val.length > 160 ? `${val.slice(0, 160)}…` : val];
  });
}

const weekAgo = () => {
  const d = new Date(`${todayInJamaica()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
};
const clock = (ts: string) => new Date(ts).toLocaleTimeString('en-JM', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Jamaica' });
const dayOf = (ts: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Jamaica' }).format(new Date(ts));

export default function AuditLog({ session }: { session: Session }) {
  const [filters, setFilters] = useState<Filters | null>(null);
  const [rows, setRows] = useState<Entry[]>([]);
  const [more, setMore] = useState(false);
  const [from, setFrom] = useState(weekAgo());
  const [to, setTo] = useState('');
  const [who, setWho] = useState('');
  const [types, setTypes] = useState<string[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const query = (before?: string) => {
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (who) p.set('user', who);
    if (types.length) p.set('types', types.join(','));
    if (actions.length) p.set('actions', actions.join(','));
    if (q.trim()) p.set('q', q.trim());
    if (before) p.set('before', before);
    return p.toString();
  };

  async function load(append = false) {
    setBusy(true); setError(null);
    try {
      const r = await api.get<{ rows: Entry[]; more: boolean }>(
        `/api/audit-log?${query(append && rows.length ? rows[rows.length - 1].ts : undefined)}`);
      setRows(append ? [...rows, ...r.rows] : r.rows);
      setMore(r.more);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not read the log'); } finally { setBusy(false); }
  }

  useEffect(() => {
    if (session.role !== 'admin') return;
    api.get<Filters>('/api/audit-log/filters').then(setFilters).catch(() => {});
  }, [session.role]);
  useEffect(() => {
    if (session.role !== 'admin') return;
    const t = setTimeout(() => { void load(); }, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [from, to, who, types.join(','), actions.join(','), q]); // eslint-disable-line react-hooks/exhaustive-deps

  if (session.role !== 'admin') {
    return <div className="notice info">The audit log is for administrators.</div>;
  }

  const exportCsv = () => downloadCsv(`audit-log${from ? `-${from}` : ''}${to ? `-to-${to}` : ''}`, [
    ['Date', 'Time (Jamaica)', 'Who', 'Action', 'Record', 'Which', 'What happened', 'Details'],
    ...rows.map((e) => [dayOf(e.ts), clock(e.ts), e.user_name, ACTION_WORDS[e.action] ?? e.action,
      typeWords(e.entity_type), e.record ?? e.entity_label ?? '', e.summary ?? '',
      detailPairs(e.details).map(([k, v]) => `${k}: ${v}`).join('; ')]),
  ]);

  return (
    <>
      <h1>Audit log</h1>
      <p className="subtitle">
        Everything anyone has done in Alka Vida: who, when, what and to which record. Newest first. Times are Jamaica time,
        when it was entered; a payment or sale entered for an earlier day says "Dated …".
      </p>
      {error && <div className="notice error">{error}</div>}

      <div className="panel" style={{ padding: 0 }}>
        <div className="list-filters">
          <div className="field">
            <label htmlFor="al-q">Find</label>
            <input id="al-q" type="search" placeholder="Order, invoice, name or detail" value={q}
                   onChange={(e) => setQ(e.target.value)} style={{ minWidth: 220 }} />
          </div>
          <div className="field">
            <label htmlFor="al-from">From</label>
            <input id="al-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="al-to">To</label>
            <input id="al-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="al-who">Who</label>
            <select id="al-who" value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">Anyone</option>
              {(filters?.people ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <MultiStatusSelect id="al-type" label="Record" value={types} onChange={setTypes} anyLabel="Any record"
                             options={(filters?.types ?? []).map((t) => [t, typeWords(t)] as const)} />
          <MultiStatusSelect id="al-act" label="Action" value={actions} onChange={setActions} anyLabel="Any action"
                             options={(filters?.actions ?? Object.keys(ACTION_WORDS)).map((a) => [a, ACTION_WORDS[a] ?? a] as const)} />
          <div className="field" style={{ alignSelf: 'flex-end' }}>
            <button type="button" className="secondary" disabled={rows.length === 0} onClick={exportCsv}>
              Export to Excel ({rows.length})
            </button>
          </div>
        </div>

        <table className="phone-cards audit-table">
          <thead>
            <tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>What happened</th></tr>
          </thead>
          <tbody>
            {rows.map((e) => {
              const pairs = detailPairs(e.details);
              const link = linkFor(e);
              const isOpen = open === e.id;
              return (
                <tr key={e.id}>
                  <td className="lead" data-label="When">
                    <span>{when(dayOf(e.ts))} <span className="muted small">{clock(e.ts)}</span></span>
                  </td>
                  <td data-label="Who">{e.user_name}</td>
                  <td data-label="Action"><span className={`chip ${ACTION_TONE[e.action] ?? 'neutral'}`}>{ACTION_WORDS[e.action] ?? e.action}</span></td>
                  <td data-label="Record">
                    <div className="muted small">{typeWords(e.entity_type)}</div>
                    {link ? <Link to={link}>{e.record ?? e.entity_label ?? 'open'}</Link> : <span>{e.record ?? e.entity_label ?? '—'}</span>}
                  </td>
                  <td data-label="What happened" className="small audit-details">
                    {e.summary ? <div>{e.summary}</div> : null}
                    {pairs.length === 0 ? (!e.summary && <span className="muted">—</span>) : e.summary ? (
                      <>
                        <button type="button" className="as-link small" onClick={() => setOpen(isOpen ? null : e.id)}>
                          {isOpen ? 'Hide the details' : 'Details'}
                        </button>
                        {isOpen && pairs.map(([k, v]) => <div key={k} className="muted"><span>{k}:</span> {v}</div>)}
                      </>
                    ) : (
                      <>
                        {(isOpen ? pairs : pairs.slice(0, 3)).map(([k, v]) => (
                          <div key={k}><span className="muted">{k}:</span> {v}</div>
                        ))}
                        {pairs.length > 3 && (
                          <button type="button" className="as-link small" onClick={() => setOpen(isOpen ? null : e.id)}>
                            {isOpen ? 'Less' : `${pairs.length - 3} more…`}
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && !busy && <p className="muted" style={{ padding: '14px 16px', margin: 0 }}>Nothing recorded for these choices.</p>}
        <div className="list-foot">
          <span>{busy ? 'Loading…' : `${rows.length} shown · newest first`}</span>
          {more && <button type="button" className="secondary" disabled={busy} onClick={() => load(true)}>Show more</button>}
        </div>
      </div>
    </>
  );
}
