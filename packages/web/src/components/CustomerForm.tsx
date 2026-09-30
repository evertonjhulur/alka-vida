import { useEffect, useState } from 'react';
import { api } from '../lib/api';

/**
 * Adding or editing a customer (Everton's revisions, 30 Sep 2026).
 *
 * It starts with the one question that decides the rest - a business or a
 * person - then asks for what that kind of customer has. The delivery zone
 * is a choice from the managed list, and shows the days that round runs; the
 * customer's own delivery days start from those and can be several. Billing
 * carries the price list, terms, how often they are invoiced (every delivery,
 * or one invoice a week or a month, due on receipt) and GCT exemption.
 *
 * Shared by the Customers list ("Add customer") and the Details tab of a
 * customer's own page, so the two can never ask different questions.
 */

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const PARISHES = [
  'Kingston', 'St Andrew', 'St Thomas', 'Portland', 'St Mary', 'St Ann',
  'Trelawny', 'St James', 'Hanover', 'Westmoreland', 'St Elizabeth',
  'Manchester', 'Clarendon', 'St Catherine',
] as const;
const PAYMENT_TERMS = ['Due on receipt', 'Cash on delivery', 'Net 15', 'Net 30', 'Net 60', 'Net 90'] as const;
const CYCLES: Array<[string, string, string]> = [
  ['PerDelivery', 'Every delivery', 'An invoice each time goods go out.'],
  ['Weekly', 'Once a week', 'One invoice each Monday for the week before (Mon–Sun), listing every delivery. Due on receipt.'],
  ['Monthly', 'Once a month', 'One invoice on the 1st for the month before, listing every delivery. Due on receipt.'],
];

interface Zone { id: string; name: string; retired_at: string | null; run_days: string[] | null }
interface Tier { id: string; name: string }

export interface CustomerFormValues {
  accountType: 'Corporate' | 'Individual' | '';
  name: string; contactPerson: string; phone: string; email: string;
  addressLine1: string; addressLine2: string; city: string; parish: string;
  deliveryAddress: string;
  deliveryZone: string; deliveryDays: string[]; routeSequence: string;
  priceTierId: string; paymentTerms: string; invoiceCycle: string;
  gctExempt: boolean; gctExemptRef: string;
  autoStatements: boolean; autoReminders: boolean;
  notes: string;
}

export const BLANK_CUSTOMER: CustomerFormValues = {
  accountType: '', name: '', contactPerson: '', phone: '', email: '',
  addressLine1: '', addressLine2: '', city: '', parish: '', deliveryAddress: '',
  deliveryZone: '', deliveryDays: [], routeSequence: '0',
  priceTierId: '', paymentTerms: '', invoiceCycle: 'PerDelivery',
  gctExempt: false, gctExemptRef: '', autoStatements: true, autoReminders: true, notes: '',
};

/** A customer row from the API, as the form's values. */
export function customerToForm(c: Record<string, unknown>): CustomerFormValues {
  const s = (k: string) => (c[k] as string | null) ?? '';
  const hasParts = !!(c.address_line1 || c.city || c.parish);
  return {
    accountType: (c.account_type as 'Corporate' | 'Individual') ?? 'Corporate',
    name: s('name'), contactPerson: s('contact_person'), phone: s('phone'), email: s('email'),
    // Before addresses came in parts the whole thing sat in one line; it
    // opens in line 1 so nothing is lost.
    addressLine1: hasParts ? s('address_line1') : s('delivery_address'),
    addressLine2: s('address_line2'), city: s('city'), parish: s('parish'),
    deliveryAddress: s('delivery_address'),
    deliveryZone: s('delivery_zone'),
    deliveryDays: Array.isArray(c.delivery_days) && (c.delivery_days as string[]).length
      ? c.delivery_days as string[] : (c.default_delivery_day ? [c.default_delivery_day as string] : []),
    routeSequence: String(c.route_sequence ?? 0),
    priceTierId: s('price_tier_id'), paymentTerms: s('payment_terms'),
    invoiceCycle: (c.invoice_cycle as string) || 'PerDelivery',
    gctExempt: !!c.gct_exempt, gctExemptRef: s('gct_exempt_ref'),
    autoStatements: c.auto_statements !== false, autoReminders: c.auto_reminders !== false,
    notes: s('notes'),
  };
}

