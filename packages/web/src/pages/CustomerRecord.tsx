import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, downloadPost, type Session } from '../lib/api';
import { payMethods, useTakeCard } from '../lib/payments';
import { money, date, statusTone, toCents, todayInJamaica, when } from '../lib/format';
import { StatementView } from './Statement';
import CustomerForm, { customerToForm, formToPayload, BLANK_CUSTOMER, type CustomerFormValues } from '../components/CustomerForm';
import { AddressesPanel, SpecialPricesPanel } from '../components/CustomerExtras';

interface Customer {
  id: string; name: string; phone: string; email: string;
  contact_person: string | null; delivery_address: string | null;
  delivery_zone: string | null; payment_terms: string | null;
  account_type: string | null; price_tier_name: string | null;
  portal_email: string | null; notes: string | null; active: boolean;
  invoice_cycle?: string | null; gct_exempt?: boolean; delivery_days?: string[] | null;
}
interface Waiting {
  kind: string; orderNumber: string; date: string; subtotalCents: number;
}
interface Order {
  id: string; order_number: string; order_date: string; status: string;
  delivery_mode: string; source: string; grand_total_cents: string;
  requested_delivery_date?: string | null; fulfilled_on?: string | null;
  customer_po?: string | null; needs_review?: boolean; lines_summary?: string | null;
  events?: Array<{ kind: string; from: string; to: string; reason: string | null }>;
}
interface Invoice {
  invoice_id: string; invoice_number: string; invoice_date: string;
  due_date: string | null; status: string; grand_total_cents: string;
  balance_cents: string; is_credit_note: boolean;
}
interface Payment {
  id: string; payment_date: string; amount_cents: string; method: string | null;
  reference: string | null; is_reversal: boolean; invoice_number: string | null;
  invoice_id?: string | null; reversed?: boolean;
}
interface History {
  customer: Customer; orders: Order[]; invoices: Invoice[];
  payments: Payment[]; balanceCents: number; overdueCents?: number; overdueInvoices?: number;
}
interface PickCustomer { id: string; name: string }
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
const METHODS = ['Cash', 'Cheque', 'Bank Transfer', 'Card'] as const;
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
  const takeCard = useTakeCard();
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
  const [pay, setPay] = useState({ amount: '', method: 'Cash', date: '', reference: '', receipt: true });
  /** How much of the payment goes on each open invoice (point 11.1). */
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  /** Changing a posted payment (point 11.2). */
  const [change, setChange] = useState<{
    p: Payment; amount: string; date: string; method: string; reference: string;
    customerId: string; invoiceId: string; reason: string;
  } | null>(null);
  const [allCustomers, setAllCustomers] = useState<PickCustomer[]>([]);
  const [targetInvoices, setTargetInvoices] = useState<Invoice[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [waiting, setWaiting] = useState<Waiting[]>([]);
  const [sendOpen, setSendOpen] = useState(false);
  const [sendTo, setSendTo] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  const [form, setForm] = useState<CustomerFormValues>({ ...BLANK_CUSTOMER });
  const [formLoaded, setFormLoaded] = useState(false);

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
    api.get<Waiting[]>(`/api/customers/${customerId}/uninvoiced`)
      .then(setWaiting).catch(() => setWaiting([]));
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
    api.get<Record<string, unknown>>(`/api/customers/${customerId}`).then((c) => {
      setForm(customerToForm(c));
      setFormLoaded(true);
    }).catch((e) => setError(e instanceof Error ? e.message : 'Could not load the details'));
  }, [tab, customerId]);

  async function run(what: () => Promise<void>, fallback: string) {
    setBusy(true); setError(null); setMsg(null);
    try { await what(); await load(); } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    } finally { setBusy(false); }
  }

  const allocatedCents = Object.values(alloc).reduce((t, v) => t + toCents(v || '0'), 0);
  const payCents = pay.amount ? toCents(pay.amount) : allocatedCents;

  async function takePayment(e: React.FormEvent) {
    e.preventDefault();
    await run(async () => {
      const allocations = Object.entries(alloc)
        .map(([invoiceId, v]) => ({ invoiceId, amountCents: toCents(v || '0') }))
        .filter((a) => a.amountCents > 0);
      const r = await api.post<{
        allocatedCents: number; unappliedCents: number;
        receipt?: { sentTo: string; receiptNumber: string }; receiptError?: string;
      }>('/api/payments/receive', {
        customerId,
        amountCents: payCents,
        method: pay.method,
        paymentDate: pay.date || null,
        reference: pay.reference || null,
        allocations,
        sendReceipt: pay.receipt,
      });
      setMsg(`Payment of ${money(payCents)} recorded`
        + (r.allocatedCents ? `, ${money(r.allocatedCents)} against ${allocations.length} invoice${allocations.length === 1 ? '' : 's'}` : '')
        + (r.unappliedCents ? `, ${money(r.unappliedCents)} left on the account` : '') + '.'
        + (r.receipt ? ` Receipt ${r.receipt.receiptNumber} emailed to ${r.receipt.sentTo}.` : '')
        + (r.receiptError ? ` No receipt was sent: ${r.receiptError}` : ''));
      setPay({ amount: '', method: 'Cash', date: '', reference: '', receipt: true });
      setAlloc({});
      setPayOpen(false);
    }, 'Could not record the payment');
  }

  /** Fill an invoice up to what it owes, or as far as the amount typed reaches. */
  function fillInvoice(i: Invoice, on: boolean) {
    setAlloc((cur) => {
      const next = { ...cur };
      if (!on) { delete next[i.invoice_id]; return next; }
      const owed = Number(i.balance_cents);
      if (!pay.amount) { next[i.invoice_id] = (owed / 100).toFixed(2); return next; }
      const used = Object.entries(next).filter(([k]) => k !== i.invoice_id)
        .reduce((t, [, v]) => t + toCents(v || '0'), 0);
      const room = Math.max(toCents(pay.amount) - used, 0);
      const take = Math.min(owed, room);
      if (take > 0) next[i.invoice_id] = (take / 100).toFixed(2);
      return next;
    });
  }

  async function openChange(p: Payment) {
    setChange({
      p, amount: (Number(p.amount_cents) / 100).toFixed(2), date: p.payment_date, method: p.method ?? 'Cash',
      reference: p.reference ?? '', customerId: customerId!, invoiceId: p.invoice_id ?? '', reason: '',
    });
    if (allCustomers.length === 0) api.get<PickCustomer[]>('/api/customers').then(setAllCustomers).catch(() => {});
  }
  useEffect(() => {
    if (!change) return;
    api.get<Invoice[]>(`/api/invoices?customerId=${change.customerId}`)
      .then((rows) => setTargetInvoices(rows.filter((i) => !i.is_credit_note && i.status !== 'Cancelled')))
      .catch(() => setTargetInvoices([]));
  }, [change?.customerId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submitChange(e: React.FormEvent) {
    e.preventDefault();
    if (!change) return;
    const p = change.p;
    const changes: Record<string, unknown> = {};
    if (toCents(change.amount) !== Number(p.amount_cents)) changes.amountCents = toCents(change.amount);
    if (change.date && change.date !== p.payment_date) changes.paymentDate = change.date;
    if (change.method !== (p.method ?? '')) changes.method = change.method;
    if (change.reference !== (p.reference ?? '')) changes.reference = change.reference;
    if (change.customerId !== customerId) changes.customerId = change.customerId;
    if ((change.invoiceId || null) !== (p.invoice_id ?? null) || change.customerId !== customerId) {
      changes.invoiceId = change.invoiceId || null;
    }
    await run(async () => {
      const r = await api.post<{ applied: boolean }>(`/api/payments/${p.id}/change`, { changes, reason: change.reason });
      setMsg(r.applied ? 'Payment changed.' : 'Change sent to an administrator for approval. Nothing moves until it is approved.');
      setChange(null);
    }, 'Could not change the payment');
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

  async function saveDetails(v: CustomerFormValues) {
    await run(async () => {
      const result = await api.patch<{ warnings: string[] }>(`/api/customers/${customerId}`, formToPayload(v));
      setForm(v);
      setMsg(`${v.name} saved.` +
        (result.warnings?.length ? ` ${result.warnings.join(' ')}` : ''));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 'Could not save the details');
  }

  /** Several open invoices: one PDF, or one email with that PDF attached. */
  const emailPicked = () => run(async () => {
    const r = await api.post<{ sentTo: string; invoiceNumbers: string[] }>(
      '/api/invoices/email-batch', { invoiceIds: picked });
    setMsg(`${r.invoiceNumbers.length} invoice${r.invoiceNumbers.length === 1 ? '' : 's'} `
      + `(${r.invoiceNumbers.join(', ')}) emailed to ${r.sentTo} in one PDF.`);
    setPicked([]);
  }, 'Could not send the invoices');
  const downloadPicked = () => run(async () => {
    await downloadPost('/api/invoices/batch.pdf', { invoiceIds: picked },
      `invoices-${(h?.customer.name ?? 'customer').replace(/\W+/g, '-')}.pdf`);
  }, 'Could not build the PDF');
  const invoiceNow = () => run(async () => {
    const r = await api.post<{ invoiceNumber: string; deliveries: number; totalCents: number }>(
      `/api/customers/${customerId}/invoice-now`, {});
    setMsg(`Invoice ${r.invoiceNumber} raised for ${r.deliveries} ${r.deliveries === 1 ? 'delivery' : 'deliveries'}, ${money(r.totalCents)}.`);
  }, 'Could not raise the invoice');

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
  const completed = h.orders.filter((o) => o.status === 'Delivered').slice(0, 5);
  const pendingOrders = h.orders.filter((o) => o.status === 'Pending' || o.status === 'Partially Delivered');
  const nextPending = pendingOrders.filter((o) => o.requested_delivery_date)
    .sort((a, b) => String(a.requested_delivery_date).localeCompare(String(b.requested_delivery_date)))[0];
  const active = schedules.filter((s) => !s.paused);
  const next = active
    .filter((s) => s.nextDeliveryDate)
    .sort((a, b) => String(a.nextDeliveryDate).localeCompare(String(b.nextDeliveryDate)))[0];

  /* ---------- pieces, as plain functions returning JSX (never nested components) ---------- */

  const invoiceTable = (rows: Invoice[], empty: string, tickable = false) => (
    <>
      <table>
        <thead>
          <tr>
            {tickable && <th className="tick-col" aria-label="Choose" />}
            <th>Invoice</th><th>Date</th><th>Due</th>
            <th className="num">Total</th><th className="num">Outstanding</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => (
            <tr key={i.invoice_id}>
              {tickable && (
                <td className="tick-col">
                  {!i.is_credit_note && i.status !== 'Cancelled' && (
                    <input type="checkbox" aria-label={`Choose ${i.invoice_number}`}
                           checked={picked.includes(i.invoice_id)}
                           onChange={(e) => setPicked((cur) => (e.target.checked
                             ? [...cur, i.invoice_id] : cur.filter((x) => x !== i.invoice_id)))} />
                  )}
                </td>
              )}
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

  const orderTable = (rows: Order[], empty = 'No orders yet.', dateLabel = 'Delivery') => (
    <>
      <table>
        <thead>
          <tr>
            <th>Order</th><th>{dateLabel}</th><th>How</th>
            <th className="num">Total</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id}>
              <td className="lead">
                <span>
                  <Link to={`/orders?find=${o.order_number}`}>{o.order_number}</Link>
                  {o.lines_summary && <div className="muted small">{o.lines_summary.replace(/Alka Vida\s+/gi, '')}</div>}
                  {o.source === 'Portal' && <div className="muted small">placed by the customer</div>}
                  {o.customer_po && <div className="muted small">PO {o.customer_po}</div>}
                  {(o.events?.length ?? 0) > 0 && (
                    <ul className="order-events">
                      {o.events!.map((ev, k) => (
                        <li key={k} className={ev.kind === 'Part delivered' ? 'part' : undefined}>
                          {ev.kind === 'Rescheduled'
                            ? `Rescheduled from ${when(ev.from)} to ${when(ev.to)}${ev.reason ? ` (${ev.reason})` : ''}`
                            : `Part delivered ${when(ev.from)}; rest ${when(ev.to)}`}
                        </li>
                      ))}
                    </ul>
                  )}
                </span>
                <span className={`chip ${statusTone(o.status)} phone-only`}>{o.needs_review ? 'Needs approval' : o.status}</span>
              </td>
              <td data-label={dateLabel}>{when(o.fulfilled_on ?? o.requested_delivery_date ?? o.order_date)}</td>
              <td data-label="How" className="small">
                {o.delivery_mode === 'Pickup' ? 'Collection' : o.delivery_mode}
              </td>
              <td data-label="Total" className="num money">{money(Number(o.grand_total_cents))}</td>
              <td className="on-desktop">
                <span className={`chip ${o.needs_review ? 'warn' : statusTone(o.status)}`}>{o.needs_review ? 'Needs approval' : o.status}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="muted">{empty}</p>}
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
              c.invoice_cycle === 'Weekly' ? 'Invoiced weekly'
                : c.invoice_cycle === 'Monthly' ? 'Invoiced monthly'
                  : c.payment_terms ? `Terms: ${c.payment_terms}` : null,
              c.delivery_days?.length ? `Delivers ${c.delivery_days.join(', ')}` : null,
              c.gct_exempt ? 'GCT exempt' : null,
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
                <Link role="menuitem" className="pop-item" to={`/quotes/new?customer=${c.id}`}>
                  <span>New quote</span>
                </Link>
                <Link role="menuitem" className="pop-item" to={`/credit-notes?new=1&customer=${c.id}`}>
                  <span>New credit note</span>
                </Link>
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
                <label htmlFor="amt">Amount received</label>
                <input id="amt" type="number" step="0.01" min="0"
                       style={{ width: 140 }} value={pay.amount}
                       placeholder={allocatedCents ? (allocatedCents / 100).toFixed(2) : ''}
                       onChange={(e) => setPay({ ...pay, amount: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="pdate">Date paid</label>
                <input id="pdate" type="date" value={pay.date} max={todayInJamaica()}
                       onChange={(e) => setPay({ ...pay, date: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="pm">How</label>
                <select id="pm" value={pay.method}
                        onChange={(e) => setPay({ ...pay, method: e.target.value })}>
                  {payMethods(METHODS, takeCard, pay.method).map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="ref">Reference</label>
                <input id="ref" style={{ width: 160 }} value={pay.reference}
                       placeholder="cheque no., slip"
                       onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
              </div>
            </div>

            {open.filter((i) => !i.is_credit_note).length > 0 && (
              <>
                <div className="panel-head" style={{ marginTop: 6 }}>
                  <span className="label" style={{ margin: 0 }}>Which invoices does it pay?</span>
                  <span className="row" style={{ gap: 10 }}>
                    <button type="button" className="as-link small"
                            onClick={() => { setAlloc({}); open.filter((i) => !i.is_credit_note).forEach((i) => fillInvoice(i, true)); }}>
                      Tick them all
                    </button>
                    <button type="button" className="as-link small" onClick={() => setAlloc({})}>Clear</button>
                  </span>
                </div>
                <table className="alloc-table">
                  <thead><tr><th className="tick-col" /><th>Invoice</th><th>Due</th><th className="num">Owed</th><th className="num">Apply</th></tr></thead>
                  <tbody>
                    {open.filter((i) => !i.is_credit_note).map((i) => {
                      const v = alloc[i.invoice_id] ?? '';
                      return (
                        <tr key={i.invoice_id}>
                          <td className="tick-col">
                            <input type="checkbox" aria-label={`Pay ${i.invoice_number}`}
                                   checked={toCents(v || '0') > 0}
                                   onChange={(e) => fillInvoice(i, e.target.checked)} />
                          </td>
                          <td>{i.invoice_number}{i.status === 'Overdue' && <span className="chip bad" style={{ marginLeft: 6 }}>overdue</span>}</td>
                          <td className="small">{i.due_date ? when(i.due_date) : '—'}</td>
                          <td className="num">{money(Number(i.balance_cents))}</td>
                          <td className="num">
                            <input type="number" step="0.01" min="0" value={v} aria-label={`Amount for ${i.invoice_number}`}
                                   onChange={(e) => setAlloc({ ...alloc, [i.invoice_id]: e.target.value })} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </>
            )}
            <div style={{ maxWidth: 360, marginTop: 8 }}>
              <div className="total-line"><span>Received</span><span>{money(payCents)}</span></div>
              <div className="total-line"><span>Against invoices</span><span>{money(allocatedCents)}</span></div>
              <div className="total-line"><span>Left on the account</span><span>{money(Math.max(payCents - allocatedCents, 0))}</span></div>
            </div>
            {allocatedCents > payCents && (
              <div className="notice warn">More is applied to invoices than was received. Lower an amount or the total.</div>
            )}
            <label className="check">
              <input type="checkbox" checked={pay.receipt}
                     onChange={(e) => setPay({ ...pay, receipt: e.target.checked })} />
              Email a receipt to {c.email || 'them (no address on file)'}
            </label>
            <button disabled={busy || !(payCents > 0) || allocatedCents > payCents}>
              {busy ? 'Recording…' : `Record ${money(payCents)}`}
            </button>
          </form>
        </div>
      )}

      {change && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Change the payment of {money(Number(change.p.amount_cents))} on {when(change.p.payment_date)}</h2>
          <form onSubmit={submitChange}>
            <div className="row">
              <div className="field">
                <label htmlFor="ch-amt">Amount</label>
                <input id="ch-amt" type="number" step="0.01" min="0" style={{ width: 130 }} value={change.amount}
                       onChange={(e) => setChange({ ...change, amount: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="ch-date">Date paid</label>
                <input id="ch-date" type="date" value={change.date} onChange={(e) => setChange({ ...change, date: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="ch-m">How</label>
                <select id="ch-m" value={change.method} onChange={(e) => setChange({ ...change, method: e.target.value })}>
                  {payMethods(METHODS, takeCard, change.method).map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="ch-ref">Reference</label>
                <input id="ch-ref" value={change.reference} onChange={(e) => setChange({ ...change, reference: e.target.value })} />
              </div>
            </div>
            <div className="row">
              <div className="field grow">
                <label htmlFor="ch-c">Customer</label>
                <select id="ch-c" value={change.customerId}
                        onChange={(e) => setChange({ ...change, customerId: e.target.value, invoiceId: '' })}>
                  <option value={customerId}>{c.name} (this customer)</option>
                  {allCustomers.filter((x) => x.id !== customerId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </div>
              <div className="field grow">
                <label htmlFor="ch-i">Against</label>
                <select id="ch-i" value={change.invoiceId} onChange={(e) => setChange({ ...change, invoiceId: e.target.value })}>
                  <option value="">Nothing in particular (on the account)</option>
                  {targetInvoices.filter((i) => Number(i.balance_cents) > 0 || i.invoice_id === change.p.invoice_id).map((i) => (
                    <option key={i.invoice_id} value={i.invoice_id}>{i.invoice_number} — {money(Number(i.balance_cents))} owed</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field">
              <label htmlFor="ch-why">Why? (required)</label>
              <input id="ch-why" style={{ width: '100%' }} value={change.reason} required
                     onChange={(e) => setChange({ ...change, reason: e.target.value })} />
            </div>
            <p className="muted small">
              {session.role === 'admin'
                ? 'As an administrator your change applies straight away. A different amount reverses the original and posts the correct one, so both stay on the record.'
                : 'This goes to an administrator to approve. Nothing changes until they do.'}
            </p>
            <div className="row" style={{ gap: 8 }}>
              <button disabled={busy || !change.reason.trim()}>{session.role === 'admin' ? 'Change it' : 'Ask for approval'}</button>
              <button type="button" className="secondary" onClick={() => setChange(null)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div className="figures">
        <div className="fig">
          <div className="fig-label">{h.balanceCents < 0 ? 'In credit' : 'Owes'}</div>
          <div className="fig-value">{money(Math.abs(h.balanceCents))}</div>
          <div className={`fig-sub${(h.overdueCents ?? 0) > 0 ? ' bad' : ''}`}>
            {(h.overdueCents ?? 0) > 0
              ? `${money(h.overdueCents ?? 0)} overdue (${h.overdueInvoices} invoice${h.overdueInvoices === 1 ? '' : 's'})`
              : `${open.length} open invoice${open.length === 1 ? '' : 's'}${open.length ? ', none late' : ''}`}
          </div>
        </div>
        <div className="fig">
          <div className="fig-label">Next delivery</div>
          <div className="fig-value" style={{ fontSize: next || nextPending ? 22 : 17 }}>
            {nextPending?.requested_delivery_date && (!next || String(nextPending.requested_delivery_date) <= String(next.nextDeliveryDate))
              ? when(nextPending.requested_delivery_date)
              : next ? when(next.nextDeliveryDate) : 'None booked'}
          </div>
          <div className="fig-sub">
            {nextPending?.requested_delivery_date && (!next || String(nextPending.requested_delivery_date) <= String(next.nextDeliveryDate))
              ? `${nextPending.order_number}${nextPending.lines_summary ? `, ${nextPending.lines_summary.replace(/Alka Vida\s+/gi, '')}` : ''}`
              : next ? `${next.lineSummary}, ${PATTERN_WORDS[next.pattern]}` : 'nothing on order'}
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
                <h2>Recent orders</h2>
                <button type="button" className="as-link small"
                        onClick={() => setTab('orders')}>All orders</button>
              </div>
              {orderTable(completed, 'Nothing delivered yet.', 'Delivered')}
              {onAccountNotice()}
            </div>
            <div className="panel phone-cards">
              <div className="panel-head">
                <h2>Pending orders</h2>
                <Link className="small" to={`/orders/new?customer=${c.id}`}>New order</Link>
              </div>
              {orderTable(pendingOrders, 'Nothing waiting to be delivered.', 'Delivery')}
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
          {(waiting.length > 0 || (c.invoice_cycle && c.invoice_cycle !== 'PerDelivery')) && (
            <div className="panel">
              <div className="panel-head">
                <h2>Delivered, waiting for their {c.invoice_cycle === 'Weekly' ? 'weekly' : c.invoice_cycle === 'Monthly' ? 'monthly' : ''} invoice</h2>
                {waiting.length > 0 && (
                  <button type="button" className="secondary" disabled={busy} onClick={invoiceNow}>Invoice now</button>
                )}
              </div>
              {waiting.length === 0 ? (
                <p className="muted small" style={{ margin: 0 }}>Nothing waiting. Deliveries collect here until the
                  {c.invoice_cycle === 'Weekly' ? ' week (Mon–Sun) closes; the invoice is raised on the Monday.'
                    : ' month closes; the invoice is raised on the 1st.'}</p>
              ) : (
                <>
                  <table>
                    <thead><tr><th>Date</th><th>Order</th><th>How</th><th className="num">Before GCT</th></tr></thead>
                    <tbody>
                      {waiting.map((w) => (
                        <tr key={`${w.orderNumber}-${w.date}`}>
                          <td>{when(w.date)}</td><td>{w.orderNumber}</td><td className="small">{w.kind}</td>
                          <td className="num">{money(w.subtotalCents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="muted small" style={{ marginBottom: 0 }}>
                    Raised automatically when the {c.invoice_cycle === 'Weekly' ? 'week' : 'month'} closes, due on
                    receipt. Money they pay in the meantime is applied to it straight away.
                    "Invoice now" raises it today for everything listed.
                  </p>
                </>
              )}
            </div>
          )}
          <div className="panel phone-cards">
            <h2 style={{ marginTop: 0 }}>Invoices</h2>
            {picked.length > 0 ? (
              <div className="batch-bar">
                <span>{picked.length} chosen · {money(h.invoices.filter((i) => picked.includes(i.invoice_id))
                  .reduce((a, i) => a + Number(i.balance_cents), 0))} still owed on them</span>
                <span className="row" style={{ gap: 6 }}>
                  <button type="button" disabled={busy} onClick={emailPicked}>Email them together</button>
                  <button type="button" className="secondary" disabled={busy} onClick={downloadPicked}>One PDF</button>
                  <button type="button" className="secondary" onClick={() => setPicked([])}>Clear</button>
                </span>
              </div>
            ) : open.length > 1 && (
              <p className="muted small" style={{ marginTop: 0 }}>
                Tick invoices to send them in one email with one PDF.{' '}
                <button type="button" className="as-link small"
                        onClick={() => setPicked(open.filter((i) => !i.is_credit_note).map((i) => i.invoice_id))}>
                  Tick every open one
                </button>
              </p>
            )}
            {invoiceTable(h.invoices, 'No invoices yet.', true)}
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
                <th>Reference</th><th className="num">Amount</th><th />
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
                  <td className="num">
                    {!p.is_reversal && Number(p.amount_cents) > 0 && (
                      <span className="row" style={{ gap: 10, justifyContent: 'flex-end' }}>
                        <button type="button" className="as-link small" disabled={busy}
                                onClick={() => run(async () => {
                                  await downloadPost('/api/receipts.pdf', { paymentIds: [p.id] }, `receipt-${p.id.slice(0, 8)}.pdf`);
                                }, 'Could not build the receipt')}>Receipt</button>
                        {!p.reversed && (
                          <button type="button" className="as-link small" disabled={busy}
                                  onClick={() => { openChange(p); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Change</button>
                        )}
                      </span>
                    )}
                  </td>
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
        <>
          <div className="panel">
            <h2 style={{ marginTop: 0 }}>Details</h2>
            {!formLoaded ? <p className="muted">Loading…</p> : (
              <CustomerForm initial={form} isNew={false} busy={busy} onSubmit={saveDetails} />
            )}
          </div>
          <AddressesPanel customerId={c.id} />
          <SpecialPricesPanel customerId={c.id} priceList={c.price_tier_name} />
        </>
      )}
    </>
  );
}
