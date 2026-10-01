import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type Session } from '../lib/api';
import { money, date, when } from '../lib/format';

/**
 * Needs a decision: everything waiting on an administrator, in one list.
 *
 * Replaces the separate Approvals and Account requests screens (UX review
 * mockups, approved 29 Sep 2026). Money changes raised by office staff -
 * discounts, credit notes, stop corrections - and requests to open an
 * account. Nothing here holds up a sale or a delivery; the amount owed
 * simply stays as it is until someone decides.
 */

interface Approval {
  id: string; requestType: string; entityLabel: string | null;
  customerName: string | null; amountCents: number;
  discountPercent: number | null; reason: string | null;
  payload: Record<string, number | string> | null;
  requestedByName: string | null; requestedDate: string;
}
interface Application {
  id: string; account_type: 'Corporate' | 'Individual';
  business_name: string | null; contact_person: string | null;
  first_name: string | null; last_name: string | null;
  email: string; phone: string; delivery_address: string | null;
  address_line1: string | null; address_line2: string | null;
  city: string | null; parish: string | null;
  notes: string | null; status: string; created_at: string;
  customer_name: string | null; decided_by_name: string | null;
}
interface Tier { id: string; name: string }
interface Zone { id: string; name: string; covers: string | null; retired_at: string | null }

type Filter = 'all' | 'money' | 'accounts';

const TYPE_LABEL: Record<string, string> = {
  Discount: 'Discount', CreditNote: 'Credit note', StopCorrection: 'Stop correction',
  SameDayOrder: 'Same-day order', PaymentChange: 'Payment change',
};
const TYPE_TONE: Record<string, string> = {
  Discount: 'warn', CreditNote: 'info', StopCorrection: 'neutral', SameDayOrder: 'info', PaymentChange: 'warn',
};
const METHOD_OK = (v: unknown) => String(v);
/** A payment change, in words: "amount 450.00, dated 2026-09-30, to another customer". */
function describeChange(p: Record<string, unknown> | null): string {
  if (!p) return '';
  const bits: string[] = [];
  if (p.amountCents !== undefined) bits.push(`amount ${money(Number(p.amountCents))}`);
  if (p.paymentDate) bits.push(`dated ${when(String(p.paymentDate))}`);
  if (p.method) bits.push(`by ${METHOD_OK(p.method).toLowerCase()}`);
  if (p.reference !== undefined) bits.push(`reference "${p.reference ?? ''}"`);
  if (p.customerId) bits.push('moved to another customer');
  if (p.invoiceId !== undefined) bits.push(p.invoiceId ? 'put against another invoice' : 'left on the account');
  return bits.join(', ');
}
const FIELD_LABEL: Record<string, string> = {
  paymentAmountCents: 'Cash collected',
  bottlesDeliveredFull: 'Bottles delivered',
  bottlesEmptiesPickedUp: 'Empties collected',
  bottlesLostDamaged: 'Lost or damaged',
  paymentMethod: 'Method',
};
const PAYMENT_TERMS = ['Cash on delivery', 'Net 15', 'Net 30', 'Net 60', 'Net 90'];

function describe(payload: Record<string, number | string> | null): string {
  if (!payload) return 'no changes recorded';
  return Object.entries(payload)
    .map(([k, v]) => `${FIELD_LABEL[k] ?? k}: ${k === 'paymentAmountCents' ? money(Number(v)) : String(v)}`)
    .join(' · ');
}

const nameOf = (a: Application) => (a.account_type === 'Corporate'
  ? a.business_name ?? ''
  : [a.first_name, a.last_name].filter(Boolean).join(' '));

/** "St. Andrew" and "St Andrew" are the same parish. */
const norm = (s: string | null | undefined) =>
  (s ?? '').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();

/** The zone whose "covers" names this parish (or town), if any. */
function zoneFor(a: Application, zones: Zone[]): Zone | null {
  const places = [a.parish, a.city].map(norm).filter(Boolean);
  return zones.find((z) => places.some((p) => norm(z.covers).includes(p) || norm(z.name) === p))
    ?? null;
}

