import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, type Session } from '../lib/api';
import { money, date, statusTone, toCents, when } from '../lib/format';
import { StatementView } from './Statement';

interface Customer {
  id: string; name: string; phone: string; email: string;
  contact_person: string | null; delivery_address: string | null;
  delivery_zone: string | null; payment_terms: string | null;
  account_type: string | null; price_tier_name: string | null;
  portal_email: string | null; notes: string | null; active: boolean;
}
interface Order {
  id: string; order_number: string; order_date: string; status: string;
  delivery_mode: string; source: string; grand_total_cents: string;
}
interface Invoice {
  invoice_id: string; invoice_number: string; invoice_date: string;
  due_date: string | null; status: string; grand_total_cents: string;
  balance_cents: string; is_credit_note: boolean;
}
interface Payment {
  id: string; payment_date: string; amount_cents: string; method: string | null;
  reference: string | null; is_reversal: boolean; invoice_number: string | null;
}
interface History {
  customer: Customer; orders: Order[]; invoices: Invoice[];
  payments: Payment[]; balanceCents: number;
}
interface Bottles {
  openingHolding: number; delivered: number; returned: number;
  lost: number; closingHolding: number;
}
interface Schedule {
  id: string; orderNumber: string; customerId: string;
  pattern: 'Weekly' | 'Biweekly' | 'Monthly';
  nextDeliveryDate: string | null; paused: boolean; endsOn: string | null;
  deliveryZone: string | null; occurrencesRaised: number; lineSummary: string;
}
interface Unapplied { id: string; customer_id: string; amount_cents: number | string }
interface Tier { id: string; name: string }
interface Zone { id: string; name: string; retired_at: string | null }

const METHODS = ['Cash', 'Cheque', 'Bank Transfer', 'Card'] as const;
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const PAYMENT_TERMS = ['Cash on delivery', 'Net 15', 'Net 30', 'Net 60', 'Net 90'] as const;
const PATTERN_WORDS: Record<Schedule['pattern'], string> = {
  Weekly: 'every week', Biweekly: 'every 2 weeks', Monthly: 'every month',
};

const TABS = [
  ['overview', 'Overview'],
  ['orders', 'Orders'],
  ['standing', 'Standing orders'],
  ['invoices', 'Invoices & statement'],
  ['payments', 'Payments'],
  ['bottles', 'Bottles'],
  ['details', 'Details'],
] as const;
type Tab = (typeof TABS)[number][0];

const BLANK_FORM = {
  name: '', phone: '', email: '', contactPerson: '', deliveryAddress: '',
  deliveryZone: '', routeSequence: '0', priceTierId: '', paymentTerms: '',
  defaultDeliveryDay: '', notes: '',
};

/**
 * One customer, everything about them, on one page.
 *
 * The list screen answers "which customer?"; this answers "what has been going
 * on with them?" - the question actually being asked when somebody rings up.
 * Since the UX review (29 Sep 2026) it is the hub: orders, standing orders,
 * invoices and the statement, payments, bottles and the editable details are
 * tabs here rather than separate screens to search again. The tab is in the
 * address (?tab=orders), so a link can open straight onto one.
 */
