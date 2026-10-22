import { useState } from 'react';
import { api } from '../lib/api';
import { money, when, todayInJamaica } from '../lib/format';
import CustomerPicker, { type PickerCustomer } from './CustomerPicker';

/**
 * A website order (alkavidaja.com, 21 Oct 2026) under Needs a decision.
 *
 * Somebody without an account ordered on the website. The office confirms it
 * with them, then books it here: a new customer is made from what they typed
 * (or the order goes on a customer already on file), and a real order is
 * created at that customer's prices. If they ticked "Open an account", the
 * login is made and the set-password link emailed, as for an account request.
 */

export interface WebsiteOrder {
  id: string; reference: string; first_name: string; last_name: string;
  business_name: string | null; phone: string; email: string | null;
  fulfilment: 'Deliver' | 'Collect'; address_line1: string | null; address_line2: string | null;
  city: string | null; parish: string | null; preferred_day: string | null;
  pay_method: string; no_empties: boolean; wants_account: boolean; notes: string | null;
  lines: Array<{ productId: string; name: string; qty: number; unit: 'case' | 'bottle'; priceCents: number }>;
  status: string; created_at: string; decline_reason: string | null;
  customer_name: string | null; order_number: string | null; decided_by_name: string | null;
  possible_matches: Array<{ id: string; name: string; phone: string | null; email: string | null }> | null;
}
interface Tier { id: string; name: string }
interface Zone { id: string; name: string; covers: string | null }

const DAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DAY_WORDS: Record<string, string> = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };

