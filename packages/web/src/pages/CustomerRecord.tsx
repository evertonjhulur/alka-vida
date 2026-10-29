import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, openPdfPost, type Session } from '../lib/api';
import { openSend, useSentRefresh } from '../lib/send';
import { payMethods, useTakeCard } from '../lib/payments';
import { money, date, statusTone, toCents, todayInJamaica, when } from '../lib/format';
import StatementDialog from '../components/StatementDialog';
import CustomerForm, { customerToForm, formToPayload, BLANK_CUSTOMER, type CustomerFormValues } from '../components/CustomerForm';
import LocationPinsPanel from '../components/LocationPinsPanel';
import { AddressesPanel, BrandsPanel, SpecialPricesPanel } from '../components/CustomerExtras';
import { BatchBar, MultiStatusSelect, SortTh, StatusSelect, TickAllTh, TickTd, passes, useSort, useTicks } from '../components/ListTools';
import { ORDER_STAGES, orderStage } from '../lib/orderStatus';
import { STATE_TONE, invoiceMatches, invoiceState } from '../lib/invoiceState';
import { downloadCsv, dollars } from '../lib/csv';
import { buildTransactions, type Tx } from '../lib/transactions';

interface Customer {
  id: string; name: string; phone: string; email: string;
  contact_person: string | null; delivery_address: string | null;
  delivery_zone: string | null; payment_terms: string | null;
  account_type: string | null; price_tier_name: string | null;
  portal_email: string | null; notes: string | null; active: boolean;
  invoice_cycle?: string | null; gct_exempt?: boolean; delivery_days?: string[] | null;
  whatsapp?: string | null;
}
interface Address {
  id: string; label: string; address_line1: string | null; address_line2: string | null;
  city: string | null; parish: string | null; is_billing: boolean; is_delivery: boolean; active?: boolean;
}
interface Waiting {
  kind: string; orderNumber: string; date: string; subtotalCents: number;
}
interface Order {
  id: string; order_number: string; order_date: string; status: string;
  delivery_mode: string; source: string; grand_total_cents: string;
  requested_delivery_date?: string | null; fulfilled_on?: string | null;
  customer_po?: string | null; needs_review?: boolean; lines_summary?: string | null;
  sheet_started?: boolean | null; ready_at?: string | null; load_logged_at?: string | null;
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
  lost: number; closingHolding: number; sold?: number;
  /** Opening balance of our bottles entered for them (28 Oct 2026). */
  openingEntered?: { quantity: number; asOf: string } | null;
}
interface Schedule {
  id: string; orderNumber: string; customerId: string;
  pattern: 'Weekly' | 'Biweekly' | 'Monthly';
  nextDeliveryDate: string | null; paused: boolean; endsOn: string | null;
  deliveryZone: string | null; occurrencesRaised: number; lineSummary: string;
}
interface Unapplied { id: string; customer_id: string; amount_cents: number | string }
/** Every invoice of theirs, for the Invoices tab (the history has the latest 25). */
interface InvRow {
  invoice_id: string; invoice_number: string; invoice_date: string; due_date: string | null;
  status: string; lifecycle?: string; grand_total_cents: number | string; amount_paid_cents: number | string;
  balance_cents: number | string; is_credit_note: boolean;
  credit_status?: string | null; notes?: string | null; order_numbers?: string | null;
}
/** Every payment of theirs (one row per invoice it went against), for the Transactions tab. */
interface PayRow {
  id: string; payment_date: string; amount_cents: number | string; method: string | null;
  reference: string | null; receipt_number: string | null; invoice_id: string | null;
  invoice_number: string | null; is_reversal: boolean; reversed: boolean; order_number: string | null;
}
/** The same five statuses as the Orders screen (15 Oct 2026). */
const ORDER_FILTERS: ReadonlyArray<readonly [string, string]> = [['', 'Any status'], ...ORDER_STAGES];
/** The Transactions tab (12 Oct 2026): one list of invoices, payments and credit notes. */
const TX_TYPES = [
  ['', 'All transactions'], ['invoice', 'Invoices'], ['payment', 'Payments received'], ['credit', 'Credit notes'],
] as const;
const TX_STATUS = [
  ['', 'Any status'], ['open', 'Open (still owed)'], ['overdue', 'Overdue'], ['partial', 'Partially paid'],
  ['paid', 'Paid'], ['unsent', 'Not sent yet'], ['account', 'Money left on account'],
  ['reversed', 'Reversed'], ['cancelled', 'Cancelled'],
] as const;
const TX_DATES = [
  ['', 'All dates'], ['month', 'This month'], ['last', 'Last month'], ['custom', 'Choose dates…'],
] as const;
const KIND_WORDS: Record<Tx['kind'], string> = {
  invoice: 'Invoice', credit: 'Credit note', payment: 'Payment', reversal: 'Payment reversed',
};
/** A number as WhatsApp wants it: with the country code (as the server's whatsappDigits). */
function whatsappLink(raw: string | null | undefined): string | null {
  const d = (raw ?? '').replace(/\D/g, '');
  const full = d.length === 7 ? `1876${d}` : d.length === 10 ? `1${d}` : d.length >= 11 ? d : null;
  return full ? `https://wa.me/${full}` : null;
}
/** The status words for a line on the Transactions tab. */
function txStatusWords(t: Tx): string {
  if (t.kind === 'invoice' || t.kind === 'credit') {
    if (t.kind === 'credit' && t.invoice?.credit_status === 'Pending') return 'Waiting for approval';
    if (t.kind === 'credit' && t.invoice?.credit_status === 'Rejected') return 'Rejected';
    return invoiceState(t.invoice!);
  }
  if (t.kind === 'reversal') return 'Reversal';
  if (t.reversed === 'all') return 'Reversed';
  if (t.reversed === 'part') return 'Part reversed';
  return t.openCents > 0 ? 'On account' : 'Applied';
}
function txTone(t: Tx): string {
  const w = txStatusWords(t);
  if (t.kind === 'invoice' || (t.kind === 'credit' && w === 'Credit note')) return STATE_TONE[invoiceState(t.invoice!)];
  return w === 'Applied' ? 'ok' : w === 'On account' ? 'info'
    : w === 'Waiting for approval' || w === 'Part reversed' ? 'warn' : w === 'Rejected' ? 'muted' : 'bad';
}
/** What the line is, in a few words. */
function txDescription(t: Tx): string {
  if (t.kind === 'invoice') return t.orderNumbers?.length ? `For ${t.orderNumbers.join(', ')}` : (t.invoice?.notes ?? '');
  if (t.kind === 'credit') return t.invoice?.notes ?? '';
  if (t.kind === 'reversal') return `Reversal of ${t.number || 'a payment'}`;
  const how = [t.method, t.reference].filter(Boolean).join(' ');
  const against = t.invoiceNumbers?.length ? `applied to ${t.invoiceNumbers.join(', ')}` : '';
  const account = t.openCents > 0 ? `${money(t.openCents)} left on account` : '';
  const order = t.orderNumbers?.length ? `paid with ${t.orderNumbers.join(', ')}` : '';
  return [how, [against, account].filter(Boolean).join(', '), order].filter(Boolean).join(' · ');
}
/** Under the status: when an invoice still owed is (or was) due. */
function txDue(t: Tx): string | null {
  if (t.kind !== 'invoice' || t.openCents <= 0 || !t.invoice?.due_date) return null;
  return invoiceState(t.invoice) === 'Overdue' ? `was due ${when(t.invoice.due_date)}` : `due ${when(t.invoice.due_date)}`;
}
const METHODS = ['Cash', 'Cheque', 'Bank Transfer', 'Card'] as const;
const PATTERN_WORDS: Record<Schedule['pattern'], string> = {
  Weekly: 'every week', Biweekly: 'every 2 weeks', Monthly: 'every month',
};