export default function Decisions({ session }: { session: Session }) {
  const isAdmin = session.role === 'admin';
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [apps, setApps] = useState<Application[]>([]);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [params] = useSearchParams();
  const asked = params.get('show');
  const [filter, setFilter] = useState<Filter>(asked === 'money' || asked === 'accounts' ? asked : 'all');
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [openFor, setOpenFor] = useState<string | null>(null);
  const [terms, setTerms] = useState({ priceTierId: '', deliveryZone: '', paymentTerms: '' });
  const [declineFor, setDeclineFor] = useState<string | null>(null);
  const [declineWhy, setDeclineWhy] = useState('');

  async function load() {
    const [a, b] = await Promise.all([
      api.get<Approval[]>('/api/approvals'),
      api.get<Application[]>('/api/applications'),
    ]);
    setApprovals(a);
    setApps(b);
    try { setTiers(await api.get<Tier[]>('/api/price-tiers')); } catch { /* not fatal */ }
    try { setZones((await api.get<Zone[]>('/api/zones')).filter((z) => !z.retired_at)); } catch { /* not fatal */ }
  }
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  async function act(what: () => Promise<string>, fallback: string) {
    setBusy(true); setError(null); setMsg(null);
    try { setMsg(await what()); await load(); } catch (e) {
      setError(e instanceof Error ? e.message : fallback);
    } finally { setBusy(false); }
  }

  const review = (r: Approval, decision: 'Approved' | 'Rejected') => act(async () => {
    await api.post(`/api/approvals/${r.id}/review`, { decision });
    return `${TYPE_LABEL[r.requestType] ?? r.requestType} for ${r.customerName ?? r.entityLabel ?? 'that record'} ${decision === 'Approved' ? 'approved' : 'rejected'}.`;
  }, 'Could not record the decision');

  const openApprove = (a: Application) => {
    setDeclineFor(null);
    if (openFor === a.id) { setOpenFor(null); return; }
    setOpenFor(a.id);
    setTerms({ priceTierId: '', deliveryZone: zoneFor(a, zones)?.name ?? '', paymentTerms: '' });
  };

  const approve = (a: Application) => act(async () => {
    setLink(null);
    const r = await api.post<{ invitation: { link: string } | null }>(
      `/api/applications/${a.id}/approve`,
      {
        priceTierId: terms.priceTierId || null,
        deliveryZone: terms.deliveryZone || null,
        paymentTerms: terms.paymentTerms || null,
      },
    );
    setLink(r.invitation?.link ?? null);
    setOpenFor(null);
    return `${nameOf(a)} is now a customer.`;
  }, 'Could not approve');

  const decline = (a: Application) => act(async () => {
    await api.post(`/api/applications/${a.id}/decline`, { reason: declineWhy.trim() || undefined });
    setDeclineFor(null); setDeclineWhy('');
    return `${nameOf(a)} was declined.`;
  }, 'Could not decline');

  const pendingApps = apps.filter((a) => a.status === 'Pending');
  const decidedApps = apps.filter((a) => a.status !== 'Pending').slice(0, 10);
  const total = approvals.length + pendingApps.length;
  const showMoney = filter !== 'accounts';
  const showAccounts = filter !== 'money';

  const pill = (key: Filter, label: string, n?: number) => (
    <button key={key} type="button" className={`pill${filter === key ? ' active' : ''}`}
            aria-pressed={filter === key} onClick={() => setFilter(key)}>
      {label}{n !== undefined ? ` · ${n}` : ''}
    </button>
  );

  const approvalRow = (r: Approval) => (
    <div key={r.id} className="decision">
      <span className={`chip ${TYPE_TONE[r.requestType] ?? 'neutral'} decision-type`}>
        {TYPE_LABEL[r.requestType] ?? r.requestType}
      </span>
      <div className="decision-body">
        <strong>{r.entityLabel ?? '—'}</strong>
        {r.customerName && <> for {r.customerName}</>}
        <div className="muted small">
          {r.reason ? `“${r.reason}” · ` : ''}asked by {r.requestedByName ?? 'someone'}, {when(r.requestedDate)}
        </div>
        {r.requestType === 'StopCorrection' && (
          <div className="small">Change to: {describe(r.payload)}</div>
        )}
        {r.requestType === 'PaymentChange' && (
          <div className="small">Change to: {describeChange(r.payload)}</div>
        )}
        {r.requestType === 'SameDayOrder' && (
          <div className="small">Approve to put it on today's round. Reject and it goes on their next delivery day instead (it is not cancelled).</div>
        )}
      </div>
      <div className="decision-amount">
        {r.requestType === 'StopCorrection' ? (
          <span className="muted small">figures on the stop</span>
        ) : r.requestType === 'SameDayOrder' || r.requestType === 'PaymentChange' ? (
          <strong>{money(r.amountCents)}</strong>
        ) : (
          <>
            <strong>−{money(r.amountCents)}</strong>
            {r.discountPercent ? <div className="muted small">{r.discountPercent}% off</div> : null}
          </>
        )}
      </div>
      <div className="decision-actions">
        {isAdmin ? (
          <>
            <button className="approve-soft" disabled={busy} onClick={() => review(r, 'Approved')}>
              {r.requestType === 'SameDayOrder' ? 'Deliver today' : 'Approve'}
            </button>
            <button className="danger-soft" disabled={busy} onClick={() => review(r, 'Rejected')}>
              {r.requestType === 'SameDayOrder' ? 'Next delivery day' : 'Reject'}
            </button>
          </>
        ) : <span className="muted small">an administrator decides</span>}
      </div>
    </div>
  );

  const appRow = (a: Application) => {
    const match = zoneFor(a, zones);
    const where = [a.address_line1 ?? a.delivery_address, a.address_line2, a.city, a.parish]
      .filter(Boolean).join(', ');
    return (
      <div key={a.id} className={`decision${openFor === a.id ? ' open' : ''}`}>
        <span className="chip ok decision-type">New account</span>
        <div className="decision-body">
          <strong>{nameOf(a)}</strong>
          <span className="muted"> · {a.account_type === 'Corporate'
            ? `business${a.contact_person ? `, ask for ${a.contact_person}` : ''}` : 'home'}</span>
          <div className="muted small">
            {where || 'no address given'} · {a.email} · {a.phone} · asked {when(a.created_at)}
          </div>
          {a.notes && <div className="small">“{a.notes}”</div>}

          {openFor === a.id && (
            <div className="decision-terms">
              <div className="row" style={{ alignItems: 'flex-end' }}>
                <div className="field">
                  <label htmlFor={`tier-${a.id}`}>Price list</label>
                  <select id={`tier-${a.id}`} value={terms.priceTierId}
                          onChange={(e) => setTerms({ ...terms, priceTierId: e.target.value })}>
                    <option value="">Standard list prices</option>
                    {tiers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={`zone-${a.id}`}>Delivery zone</label>
                  <select id={`zone-${a.id}`} value={terms.deliveryZone}
                          onChange={(e) => setTerms({ ...terms, deliveryZone: e.target.value })}>
                    <option value="">No round yet (they collect)</option>
                    {zones.map((z) => (
                      <option key={z.id} value={z.name}>{z.name}{z.covers ? ` — ${z.covers}` : ''}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={`terms-${a.id}`}>Payment terms</label>
                  <select id={`terms-${a.id}`} value={terms.paymentTerms}
                          onChange={(e) => setTerms({ ...terms, paymentTerms: e.target.value })}>
                    <option value="">Not agreed yet</option>
                    {PAYMENT_TERMS.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div className="field">
                  <button className="approve-soft" disabled={busy} onClick={() => approve(a)}>
                    Approve and invite
                  </button>
                </div>
              </div>
              {!match && a.parish && (
                <p className="small" style={{ margin: 0, color: 'var(--bad)' }}>
                  No zone covers {a.parish} yet. Add one in <Link to="/zones">Delivery zones</Link>,
                  or leave it blank if they will collect.
                </p>
              )}
              {match && terms.deliveryZone === match.name && (
                <p className="muted small" style={{ margin: 0 }}>
                  {match.name} chosen because it covers {a.parish ?? a.city}.
                </p>
              )}
            </div>
          )}

          {declineFor === a.id && (
            <div className="decision-terms">
              <div className="row" style={{ alignItems: 'flex-end' }}>
                <div className="field" style={{ flex: '1 1 320px' }}>
                  <label htmlFor={`why-${a.id}`}>Why? (optional, kept on the record)</label>
                  <input id={`why-${a.id}`} style={{ width: '100%' }} value={declineWhy}
                         onChange={(e) => setDeclineWhy(e.target.value)} />
                </div>
                <div className="field">
                  <button className="danger-soft" disabled={busy} onClick={() => decline(a)}>
                    Decline {nameOf(a)}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="decision-actions">
          {isAdmin ? (
            <>
              <button className={openFor === a.id ? 'secondary' : 'approve-soft'} disabled={busy}
                      onClick={() => openApprove(a)}>
                {openFor === a.id ? 'Close' : 'Approve…'}
              </button>
              <button className={declineFor === a.id ? 'secondary' : 'danger-soft'} disabled={busy}
                      onClick={() => {
                        setOpenFor(null);
                        setDeclineWhy('');
                        setDeclineFor(declineFor === a.id ? null : a.id);
                      }}>
                {declineFor === a.id ? 'Close' : 'Decline…'}
              </button>
            </>
          ) : <span className="muted small">an administrator decides</span>}
        </div>
      </div>
    );
  };

  const shown = [
    ...(showMoney ? approvals.map(approvalRow) : []),
    ...(showAccounts ? pendingApps.map(appRow) : []),
  ];

  return (
    <>
      <h1>Needs a decision</h1>
      <p className="subtitle">
        Nothing here holds up a sale or a delivery. The amount owed stays as it is
        until you decide.
      </p>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}
      {link && (
        <div className="notice info">
          <strong>Send them this link so they can choose a password.</strong>
          <p className="small" style={{ margin: '6px 0' }}>
            It works once and expires in 7 days. If email is set up it has already
            gone to them; otherwise pass it on yourself.
          </p>
          <input readOnly value={link} style={{ width: '100%' }}
                 onFocus={(e) => e.currentTarget.select()} />
        </div>
      )}
      {!isAdmin && (
        <div className="notice info">
          You can see what is waiting, but only an administrator can decide.
        </div>
      )}

      <div className="pills" role="group" aria-label="Show">
        {pill('all', 'Everything', total)}
        {pill('money', 'Money changes', approvals.length)}
        {pill('accounts', 'New accounts', pendingApps.length)}
      </div>

      <div className="panel" style={{ padding: 0 }}>
        {shown}
        {shown.length === 0 && (
          <p className="muted" style={{ padding: 18, margin: 0 }}>Nothing is waiting on you.</p>
        )}
      </div>

      {showAccounts && decidedApps.length > 0 && (
        <details className="panel">
          <summary style={{ cursor: 'pointer' }}><strong>Account requests already dealt with</strong></summary>
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>Who</th><th>Asked</th><th>Decision</th><th>By</th></tr></thead>
            <tbody>
              {decidedApps.map((a) => (
                <tr key={a.id}>
                  <td>{nameOf(a)}{a.customer_name && a.customer_name !== nameOf(a)
                    ? <div className="muted small">now {a.customer_name}</div> : null}</td>
                  <td>{when(a.created_at)}</td>
                  <td><span className={`chip ${a.status === 'Approved' ? 'ok' : 'muted'}`}>{a.status}</span></td>
                  <td className="muted small">{a.decided_by_name ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </>
  );
}