export default function CustomerRecord({ session }: { session: Session }) {
  const { customerId } = useParams();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const tab: Tab = TABS.some(([k]) => k === tabParam) ? tabParam as Tab : 'overview';
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    if (t === 'overview') next.delete('tab'); else next.set('tab', t);
    setParams(next, { replace: true });
  };

  const [h, setH] = useState<History | null>(null);
  const [bottles, setBottles] = useState<Bottles | null>(null);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [onAccountCents, setOnAccountCents] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [payOpen, setPayOpen] = useState(false);
  const [pay, setPay] = useState({ amount: '', method: 'Cash', invoiceId: '', reference: '' });
  const [sendOpen, setSendOpen] = useState(false);
  const [sendTo, setSendTo] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  const [form, setForm] = useState({ ...BLANK_FORM });
  const [formLoaded, setFormLoaded] = useState(false);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);

  const load = useCallback(async () => {
    const data = await api.get<History>(`/api/customers/${customerId}/history`);
    setH(data);
    // Everything else is extra: the page still works if any of it fails.
    api.get<Bottles>(`/api/customers/${customerId}/bottles`)
      .then(setBottles).catch(() => setBottles(null));
    api.get<Schedule[]>('/api/recurring')
      .then((all) => setSchedules(all.filter((s) => s.customerId === customerId)))
      .catch(() => setSchedules([]));
    api.get<Unapplied[]>(`/api/payments/unapplied?customerId=${customerId}`)
      .then((rows) => setOnAccountCents(rows
        .filter((r) => r.customer_id === customerId)
        .reduce((s, r) => s + Number(r.amount_cents), 0)))
      .catch(() => setOnAccountCents(0));
  }, [customerId]);

  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  // The More menu closes on a click anywhere else.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  /** The editable record, read fresh each time the Details tab is opened. */
  useEffect(() => {
    if (tab !== 'details') return;
    setFormLoaded(false);
    Promise.all([
      api.get<Record<string, unknown>>(`/api/customers/${customerId}`),
      api.get<Tier[]>('/api/price-tiers'),
      api.get<Zone[]>('/api/zones'),
    ]).then(([c, t, z]) => {
      setForm({
        name: (c.name as string) ?? '',
        phone: (c.phone as string) ?? '',
        email: (c.email as string) ?? '',
        contactPerson: (c.contact_person as string) ?? '',
        deliveryAddress: (c.delivery_address as string) ?? '',
        deliveryZone: (c.delivery_zone as string) ?? '',
        routeSequence: String(c.route_sequence ?? 0),
        priceTierId: (c.price_tier_id as string) ?? '',
        paymentTerms: (c.payment_terms as string) ?? '',
        defaultDeliveryDay: (c.default_delivery_day as string) ?? '',
        notes: (c.notes as string) ?? '',
      });
      setTiers(t);
      setZones(z);
      setFormLoaded(true);
    }).catch((e) => setError(e instanceof Error ? e.message : 'Could not load the details'));
  }, [tab, customerId]);

  async function run(what: () => Promise<void>, fallback: string) {
    setBusy(true); setError(null); setMsg(null);
    try { await what(); await load(); } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    } finally { setBusy(false); }
  }

  async function takePayment(e: React.FormEvent) {
    e.preventDefault();
    await run(async () => {
      await api.post('/api/payments', {
        customerId,
        // Blank means it is not against any one invoice - which is a real
        // thing here, not a fallback. It simply sits on the account.
        invoiceId: pay.invoiceId || null,
        amountCents: toCents(pay.amount),
        method: pay.method,
        reference: pay.reference || null,
      });
      setMsg(`Payment of ${money(toCents(pay.amount))} recorded.`);
      setPay({ amount: '', method: 'Cash', invoiceId: '', reference: '' });
      setPayOpen(false);
    }, 'Could not record the payment');
  }

  async function downloadStatement() {
    if (!h) return;
    setBusy(true); setError(null);
    try {
      const blob = await api.getBlob(`/api/customers/${customerId}/statement.pdf`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `statement-${h.customer.name.replace(/\W+/g, '-')}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not build the statement');
    } finally { setBusy(false); }
  }

  async function emailStatement(e: React.FormEvent) {
    e.preventDefault();
    await run(async () => {
      const r = await api.post<{ sentTo: string }>(
        `/api/customers/${customerId}/statement/email`,
        { sendTo: sendTo || undefined },
      );
      setMsg(`Statement emailed to ${r.sentTo}.`);
      setSendOpen(false); setSendTo('');
    }, 'Could not send the statement');
  }

  async function saveDetails(e: React.FormEvent) {
    e.preventDefault();
    await run(async () => {
      const result = await api.patch<{ warnings: string[] }>(`/api/customers/${customerId}`, {
        name: form.name,
        phone: form.phone,
        email: form.email,
        contactPerson: form.contactPerson || null,
        deliveryAddress: form.deliveryAddress || null,
        deliveryZone: form.deliveryZone || null,
        routeSequence: Number(form.routeSequence) || 0,
        priceTierId: form.priceTierId || null,
        paymentTerms: form.paymentTerms || null,
        defaultDeliveryDay: form.defaultDeliveryDay || null,
        notes: form.notes || null,
      });
      setMsg(`${form.name} saved.` +
        (result.warnings?.length ? ` ${result.warnings.join(' ')}` : ''));
    }, 'Could not save the details');
  }

  const pauseSchedule = (s: Schedule) => run(async () => {
    await api.post(`/api/recurring/${s.id}/pause`, { paused: !s.paused });
    setMsg(s.paused ? 'Standing order resumed.' : 'Standing order paused. It raises nothing until resumed.');
  }, 'Could not change the standing order');

  const endSchedule = (s: Schedule) => run(async () => {
    await api.post(`/api/recurring/${s.id}/end`, {});
    setMsg('Standing order ended. Orders it already raised are not touched.');
  }, 'Could not end the standing order');

  if (error && !h) return <div className="notice error">{error}</div>;
  if (!h) return <p className="muted">Loading…</p>;

  const c = h.customer;
  const open = h.invoices.filter((i) => Number(i.balance_cents) > 0);
  const late = open.filter((i) => i.status === 'Overdue');
  const active = schedules.filter((s) => !s.paused);
  const next = active
    .filter((s) => s.nextDeliveryDate)
    .sort((a, b) => String(a.nextDeliveryDate).localeCompare(String(b.nextDeliveryDate)))[0];
  const set = (k: keyof typeof BLANK_FORM, v: string) => setForm({ ...form, [k]: v });

  /* ---------- pieces, as plain functions returning JSX (never nested components) ---------- */

  const invoiceTable = (rows: Invoice[], empty: string) => (
    <>
      <table>
        <thead>
          <tr>
            <th>Invoice</th><th>Date</th><th>Due</th>
            <th className="num">Total</th><th className="num">Outstanding</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => (
            <tr key={i.invoice_id}>
              <td className="lead">
                <Link to={`/invoices/${i.invoice_id}`}>{i.invoice_number}</Link>
                <span className={`chip ${statusTone(i.status)} phone-only`}>{i.status}</span>
              </td>
              <td data-label="Date">{when(i.invoice_date)}</td>
              <td data-label="Due">{i.due_date ? when(i.due_date) : '—'}</td>
              <td data-label="Total" className="num">{money(Number(i.grand_total_cents))}</td>
              <td data-label="Outstanding" className="num money">
                {money(Number(i.balance_cents))}
              </td>
              <td className="on-desktop">
                <span className={`chip ${statusTone(i.status)}`}>{i.status}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="muted">{empty}</p>}
    </>
  );

  const orderTable = (rows: Order[]) => (
    <>
      <table>
        <thead>
          <tr>
            <th>Order</th><th>Date</th><th>How</th>
            <th className="num">Total</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id}>
              <td className="lead">
                <span>
                  {o.order_number}
                  {o.source === 'Portal' && <div className="muted small">placed by the customer</div>}
                </span>
                <span className={`chip ${statusTone(o.status)} phone-only`}>{o.status}</span>
              </td>
              <td data-label="Date">{when(o.order_date)}</td>
              <td data-label="How" className="small">
                {o.delivery_mode === 'Pickup' ? 'Collection' : o.delivery_mode}
              </td>
              <td data-label="Total" className="num money">{money(Number(o.grand_total_cents))}</td>
              <td className="on-desktop">
                <span className={`chip ${statusTone(o.status)}`}>{o.status}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="muted">No orders yet.</p>}
    </>
  );

  const onAccountNotice = () => (onAccountCents > 0 ? (
    <div className="notice warn" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: 12, marginBottom: 0 }}>
      <span>
        {money(onAccountCents)} paid is on the account, not yet against an invoice.
        It already counts towards what they owe.
      </span>
      <Link to="/payments" style={{ color: 'inherit', fontWeight: 600, whiteSpace: 'nowrap' }}>Apply it</Link>
    </div>
  ) : null);

  const scheduleCard = (s: Schedule) => (
    <div key={s.id} className="panel" style={{ marginBottom: 12 }}>
      <div className="panel-head">
        <h2 style={{ margin: 0, fontSize: 15 }}>
          {s.lineSummary}, {PATTERN_WORDS[s.pattern]}
        </h2>
        {s.paused
          ? <span className="chip warn">Paused</span>
          : <span className="chip ok">Active</span>}
      </div>
      <p className="small" style={{ margin: '4px 0 10px' }}>
        {s.nextDeliveryDate
          ? <>Next: <strong>{when(s.nextDeliveryDate)}</strong></>
          : <span style={{ color: 'var(--bad)' }}>No next delivery date set.</span>}
        <span className="muted">
          {s.deliveryZone ? ` · ${s.deliveryZone} round` : ''} · from {s.orderNumber}
          {s.endsOn ? ` · ends ${when(s.endsOn)}` : ''}
          {' · '}{s.occurrencesRaised} raised so far
        </span>
      </p>
      <div className="row" style={{ gap: 8 }}>
        <Link to="/recurring"><button type="button" className="secondary">Change</button></Link>
        <button type="button" className="secondary" disabled={busy}
                onClick={() => pauseSchedule(s)}>{s.paused ? 'Resume' : 'Pause'}</button>
        <button type="button" className="danger-soft" disabled={busy}
                onClick={() => endSchedule(s)}>End</button>
      </div>
    </div>
  );

  return (
    <>
      <p style={{ marginTop: 0 }}><Link to="/customers">← Customers</Link></p>

      <div className="panel-head record-head">
        <div>
          <h1 style={{ marginBottom: 2 }}>{c.name}</h1>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            {/* Each part labelled. Bare, the account type and the price
                list could both read "Corporate" side by side. */}
            {[
              c.account_type === 'Corporate' ? 'Business account'
                : c.account_type ? `${c.account_type} account` : null,
              c.contact_person ? `Contact: ${c.contact_person}` : null,
              c.delivery_zone ? `${c.delivery_zone} zone` : 'No delivery zone',
              c.price_tier_name ? `${c.price_tier_name} price list` : 'List price',
              c.payment_terms ? `Terms: ${c.payment_terms}` : null,
            ].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="record-actions">
          <button className="secondary" disabled={busy} onClick={downloadStatement}>
            Statement PDF
          </button>
          <Link to={`/orders/new?customer=${c.id}`}>
            <button type="button" className="secondary">New order</button>
          </Link>
          <button disabled={busy}
                  onClick={() => { setPayOpen(!payOpen); setSendOpen(false); }}>
            {payOpen ? 'Close payment' : 'Take a payment'}
          </button>
          <div className="deskbar-menu" ref={moreRef}>
            <button type="button" className="secondary" aria-haspopup="true"
                    aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>
              More ▾
            </button>
            {moreOpen && (
              <div className="deskbar-pop deskbar-pop-right" role="menu">
                <button type="button" role="menuitem" className="pop-item pop-button"
                        onClick={() => { setSendOpen(true); setPayOpen(false); setMoreOpen(false); }}>
                  <span>Send statement by email</span>
                </button>
                <button type="button" role="menuitem" className="pop-item pop-button"
                        onClick={() => { setTab('details'); setMoreOpen(false); }}>
                  <span>Edit details</span>
                </button>
                {session.role === 'admin' && (
                  <Link role="menuitem" className="pop-item" to="/customers">
                    <span>Merge with a duplicate</span>
                    <span className="pop-meta">on the customers list</span>
                  </Link>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      {sendOpen && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Send this statement</h2>
          <p className="muted small">
            Emails the same PDF the Statement PDF button downloads. Leave the address
            blank to use the one on the customer record.
          </p>
          <form onSubmit={emailStatement}>
            <div className="row">
              <div className="field" style={{ flex: '1 1 300px' }}>
                <label htmlFor="sendto">Send to</label>
                <input id="sendto" type="email" style={{ width: '100%' }} value={sendTo}
                       placeholder={c.email || 'no address on file'}
                       onChange={(e) => setSendTo(e.target.value)} />
              </div>
              <div className="field">
                <button disabled={busy}>{busy ? 'Sending…' : 'Send'}</button>{' '}
                <button type="button" className="secondary" onClick={() => setSendOpen(false)}>
                  Close
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {payOpen && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Take a payment from {c.name}</h2>
          <form onSubmit={takePayment}>
            <div className="row">
              <div className="field">
                <label htmlFor="amt">Amount</label>
                <input id="amt" type="number" step="0.01" min="0" required
                       style={{ width: 140 }} value={pay.amount}
                       onChange={(e) => setPay({ ...pay, amount: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="pm">How</label>
                <select id="pm" value={pay.method}
                        onChange={(e) => setPay({ ...pay, method: e.target.value })}>
                  {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div className="field" style={{ flex: '1 1 260px' }}>
                <label htmlFor="inv">Against which invoice?</label>
                <select id="inv" style={{ width: '100%' }} value={pay.invoiceId}
                        onChange={(e) => setPay({ ...pay, invoiceId: e.target.value })}>
                  <option value="">Leave it on the account</option>
                  {open.map((i) => (
                    <option key={i.invoice_id} value={i.invoice_id}>
                      {i.invoice_number} — {money(Number(i.balance_cents))} outstanding
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="ref">Reference</label>
                <input id="ref" style={{ width: 160 }} value={pay.reference}
                       placeholder="cheque no., slip"
                       onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
              </div>
              <div className="field">
                <button disabled={busy || !(Number(pay.amount) > 0)}>
                  {busy ? 'Recording…' : 'Record payment'}
                </button>
              </div>
            </div>
            {!pay.invoiceId && (
              <p className="muted small" style={{ margin: 0 }}>
                Money left on the account is not applied to anything until somebody
                puts it against an invoice. It still counts towards what they owe.
              </p>
            )}
          </form>
        </div>
      )}

      <div className="figures">
        <div className="fig">
          <div className="fig-label">{h.balanceCents < 0 ? 'In credit' : 'Owes'}</div>
          <div className="fig-value">{money(Math.abs(h.balanceCents))}</div>
          <div className={`fig-sub${late.length ? ' bad' : ''}`}>
            {open.length} open invoice{open.length === 1 ? '' : 's'}
            {late.length ? `, ${late.length} overdue` : open.length ? ', none late' : ''}
          </div>
        </div>
        <div className="fig">
          <div className="fig-label">Next delivery</div>
          <div className="fig-value" style={{ fontSize: next ? 22 : 17 }}>
            {next ? when(next.nextDeliveryDate) : 'None booked'}
          </div>
          <div className="fig-sub">
            {next ? `${next.lineSummary}, ${PATTERN_WORDS[next.pattern]}` : 'no standing order'}
          </div>
        </div>
        <div className="fig">
          <div className="fig-label">Bottles held</div>
          <div className="fig-value">{bottles ? bottles.closingHolding : '—'}</div>
          <div className="fig-sub">
            {bottles ? `${bottles.delivered} out, ${bottles.returned} back` : 'no returnables'}
          </div>
        </div>
        <div className="fig">
          <div className="fig-label">Portal</div>
          <div className="fig-value" style={{ fontSize: 17 }}>
            {c.portal_email ? 'Signed up' : 'Not signed up'}
          </div>
          <div className="fig-sub">{c.portal_email ?? 'cannot order online'}</div>
        </div>
      </div>

      <nav className="tabs" aria-label="Customer sections">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" className={`tab${tab === key ? ' active' : ''}`}
                  aria-current={tab === key ? 'page' : undefined}
                  onClick={() => setTab(key)}>
            {label}
            {key === 'standing' && schedules.length > 0 && (
              <span className="tab-count">{schedules.length}</span>
            )}
            {key === 'invoices' && open.length > 0 && (
              <span className="tab-count">{open.length}</span>
            )}
          </button>
        ))}
      </nav>

      {tab === 'overview' && (
        <div className="split record-split">
          <div>
            <div className="panel phone-cards">
              <div className="panel-head">
                <h2>Open invoices</h2>
                <button type="button" className="as-link small"
                        onClick={() => setTab('invoices')}>Full statement</button>
              </div>
              {invoiceTable(open, 'Nothing outstanding.')}
              {onAccountNotice()}
            </div>
            <div className="panel phone-cards">
              <div className="panel-head">
                <h2>Recent orders</h2>
                <button type="button" className="as-link small"
                        onClick={() => setTab('orders')}>All orders</button>
              </div>
              {orderTable(h.orders.slice(0, 5))}
            </div>
          </div>
          <div>
            {schedules.length > 0
              ? schedules.map(scheduleCard)
              : (
                <div className="panel">
                  <h2 style={{ marginTop: 0, fontSize: 15 }}>Standing order</h2>
                  <p className="muted small" style={{ margin: 0 }}>
                    None. Use Repeat… on one of their orders to make it a standing order.
                  </p>
                </div>
              )}
            <div className="panel">
              <div className="panel-head">
                <h2 style={{ margin: 0, fontSize: 15 }}>Delivery and contact</h2>
                <button type="button" className="as-link small"
                        onClick={() => setTab('details')}>Edit</button>
              </div>
              <p style={{ margin: '8px 0 4px' }}>{c.delivery_address ?? <span className="muted">No address on file</span>}</p>
              <p className="small" style={{ margin: 0 }}>{c.phone}</p>
              <p className="small" style={{ margin: 0 }}>{c.email}</p>
              {c.notes && <p className="muted small" style={{ margin: '8px 0 0' }}>{c.notes}</p>}
            </div>
          </div>
        </div>
      )}

      {tab === 'orders' && (
        <div className="panel phone-cards">
          <div className="panel-head">
            <h2>Orders</h2>
            <Link className="small" to={`/orders/new?customer=${c.id}`}>New order for {c.name}</Link>
          </div>
          {orderTable(h.orders)}
          {h.orders.length >= 25 && (
            <p className="muted small">The most recent 25. The Orders screen has the rest.</p>
          )}
        </div>
      )}

      {tab === 'standing' && (
        <>
          {schedules.map(scheduleCard)}
          {schedules.length === 0 && (
            <div className="panel">
              <p className="muted" style={{ margin: 0 }}>
                No standing order. On the Orders tab, or the Orders screen, press
                Repeat… on an order to have it raised for them every week, 2 weeks or month.
              </p>
            </div>
          )}
        </>
      )}

      {tab === 'invoices' && (
        <>
          <div className="panel phone-cards">
            <h2 style={{ marginTop: 0 }}>Invoices</h2>
            {invoiceTable(h.invoices, 'No invoices yet.')}
            {onAccountNotice()}
          </div>
          <StatementView customerId={c.id} />
        </>
      )}

      {tab === 'payments' && (
        <div className="panel phone-cards">
          <div className="panel-head">
            <h2>Payments</h2>
            {!payOpen && (
              <button type="button" onClick={() => setPayOpen(true)}>Take a payment</button>
            )}
          </div>
          <table>
            <thead>
              <tr>
                <th>Date</th><th>Against</th><th>How</th>
                <th>Reference</th><th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {h.payments.map((p) => (
                <tr key={p.id}>
                  <td className="lead">
                    <span>{when(p.payment_date)}</span>
                    {p.is_reversal && <span className="chip bad">reversed</span>}
                  </td>
                  <td data-label="Against">
                    {p.invoice_number ?? <span className="muted">left on account</span>}
                  </td>
                  <td data-label="How">{p.method ?? '—'}</td>
                  <td data-label="Reference" className="small muted">{p.reference ?? '—'}</td>
                  <td data-label="Amount" className="num money">{money(Number(p.amount_cents))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {h.payments.length === 0 && <p className="muted">Nothing paid yet.</p>}
          {onAccountNotice()}
        </div>
      )}

      {tab === 'bottles' && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>5-gallon bottles</h2>
          {bottles ? (
            <>
              <div className="aging" style={{ marginBottom: 12 }}>
                <div className="age"><b>Delivered full</b><span>{bottles.delivered}</span></div>
                <div className="age"><b>Empties back</b><span>{bottles.returned}</span></div>
                <div className="age"><b>Lost or damaged</b><span>{bottles.lost}</span></div>
                <div className="age"><b>Holding now</b><span>{bottles.closingHolding}</span></div>
              </div>
              <p className="muted small" style={{ margin: 0 }}>
                From every delivery recorded for them. Bottles lost or damaged are a
                business loss and are never charged to the customer. The statement
                shows the same count for any date range.{' '}
                <Link to="/bottle-pool">Bottle pool</Link>
              </p>
            </>
          ) : <p className="muted" style={{ margin: 0 }}>They have never had 5-gallon bottles.</p>}
        </div>
      )}

      {tab === 'details' && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Details</h2>
          {!formLoaded ? <p className="muted">Loading…</p> : (
            <form onSubmit={saveDetails}>
              <div className="row">
                <div className="field" style={{ flex: '1 1 240px' }}>
                  <label htmlFor="d-name">Name</label>
                  <input id="d-name" required style={{ width: '100%' }} value={form.name}
                         onChange={(e) => set('name', e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="d-phone">Phone</label>
                  <input id="d-phone" required value={form.phone}
                         onChange={(e) => set('phone', e.target.value)} />
                </div>
                <div className="field" style={{ flex: '1 1 220px' }}>
                  <label htmlFor="d-email">Email</label>
                  <input id="d-email" type="email" required style={{ width: '100%' }}
                         value={form.email} onChange={(e) => set('email', e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="d-contact">Contact person</label>
                  <input id="d-contact" value={form.contactPerson}
                         onChange={(e) => set('contactPerson', e.target.value)} />
                </div>
              </div>
              <div className="row">
                <div className="field" style={{ flex: '1 1 300px' }}>
                  <label htmlFor="d-addr">Delivery address</label>
                  <input id="d-addr" style={{ width: '100%' }} value={form.deliveryAddress}
                         onChange={(e) => set('deliveryAddress', e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="d-zone">Delivery zone</label>
                  <select id="d-zone" value={form.deliveryZone}
                          onChange={(e) => set('deliveryZone', e.target.value)}>
                    <option value="">None (collects or walks in)</option>
                    {zones.filter((z) => !z.retired_at || z.name === form.deliveryZone)
                      .map((z) => <option key={z.id} value={z.name}>{z.name}</option>)}
                    {/* A zone typed before zones became a managed list keeps
                        showing, rather than silently reading as None. */}
                    {form.deliveryZone && !zones.some((z) => z.name === form.deliveryZone) && (
                      <option value={form.deliveryZone}>{form.deliveryZone} (not a listed zone)</option>
                    )}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="d-seq">Visit order on the round</label>
                  <input id="d-seq" type="number" min="0" style={{ width: 110 }}
                         value={form.routeSequence}
                         onChange={(e) => set('routeSequence', e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="d-day">Usual delivery day</label>
                  <select id="d-day" value={form.defaultDeliveryDay}
                          onChange={(e) => set('defaultDeliveryDay', e.target.value)}>
                    <option value="">—</option>
                    {DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
              </div>
              <div className="row">
                <div className="field">
                  <label htmlFor="d-tier">Price list</label>
                  <select id="d-tier" value={form.priceTierId}
                          onChange={(e) => set('priceTierId', e.target.value)}>
                    <option value="">List price</option>
                    {tiers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="d-terms">Payment terms</label>
                  <select id="d-terms" value={form.paymentTerms}
                          onChange={(e) => set('paymentTerms', e.target.value)}>
                    <option value="">Not set</option>
                    {PAYMENT_TERMS.map((t) => <option key={t} value={t}>{t}</option>)}
                    {form.paymentTerms
                      && !PAYMENT_TERMS.includes(form.paymentTerms as typeof PAYMENT_TERMS[number])
                      && <option value={form.paymentTerms}>{form.paymentTerms}</option>}
                  </select>
                </div>
                <div className="field" style={{ flex: '1 1 260px' }}>
                  <label htmlFor="d-notes">Notes</label>
                  <input id="d-notes" style={{ width: '100%' }} value={form.notes}
                         onChange={(e) => set('notes', e.target.value)} />
                </div>
              </div>
              {!form.deliveryZone && (
                <div className="notice warn">
                  Without a delivery zone, their delivery orders cannot be put on a
                  round automatically. Leave it blank only for customers who collect
                  or walk in.
                </div>
              )}
              <button disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
            </form>
          )}
        </div>
      )}
    </>
  );
}