const TABS = [
  ['overview', 'Overview'],
  ['transactions', 'Transactions'],
  ['orders', 'Orders'],
  ['standing', 'Standing orders'],
  ['bottles', 'Bottles'],
  ['details', 'Details'],
] as const;
/** Links made before 12 Oct 2026 open the tab that replaced them. */
const OLD_TABS: Record<string, string> = { invoices: 'transactions', payments: 'transactions' };
type Tab = (typeof TABS)[number][0];

/** The parts of the Details tab. */
const PARTS = [
  ['contact', 'Contact & delivery'],
  ['billing', 'Billing'],
  ['emails', 'Emails'],
  ['addresses', 'Addresses'],
  ['products', 'Products & prices'],
] as const;
type Part = (typeof PARTS)[number][0];


/**
 * One customer, everything about them, on one page.
 *
 * The list screen answers "which customer?"; this answers "what has been going
 * on with them?" - the question actually being asked when somebody rings up.
 * Since the UX review (29 Sep 2026) it is the hub: orders, standing orders,
 * invoices and the statement, payments, bottles and the editable details are
 * tabs here rather than separate screens to search again. The tab is in the
 * address (?tab=orders), so a link can open straight onto one.
 *
 * Redesigned 12 Oct 2026 (Everton, after QuickBooks' customer page): contact
 * details and a money summary (open balance and overdue) in the header; one
 * "New transaction" menu for New order, Take a payment, Statement…, quotes
 * and credit notes; and one Transactions tab - invoices, payments and credit
 * notes together, with an optional running balance - in place of the
 * Invoices & statement and Payments tabs.
 */
