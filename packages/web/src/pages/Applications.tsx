import { Fragment, useEffect, useState } from 'react';
import { api, type Session } from '../lib/api';
import { date } from '../lib/format';

interface Application {
  id: string; account_type: 'Corporate' | 'Individual';
  business_name: string | null; contact_person: string | null;
  first_name: string | null; last_name: string | null;
  email: string; phone: string; delivery_address: string | null;
  delivery_zone: string | null; notes: string | null;
  status: string; created_at: string; decline_reason: string | null;
  customer_name: string | null; decided_by_name: string | null;
}

interface Tier { id: string; name: string }

const nameOf = (a: Application) => (a.account_type === 'Corporate'
  ? a.business_name ?? ''
  : [a.first_name, a.last_name].filter(Boolean).join(' '));

/**
 * Requests for a trading account.
 *
 * Approving is where the terms are decided - price tier, delivery zone,
 * payment terms - which is the reason registration is an application rather
 * than a sign-up. Approving creates the customer, the login, and the
 * invitation that lets them set their own password, in one go.
 */
export default function Applications({ session }: { session: Session }) {
  const [apps, setApps] = useState<Application[]>([]);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [zones, setZones] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [openFor, setOpenFor] = useState<string | null>(null);
  const [terms, setTerms] = useState({ priceTierId: '', deliveryZone: '', paymentTerms: '' });

  const isAdmin = session.role === 'admin';

  async function load() {
    setApps(await api.get<Application[]>('/api/applications'));
    if (isAdmin) {
      try { setTiers(await api.get<Tier[]>('/api/price-tiers')); } catch { /* office only */ }
    }
    // Existing zones, so a new customer joins a round that already exists
    // rather than inventing a spelling of one.
    try {
      const cs = await api.get<Array<{ delivery_zone: string | null }>>('/api/customers');
      setZones([...new Set(cs.map((c) => c.delivery_zone).filter(Boolean) as string[])].sort());
    } catch { /* not fatal */ }
  }
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  async function approve(a: Application) {
    setBusy(true); setError(null); setMsg(null); setLink(null);
    try {
      const r = await api.post<{ invitation: { link: string } | null }>(
        `/api/applications/${a.id}/approve`,
        {
          priceTierId: terms.priceTierId || null,
          deliveryZone: terms.deliveryZone || null,
          paymentTerms: terms.paymentTerms || null,
        },
      );
      setMsg(`${nameOf(a)} is now a customer.`);
      setLink(r.invitation?.link ?? null);
      setOpenFor(null);
      setTerms({ priceTierId: '', deliveryZone: '', paymentTerms: '' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not approve');
    } finally { setBusy(false); }
  }

  async function decline(a: Application) {
    const reason = window.prompt(`Why are you turning down ${nameOf(a)}? (optional)`);
    if (reason === null) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/api/applications/${a.id}/decline`, { reason: reason || undefined });
      setMsg(`${nameOf(a)} was declined.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not decline');
    } finally { setBusy(false); }
  }

  const pending = apps.filter((a) => a.status === 'Pending');
  const decided = apps.filter((a) => a.status !== 'Pending');

  const row = (a: Application) => (
    <Fragment key={a.id}>
      <tr>
        <td>
          <strong>{nameOf(a)}</strong>
          <div className="muted small">
            {a.account_type === 'Corporate'
              ? `Business · ${a.contact_person ?? 'no contact named'}`
              : 'Individual'}
          </div>
        </td>
        <td className="small">
          {a.email}
          <div className="muted">{a.phone}</div>
        </td>
        <td className="small">
          {a.delivery_address ?? <span className="muted">no address given</span>}
          {a.notes && <div className="muted">“{a.notes}”</div>}
        </td>
        <td className="small muted">{date(a.created_at)}</td>
        <td className="num">
          {a.status === 'Pending' ? (
            isAdmin ? (
              <>
                <button className="secondary" disabled={busy}
                        onClick={() => {
                          setOpenFor(openFor === a.id ? null : a.id);
                          setTerms({ priceTierId: '', deliveryZone: '', paymentTerms: '' });
                        }}>
                  {openFor === a.id ? 'Cancel' : 'Approve…'}
                </button>{' '}
                <button className="secondary" disabled={busy} onClick={() => decline(a)}>
                  Decline
                </button>
              </>
            ) : <span className="muted small">an administrator decides</span>
          ) : (
            <span className={`chip ${a.status === 'Approved' ? 'ok' : 'muted'}`}>
              {a.status}
            </span>
          )}
        </td>
      </tr>

      {openFor === a.id && (
        <tr>
          <td colSpan={5} style={{ background: '#f9fafb' }}>
            <strong>Set {nameOf(a)}'s terms</strong>
            <p className="muted small" style={{ marginTop: 4 }}>
              These are what they will be charged and how they will be routed. Approving
              creates the customer, their login, and a link for them to choose their own
              password. You can change any of it afterwards.
            </p>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <div className="field">
                <label>Price tier</label>
                <select value={terms.priceTierId}
                        onChange={(e) => setTerms({ ...terms, priceTierId: e.target.value })}>
                  <option value="">Standard list prices</option>
                  {tiers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Delivery zone</label>
                <input list="zones" value={terms.deliveryZone}
                       placeholder="which round?"
                       onChange={(e) => setTerms({ ...terms, deliveryZone: e.target.value })} />
                <datalist id="zones">
                  {zones.map((z) => <option key={z} value={z} />)}
                </datalist>
              </div>
              <div className="field">
                <label>Payment terms</label>
                <input style={{ width: 140 }} value={terms.paymentTerms}
                       placeholder="e.g. Net 30"
                       onChange={(e) => setTerms({ ...terms, paymentTerms: e.target.value })} />
              </div>
              <div className="field">
                <button disabled={busy} onClick={() => approve(a)}>
                  Approve and invite
                </button>
              </div>
            </div>
            {!terms.deliveryZone && (
              <p className="muted small" style={{ margin: 0 }}>
                Without a zone their orders will not land on a round automatically.
              </p>
            )}
          </td>
        </tr>
      )}
    </Fragment>
  );

  return (
    <>
      <h1>Account requests</h1>
      <p className="subtitle">
        People asking to open an account. Nobody can order until you approve them.
      </p>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      {link && (
        <div className="notice info">
          <strong>Send them this link so they can choose a password.</strong>
          <p className="small" style={{ margin: '6px 0' }}>
            It works once and expires in 7 days. If email is set up on this machine
            it has already gone to them; otherwise pass it on yourself.
          </p>
          <input readOnly value={link} style={{ width: '100%' }}
                 onFocus={(e) => e.currentTarget.select()} />
        </div>
      )}

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Waiting ({pending.length})</h2>
        <table>
          <thead>
            <tr>
              <th>Who</th><th>Contact</th><th>Where</th><th>Asked</th><th />
            </tr>
          </thead>
          <tbody>{pending.map(row)}</tbody>
        </table>
        {pending.length === 0 && <p className="muted">Nothing waiting.</p>}
      </div>

      {decided.length > 0 && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Already dealt with</h2>
          <table>
            <thead>
              <tr>
                <th>Who</th><th>Contact</th><th>Where</th><th>Asked</th><th />
              </tr>
            </thead>
            <tbody>{decided.map(row)}</tbody>
          </table>
        </div>
      )}
    </>
  );
}
