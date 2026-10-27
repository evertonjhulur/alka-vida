import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, openPdfPost, getSession, idempotencyKey } from '../lib/api';
import { payMethods, useTakeCard } from '../lib/payments';
import { money, day, date, todayInJamaica } from '../lib/format';
import CustomerPicker from '../components/CustomerPicker';

/**
 * New sale, one screen (Everton, 11 Oct 2026; mockup "Alka Vida order
 * screens", round 3).
 *
 * One screen for a walk-in and for a customer with an account. Across the
 * top: who it is for (type a name, or the Walk-in button), how it goes out
 * and when, and - once a customer is chosen - the address it goes to, so the
 * right one is seen before anything else. Below, the products on the left
 * (product first, then its size, from drop-downs: several products share a
 * size) and, on the right, the totals and then the payment, last.
 *
 * Payment: a walk-in pays in full now. A customer with an account is paid
 * now, by the driver at the door, or on account. Money taken before delivery
 * sits on their account and goes against this order's invoice the moment it
 * is raised (server: payments.applyAccountCredit); credit they already hold
 * is used first. Older invoices can be paid at the same time.
 */

interface Product {
  id: string;
  name: string;
  size?: string | null;
  bottles_per_case: number;
  price_per_case_cents: number;
  price_per_bottle_cents: number;
  is_returnable?: boolean;
  special_price?: boolean;
  /** The 5-gallon bottle itself: only ever added for empties short. */
  is_bottle_charge?: boolean;
}

interface Customer {
  id: string;
  name: string;
  phone: string | null;
  email?: string | null;
  delivery_zone: string | null;
  delivery_address?: string | null;
  price_tier: string | null;
  balance_cents: number | string | null;
  delivery_days?: string[] | null;
  zone_run_days?: string[] | null;
  invoice_cycle?: string | null;
  gct_exempt?: boolean;
  payment_terms?: string | null;
  is_walk_in?: boolean;
}

interface Address {
  id: string; label: string; is_delivery: boolean; is_billing?: boolean; delivery_zone: string | null;
  address_line1: string | null; address_line2?: string | null; city: string | null; parish?: string | null;
}

interface History {
  customer: { payment_terms: string | null; price_tier_name: string | null; delivery_zone: string | null; delivery_address?: string | null };
  invoices: Array<{
    invoice_id: string; invoice_number: string; invoice_date: string; due_date: string | null;
    status: string; balance_cents: string; is_credit_note: boolean;
  }>;
  balanceCents: number;
  /** Paid with orders still to be delivered: kept for them, not spare credit. */
  keptForOrdersCents?: number;
}

interface Sheet {
  id: string; zone: string; delivery_date: string; status: string;
  stop_count: number; started_at?: string | null;
}

interface Line {
  key: number;
  /** The product (its name without the size): the first drop-down. */
  group: string;
  /** The product in that size: the second drop-down. Blank until chosen. */
  productId: string;
  qty: string;
  /** A price typed for this order only, in cents; null = their usual price. */
  price: number | null;
}

type Who = 'none' | 'account' | 'walkin';
type Mode = 'Counter' | 'Pickup' | 'Delivery';
type PayWhen = 'Now' | 'On delivery' | 'On account';
type Pattern = 'Weekly' | 'Biweekly' | 'Monthly';

const GCT_RATE = 0.15;
/** Recording an earlier day (23 Oct 2026): it was delivered, or they took it. */
const PAST_MODES: Array<[Mode, string]> = [
  ['Delivery', 'We delivered it'],
  ['Pickup', 'They took it'],
];
const MODES: Array<[Mode, string]> = [
  ['Counter', 'Taking it now'],
  ['Pickup', 'Collecting later'],
  ['Delivery', 'We deliver'],
];
const PATTERNS: Array<[Pattern, string]> = [
  ['Weekly', 'Every week'],
  ['Biweekly', 'Every 2 weeks'],
  ['Monthly', 'Every month'],
];
const METHODS = [['Cash', 'Cash'], ['Bank Transfer', 'Transfer'], ['Cheque', 'Cheque'], ['Card', 'Card']] as const;

const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekdayOf = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
};
const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
/** The first date on or after `from` that falls on one of `days`. */
const nextRunDate = (from: string, days: string[]) => {
  if (!days.length) return from;
  for (let i = 0; i < 7; i++) {
    const d = addDays(from, i);
    if (days.includes(weekdayOf(d))) return d;
  }
  return from;
};
/** The same rule as the server's nextOccurrence: +7, +14, or +1 month clamped. */
function nextAfter(iso: string, p: Pattern): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (p !== 'Monthly') {
    return new Date(Date.UTC(y, m - 1, d + (p === 'Weekly' ? 7 : 14))).toISOString().slice(0, 10);
  }
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/*
 * Product, then size. A product's name carries its size at the end ("Alka
 * Vida 500ml", "Alka Vida Purified 1.5L", "Alka Vida 5 Gallon"): what comes
 * before it is the product in the first drop-down, the size the second.
 */
const SIZE_AT_END = /\s+(\d+(?:\.\d+)?\s*(?:ml|l|ltr|litres?|liters?|gal|gallons?|oz))$/i;
function splitName(p: Product): { group: string; size: string } {
  const m = p.name.match(SIZE_AT_END);
  if (m && m.index !== undefined) return { group: p.name.slice(0, m.index).trim(), size: m[1] };
  return { group: p.name, size: p.size?.trim() || 'Each' };
}
/** Sizes in order of volume, smallest first. */
function sizeMl(size: string): number {
  const m = size.match(/(\d+(?:\.\d+)?)\s*(ml|l|ltr|litres?|liters?|gal|gallons?|oz)?/i);
  if (!m) return Number.MAX_SAFE_INTEGER;
  const n = Number(m[1]);
  const u = (m[2] ?? '').toLowerCase();
  if (u.startsWith('gal')) return n * 3785;
  if (u === 'oz') return n * 29.6;
  if (u === 'ml') return n;
  return n * 1000;
}

const listPriceOf = (p: Product) => (p.bottles_per_case > 0
  ? Number(p.price_per_case_cents) : Number(p.price_per_bottle_cents));
const priceOf = (p: Product, l?: Line) => (l?.price ?? listPriceOf(p));
const unitOf = (p: Product) => (p.bottles_per_case > 0 ? 'cs' : 'btl');
const packOf = (p: Product) => (p.bottles_per_case > 0 ? `${p.bottles_per_case}/case` : 'each');
const centsOf = (typed: string) => Math.max(0, Math.round((Number(String(typed).replace(/[,$\s]/g, '')) || 0) * 100));

let nextKey = 1;