export default function CustomerRecord({ session }: { session: Session }) {
  const takeCard = useTakeCard();
  const { customerId } = useParams();
  const [params, setParams] = useSearchParams();
  const rawTab = params.get('tab');
  const tabParam = rawTab ? OLD_TABS[rawTab] ?? rawTab : null;
  const tab: Tab = TABS.some(([k]) => k === tabParam) ? tabParam as Tab : 'overview';
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    if (t === 'overview') next.delete('tab'); else next.set('tab', t);
    if (t !== 'details') next.delete('part');
    setParams(next, { replace: true });
  };

  const [brandsSaved, setBrandsSaved] = useState(0);
  const partParam = params.get('part');
  const part: Part = PARTS.some(([k]) => k === partParam) ? partParam as Part : 'contact';
  const setPart = (p: Part) => {
    const next = new URLSearchParams(params);
    next.set('tab', 'details');
    if (p === 'contact') next.delete('part'); else next.set('part', p);
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
  /** Changing a posted payment (point 11.2). `parts`: the rows of the payment, when it went against several invoices. */
  const [change, setChange] = useState<{
    p: Payment; amount: string; date: string; method: string; reference: string;
    customerId: string; invoiceId: string; reason: string; parts: Payment[]; number: string | null;
  } | null>(null);
  const [allCustomers, setAllCustomers] = useState<PickCustomer[]>([]);
  const [targetInvoices, setTargetInvoices] = useState<Invoice[]>([]);
  const [invRows, setInvRows] = useState<InvRow[]>([]);
  const [payRows, setPayRows] = useState<PayRow[]>([]);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [ordStatus, setOrdStatus] = useState<string[]>([]);
  /** The Transactions tab's filters (12 Oct 2026). */
  const [txType, setTxType] = useState<string[]>([]);
  const [txStatus, setTxStatus] = useState<string[]>([]);
  const [txRange, setTxRange] = useState('');
  const [txFrom, setTxFrom] = useState('');
  const [txTo, setTxTo] = useState('');
  const [showBal, setShowBal] = useState(false);
  const [waiting, setWaiting] = useState<Waiting[]>([]);
  /** Statement… asks for the period first (UX review, 11 Oct 2026). */
  const [statementOpen, setStatementOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const [newOpen, setNewOpen] = useState(false);
  const newRef = useRef<HTMLDivElement>(null);

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
    api.get<InvRow[]>(`/api/invoices?customerId=${customerId}`).then(setInvRows).catch(() => setInvRows([]));
    api.get<PayRow[]>(`/api/payments?customerId=${customerId}&limit=2000`).then(setPayRows).catch(() => setPayRows([]));
    api.get<Address[]>(`/api/customers/${customerId}/addresses`).then(setAddresses).catch(() => setAddresses([]));
  }, [customerId]);

  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  /* ---------- the Transactions tab: one list, filters, sort, ticks (12 Oct 2026) ---------- */
  const today = todayInJamaica();
  const allTx = buildTransactions(invRows, payRows, date);
  const monthStart = `${today.slice(0, 7)}-01`;
  const lastMonthEnd = (() => {
    const d = new Date(`${monthStart}T12:00:00Z`); d.setUTCDate(0); return d.toISOString().slice(0, 10);
  })();
  const lastMonthStart = `${lastMonthEnd.slice(0, 7)}-01`;
  const inRange = (t: Tx) => (txRange === 'month' ? t.date >= monthStart && t.date <= today
    : txRange === 'last' ? t.date >= lastMonthStart && t.date <= lastMonthEnd
      : txRange === 'custom' ? (!txFrom || t.date >= txFrom) && (!txTo || t.date <= txTo) : true);
  const ofType = (t: Tx) => passes(txType, (v) => (v === 'payment' ? t.kind === 'payment' || t.kind === 'reversal' : t.kind === v));
  const ofStatus = (t: Tx) => passes(txStatus, (v) => ofOneStatus(t, v));
  const ofOneStatus = (t: Tx, txStatus: string) => {
    if (t.kind === 'invoice' || t.kind === 'credit') {
      if (txStatus === 'unsent') return t.kind === 'invoice' && invoiceState(t.invoice!) === 'Open';
      if (txStatus === 'account' || txStatus === 'reversed') return false;
      return invoiceMatches(t.invoice!, txStatus);
    }
    if (txStatus === 'account') return t.kind === 'payment' && t.openCents > 0;
    if (txStatus === 'reversed') return t.kind === 'reversal' || t.reversed !== 'none';
    return false;
  };
  // Newest first until a heading is clicked; ties keep the order of entry, newest first.
  const shownTx = allTx.filter((t) => ofType(t) && ofStatus(t) && inRange(t)).reverse();
  const txSort = useSort(shownTx, {
    date: (t) => t.date, type: (t) => KIND_WORDS[t.kind], number: (t) => t.number,
    amount: (t) => t.effectCents, open: (t) => t.openCents, balance: (t) => t.balanceCents,
    status: (t) => txStatusWords(t),
  });
  const txTicks = useTicks(txSort.sorted.map((t) => t.key));
  const tickedTx = txSort.sorted.filter((t) => txTicks.has(t.key));
  const tickedDocs = tickedTx.filter((t) => t.kind === 'invoice' || t.kind === 'credit');
  const tickedInvoices = tickedTx.filter((t) => t.kind === 'invoice');
  const tickedOwed = tickedInvoices.filter((t) => t.openCents > 0);
  const tickedPayRows = tickedTx.filter((t) => t.kind === 'payment' && t.reversed !== 'all')
    .flatMap((t) => (t.rows ?? []).filter((r) => !r.reversed && Number(r.amount_cents) > 0).map((r) => r.id));
  const filtered = !!(txType.length || txStatus.length || txRange);

  const ordRows = (h?.orders ?? []).filter((o) => passes(ordStatus, (v) => orderStage(o) === v));
  const ordSort = useSort(ordRows, {
    number: (o) => o.order_number,
    date: (o) => date(o.fulfilled_on ?? o.requested_delivery_date ?? o.order_date),
    how: (o) => o.delivery_mode, total: (o) => Number(o.grand_total_cents),
    status: (o) => (o.needs_review ? 'Needs approval' : o.status),
  });

  // Arriving from Invoices with "Receive payment" (?pay=id,id): the payment
  // form opens with those invoices ticked to be paid in full.
  const payParam = params.get('pay');
  useEffect(() => {
    if (!payParam || invRows.length === 0) return;
    const want = payParam.split(',');
    const next: Record<string, string> = {};
    for (const r of invRows) {
      if (want.includes(r.invoice_id) && Number(r.balance_cents) > 0) next[r.invoice_id] = (Number(r.balance_cents) / 100).toFixed(2);
    }
    setAlloc(next);
    setPayOpen(true);
    const p2 = new URLSearchParams(params);
    p2.delete('pay');
    setParams(p2, { replace: true });
  }, [payParam, invRows.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // The More and New transaction menus close on a click anywhere else.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
      if (newRef.current && !newRef.current.contains(e.target as Node)) setNewOpen(false);
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

  async function openChange(p: Payment, parts: Payment[] = [p], number: string | null = null) {
    setChange({
      p, amount: (Number(p.amount_cents) / 100).toFixed(2), date: p.payment_date, method: p.method ?? 'Cash',
      reference: p.reference ?? '', customerId: customerId!, invoiceId: p.invoice_id ?? '', reason: '',
      parts, number,
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

  // The send screen is another tab: when it says something went, show it here.
  useSentRefresh(() => { load().catch(() => {}); });

  async function saveDetails(v: CustomerFormValues) {
    await run(async () => {
      const result = await api.patch<{ warnings: string[] }>(`/api/customers/${customerId}`, formToPayload(v));
      setForm(v);
      setMsg(`${v.name} saved.` +
        (result.warnings?.length ? ` ${result.warnings.join(' ')}` : ''));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 'Could not save the details');
  }

  /** Ticked invoices and credit notes: one PDF, or one email with that PDF attached. */
  const docIds = () => tickedDocs.map((t) => t.invoice!.invoice_id);
  /** The send screen in a new tab (28 Oct 2026): the ticked ones in one PDF. */
  const emailPicked = () => {
    const ids = docIds();
    openSend({ kind: ids.length === 1 ? 'invoice' : 'invoices', ids });
    setMsg('The email opened in a new tab.');
  };
  const downloadPicked = () => run(async () => {
    await openPdfPost('/api/invoices/batch.pdf', { invoiceIds: docIds() },
      `invoices-${(h?.customer.name ?? 'customer').replace(/\W+/g, '-')}.pdf`);
  }, 'Could not build the PDF');
  /** Take a payment opens with these invoices filled in to be paid in full. */
  const payInvoices = (rows: Tx[]) => {
    const next: Record<string, string> = {};
    for (const t of rows) if (t.openCents > 0) next[t.invoice!.invoice_id] = (t.openCents / 100).toFixed(2);
    setAlloc(next);
    setPay((p) => ({ ...p, amount: '' }));
    setPayOpen(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const markPickedSent = () => run(async () => {
    const open_ = tickedInvoices.filter((t) => invoiceState(t.invoice!) === 'Open');
    for (const t of open_) await api.post(`/api/invoices/${t.invoice!.invoice_id}/sent`, {});
    setMsg(`${open_.length} marked as sent.`);
  }, 'Could not mark them');
  const printReceipts = () => run(async () => {
    await openPdfPost('/api/batch/receipts/print.pdf', { ids: tickedPayRows }, 'Receipts.pdf');
  }, 'Could not build the receipts');
  const emailReceipt = () => {
    openSend({ kind: 'receipt', ids: tickedPayRows });
    setMsg('The email opened in a new tab.');
  };
  const receiptFor = (t: Tx) => run(async () => {
    const ids = (t.rows ?? []).filter((r) => Number(r.amount_cents) > 0).map((r) => r.id);
    await openPdfPost('/api/receipts.pdf', { paymentIds: ids }, `Receipt-${t.number || 'payment'}.pdf`);
  }, 'Could not build the receipt');
  const exportTx = (rows: Tx[]) => downloadCsv(`transactions-${(h?.customer.name ?? 'customer').replace(/\W+/g, '-')}`, [
    ['Date', 'Type', 'No.', 'Description', 'Amount', 'Still open', 'Balance', 'Status'],
    ...rows.map((t) => [t.date, KIND_WORDS[t.kind], t.number, txDescription(t), dollars(t.effectCents),
      t.openCents ? dollars(t.kind === 'invoice' ? t.openCents : -t.openCents) : '',
      t.balanceCents === null ? '' : dollars(t.balanceCents), txStatusWords(t)]),
  ]);
  /** Change… on a payment: one row, or the part to change when it went against several invoices. */
  const changeTx = (t: Tx) => {
    const parts: Payment[] = (t.rows ?? []).filter((r) => !r.reversed && !r.is_reversal).map((r) => ({
      id: r.id, payment_date: r.payment_date, amount_cents: String(r.amount_cents), method: r.method,
      reference: r.reference, is_reversal: r.is_reversal, invoice_number: r.invoice_number,
      invoice_id: r.invoice_id, reversed: r.reversed,
    }));
    if (parts.length === 0) return;
    void openChange(parts[0], parts, t.number || null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

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

  const wa = whatsappLink(c.whatsapp || c.phone);
  const billing = addresses.find((a) => a.is_billing && a.active !== false);
  const lineOf = (a: Address) => [a.address_line1, a.address_line2, a.city, a.parish].filter(Boolean).join(', ');
  const billTo = billing ? lineOf(billing) : c.delivery_address;
  const otherDelivery = addresses.filter((a) => a.is_delivery && a.active !== false).length;
  const openInvoices = invRows.filter((i) => !i.is_credit_note && Number(i.balance_cents) > 0
    && i.status !== 'Cancelled' && i.lifecycle !== 'Cancelled');
  const openSum = openInvoices.reduce((t, i) => t + Number(i.balance_cents), 0);
  const waitingCents = waiting.reduce((t, w) => t + Number(w.subtotalCents), 0);

  /* ---------- pieces, as plain functions returning JSX (never nested components) ---------- */

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

      <section className="panel cust-head" aria-label={c.name}>
        <div className="cust-main">
          <div className="cust-top">
            <div style={{ minWidth: 0 }}>
              <h1 style={{ marginBottom: 0 }}>{c.name}</h1>
              {/* Each part labelled. Bare, the account type and the price
                  list could both read "Corporate" side by side. */}
              <div className="cust-chips">
                {[
                  c.account_type === 'Corporate' ? 'Business account'
                    : c.account_type ? `${c.account_type} account` : null,
                  c.delivery_zone ? `${c.delivery_zone} zone` : 'No delivery zone',
                  c.price_tier_name ? `${c.price_tier_name} price list` : 'List price',
                  c.invoice_cycle === 'Weekly' ? 'Invoiced weekly'
                    : c.invoice_cycle === 'Monthly' ? 'Invoiced monthly'
                      : c.payment_terms ? `Terms: ${c.payment_terms}` : null,
                  c.delivery_days?.length ? `Delivers ${c.delivery_days.join(', ')}` : null,
                  c.gct_exempt ? 'GCT exempt' : null,
                  c.active ? null : 'Closed account',
                ].filter(Boolean).map((w) => <span key={w} className="chip neutral">{w}</span>)}
              </div>
            </div>
            <div className="record-actions">
              {/* One menu for everything that makes a transaction (Everton, 12 Oct 2026). */}
              <div className="deskbar-menu" ref={newRef}>
                <button type="button" className="go" aria-haspopup="true" aria-expanded={newOpen}
                        onClick={() => { setNewOpen(!newOpen); setMoreOpen(false); }}>
                  New transaction ▾
                </button>
                {newOpen && (
                  <div className="deskbar-pop deskbar-pop-right" role="menu">
                    <Link role="menuitem" className="pop-item" to={`/orders/new?customer=${c.id}`}>
                      <span>New order</span>
                    </Link>
                    <button type="button" role="menuitem" className="pop-item pop-button"
                            onClick={() => { setPayOpen(true); setNewOpen(false); }}>
                      <span>Take a payment</span>
                    </button>
                    <button type="button" role="menuitem" className="pop-item pop-button"
                            onClick={() => { setStatementOpen(true); setPayOpen(false); setNewOpen(false); }}>
                      <span>Statement…</span>
                      <span className="pop-meta">pick the dates, then PDF or email</span>
                    </button>
                    <Link role="menuitem" className="pop-item" to={`/quotes/new?customer=${c.id}`}>
                      <span>New quote</span>
                    </Link>
                    <Link role="menuitem" className="pop-item" to={`/credit-notes?new=1&customer=${c.id}`}>
                      <span>New credit note</span>
                    </Link>
                  </div>
                )}
              </div>
              <div className="deskbar-menu" ref={moreRef}>
                <button type="button" className="secondary" aria-haspopup="true"
                        aria-expanded={moreOpen} onClick={() => { setMoreOpen(!moreOpen); setNewOpen(false); }}>
                  More ▾
                </button>
                {moreOpen && (
                  <div className="deskbar-pop deskbar-pop-right" role="menu">
                    {c.active && (
                      <Link role="menuitem" className="pop-item" to={`/messages?customer=${c.id}`}>
                        <span>Send a message</span>
                        <span className="pop-meta">email, or WhatsApp</span>
                      </Link>
                    )}
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

          <div className="cust-contact">
            <div>
              <span className="k">Email</span>
              <span>{c.email || <span className="muted">none on file</span>}</span>
            </div>
            <div>
              <span className="k">Phone</span>
              <span>
                {c.phone || <span className="muted">none on file</span>}
                {wa && <> <a href={wa} target="_blank" rel="noreferrer" className="small" style={{ marginLeft: 6 }}>WhatsApp</a></>}
              </span>
            </div>
            {c.contact_person && (
              <div>
                <span className="k">Contact</span>
                <span>{c.contact_person}</span>
              </div>
            )}
            <div>
              <span className="k">Bill to</span>
              <span>{billTo ?? <span className="muted">no address on file</span>}</span>
            </div>
            <div>
              <span className="k">Deliver to</span>
              <span>
                {billing ? (c.delivery_address ?? <span className="muted">no address on file</span>) : (c.delivery_address ? 'Same as billing' : <span className="muted">no address on file</span>)}
                {otherDelivery > 0 && <span className="muted small"> + {otherDelivery} other address{otherDelivery === 1 ? '' : 'es'}</span>}
              </span>
            </div>
            <div>
              <span className="k">Notes</span>
              {c.notes
                ? <span className="small">{c.notes}</span>
                : <button type="button" className="as-link" onClick={() => setTab('details')}>Add notes</button>}
            </div>
            <div>
              <span className="k">Portal</span>
              <span>{c.portal_email ? 'Signed up' : <span className="muted">Not signed up</span>}</span>
            </div>
          </div>

          <div className="cust-figs">
            <div className="cust-fig">
              <span className="k">Next delivery</span>
              <span className="v">
                {nextPending?.requested_delivery_date && (!next || String(nextPending.requested_delivery_date) <= String(next.nextDeliveryDate))
                  ? when(nextPending.requested_delivery_date)
                  : next ? when(next.nextDeliveryDate) : 'None booked'}
              </span>
              <span className="s">
                {nextPending?.requested_delivery_date && (!next || String(nextPending.requested_delivery_date) <= String(next.nextDeliveryDate))
                  ? `${nextPending.order_number}${nextPending.lines_summary ? `, ${nextPending.lines_summary.replace(/Alka Vida\s+/gi, '')}` : ''}`
                  : next ? `${next.lineSummary}, ${PATTERN_WORDS[next.pattern]}` : 'nothing on order'}
              </span>
            </div>
            <div className="cust-fig">
              <span className="k">Standing orders</span>
              <span className="v">{active.length ? `${active.length} running` : 'None'}</span>
              <span className="s">{schedules.length > active.length ? `${schedules.length - active.length} paused` : active.map((x) => PATTERN_WORDS[x.pattern]).join(', ') || 'Repeat… on an order sets one up'}</span>
            </div>
            <div className="cust-fig">
              <span className="k">5-gallon bottles</span>
              <span className="v">{bottles ? `${bottles.closingHolding} with them` : '—'}</span>
              <span className="s">{bottles ? `${bottles.delivered} out, ${bottles.returned} back` : 'no returnables'}</span>
            </div>
          </div>
        </div>

        <aside className="money-sum" aria-label="Money summary">
          <div className="money-sum-title">Money summary</div>
          <button type="button" className="sum-btn"
                  onClick={() => { setTab('transactions'); setTxType(['invoice']); setTxStatus(['open']); setTxRange(''); }}>
            <span className="sum-k"><span className="dot owe" aria-hidden="true" />{h.balanceCents < 0 ? 'In credit' : 'Open balance'}</span>
            <span className="sum-v">{money(Math.abs(h.balanceCents))}</span>
            <span className="sum-s">
              {openInvoices.length} open invoice{openInvoices.length === 1 ? '' : 's'}
              {openInvoices.length ? ` (${money(openSum)})` : ''}
              {openSum - h.balanceCents > 0 ? `, less ${money(openSum - h.balanceCents)} credit` : ''}
            </span>
          </button>
          <button type="button" className="sum-btn"
                  onClick={() => { setTab('transactions'); setTxType(['invoice']); setTxStatus(['overdue']); setTxRange(''); }}>
            <span className="sum-k"><span className="dot late" aria-hidden="true" />Overdue</span>
            <span className={`sum-v${(h.overdueCents ?? 0) > 0 ? ' bad' : ''}`}>{money(h.overdueCents ?? 0)}</span>
            <span className="sum-s">
              {(h.overdueCents ?? 0) > 0
                ? `${h.overdueInvoices} invoice${h.overdueInvoices === 1 ? '' : 's'} past the due date`
                : 'nothing past its due date'}
            </span>
          </button>
          {(onAccountCents > 0 || waiting.length > 0) && (
            <div className="sum-lines">
              {onAccountCents > 0 && (
                <div><span>Paid, on account</span><span className="money">{money(onAccountCents)}</span></div>
              )}
              {waiting.length > 0 && (
                <div><span>Delivered, not invoiced yet <span className="muted small">(before GCT)</span></span><span className="money">{money(waitingCents)}</span></div>
              )}
            </div>
          )}
        </aside>
      </section>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      {statementOpen && (
        <StatementDialog customerId={c.id} customerName={c.name} customerEmail={c.email}
                         onClose={() => setStatementOpen(false)}
                         onDone={(m) => { setError(null); setMsg(m); }} />
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
          <h2 style={{ marginTop: 0 }}>
            Change {change.number ? `payment ${change.number}` : 'the payment'} of {money(Number(change.p.amount_cents))} on {when(change.p.payment_date)}
          </h2>
          <form onSubmit={submitChange}>
            {change.parts.length > 1 && (
              <div className="field">
                <label htmlFor="ch-part">It went against several invoices. Which part?</label>
                <select id="ch-part" value={change.p.id}
                        onChange={(e) => { const q = change.parts.find((x) => x.id === e.target.value); if (q) void openChange(q, change.parts, change.number); }}>
                  {change.parts.map((x) => (
                    <option key={x.id} value={x.id}>{money(Number(x.amount_cents))} {x.invoice_number ? `against ${x.invoice_number}` : 'on the account'}</option>
                  ))}
                </select>
              </div>
            )}
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

      <nav className="tabs" aria-label="Customer sections">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" className={`tab${tab === key ? ' active' : ''}`}
                  aria-current={tab === key ? 'page' : undefined}
                  onClick={() => setTab(key)}>
            {label}
            {key === 'standing' && schedules.length > 0 && (
              <span className="tab-count">{schedules.length}</span>
            )}
            {key === 'transactions' && openInvoices.length > 0 && (
              <span className="tab-count">{openInvoices.length}</span>
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
          </div>
        </div>
      )}

      {tab === 'orders' && (
        <div className="panel phone-cards">
          <div className="panel-head">
            <h2>Orders</h2>
            <Link className="small" to={`/orders/new?customer=${c.id}`}>New order for {c.name}</Link>
          </div>
          <div className="row">
            <MultiStatusSelect id="c-ord-st" value={ordStatus} onChange={setOrdStatus} options={ORDER_FILTERS} />
          </div>
          <table>
            <thead>
              <tr>
                <SortTh label="Order" k="number" sort={ordSort.sort} onSort={ordSort.onSort} />
                <SortTh label="Date" k="date" sort={ordSort.sort} onSort={ordSort.onSort} />
                <SortTh label="How" k="how" sort={ordSort.sort} onSort={ordSort.onSort} />
                <SortTh label="Total" k="total" sort={ordSort.sort} onSort={ordSort.onSort} className="num" />
                <SortTh label="Status" k="status" sort={ordSort.sort} onSort={ordSort.onSort} />
              </tr>
            </thead>
            <tbody>
              {ordSort.sorted.map((o) => (
                <tr key={o.id}>
                  <td className="lead">
                    <span>
                      <Link to={`/orders?find=${o.order_number}`}>{o.order_number}</Link>
                      {o.lines_summary && <div className="muted small">{o.lines_summary.replace(/Alka Vida\s+/gi, '')}</div>}
                      {o.customer_po && <div className="muted small">PO {o.customer_po}</div>}
                    </span>
                    <span className={`chip ${statusTone(o.status)} phone-only`}>{o.needs_review ? 'Needs approval' : o.status}</span>
                  </td>
                  <td data-label="Date">{when(o.fulfilled_on ?? o.requested_delivery_date ?? o.order_date)}</td>
                  <td data-label="How" className="small">{o.delivery_mode === 'Pickup' ? 'Collection' : o.delivery_mode}</td>
                  <td data-label="Total" className="num money">{money(Number(o.grand_total_cents))}</td>
                  <td className="on-desktop">
                    <span className={`chip ${o.needs_review ? 'warn' : statusTone(o.status)}`}>{o.needs_review ? 'Needs approval' : o.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {ordSort.sorted.length === 0 && <p className="muted">{h.orders.length ? 'No order in that status.' : 'No orders yet.'}</p>}
          {h.orders.length >= 60 && (
            <p className="muted small">The most recent 60. The Orders screen has the rest.</p>
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

      {tab === 'transactions' && (
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
            <div className="tx-tools">
              <BatchBar count={txTicks.picked.length} noun={['line', 'lines']} busy={busy}
                        summary={tickedOwed.length ? `${money(tickedOwed.reduce((a, t) => a + t.openCents, 0))} still owed on them` : undefined}
                        onClear={txTicks.clear}
                        actions={[
                          { label: 'Email invoices together (one PDF)…', run: emailPicked,
                            disabledWhy: tickedDocs.length ? null : 'Tick an invoice or credit note' },
                          { label: 'Print invoices (one PDF)', run: downloadPicked,
                            disabledWhy: tickedDocs.length ? null : 'Tick an invoice or credit note' },
                          { label: 'Receive payment', run: () => payInvoices(tickedOwed),
                            disabledWhy: tickedOwed.length ? null : 'Nothing owed on what is ticked' },
                          { label: 'Mark as sent', run: markPickedSent,
                            disabledWhy: tickedInvoices.some((t) => invoiceState(t.invoice!) === 'Open') ? null : 'No ticked invoice is waiting to be sent' },
                          { label: 'Print receipts (one PDF)', run: printReceipts,
                            disabledWhy: tickedPayRows.length ? null : 'Tick a payment' },
                          { label: 'Email one receipt for them…', run: emailReceipt,
                            disabledWhy: tickedPayRows.length ? null : 'Tick a payment' },
                          { label: 'Export to Excel', run: () => exportTx(tickedTx) },
                        ]} />
            </div>
            <div className="tx-filters">
              <MultiStatusSelect id="tx-type" label="Type" value={txType} onChange={setTxType} options={TX_TYPES} />
              <MultiStatusSelect id="tx-status" value={txStatus} onChange={setTxStatus} options={TX_STATUS} />
              <StatusSelect id="tx-date" label="Date" value={txRange} onChange={setTxRange} options={TX_DATES} />
              {txRange === 'custom' && (
                <>
                  <div className="field">
                    <label htmlFor="tx-from">From</label>
                    <input id="tx-from" type="date" value={txFrom} onChange={(e) => setTxFrom(e.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor="tx-to">To</label>
                    <input id="tx-to" type="date" value={txTo} onChange={(e) => setTxTo(e.target.value)} />
                  </div>
                </>
              )}
              {filtered && (
                <button type="button" className="as-link small tx-clear"
                        onClick={() => { setTxType([]); setTxStatus([]); setTxRange(''); }}>Clear filters</button>
              )}
              <div className="tx-right">
                <label className="check">
                  <input type="checkbox" checked={showBal} onChange={(e) => setShowBal(e.target.checked)} />
                  Running balance
                </label>
                <button type="button" className="secondary" disabled={txSort.sorted.length === 0}
                        onClick={() => exportTx(txSort.sorted)}>Export</button>
              </div>
            </div>
            <table className="tx-table">
              <thead>
                <tr>
                  <TickAllTh all={txTicks.all} some={txTicks.some} onToggle={txTicks.toggleAll} disabled={txSort.sorted.length === 0} />
                  <SortTh label="Date" k="date" sort={txSort.sort} onSort={txSort.onSort} />
                  <SortTh label="Type" k="type" sort={txSort.sort} onSort={txSort.onSort} />
                  <SortTh label="No." k="number" sort={txSort.sort} onSort={txSort.onSort} />
                  <th>Description</th>
                  <SortTh label="Amount" k="amount" sort={txSort.sort} onSort={txSort.onSort} className="num" />
                  <SortTh label="Still open" k="open" sort={txSort.sort} onSort={txSort.onSort} className="num" />
                  {showBal && <SortTh label="Balance" k="balance" sort={txSort.sort} onSort={txSort.onSort} className="num" />}
                  <SortTh label="Status" k="status" sort={txSort.sort} onSort={txSort.onSort} />
                  <th />
                </tr>
              </thead>
              <tbody>
                {txSort.sorted.map((t) => {
                  const words = txStatusWords(t);
                  const due = txDue(t);
                  const desc = txDescription(t);
                  return (
                    <tr key={t.key} className={t.counts ? undefined : 'tx-void'}>
                      <TickTd checked={txTicks.has(t.key)} onToggle={() => txTicks.toggle(t.key)} label={`Tick ${KIND_WORDS[t.kind]} ${t.number}`} />
                      <td data-label="Date" className="tx-dup tx-nowrap">{when(t.date)}</td>
                      <td data-label="Type" className="tx-dup">{KIND_WORDS[t.kind]}</td>
                      <td className="lead">
                        <span className="tx-nowrap">
                          {t.invoice
                            ? <Link to={`/invoices/${t.invoice.invoice_id}`}>{t.number}</Link>
                            : <strong>{t.number || '—'}</strong>}
                          <span className="phone-only muted small"> · {KIND_WORDS[t.kind]} · {when(t.date)}</span>
                        </span>
                        <span className={`chip ${txTone(t)} phone-only`}>{words}</span>
                      </td>
                      <td data-label="What" className="small muted tx-desc">{desc || '—'}</td>
                      <td data-label="Amount" className="num money">{money(t.effectCents)}</td>
                      <td data-label="Still open" className={`num${t.openCents > 0 && words === 'Overdue' ? ' tx-late' : ''}`}>
                        {t.openCents > 0 ? money(t.kind === 'invoice' ? t.openCents : -t.openCents) : <span className="muted">—</span>}
                      </td>
                      {showBal && (
                        <td data-label="Balance" className="num money">{t.balanceCents === null ? <span className="muted">—</span> : money(t.balanceCents)}</td>
                      )}
                      <td className="on-desktop">
                        <span className={`chip ${txTone(t)}`}>{words}</span>
                        {due && <div className={`small ${words === 'Overdue' ? 'tx-late' : 'muted'}`}>{due}</div>}
                      </td>
                      <td className="num tx-acts">
                        {t.kind === 'invoice' && t.openCents > 0 && (
                          <button type="button" className="as-link small" disabled={busy} onClick={() => payInvoices([t])}>Receive payment</button>
                        )}
                        {t.kind === 'payment' && (
                          <>
                            <button type="button" className="as-link small" disabled={busy} onClick={() => receiptFor(t)}>Receipt</button>
                            {t.reversed !== 'all' && (
                              <button type="button" className="as-link small" disabled={busy} onClick={() => changeTx(t)}>Change</button>
                            )}
                          </>
                        )}
                        {t.invoice && (
                          <Link className="small" to={`/invoices/${t.invoice.invoice_id}`}>View</Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {txSort.sorted.length === 0 && (
              <p className="muted">{allTx.length ? 'Nothing matches these filters.' : 'No invoices or payments yet.'}</p>
            )}
            {txSort.sorted.length > 0 && (
              <div className="tx-foot small muted">
                <span>{txSort.sorted.length} shown{txTicks.picked.length ? ` · ${txTicks.picked.length} ticked` : ''}</span>
                <span>
                  Still owed on what is shown: {money(txSort.sorted.reduce((a, t) => a + (!t.counts ? 0
                    : t.kind === 'invoice' ? t.openCents : t.kind === 'payment' ? -t.openCents : 0), 0))}
                </span>
              </div>
            )}
            {onAccountNotice()}
          </div>
        </>
      )}

      {tab === 'bottles' && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>5-gallon bottles</h2>
          {bottles && (bottles.closingHolding !== 0 || bottles.delivered > 0 || bottles.returned > 0 || bottles.openingEntered) ? (
            <>
              <div className="aging" style={{ marginBottom: 12 }}>
                {bottles.openingEntered && (
                  <div className="age"><b>Opening balance</b><span>{bottles.openingEntered.quantity}</span></div>
                )}
                <div className="age"><b>Delivered full</b><span>{bottles.delivered}</span></div>
                <div className="age"><b>Empties back</b><span>{bottles.returned}</span></div>
                <div className="age"><b>Lost or damaged</b><span>{bottles.lost}</span></div>
                {Number(bottles.sold) > 0 && <div className="age"><b>Bought (theirs)</b><span>{bottles.sold}</span></div>}
                <div className="age"><b>Ours with them now</b><span>{bottles.closingHolding}</span></div>
              </div>
              <p className="muted small" style={{ margin: 0 }}>
                {bottles.openingEntered
                  ? <>Their opening balance of our bottles as at {when(bottles.openingEntered.asOf)}, plus every delivery recorded since, less the empties back. </>
                  : <>From every delivery recorded for them. </>}
                Bottles lost or damaged are a business loss and are never charged to the customer. Bottles they bought are
                theirs and are not counted. The statement shows the same count for any date range.{' '}
                <Link to="/bottle-pool">Bottle pool</Link>
              </p>
            </>
          ) : <p className="muted" style={{ margin: 0 }}>They have never had any of our 5-gallon bottles.</p>}
          {session.role === 'admin' && (
            <OpeningBottlesForm customerId={c.id} current={bottles?.openingEntered ?? null}
                                onSaved={() => api.get<Bottles>(`/api/customers/${customerId}/bottles`).then(setBottles).catch(() => undefined)} />
          )}
        </div>
      )}

      {tab === 'details' && (
        <>
          {/* Four short tabs instead of one 2,100px form (UX review,
              11 Oct 2026). Each has its own Save; the part is in the address
              (?tab=details&part=billing) so a link can open straight onto it. */}
          <nav className="tabs sub-tabs" aria-label="Details">
            {PARTS.map(([k, label]) => (
              <button key={k} type="button" className={`tab${part === k ? ' active' : ''}`}
                      aria-current={part === k ? 'page' : undefined} onClick={() => setPart(k)}>
                {label}
              </button>
            ))}
          </nav>
          {part === 'addresses' ? (
            <>
              <AddressesPanel customerId={c.id} />
              <LocationPinsPanel customerId={c.id} />
            </>
          ) : part === 'products' ? (
            <>
              <BrandsPanel customerId={c.id} onSaved={() => setBrandsSaved((n) => n + 1)} />
              <SpecialPricesPanel customerId={c.id} priceList={c.price_tier_name} refresh={brandsSaved} />
            </>
          ) : (
            <div className="panel">
              {!formLoaded ? <p className="muted">Loading…</p> : (
                <CustomerForm key={part} initial={form} isNew={false} busy={busy} onSubmit={saveDetails}
                              part={part} submitLabel={`Save ${PARTS.find(([k]) => k === part)![1].toLowerCase()}`} />
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}

/*
 * One customer's opening balance of OUR 5-gallon bottles (Everton, 28 Oct
 * 2026): what they already had when the app started. Administrators only,
 * with a reason; saving again replaces it, 0 removes it. Many at once:
 * Stock > Bottle pool > Upload opening balances.
 */
function OpeningBottlesForm({ customerId, current, onSaved }: {
  customerId: string; current: { quantity: number; asOf: string } | null; onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState('');
  const [asOf, setAsOf] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function start() {
    setQty(current ? String(current.quantity) : '');
    setAsOf(current?.asOf ?? '2026-10-23');
    setReason(''); setErr(null); setMsg(null); setOpen(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await api.put<{ was: number; now: number }>(`/api/customers/${customerId}/opening-bottles`,
        { quantity: Number(qty), asOf, reason });
      setMsg(r.now === 0 ? 'Opening balance removed.' : `Opening balance set to ${r.now} of our bottles${r.was ? ` (was ${r.was})` : ''}.`);
      setOpen(false); onSaved();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Could not save the opening balance');
    } finally { setBusy(false); }
  }

  return (
    <div style={{ marginTop: 12 }}>
      {msg && <div className="notice ok">{msg}</div>}
      {!open ? (
        <button type="button" className="as-link small" onClick={start}>
          {current ? `Change the opening balance (${current.quantity} as at ${when(current.asOf)})` : 'Set an opening balance of our bottles'}
        </button>
      ) : (
        <form onSubmit={save} className="panel" style={{ marginTop: 8 }}>
          <p className="muted small" style={{ marginTop: 0 }}>
            How many of <strong>our</strong> bottles they had when the app started. Leave out bottles they own. 0 removes it.
          </p>
          <div className="row">
            <div className="field">
              <label htmlFor="ob-q">Our bottles with them</label>
              <input id="ob-q" type="number" min="0" step="1" style={{ width: 120 }} value={qty} onChange={(e) => setQty(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="ob-d">As at</label>
              <input id="ob-d" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} required />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 220 }}>
              <label htmlFor="ob-r">Reason</label>
              <input id="ob-r" value={reason} placeholder="e.g. From the delivery sheet review" onChange={(e) => setReason(e.target.value)} required />
            </div>
          </div>
          {err && <div className="notice error">{err}</div>}
          <div className="row" style={{ gap: 8 }}>
            <button className="go" disabled={busy || qty === '' || !reason.trim()}>Save</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