/** The next date (after today) that falls on that weekday; tomorrow when none was asked for. */
function nextDate(day: string | null): string {
  const d = new Date(`${todayInJamaica()}T12:00:00`);
  d.setDate(d.getDate() + 1);
  if (day && day in DAYS) while (d.getDay() !== DAYS[day]) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

export const websiteOrderName = (w: WebsiteOrder) => w.business_name ?? `${w.first_name} ${w.last_name}`;

export default function WebsiteOrderRow({
  w, isAdmin, tiers, zones, customers, busy, act, onLink,
}: {
  w: WebsiteOrder; isAdmin: boolean; tiers: Tier[]; zones: Zone[]; customers: PickerCustomer[]; busy: boolean;
  act: (what: () => Promise<string>, fallback: string) => void;
  /** The set-password link, when booking made them a login. */
  onLink: (link: string | null, emailed: boolean) => void;
}) {
  const [mode, setMode] = useState<'book' | 'decline' | null>(null);
  const matches = w.possible_matches ?? [];
  const [forWhom, setForWhom] = useState<string>(matches.length === 1 ? matches[0].id : '');
  const [tier, setTier] = useState('');
  const [zone, setZone] = useState('');
  const [day, setDay] = useState(nextDate(w.preferred_day));
  const [why, setWhy] = useState('');

  const name = websiteOrderName(w);
  const where = w.fulfilment === 'Collect' ? 'Collecting at White Marl'
    : [w.address_line1, w.address_line2, w.city, w.parish].filter(Boolean).join(', ');
  const listed = w.lines.reduce((s, l) => s + l.priceCents * l.qty, 0);

  const book = () => act(async () => {
    const r = await api.post<{ orderNumber: string; invitation: { link: string } | null; emailed: boolean }>(
      `/api/website-orders/${w.id}/book`,
      { existingCustomerId: forWhom || null, priceTierId: tier || null, deliveryZone: zone || null, deliveryDate: day || null },
    );
    setMode(null);
    onLink(r.invitation?.link ?? null, r.emailed);
    const who = forWhom ? (customers.find((c) => c.id === forWhom)?.name ?? 'the customer') : name;
    return `${w.reference} booked as order ${r.orderNumber} for ${who}.`
      + (r.invitation ? (r.emailed ? ` We emailed ${w.email} the link to set a password.` : ' The account email did not go: send them the link below.') : '');
  }, 'Could not book the order');

  const decline = () => act(async () => {
    await api.post(`/api/website-orders/${w.id}/decline`, { reason: why.trim() || undefined });
    setMode(null);
    return `${w.reference} from ${name} was declined.`;
  }, 'Could not decline');

  return (
    <div className={`decision${mode ? ' open' : ''}`}>
      <span className="chip info decision-type">Website order</span>
      <div className="decision-body">
        <strong>{name}</strong>
        <span className="muted"> · {w.reference}{w.business_name ? ` · ask for ${w.first_name} ${w.last_name}` : ''}</span>
        <div className="small">
          {w.lines.map((l) => `${l.qty} x ${l.name}${l.unit === 'case' ? (l.qty === 1 ? ' (case)' : ' (cases)') : ''}`).join(' · ')}
          {w.no_empties && <span className="chip warn" style={{ marginLeft: 6 }}>first 5 gallon, no empty</span>}
        </div>
        <div className="muted small">
          {where} · {w.preferred_day ? `would like ${DAY_WORDS[w.preferred_day]}` : 'any day'} · pays {w.pay_method === 'Bank Transfer' ? 'by transfer' : 'cash'}
        </div>
        <div className="muted small">
          <a href={`tel:${w.phone}`}>{w.phone}</a>{w.email ? <> · {w.email}</> : ' · no email'}
          {w.wants_account && w.email ? ' · wants an account' : ''} · sent {when(w.created_at)}
        </div>
        {w.notes && <div className="small">“{w.notes}”</div>}
        {matches.length > 0 && (
          <div className="small" style={{ color: 'var(--warn)' }}>
            Maybe already a customer: {matches.map((m) => m.name).join(', ')} (same email or phone).
          </div>
        )}

        {mode === 'book' && (
          <div className="decision-terms">
            <p className="muted small" style={{ margin: 0 }}>Confirm it with them first. Booking makes a real order at the customer's prices.</p>
            <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div className="field" style={{ minWidth: 240 }}>
                <label htmlFor={`who-${w.id}`}>Book for</label>
                <select id={`who-${w.id}`} value={matches.some((m) => m.id === forWhom) || !forWhom ? forWhom : '__other'}
                        onChange={(e) => setForWhom(e.target.value === '__other' ? (customers[0]?.id ?? '') : e.target.value)}>
                  <option value="">New customer: {name}</option>
                  {matches.map((m) => <option key={m.id} value={m.id}>{m.name}{m.phone ? ` · ${m.phone}` : ''}</option>)}
                  <option value="__other">Another customer on file…</option>
                </select>
              </div>
              {forWhom && !matches.some((m) => m.id === forWhom) && (
                <div className="field" style={{ minWidth: 240 }}>
                  <label htmlFor={`pick-${w.id}`}>Customer</label>
                  <CustomerPicker id={`pick-${w.id}`} customers={customers} value={forWhom} onChange={setForWhom} />
                </div>
              )}
              {!forWhom && (
                <>
                  <div className="field">
                    <label htmlFor={`tier-${w.id}`}>Price list</label>
                    <select id={`tier-${w.id}`} value={tier} onChange={(e) => setTier(e.target.value)}>
                      <option value="">Standard list prices</option>
                      {tiers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </div>
                  {w.fulfilment === 'Deliver' && (
                    <div className="field">
                      <label htmlFor={`zone-${w.id}`}>Delivery zone</label>
                      <select id={`zone-${w.id}`} value={zone} onChange={(e) => setZone(e.target.value)}>
                        <option value="">Not set yet</option>
                        {zones.map((z) => <option key={z.id} value={z.name}>{z.name}{z.covers ? ` — ${z.covers}` : ''}</option>)}
                      </select>
                    </div>
                  )}
                </>
              )}
              <div className="field">
                <label htmlFor={`day-${w.id}`}>{w.fulfilment === 'Collect' ? 'Collecting on' : 'Deliver on'}</label>
                <input id={`day-${w.id}`} type="date" value={day} onChange={(e) => setDay(e.target.value)} />
              </div>
              <div className="field">
                <button className="approve-soft" disabled={busy} onClick={book}>Book the order</button>
              </div>
            </div>
          </div>
        )}

        {mode === 'decline' && (
          <div className="decision-terms">
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <div className="field" style={{ flex: '1 1 320px' }}>
                <label htmlFor={`why-${w.id}`}>Why? (optional, kept on the record)</label>
                <input id={`why-${w.id}`} style={{ width: '100%' }} value={why} onChange={(e) => setWhy(e.target.value)} />
              </div>
              <div className="field">
                <button className="danger-soft" disabled={busy} onClick={decline}>Decline {w.reference}</button>
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="decision-amount">
        {listed > 0 ? <>{money(listed)}<div className="muted small">at listed prices</div></> : null}
      </div>
      <div className="decision-actions">
        {isAdmin ? (
          <>
            <button className={mode === 'book' ? 'secondary' : 'approve-soft'} disabled={busy}
                    onClick={() => setMode(mode === 'book' ? null : 'book')}>{mode === 'book' ? 'Close' : 'Book…'}</button>
            <button className={mode === 'decline' ? 'secondary' : 'danger-soft'} disabled={busy}
                    onClick={() => setMode(mode === 'decline' ? null : 'decline')}>{mode === 'decline' ? 'Close' : 'Decline…'}</button>
          </>
        ) : <span className="muted small">an administrator decides</span>}
      </div>
    </div>
  );
}