/** The form's values as the API wants them. */
export function formToPayload(f: CustomerFormValues) {
  return {
    accountType: f.accountType || 'Corporate',
    name: f.name.trim(),
    contactPerson: f.accountType === 'Individual' ? null : (f.contactPerson || null),
    phone: f.phone, email: f.email,
    addressLine1: f.addressLine1 || null, addressLine2: f.addressLine2 || null,
    city: f.city || null, parish: f.parish || null,
    deliveryZone: f.deliveryZone || null,
    deliveryDays: f.deliveryDays,
    routeSequence: Number(f.routeSequence) || 0,
    priceTierId: f.priceTierId || null,
    paymentTerms: f.invoiceCycle !== 'PerDelivery' ? 'Due on receipt' : (f.paymentTerms || null),
    invoiceCycle: f.invoiceCycle,
    gctExempt: f.gctExempt, gctExemptRef: f.gctExempt ? (f.gctExemptRef || null) : null,
    autoStatements: f.autoStatements, autoReminders: f.autoReminders,
    notes: f.notes || null,
  };
}

export default function CustomerForm({
  initial, isNew, busy, onSubmit, onCancel, submitLabel,
}: {
  initial: CustomerFormValues;
  isNew: boolean;
  busy: boolean;
  onSubmit: (v: CustomerFormValues) => void;
  onCancel?: () => void;
  submitLabel?: string;
}) {
  const [f, setF] = useState<CustomerFormValues>(initial);
  const [zones, setZones] = useState<Zone[]>([]);
  const [tiers, setTiers] = useState<Tier[]>([]);

  useEffect(() => {
    api.get<Zone[]>('/api/zones').then(setZones).catch(() => {});
    api.get<Tier[]>('/api/price-tiers').then(setTiers).catch(() => {});
  }, []);
  useEffect(() => { setF(initial); }, [initial]);

  const set = <K extends keyof CustomerFormValues>(k: K, v: CustomerFormValues[K]) =>
    setF((cur) => ({ ...cur, [k]: v }));
  const zone = zones.find((z) => z.name === f.deliveryZone);
  const zoneDays = zone?.run_days ?? [];

  /** Choosing a zone fills in the days it runs, unless days were already picked. */
  function chooseZone(name: string) {
    const z = zones.find((x) => x.name === name);
    setF((cur) => ({
      ...cur, deliveryZone: name,
      deliveryDays: cur.deliveryDays.length === 0 && z?.run_days?.length ? [...z.run_days] : cur.deliveryDays,
    }));
  }
  const toggleDay = (d: string) => setF((cur) => ({
    ...cur,
    deliveryDays: cur.deliveryDays.includes(d)
      ? cur.deliveryDays.filter((x) => x !== d)
      : DAYS.filter((x) => x === d || cur.deliveryDays.includes(x)),
  }));
  const offRound = f.deliveryDays.filter((d) => zoneDays.length && !zoneDays.includes(d));
  const business = f.accountType !== 'Individual';

  const submit = (e: React.FormEvent) => { e.preventDefault(); onSubmit(f); };

  return (
    <form onSubmit={submit} className="customer-form">
      <div className="field">
        <span className="label">What kind of customer?</span>
        <div className="seg" role="group" aria-label="Customer type">
          {([['Corporate', 'A business'], ['Individual', 'A person']] as const).map(([k, label]) => (
            <button key={k} type="button" className={f.accountType === k ? 'active' : ''}
                    aria-pressed={f.accountType === k} onClick={() => set('accountType', k)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {isNew && !f.accountType ? (
        <p className="muted small">Choose one to carry on.</p>
      ) : (
        <>
          <fieldset className="form-block">
            <legend>{business ? 'The business' : 'The person'}</legend>
            <div className="row">
              <div className="field grow">
                <label htmlFor="cf-name">{business ? 'Business name *' : 'Full name *'}</label>
                <input id="cf-name" required value={f.name} onChange={(e) => set('name', e.target.value)} />
              </div>
              {business && (
                <div className="field grow">
                  <label htmlFor="cf-contact">Contact person</label>
                  <input id="cf-contact" value={f.contactPerson}
                         onChange={(e) => set('contactPerson', e.target.value)} />
                </div>
              )}
            </div>
            <div className="row">
              <div className="field">
                <label htmlFor="cf-phone">Phone *</label>
                <input id="cf-phone" required value={f.phone} onChange={(e) => set('phone', e.target.value)} />
              </div>
              <div className="field grow">
                <label htmlFor="cf-email">Email *</label>
                <input id="cf-email" type="email" required value={f.email}
                       onChange={(e) => set('email', e.target.value)} />
              </div>
            </div>
          </fieldset>

          <fieldset className="form-block">
            <legend>Where we deliver</legend>
            <div className="row">
              <div className="field grow">
                <label htmlFor="cf-a1">Address</label>
                <input id="cf-a1" value={f.addressLine1} placeholder="Street and number"
                       onChange={(e) => set('addressLine1', e.target.value)} />
              </div>
              <div className="field grow">
                <label htmlFor="cf-a2">Address line 2</label>
                <input id="cf-a2" value={f.addressLine2} placeholder="Building, plaza, suite"
                       onChange={(e) => set('addressLine2', e.target.value)} />
              </div>
            </div>
            <div className="row">
              <div className="field">
                <label htmlFor="cf-city">Town or district</label>
                <input id="cf-city" value={f.city} onChange={(e) => set('city', e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="cf-parish">Parish</label>
                <select id="cf-parish" value={f.parish} onChange={(e) => set('parish', e.target.value)}>
                  <option value="">Choose…</option>
                  {PARISHES.map((p) => <option key={p}>{p}</option>)}
                  {f.parish && !PARISHES.includes(f.parish as typeof PARISHES[number])
                    && <option>{f.parish}</option>}
                </select>
              </div>
              <div className="field">
                <label htmlFor="cf-zone">Delivery zone</label>
                <select id="cf-zone" value={f.deliveryZone} onChange={(e) => chooseZone(e.target.value)}>
                  <option value="">None (collects or walks in)</option>
                  {zones.filter((z) => !z.retired_at || z.name === f.deliveryZone).map((z) => (
                    <option key={z.id} value={z.name}>
                      {z.name}{z.run_days?.length ? ` — ${z.run_days.join(', ')}` : ''}
                    </option>
                  ))}
                  {f.deliveryZone && !zones.some((z) => z.name === f.deliveryZone) && (
                    <option value={f.deliveryZone}>{f.deliveryZone} (not a listed zone)</option>
                  )}
                </select>
              </div>
              <div className="field">
                <label htmlFor="cf-seq">Visit order on the round</label>
                <input id="cf-seq" type="number" min="0" style={{ width: 110 }} value={f.routeSequence}
                       onChange={(e) => set('routeSequence', e.target.value)} />
              </div>
            </div>
            <div className="field">
              <span className="label">Delivery days</span>
              <div className="day-picks" role="group" aria-label="Delivery days">
                {DAYS.map((d) => (
                  <button key={d} type="button" aria-pressed={f.deliveryDays.includes(d)}
                          className={`day-pick${f.deliveryDays.includes(d) ? ' on' : ''}${zoneDays.includes(d) ? ' runs' : ''}`}
                          onClick={() => toggleDay(d)}>{d}</button>
                ))}
              </div>
              <div className="muted small" style={{ marginTop: 4 }}>
                {zone
                  ? zoneDays.length
                    ? <>The {zone.name} round runs {zoneDays.join(', ')} (underlined). Pick as many days as they take deliveries.</>
                    : <>The {zone.name} round has no set days yet (set them under Delivery zones).</>
                  : 'Choose a zone to see the days its round runs.'}
              </div>
              {offRound.length > 0 && (
                <div className="notice warn" style={{ marginTop: 8, marginBottom: 0 }}>
                  The {zone?.name} round does not run on {offRound.join(', ')}. Orders for those days
                  start a round of their own.
                </div>
              )}
            </div>
            {!f.deliveryZone && (
              <div className="notice warn" style={{ marginBottom: 0 }}>
                Without a delivery zone their delivery orders cannot go on a round by themselves.
                Leave it blank only for customers who collect or walk in.
              </div>
            )}
          </fieldset>

          <fieldset className="form-block">
            <legend>Prices and billing</legend>
            <div className="row">
              <div className="field">
                <label htmlFor="cf-tier">Price list</label>
                <select id="cf-tier" value={f.priceTierId} onChange={(e) => set('priceTierId', e.target.value)}>
                  <option value="">List price</option>
                  {tiers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="cf-terms">Payment terms</label>
                <select id="cf-terms" value={f.invoiceCycle !== 'PerDelivery' ? 'Due on receipt' : f.paymentTerms}
                        disabled={f.invoiceCycle !== 'PerDelivery'}
                        onChange={(e) => set('paymentTerms', e.target.value)}>
                  <option value="">Not set</option>
                  {PAYMENT_TERMS.map((t) => <option key={t} value={t}>{t}</option>)}
                  {f.paymentTerms && !PAYMENT_TERMS.includes(f.paymentTerms as typeof PAYMENT_TERMS[number])
                    && <option value={f.paymentTerms}>{f.paymentTerms}</option>}
                </select>
              </div>
            </div>
            <div className="field">
              <span className="label">How often we invoice them</span>
              <div className="seg seg-small" role="group" aria-label="Invoice cycle">
                {CYCLES.map(([k, label]) => (
                  <button key={k} type="button" className={f.invoiceCycle === k ? 'active' : ''}
                          aria-pressed={f.invoiceCycle === k} onClick={() => set('invoiceCycle', k)}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="muted small" style={{ marginTop: 4 }}>
                {CYCLES.find(([k]) => k === f.invoiceCycle)?.[2]}
              </div>
            </div>
            <div className="row" style={{ alignItems: 'center' }}>
              <label className="check">
                <input type="checkbox" checked={f.gctExempt}
                       onChange={(e) => set('gctExempt', e.target.checked)} />
                GCT exempt
              </label>
              {f.gctExempt && (
                <div className="field grow" style={{ marginBottom: 0, maxWidth: 360 }}>
                  <label htmlFor="cf-gref">Exemption certificate or letter no.</label>
                  <input id="cf-gref" value={f.gctExemptRef} placeholder="Printed on their invoices"
                         onChange={(e) => set('gctExemptRef', e.target.value)} />
                </div>
              )}
            </div>
          </fieldset>

          <fieldset className="form-block">
            <legend>Emails we send them on our own</legend>
            <label className="check">
              <input type="checkbox" checked={f.autoStatements}
                     onChange={(e) => set('autoStatements', e.target.checked)} />
              Monthly statement, when they owe something
            </label>
            <label className="check">
              <input type="checkbox" checked={f.autoReminders}
                     onChange={(e) => set('autoReminders', e.target.checked)} />
              Reminders when an invoice is overdue
            </label>
            <p className="muted small" style={{ margin: '4px 0 0' }}>
              Only sent when automatic emails are switched on under Settings › Automatic emails.
            </p>
          </fieldset>

          <div className="field">
            <label htmlFor="cf-notes">Notes</label>
            <input id="cf-notes" style={{ width: '100%' }} value={f.notes}
                   onChange={(e) => set('notes', e.target.value)} />
          </div>

          <div className="row">
            <button disabled={busy || !f.accountType}>
              {busy ? 'Saving…' : submitLabel ?? (isNew ? 'Add customer' : 'Save changes')}
            </button>
            {onCancel && <button type="button" className="secondary" onClick={onCancel}>Cancel</button>}
          </div>
        </>
      )}
    </form>
  );
}