export default function NewOrder() {
  const takeCard = useTakeCard();
  const [params] = useSearchParams();
  const startMode = params.get('mode');
  const startWho: Who = startMode === 'Counter' ? 'walkin' : 'none';
  const isAdmin = getSession()?.role === 'admin';
  const today = todayInJamaica();

  const [listProducts, setListProducts] = useState<Product[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);

  const [who, setWho] = useState<Who>(params.get('customer') ? 'account' : startWho);
  const [customerId, setCustomerId] = useState(params.get('customer') ?? '');
  const [walkIn, setWalkIn] = useState({ name: '', phone: '', email: '' });
  const [history, setHistory] = useState<History | null>(null);
  const [addresses, setAddresses] = useState<Address[]>([]);

  const [mode, setMode] = useState<Mode>(startMode === 'Pickup' ? 'Pickup' : 'Delivery');
  const [requestedDate, setRequestedDate] = useState(today);
  const [customerPo, setCustomerPo] = useState('');
  const [addressId, setAddressId] = useState('');
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [cutoff, setCutoff] = useState('10:00');

  const [lines, setLines] = useState<Line[]>([]);
  const [emptiesBack, setEmptiesBack] = useState('');
  const [discount, setDiscount] = useState('0');
  const [discountAs, setDiscountAs] = useState<'%' | '$'>('%');
  const [chargeGct, setChargeGct] = useState(true);
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [pattern, setPattern] = useState<Pattern>('Weekly');
  const [repeatDays, setRepeatDays] = useState<string[]>([]);

  const [payWhen, setPayWhen] = useState<PayWhen>('Now');
  /**
   * Recording something that went out on an earlier day (23 Oct 2026): the
   * invoice and any payment are dated that day. Office staff can go back
   * backLimit days (Settings › Invoices & payments); administrators any day.
   */
  const [past, setPast] = useState(false);
  const [pastOn, setPastOn] = useState(addDays(today, -1));
  const [backLimit, setBackLimit] = useState(3);
  useEffect(() => {
    api.get<{ backdateDays?: number }>('/api/settings/money')
      .then((m) => { if (typeof m.backdateDays === 'number') setBackLimit(m.backdateDays); }).catch(() => {});
  }, []);
  const [method, setMethod] = useState('Cash');
  const [amount, setAmount] = useState<string | null>(null);
  const [reference, setReference] = useState('');
  const [older, setOlder] = useState<string[]>([]);
  const [emailReceipt, setEmailReceipt] = useState(true);

  const [result, setResult] = useState<{
    text: string; customerId: string | null; paymentIds: string[]; receiptName: string;
  } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saleKey = useRef(idempotencyKey('sale'));

  const nowHm = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Jamaica', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const pastCutoff = nowHm >= cutoff;

  useEffect(() => {
    api.get<Product[]>('/api/products?for=walkin').then((p) => { setListProducts(p); setProducts(p); }).catch(() => {});
    api.get<Customer[]>('/api/customers').then(setCustomers).catch(() => {});
    api.get<{ sameDayCutoff: string }>('/api/settings/ordering')
      .then((o) => setCutoff(o.sameDayCutoff || '10:00')).catch(() => {});
  }, []);

  const customer = who === 'account' ? customers.find((c) => c.id === customerId) : undefined;
  const isWalkIn = who === 'walkin';
  const isAccount = who === 'account' && !!customer;
  const outMode: Mode = isAccount ? mode : 'Counter';

  // Their prices, what they owe and their addresses, when a customer is chosen.
  useEffect(() => {
    setHistory(null);
    setAddresses([]);
    setAddressId('');
    setOlder([]);
    if (who !== 'account' || !customerId) {
      setProducts(listProducts);
      return;
    }
    api.get<Array<Product & { product_id: string }>>(`/api/customers/${customerId}/prices`)
      .then((rows) => setProducts(rows.map((r) => ({ ...r, id: r.product_id })))).catch(() => {});
    api.get<History>(`/api/customers/${customerId}/history`).then(setHistory).catch(() => {});
    api.get<Address[]>(`/api/customers/${customerId}/addresses`).then(setAddresses).catch(() => {});
  }, [who, customerId, listProducts]); // eslint-disable-line react-hooks/exhaustive-deps

  // A customer brings their GCT position, delivery days and next run day.
  useEffect(() => {
    if (!customer) { setChargeGct(true); return; }
    setChargeGct(!customer.gct_exempt);
    const days = (customer.delivery_days?.length ? customer.delivery_days : customer.zone_run_days) ?? [];
    setRepeatDays(days.length ? [...days] : []);
    const start = pastCutoff ? addDays(today, 1) : today;
    setRequestedDate(days.length ? nextRunDate(start, days) : start);
    // Their terms suggest when payment is collected; the office can change it.
    const terms = customer.payment_terms ?? '';
    // A delivery is paid at the door unless the office has the money in hand
    // (27 Oct 2026: "Now" was the default, so cash the driver later collected
    // was recorded twice - once at order entry, once at settlement).
    setPayWhen(customer.invoice_cycle === 'Weekly' || customer.invoice_cycle === 'Monthly'
      || /net|account|credit|\bdays?\b/i.test(terms) ? 'On account' : 'On delivery');
    setAmount(null);
  }, [customer?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const deliveryAddresses = addresses.filter((a) => a.is_delivery);
  const address = deliveryAddresses.find((a) => a.id === addressId) ?? null;
  const zone = address?.delivery_zone ?? history?.customer.delivery_zone ?? customer?.delivery_zone ?? null;

  // Which round the date puts it on.
  useEffect(() => {
    setSheets(null);
    if (outMode !== 'Delivery' || !requestedDate) return;
    api.get<Sheet[]>(`/api/delivery-sheets?date=${requestedDate}`).then(setSheets).catch(() => {});
  }, [outMode, requestedDate]);

  // A different delivery address can mean a different zone, so a different day.
  useEffect(() => {
    if (!address?.delivery_zone || outMode !== 'Delivery') return;
    api.get<Array<{ name: string; run_days?: string[] }>>('/api/zones')
      .then((zs) => {
        const z = zs.find((x) => x.name === address.delivery_zone);
        if (z?.run_days?.length) setRequestedDate(nextRunDate(pastCutoff ? addDays(today, 1) : today, z.run_days));
      }).catch(() => {});
  }, [addressId]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------- products ---------------- */

  const productOf = (id: string) => products.find((p) => p.id === id);
  const groups = useMemo(() => {
    const m = new Map<string, Array<Product & { sizeLabel: string }>>();
    for (const p of products) {
      if (p.is_bottle_charge) continue;
      const { group, size } = splitName(p);
      if (!m.has(group)) m.set(group, []);
      m.get(group)!.push({ ...p, sizeLabel: size });
    }
    for (const list of m.values()) list.sort((a, b) => sizeMl(a.sizeLabel) - sizeMl(b.sizeLabel));
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [products]);
  const sizesOf = (group: string) => groups.find(([g]) => g === group)?.[1] ?? [];

  const focusSoon = (id: string) => window.setTimeout(() => document.getElementById(id)?.focus(), 0);
  function chooseGroup(key: number | null, group: string) {
    if (!group) return;
    const sizes = sizesOf(group);
    // One size only: it is chosen too, and the cursor goes to the quantity.
    const only = sizes.length === 1 ? sizes[0].id : '';
    if (key === null) {
      const k = nextKey++;
      setLines((cur) => [...cur, { key: k, group, productId: only, qty: only ? '1' : '', price: null }]);
      focusSoon(only ? `ns-qty-${k}` : `ns-size-${k}`);
    } else {
      setLines((cur) => cur.map((l) => (l.key === key && l.group !== group
        ? { ...l, group, productId: only, qty: only ? (l.qty || '1') : l.qty, price: null } : l)));
      focusSoon(only ? `ns-qty-${key}` : `ns-size-${key}`);
    }
  }
  const chooseSize = (key: number, productId: string) => {
    setLines((cur) => cur.map((l) => (l.key === key ? { ...l, productId, qty: l.qty || '1', price: null } : l)));
    if (productId) focusSoon(`ns-qty-${key}`);
  };
  const setQty = (key: number, typed: string) => setLines((cur) => cur.map((l) => (
    l.key === key ? { ...l, qty: typed.replace(/[^0-9]/g, '').slice(0, 5) } : l)));
  const setPrice = (key: number, typed: string) => setLines((cur) => cur.map((l) => {
    if (l.key !== key) return l;
    const p = productOf(l.productId);
    if (typed.trim() === '') return { ...l, price: null };
    const cents = centsOf(typed);
    return { ...l, price: p && cents === listPriceOf(p) ? null : cents };
  }));
  const removeLine = (key: number) => setLines((cur) => cur.filter((l) => l.key !== key));
  const qtyOf = (l: Line) => Math.max(0, Number(l.qty) || 0);

  /* ---------------- totals (the server's calculation, exactly) ---------------- */

  const bottleProduct = products.find((p) => p.is_bottle_charge) ?? null;
  const fullFives = lines.reduce((n, l) => {
    const p = productOf(l.productId);
    return p?.is_returnable ? n + qtyOf(l) * (p.bottles_per_case > 0 ? p.bottles_per_case : 1) : n;
  }, 0);
  const bottleOnOrder = !!bottleProduct && lines.some((l) => l.productId === bottleProduct.id);
  const emptiesN = emptiesBack === '' ? null : Math.max(0, Math.round(Number(emptiesBack)) || 0);
  const shortfall = fullFives > 0 && emptiesN !== null && !bottleOnOrder && bottleProduct
    ? Math.max(0, fullFives - emptiesN) : 0;

  const totals = useMemo(() => {
    let subtotal = 0;
    for (const l of lines) {
      const p = productOf(l.productId);
      if (!p || qtyOf(l) <= 0) continue;
      subtotal += qtyOf(l) * priceOf(p, l);
    }
    if (shortfall > 0 && bottleProduct) subtotal += shortfall * priceOf(bottleProduct);
    const fixed = discountAs === '$' ? centsOf(discount) : 0;
    const pct = discountAs === '%' ? Math.min(Math.max(Number(discount) || 0, 0), 100) : 0;
    const discountAmount = fixed > 0 ? Math.min(fixed, subtotal) : Math.round(subtotal * (pct / 100));
    const net = subtotal - discountAmount;
    const gct = chargeGct ? Math.round(net * GCT_RATE) : 0;
    return { subtotal, discountAmount, gct, grandTotal: net + gct, fixed, pct };
  }, [lines, discount, discountAs, chargeGct, products, shortfall]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------- payment ---------------- */

  const balance = history?.balanceCents ?? Number(customer?.balance_cents ?? 0);
  const credit = isAccount ? Math.max(0, -balance - (history?.keptForOrdersCents ?? 0)) : 0;
  const due = Math.max(0, totals.grandTotal - credit);
  const onCycle = customer?.invoice_cycle === 'Weekly' || customer?.invoice_cycle === 'Monthly';
  const termsWords = onCycle ? `their ${customer!.invoice_cycle!.toLowerCase()} invoice`
    : customer?.payment_terms ? `their ${customer.payment_terms} terms` : 'their terms';
  const whens: Array<[PayWhen, string]> = past ? [['Now', 'Paid at the time'], ['On account', 'On account']] : [
    ['Now', outMode === 'Delivery' ? 'Paid now, in the office' : 'Now'],
    ...(outMode === 'Delivery' ? [['On delivery', 'On delivery'] as [PayWhen, string]] : []),
    ['On account', 'On account'],
  ];
  const when: PayWhen = isWalkIn ? 'Now'
    : payWhen === 'On delivery' && past ? 'Now'
      : payWhen === 'On delivery' && outMode !== 'Delivery' ? 'On account' : payWhen;
  const takingNow = isWalkIn || (isAccount && when === 'Now');
  const amountTyped = amount ?? ((isWalkIn ? totals.grandTotal : due) / 100).toFixed(2);
  const amountCents = centsOf(amountTyped);
  const openOlder = (history?.invoices ?? [])
    .filter((i) => !i.is_credit_note && Number(i.balance_cents) > 0 && i.status !== 'Cancelled')
    .sort((a, b) => a.invoice_date.localeCompare(b.invoice_date));
  const olderCents = isAccount && takingNow
    ? openOlder.filter((i) => older.includes(i.invoice_id)).reduce((n, i) => n + Number(i.balance_cents), 0) : 0;
  const forOrder = isAccount && takingNow ? amountCents : 0;
  const taking = forOrder + olderCents;
  // Money paid ahead on other orders is theirs to settle, not spare credit.
  const after = balance + (history?.keptForOrdersCents ?? 0) + totals.grandTotal - taking;
  const methods = payMethods(METHODS, takeCard);
  const walkInShort = isWalkIn && amountCents < totals.grandTotal;

  const amountNote = (() => {
    if (isWalkIn) {
      if (method !== 'Cash') return walkInShort ? <span className="bad-text">A walk-in pays in full: {money(totals.grandTotal)}.</span> : null;
      const diff = amountCents - totals.grandTotal;
      return diff >= 0
        ? <strong className="ns-change">Change to give: {money(diff)}</strong>
        : <strong className="bad-text">Still to pay: {money(-diff)}</strong>;
    }
    if (!takingNow) return null;
    const d = amountCents - due;
    if (d > 0) return <>{money(d)} over stays on their account as credit.</>;
    if (d < 0) return <>Part payment: {money(-d)} left on {termsWords}.</>;
    if (due === 0 && amountCents === 0) return <>Their credit covers it; nothing to take.</>;
    return <>Pays this order in full.</>;
  })();

  /* ---------------- choosing who ---------------- */

  function chooseCustomer(id: string) {
    const c = customers.find((x) => x.id === id);
    if (c?.is_walk_in) {
      // A walk-in already on file: their details on the receipt, paid in full.
      setWho('walkin');
      setCustomerId(c.id);
      setWalkIn({ name: c.name === 'Cash Walk-In' ? '' : c.name, phone: c.phone && c.phone !== '000' ? c.phone : '', email: c.email ?? '' });
    } else {
      setWho('account');
      setCustomerId(id);
    }
    setAmount(null);
    setResult(null);
  }
  function chooseWalkIn() {
    setWho('walkin');
    setCustomerId('');
    setWalkIn({ name: '', phone: '', email: '' });
    setMethod('Cash');
    setAmount(null);
    setResult(null);
  }
  function changeWho() {
    setWho('none');
    setCustomerId('');
    setAmount(null);
  }

  /** A walk-in who gave a name and phone is put on file (or found there) for the receipt. */
  async function walkInRecord(): Promise<string | null> {
    if (customerId) return customerId;
    const name = walkIn.name.trim();
    const phone = walkIn.phone.trim();
    if (!name || !phone) return null;
    const digits = phone.replace(/\D/g, '');
    const known = customers.find((c) => c.is_walk_in && (c.phone ?? '').replace(/\D/g, '') === digits
      && c.name.toLowerCase() === name.toLowerCase());
    if (known) return known.id;
    const made = await api.post<{ id: string }>('/api/customers', {
      name, phone, email: walkIn.email.trim(), isWalkIn: true,
    });
    return made.id;
  }

  function reset() {
    setLines([]);
    setEmptiesBack('');
    setDiscount('0');
    setDiscountAs('%');
    setNote('');
    setNoteOpen(false);
    setRepeat(false);
    setAmount(null);
    setReference('');
    setOlder([]);
    setCustomerPo('');
    setAddressId('');
    setMode(startMode === 'Pickup' ? 'Pickup' : 'Delivery');
    setWho(startWho);
    setPast(false);
    setCustomerId('');
    setWalkIn({ name: '', phone: '', email: '' });
    saleKey.current = idempotencyKey('sale');
  }

  /* ---------------- finishing ---------------- */

  async function finish() {
    setBusy(true); setError(null); setResult(null); setWarnings([]);
    const payloadLines = lines
      .filter((l) => qtyOf(l) > 0 && productOf(l.productId))
      .map((l) => {
        const cased = productOf(l.productId)!.bottles_per_case > 0;
        const price = l.price === null ? {} : cased ? { pricePerCaseCents: l.price } : { pricePerBottleCents: l.price };
        return cased
          ? { productId: l.productId, cases: qtyOf(l), ...price }
          : { productId: l.productId, looseBottles: qtyOf(l), ...price };
      });
    const fail = (m: string) => { setError(m); setBusy(false); };
    if (payloadLines.length === 0) return fail('Add at least one product, with its size and how many.');
    if (lines.some((l) => l.group && !l.productId)) return fail('Choose the size for every product, or remove the line.');
    if (fullFives > 0 && emptiesN === null && !bottleOnOrder) {
      return fail(outMode === 'Delivery' && !past ? 'How many 5-gallon empties will they hand over? Put 0 if none.'
        : 'How many 5-gallon empties did they hand in? Put 0 if none.');
    }
    if (walkInShort) return fail(`A walk-in pays in full: ${money(totals.grandTotal)}. To take part payment, choose their customer account.`);
    const money_ = { discountPercent: totals.pct, discountFixedCents: totals.fixed, gctExempt: !chargeGct };
    const older_ = openOlder.filter((i) => older.includes(i.invoice_id))
      .map((i) => ({ invoiceId: i.invoice_id, amountCents: Number(i.balance_cents) }));

    try {
      if (past) {
        // Went out on an earlier day (23 Oct 2026): dated that day, never on a round.
        const id = isWalkIn ? await walkInRecord() : customerId;
        const paidThen = isWalkIn ? totals.grandTotal : (takingNow ? amountCents : 0);
        const r = await api.post<{
          orderNumber: string; invoiceNumber: string | null; onCycle: boolean;
          grandTotalCents: number; balanceCents: number | null;
        }>('/api/past-delivery', {
          customerId: id || null,
          deliveredOn: pastOn,
          how: isAccount && mode === 'Delivery' ? 'Delivered' : 'Collected',
          lines: payloadLines,
          ...money_,
          amountPaidCents: paidThen,
          method,
          reference: reference.trim() || null,
          notes: note.trim() || null,
          emptiesReturned: fullFives > 0 ? (emptiesN ?? 0) : null,
          idempotencyKey: saleKey.current,
        });
        const who_ = isWalkIn ? (walkIn.name.trim() || 'a walk-in') : customer?.name ?? 'the customer';
        setResult({
          customerId: isWalkIn ? null : customerId, paymentIds: [], receiptName: '',
          text: `Recorded for ${who_} on ${day(pastOn)}: order ${r.orderNumber}, ${money(r.grandTotalCents)}. `
            + (r.onCycle ? `It goes on their ${customer?.invoice_cycle?.toLowerCase() ?? ''} invoice for that period.`
              : `Invoice ${r.invoiceNumber} is dated ${day(pastOn)}${r.balanceCents && r.balanceCents > 0 ? `, ${money(r.balanceCents)} left on account` : ', paid'}.`),
        });
        setPast(false);
      } else if (outMode === 'Counter') {
        // Invoice and payment in one motion, at the counter.
        const id = isWalkIn ? await walkInRecord() : customerId;
        const email = isWalkIn ? walkIn.email.trim() : customer?.email ?? '';
        const paidNow = isWalkIn ? totals.grandTotal : (takingNow ? amountCents : 0);
        const sale = await api.post<{
          invoiceNumber: string; grandTotalCents: number; balanceCents: number; paymentIds?: string[];
          paymentError?: string; receipt?: { sentTo: string }; receiptError?: string;
        }>('/api/counter-sale', {
          customerId: id || null,
          lines: payloadLines,
          ...money_,
          amountPaidCents: paidNow,
          method,
          reference: reference.trim() || null,
          notes: note.trim() || null,
          emptiesReturned: fullFives > 0 ? (emptiesN ?? 0) : null,
          idempotencyKey: saleKey.current,
          sendReceipt: emailReceipt && !!email && paidNow > 0,
          receiptTo: email || undefined,
          olderPayment: older_.length ? {
            amountCents: older_.reduce((n, o) => n + o.amountCents, 0), method,
            reference: reference.trim() || null, allocations: older_,
          } : undefined,
        });
        const warn: string[] = [];
        if (sale.paymentError) warn.push(`The sale is done, but the payment on older invoices was not recorded: ${sale.paymentError}`);
        if (sale.receiptError) warn.push(`The receipt was not emailed: ${sale.receiptError}`);
        setWarnings(warn);
        const who_ = isWalkIn ? (walkIn.name.trim() || 'a walk-in') : customer?.name ?? 'the customer';
        const ids = sale.paymentIds ?? [];
        setResult({
          customerId: isWalkIn ? null : customerId, paymentIds: ids, receiptName: `Receipt ${sale.invoiceNumber}.pdf`,
          text: `Sale to ${who_} done. Invoice ${sale.invoiceNumber} for ${money(sale.grandTotalCents)}, `
            + (sale.balanceCents > 0 ? `${money(sale.balanceCents)} left on account.` : 'paid.')
            + (isWalkIn && method === 'Cash' && amountCents > totals.grandTotal ? ` Change given: ${money(amountCents - totals.grandTotal)}.` : '')
            + (sale.receipt ? ` Receipt emailed to ${sale.receipt.sentTo}.` : ''),
        });
        // The receipt is one click away on the message above ("View receipt"):
        // it opens in a new tab, which a browser only allows from a click
        // (23 Oct 2026; it used to download by itself here).
      } else {
        const payment = takingNow && taking > 0 ? {
          amountCents: taking, method, reference: reference.trim() || null, paymentDate: today,
          allocations: older_, idempotencyKey: saleKey.current,
          sendReceipt: emailReceipt && !!customer?.email,
        } : undefined;
        const order = await api.post<{
          id: string; orderNumber: string; grandTotalCents: number; deliverySheetId: string | null;
          warnings: string[]; needsReview?: boolean; paymentIds?: string[]; paymentError?: string;
          receipt?: { sentTo: string }; receiptError?: string;
        }>('/api/orders', {
          customerId,
          deliveryMode: outMode,
          requestedDeliveryDate: requestedDate,
          addressId: outMode === 'Delivery' ? (addressId || null) : null,
          customerPo: customerPo || null,
          notes: note.trim() || null,
          ...money_,
          lines: payloadLines,
          emptiesExpected: fullFives > 0 && !bottleOnOrder ? emptiesN : null,
          payWhen: when,
          payment,
        });
        const warn = [...(order.warnings ?? [])];
        if (order.paymentError) warn.push(`The order is made, but the payment was not recorded: ${order.paymentError}. Record it on Payments.`);
        if (order.receiptError) warn.push(`The receipt was not emailed: ${order.receiptError}`);
        let repeatText = '';
        if (repeat) {
          try {
            const r = await api.post<{ nextDeliveryDate: string }>(`/api/orders/${order.id}/recurring`, { pattern });
            repeatText = ` It repeats ${PATTERNS.find(([p]) => p === pattern)![1].toLowerCase()}; the next is for ${day(r.nextDeliveryDate)}.`;
            // Several days a week: each other day is its own weekly standing order.
            if (pattern === 'Weekly') {
              const extra: string[] = [];
              for (const d of repeatDays.filter((x) => x !== weekdayOf(requestedDate))) {
                const first = nextRunDate(addDays(requestedDate, 1), [d]);
                const o2 = await api.post<{ id: string }>('/api/orders', {
                  customerId, deliveryMode: outMode, requestedDeliveryDate: first,
                  addressId: outMode === 'Delivery' ? (addressId || null) : null,
                  ...money_, lines: payloadLines, payWhen: when === 'Now' ? 'On account' : when,
                });
                await api.post(`/api/orders/${o2.id}/recurring`, { pattern: 'Weekly' });
                extra.push(`${d} (first ${day(first)})`);
              }
              if (extra.length) repeatText += ` Also every ${extra.join(', ')}.`;
            }
          } catch (err) {
            warn.push(`The order was made, but it could not be set to repeat: ${err instanceof Error ? err.message : 'unknown error'}. Use ⋯ on Orders to try again.`);
          }
        }
        setWarnings(warn);
        const paidText = payment && !order.paymentError ? ` ${money(taking)} recorded${order.receipt ? `, receipt emailed to ${order.receipt.sentTo}` : ''}.` : '';
        setResult({
          customerId, paymentIds: order.paymentIds ?? [], receiptName: `Receipt ${order.orderNumber}.pdf`,
          text: `Order ${order.orderNumber} for ${customer?.name ?? 'the customer'}, ${money(order.grandTotalCents)}`
            + (order.needsReview ? ', waiting for approval for today.'
              : outMode === 'Pickup' ? `, to collect ${day(requestedDate)}.`
                : order.deliverySheetId ? `, on the ${zone ?? ''} round for ${day(requestedDate)}.` : '. It is not on a round yet.')
            + paidText + repeatText,
        });
      }
      reset();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save it');
    } finally {
      setBusy(false);
    }
  }

  /* ---------------- what the screen says ---------------- */

  const late = openOlder.filter((i) => i.status === 'Overdue').length;
  const kept = history?.keptForOrdersCents ?? 0;
  const owesNet = balance + kept;
  const balanceChip = !history ? null : (
    <>
      {owesNet > 0 ? <span className="chip bad">Owes {money(owesNet)}{late ? `, ${late} late` : ''}</span>
        : credit > 0 ? <span className="chip ok">In credit {money(credit)}</span>
          : <span className="chip neutral">Owes nothing</span>}
      {kept > 0 && <span className="chip info">Paid ahead on orders {money(kept)}</span>}
    </>
  );

  const billing = addresses.find((a) => a.is_billing);
  const lineOf = (a: Address) => [a.address_line1, a.address_line2, a.city, a.parish].filter(Boolean).join(', ');
  const mainAddress = history?.customer.delivery_address ?? customer?.delivery_address ?? null;
  const billTo = billing ? lineOf(billing) : mainAddress;

  const zoneDays = address ? [] : (customer?.zone_run_days ?? []);
  const offDay = outMode === 'Delivery' && zoneDays.length > 0 && requestedDate && !zoneDays.includes(weekdayOf(requestedDate));
  const round = sheets?.find((s) => s.zone === zone && s.status === 'Open') ?? null;
  const roundNote = (() => {
    if (outMode !== 'Delivery' || !customer || past) return null;
    if (!zone) return <span className="bad-text">No delivery zone on file, so this cannot go on a round. Set one on their Details tab.</span>;
    if (!sheets) return null;
    if (round?.started_at) return <>The {zone} round for {day(requestedDate)} is already on the road; this is added to it ({round.stop_count} stops).</>;
    if (round) return <>On the {zone} round for {day(requestedDate)} ({round.stop_count} {round.stop_count === 1 ? 'stop' : 'stops'} so far).</>;
    return <>Starts the {zone} round for {day(requestedDate)}.</>;
  })();

  const finishText = busy ? 'Saving…'
    : past && (isAccount || isWalkIn) ? `Record it for ${day(pastOn)}${takingNow && (isWalkIn ? totals.grandTotal : amountCents) > 0 ? `, paid ${money(isWalkIn ? totals.grandTotal : amountCents)}` : ''}`
    : isWalkIn ? `Take ${money(totals.grandTotal)} and print receipt`
      : !isAccount ? 'Choose who it is for'
        : taking > 0 ? `${outMode === 'Counter' ? 'Complete sale' : repeat ? 'Create standing order' : 'Create order'}, record ${money(taking)}`
          : when === 'On delivery' ? `Create order · driver collects ${money(due)}`
            : outMode === 'Counter' ? 'Complete sale on account'
              : repeat ? 'Create standing order' : 'Create order';

  const blankLine = lines.length === 0 || lines[lines.length - 1].productId !== '';

  return (
    <div className="ns">
      <div className="ns-head">
        <h1>New sale</h1>
        <Link to="/orders" className="back-link">← Orders</Link>
      </div>

      {error && <div className="notice error">{error}</div>}
      {result && (
        <div className="notice ok">
          {result.text}{' '}
          {result.paymentIds.length > 0 && (
            <button type="button" className="as-link"
                    onClick={() => void openPdfPost('/api/receipts.pdf', { paymentIds: result.paymentIds }, result.receiptName)
                      .catch((e) => setError(e instanceof Error ? e.message : 'Could not open the receipt'))}>
              View receipt
            </button>
          )}
          {result.customerId && <>{' · '}<Link to={`/customers/${result.customerId}?tab=orders`}>See their orders</Link></>}
        </div>
      )}
      {warnings.map((w) => <div className="notice warn" key={w}>{w}</div>)}

      <section className="panel ns-strip" aria-label="Customer and how it goes out">
        <div className="ns-strip-row">
          {who === 'none' && (
            <div className="ns-who">
              <label htmlFor="ns-cust">Customer</label>
              <div className="ns-who-row">
                <CustomerPicker id="ns-cust" customers={customers.filter((c) => c.name !== 'Cash Walk-In')}
                                value="" onChange={chooseCustomer} placeholder="Type a name or phone number" />
                <button type="button" className="secondary ns-walkin-btn" onClick={chooseWalkIn}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="5" r="2" /><path d="M10 22l1-7-2-3 1-4h4l1 4-2 3 1 7" />
                  </svg>
                  Walk-in
                </button>
              </div>
            </div>
          )}

          {isAccount && customer && (
            <>
              <div className="ns-who">
                <span className="label">Customer</span>
                <div className="ns-chosen">
                  <Link to={`/customers/${customer.id}`} className="ns-name">{customer.name}</Link>
                  <span className="chip neutral">{history?.customer.price_tier_name ?? customer.price_tier ?? 'List prices'}</span>
                  <span className="chip neutral">{onCycle ? `Invoiced ${customer.invoice_cycle!.toLowerCase()}` : customer.payment_terms ?? 'No terms set'}</span>
                  {customer.gct_exempt && <span className="chip neutral">GCT exempt</span>}
                  {balanceChip}
                  <button type="button" className="as-link" onClick={changeWho}>Change</button>
                </div>
              </div>
              <div>
                <span className="label">How it goes out</span>
                <div className="ns-seg" role="group" aria-label="How it goes out">
                  {(past ? PAST_MODES : MODES).map(([m, label]) => (
                    <button key={m} type="button" className={mode === m ? 'on' : ''} aria-pressed={mode === m}
                            onClick={() => { setMode(m); if (m === 'Counter') setRepeat(false); }}>{label}</button>
                  ))}
                </div>
              </div>
              {mode !== 'Counter' && !past && (
                <div className="ns-date">
                  <label htmlFor="ns-date">{mode === 'Pickup' ? 'Collect on' : 'Deliver on'}</label>
                  <input id="ns-date" type="date" value={requestedDate} min={today}
                         onChange={(e) => setRequestedDate(e.target.value)} />
                </div>
              )}
              <div className="ns-po">
                <label htmlFor="ns-po">Their PO no.</label>
                <input id="ns-po" value={customerPo} onChange={(e) => setCustomerPo(e.target.value)} />
              </div>
            </>
          )}

          {isWalkIn && (
            <div className="ns-who ns-who-wide">
              <span className="label">Customer</span>
              <div className="ns-chosen">
                <span className="ns-walkin-tag">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="5" r="2" /><path d="M10 22l1-7-2-3 1-4h4l1 4-2 3 1 7" />
                  </svg>
                  Walk-in
                </span>
                <input className="ns-wi-name" aria-label="Name for the receipt" placeholder="Name for the receipt"
                       value={walkIn.name} disabled={!!customerId}
                       onChange={(e) => setWalkIn({ ...walkIn, name: e.target.value })} />
                <input className="ns-wi-phone" aria-label="Phone" placeholder="Phone" inputMode="tel"
                       value={walkIn.phone} disabled={!!customerId}
                       onChange={(e) => setWalkIn({ ...walkIn, phone: e.target.value })} />
                <input className="ns-wi-email" aria-label="Email" placeholder="Email (to send the receipt)" type="email"
                       value={walkIn.email} disabled={!!customerId}
                       onChange={(e) => setWalkIn({ ...walkIn, email: e.target.value })} />
                <button type="button" className="as-link" onClick={changeWho}>Change</button>
              </div>
              <div className="muted small">{past ? 'Paid in full at the time.' : 'Takes the goods now and pays in full.'} A name and phone put them on file for next time.</div>
            </div>
          )}

          {(isAccount || isWalkIn) && (
            <div className="ns-past">
              <label className="ns-past-tick">
                <input type="checkbox" checked={past} onChange={(e) => {
                  setPast(e.target.checked); setRepeat(false); setAmount(null);
                  if (e.target.checked && mode === 'Counter') setMode('Pickup');
                }} />
                It already went out on an earlier day
              </label>
              {past && (
                <span className="ns-past-date">
                  <label htmlFor="ns-past-on">Went out on</label>
                  <input id="ns-past-on" type="date" value={pastOn} max={today}
                         min={isAdmin ? undefined : addDays(today, -backLimit)}
                         onChange={(e) => setPastOn(e.target.value)} />
                  <span className="muted small">
                    The invoice and any payment are dated that day.{isAdmin ? ' As an administrator you can choose any day.' : ` Up to ${backLimit} ${backLimit === 1 ? 'day' : 'days'} back; older ones need an administrator.`}
                  </span>
                </span>
              )}
            </div>
          )}
        </div>

        {isAccount && customer && (
          <div className="ns-address">
            {mode === 'Delivery' && (
              <>
                <label htmlFor="ns-addr" className="ns-inline-label">Deliver to</label>
                <select id="ns-addr" value={addressId} onChange={(e) => setAddressId(e.target.value)}>
                  <option value="">Main address{mainAddress ? ` · ${mainAddress}` : ''}{customer.delivery_zone ? ` (${customer.delivery_zone})` : ''}</option>
                  {deliveryAddresses.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}{lineOf(a) ? ` · ${lineOf(a)}` : ''}{a.delivery_zone ? ` (${a.delivery_zone})` : ''}
                    </option>
                  ))}
                </select>
                <Link to={`/customers/${customer.id}?tab=details&part=addresses`} className="small">+ Add an address</Link>
                {roundNote && <span className="small ns-round">{roundNote}</span>}
              </>
            )}
            <span className="small muted ns-billto">Bill to: {billTo ?? 'no address on file'}</span>
          </div>
        )}
        {isAccount && mode === 'Delivery' && requestedDate === today && pastCutoff && (
          <div className="notice warn ns-tight">
            It is past the {cutoff} cut-off for same-day delivery.{' '}
            {isAdmin ? 'As an administrator, yours goes straight on today\'s round.'
              : 'This order will wait in Needs a decision until an administrator approves it for today.'}
          </div>
        )}
        {isAccount && offDay && (
          <div className="notice warn ns-tight">
            The {zone} round runs {zoneDays.join(', ')}, not {weekdayOf(requestedDate)}.{' '}
            <button type="button" className="as-link" onClick={() => setRequestedDate(nextRunDate(requestedDate, zoneDays))}>
              Move it to {day(nextRunDate(requestedDate, zoneDays))}
            </button>
          </div>
        )}
      </section>

      <div className="ns-cols">
        <section className="panel ns-products" aria-labelledby="ns-lines-h">
          <div className="ns-panel-head">
            <h2 id="ns-lines-h">Products</h2>
            <span className="small muted">Product, then size.{isAccount ? ' Their prices.' : ' List prices.'}</span>
          </div>
          <div className="ns-lg ns-lg-head" aria-hidden="true">
            <span className="ns-hide-s">#</span><span>Product</span><span>Size</span><span>Qty</span>
            <span className="num ns-hide-s">Rate</span><span className="num ns-hide-s">Amount</span><span />
          </div>
          {lines.map((l, i) => {
            const p = productOf(l.productId);
            const sizes = sizesOf(l.group);
            return (
              <div className="ns-lg" key={l.key}>
                <span className="ns-n ns-hide-s">{i + 1}</span>
                <select aria-label={`Product, line ${i + 1}`} value={l.group}
                        onChange={(e) => chooseGroup(l.key, e.target.value)}>
                  {!groups.some(([g]) => g === l.group) && <option value={l.group}>{l.group}</option>}
                  {groups.map(([g]) => <option key={g} value={g}>{g}</option>)}
                </select>
                <select id={`ns-size-${l.key}`} aria-label={`Size, line ${i + 1}`} value={l.productId}
                        onChange={(e) => chooseSize(l.key, e.target.value)}>
                  <option value="">Choose a size…</option>
                  {sizes.map((z) => (
                    <option key={z.id} value={z.id}>{z.sizeLabel} · {packOf(z)} · {money(listPriceOf(z))}</option>
                  ))}
                  {p && !sizes.some((z) => z.id === p.id) && <option value={p.id}>{p.name}</option>}
                </select>
                <span className="ns-qty">
                  <input id={`ns-qty-${l.key}`} inputMode="numeric" aria-label={`How many, line ${i + 1}`}
                         value={l.qty} disabled={!p} onChange={(e) => setQty(l.key, e.target.value)}
                         onFocus={(e) => e.currentTarget.select()}
                         onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); focusSoon('ns-add'); } }} />
                  <span className="small muted">{p ? unitOf(p) : ''}</span>
                </span>
                <span className="num ns-hide-s ns-rate">
                  {p ? (
                    <>
                      <input inputMode="decimal" aria-label={`Price per ${p.bottles_per_case > 0 ? 'case' : 'bottle'}, line ${i + 1}`}
                             className={`price-input${l.price !== null ? ' changed' : ''}`}
                             value={(priceOf(p, l) / 100).toFixed(2)}
                             onChange={(e) => setPrice(l.key, e.target.value)} />
                      {l.price !== null
                        ? <button type="button" className="as-link ns-tiny" onClick={() => setPrice(l.key, '')}>usual {money(listPriceOf(p))}</button>
                        : p.special_price ? <span className="ns-tiny ok-text">special</span> : null}
                    </>
                  ) : ''}
                </span>
                <span className="num ns-hide-s ns-amt">{p ? money(qtyOf(l) * priceOf(p, l)) : ''}</span>
                <button type="button" className="ns-x" aria-label={`Remove line ${i + 1}`} onClick={() => removeLine(l.key)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
                       strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              </div>
            );
          })}
          {blankLine && (
            <div className="ns-lg">
              <span className="ns-n ns-hide-s">+</span>
              <select id="ns-add" aria-label="Add a product" value="" onChange={(e) => chooseGroup(null, e.target.value)}>
                <option value="">Add a product…</option>
                {groups.map(([g, list]) => (
                  <option key={g} value={g}>{g} ({list.length} {list.length === 1 ? 'size' : 'sizes'})</option>
                ))}
              </select>
              <select disabled aria-label="Size"><option>Size</option></select>
              <span /><span className="ns-hide-s" /><span className="ns-hide-s" /><span />
            </div>
          )}

          {fullFives > 0 && !bottleOnOrder && (
            <div className="ns-empties">
              <label htmlFor="ns-emp">{outMode === 'Delivery' && !past ? '5-gal empties to hand over' : '5-gal empties handed in'}</label>
              <input id="ns-emp" inputMode="numeric" value={emptiesBack} placeholder={String(fullFives)}
                     onChange={(e) => setEmptiesBack(e.target.value.replace(/[^0-9]/g, ''))} />
              <span className="small">
                of {fullFives} full: {shortfall > 0 && bottleProduct
                  ? <strong>{shortfall} short, {shortfall} × {bottleProduct.name} at {money(priceOf(bottleProduct))} added. They own {shortfall === 1 ? 'it' : 'them'}.</strong>
                  : emptiesN === null ? 'how many come back?' : 'a straight swap.'}
              </span>
            </div>
          )}

          {(isAccount || isWalkIn) && (
            <div className="ns-extras">
              <div className="ns-extras-row">
                <button type="button" className="as-link" aria-expanded={noteOpen} onClick={() => setNoteOpen(!noteOpen)}>
                  {noteOpen ? '−' : '+'} {outMode === 'Delivery' ? 'Note for the driver' : 'Note on the order'}
                </button>
                {isAccount && outMode !== 'Counter' && !past && (
                  <span className="ns-repeat">
                    <span className="small">Repeat this order</span>
                    <button type="button" role="switch" aria-checked={repeat} aria-label="Repeat this order"
                            className={`switch${repeat ? ' on' : ''}`} onClick={() => setRepeat(!repeat)}><span /></button>
                  </span>
                )}
              </div>
              {noteOpen && (
                <textarea aria-label={outMode === 'Delivery' ? 'Note for the driver' : 'Note on the order'}
                          value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
              )}
              {repeat && isAccount && outMode !== 'Counter' && (
                <div className="ns-repeat-opts">
                  <div className="seg seg-small" role="group" aria-label="How often">
                    {PATTERNS.map(([pt, label]) => (
                      <button key={pt} type="button" className={pattern === pt ? 'active' : ''}
                              aria-pressed={pattern === pt} onClick={() => setPattern(pt)}>{label}</button>
                    ))}
                  </div>
                  {pattern === 'Weekly' && (
                    <div className="day-picks" role="group" aria-label="Repeat on these days">
                      {WEEK.map((d) => {
                        const on = repeatDays.includes(d) || d === weekdayOf(requestedDate);
                        return (
                          <button key={d} type="button" aria-pressed={on} className={`day-pick${on ? ' on' : ''}`}
                                  disabled={d === weekdayOf(requestedDate)}
                                  onClick={() => setRepeatDays((cur) => (cur.includes(d)
                                    ? cur.filter((x) => x !== d) : WEEK.filter((x) => x === d || cur.includes(x))))}>
                            {d}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <div className="muted small">
                    {pattern === 'Weekly' ? `${weekdayOf(requestedDate)} is this order's own day; each other day becomes its own weekly standing order. ` : ''}
                    Next after this: {day(nextAfter(date(requestedDate), pattern))}.
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        <section className="panel ns-money" aria-labelledby="ns-pay-h">
          <div className="total-line"><span>Subtotal</span><span className="num">{money(totals.subtotal)}</span></div>
          {shortfall > 0 && bottleProduct && (
            <div className="total-line muted small"><span>incl. {shortfall} × {bottleProduct.name}</span><span className="num">{money(shortfall * priceOf(bottleProduct))}</span></div>
          )}
          <div className="total-line">
            <label htmlFor="ns-disc" className="ns-inline-label">Discount</label>
            <span className="ns-disc">
              <span className="money-toggle" role="group" aria-label="Discount as">
                {(['%', '$'] as const).map((k) => (
                  <button key={k} type="button" className={discountAs === k ? 'on' : ''} aria-pressed={discountAs === k}
                          onClick={() => { setDiscountAs(k); setDiscount('0'); }}>{k}</button>
                ))}
              </span>
              <input id="ns-disc" inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} />
            </span>
          </div>
          {totals.discountAmount > 0 && <div className="total-line muted"><span /><span className="num">−{money(totals.discountAmount)}</span></div>}
          <div className="total-line">
            <label className="check ns-inline-label">
              <input type="checkbox" checked={chargeGct} onChange={(e) => setChargeGct(e.target.checked)} /> GCT 15%
            </label>
            <span className="num">{chargeGct ? money(totals.gct) : 'none'}</span>
          </div>
          {!chargeGct && customer?.gct_exempt && <div className="muted small">They are GCT exempt.</div>}
          <div className="total-line grand"><span>Total</span><span className="num ns-total">{money(totals.grandTotal)}</span></div>

          <h2 id="ns-pay-h" className="ns-pay-h">Payment</h2>

          {isAccount && (
            <div className="ns-seg ns-seg-full" role="group" aria-label="When do we collect payment">
              {whens.map(([w, label]) => (
                <button key={w} type="button" className={when === w ? 'on' : ''} aria-pressed={when === w}
                        onClick={() => { setPayWhen(w); setAmount(null); }}>{label}</button>
              ))}
            </div>
          )}
          {credit > 0 && (
            <div className="notice ok ns-tight">
              {money(credit)} credit goes against this order first{due > 0 ? `: ${money(due)} left to pay.` : ' and covers it.'}
            </div>
          )}
          {isAccount && when === 'On delivery' && (
            <div className="small">The driver collects {money(due)} at the door; it is settled with the round.</div>
          )}
          {isAccount && when === 'Now' && outMode === 'Delivery' && !past && (
            <div className="small" style={{ color: 'var(--warn-ink, #8a5a00)' }}>
              Only if the money is in the office now. The driver then has nothing to collect for this order; if the driver collects it too, it is counted twice.
            </div>
          )}
          {isAccount && when === 'On account' && (
            <div className="small">Nothing taken now. It goes on {termsWords}.</div>
          )}
          {isWalkIn && <div className="small muted">A walk-in pays the full {money(totals.grandTotal)} now.</div>}

          {takingNow && (
            <>
              <div className="ns-seg ns-seg-full" role="group" aria-label="Paid by">
                {methods.map(([v, label]) => (
                  <button key={v} type="button" className={method === v ? 'on' : ''} aria-pressed={method === v}
                          onClick={() => setMethod(v)}>{label}</button>
                ))}
              </div>
              <div className="ns-pay-row">
                <div>
                  <label htmlFor="ns-amt">{isWalkIn && method === 'Cash' ? 'Cash received' : isAccount ? 'For this order' : 'Amount received'}</label>
                  <input id="ns-amt" inputMode="decimal" value={amountTyped} onChange={(e) => setAmount(e.target.value)} />
                </div>
                {method !== 'Cash' && (
                  <div>
                    <label htmlFor="ns-ref">{method === 'Cheque' ? 'Cheque no.' : 'Reference'}</label>
                    <input id="ns-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
                  </div>
                )}
              </div>
              {amountNote && <div className="small">{amountNote}</div>}
            </>
          )}

          {isAccount && takingNow && openOlder.length > 0 && !past && (
            <div>
              <span className="label">Also collect on older invoices</span>
              <div className="ns-older">
                {openOlder.map((i) => {
                  const on = older.includes(i.invoice_id);
                  return (
                    <label key={i.invoice_id} className={on ? 'on' : ''} title={`${day(i.invoice_date)}${i.due_date ? `, due ${day(i.due_date)}` : ''}`}>
                      <input type="checkbox" checked={on}
                             onChange={() => setOlder((cur) => (on ? cur.filter((x) => x !== i.invoice_id) : [...cur, i.invoice_id]))} />
                      <span className="ns-inv">{i.invoice_number}</span>
                      {i.status === 'Overdue' && <span className="chip bad">Late</span>}
                      <span className="num">{money(Number(i.balance_cents))}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {isAccount && (
            <div className="ns-sum">
              <div className="total-line"><span>{past ? 'Paid at the time' : 'Taking now'}</span><strong className="num">{money(taking)}</strong></div>
              <div className="total-line">
                <span>{after < 0 ? 'In credit afterwards' : past ? 'They will owe' : `They will owe, once ${outMode === 'Delivery' ? 'delivered' : 'invoiced'}`}</span>
                <strong className={`num${after <= 0 ? ' ok-text' : ''}`}>{money(Math.abs(after))}</strong>
              </div>
            </div>
          )}

          {takingNow && ((isWalkIn && walkIn.email.trim()) || (isAccount && customer?.email)) && (
            <label className="check small">
              <input type="checkbox" checked={emailReceipt} onChange={(e) => setEmailReceipt(e.target.checked)} />
              Email the receipt to {isWalkIn ? walkIn.email.trim() : customer!.email}
            </label>
          )}

          <button type="button" className="ns-go" disabled={busy || who === 'none' || (who === 'account' && !customer)
                  || lines.every((l) => qtyOf(l) <= 0 || !l.productId)} onClick={finish}>
            {finishText}
          </button>
          <div className="ns-foot">
            <Link to="/orders" className="small">Cancel</Link>
            {isAccount && <Link to={`/quotes?customer=${customer!.id}`} className="small">Make a quote instead</Link>}
          </div>
        </section>
      </div>
    </div>
  );
}
