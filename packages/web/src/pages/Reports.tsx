import { Fragment, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, openPdf } from '../lib/api';
import { downloadCsv } from '../lib/csv';
import { money, day, todayInJamaica } from '../lib/format';

/**
 * Reports, as tabs over one period (approved mockup, 29 Sep 2026).
 *
 * Sales (by product, by where it went, top customers), a first look at
 * margin from the bills of materials, money owed, bottles, and the two
 * reports that were already here: discounts and raw material cost. Every
 * tab can be exported as a spreadsheet file for the accountant.
 */

interface Sales {
  totals: {
    netCents: number; grossCents: number; invoices: number; customers: number;
    newCustomers: number | null; creditNoteCents: number; creditNotes: number;
    creditNoteNetCents: number; creditNoteGctCents: number;
    netAfterCreditsCents: number; grossAfterCreditsCents: number; gctCents: number; gctAfterCreditsCents: number;
    totalSalesNetCents?: number; totalSalesGrossCents?: number;
  };
  /** Delivered to weekly/monthly customers, not invoiced yet (27 Oct 2026). */
  notInvoiced?: NotInvoiced;
  byProduct: Array<{ productId: string; name: string; bottlesPerCase: number; cases: number; bottles: number; cents: number }>;
  byZone: Array<{ zone: string; invoices: number; cents: number }>;
  topCustomers: Array<{ customerId: string; name: string; invoices: number; cents: number }>;
  bottles: { out: number; back: number; lost: number };
}
interface NotInvoiced {
  deliveries: number; netCents: number; grossCents: number; gctCents: number;
  customers: Array<{ customerId: string; name: string; cycle: string; deliveries: number; netCents: number; grossCents: number }>;
  items: Array<{ date: string; customerId: string; customer: string; cycle: string; orderNumber: string; kind: string;
    lines: Array<{ name: string; cases: number; bottles: number; bottlesPerCase: number; cents: number }> }>;
}
/** The end-of-day report (27 Oct 2026); see services/endofday.ts. */
interface EndOfDay {
  day: string; tomorrow: string;
  sales: {
    invoices: Array<{ invoiceId: string; number: string; customerId: string; customer: string; how: string; orders: string | null;
      netCents: number; gctCents: number; totalCents: number; paidCents: number; balanceCents: number; status: string }>;
    byProduct: Array<{ name: string; bottlesPerCase: number; cases: number; bottles: number; cents: number }>;
    byHow: Array<{ how: string; count: number; netCents: number }>;
    credits: Array<{ invoiceId: string; number: string; customer: string; against: string | null; netCents: number; totalCents: number; reason: string | null }>;
    notInvoiced: NotInvoiced;
    totals: { invoices: number; customers: number; invoicedNetCents: number; invoicedGrossCents: number; creditNetCents: number;
      creditGrossCents: number; netAfterCreditsCents: number; grossAfterCreditsCents: number; notInvoicedNetCents: number;
      notInvoicedGrossCents: number; totalSalesNetCents: number; totalSalesGrossCents: number; paidOnTheseCents: number; stillOwedOnTheseCents: number };
  };
  money: {
    payments: Array<{ id: string; amountCents: number; method: string; confirmed: boolean; reversal: boolean; receipt: string | null;
      reference: string | null; customer: string; invoice: string | null; takenBy: string; onRound: boolean; at: string }>;
    byMethod: Array<{ label: string; count: number; cents: number }>;
    byWho: Array<{ label: string; count: number; cents: number }>;
    confirmedCents: number; provisionalCents: number; totalCents: number;
  };
  rounds: Rounds;
  orders: {
    taken: Array<{ orderId: string; number: string; customer: string; zone: string | null; mode: string; source: string; status: string; forDay: string | null; totalCents: number; items: string }>;
    booked: Array<{ orderId: string; number: string; customer: string; zone: string | null; mode: string; source: string; status: string; forDay: string | null; totalCents: number; items: string }>;
  };
}
interface Txn {
  invoiceId: string; number: string; date: string; type: string; customerId: string; customer: string;
  orders: string | null; customerPo: string | null; against: string | null;
  subtotalCents: number; discountCents: number; netCents: number; gctCents: number; totalCents: number;
  balanceCents: number; status: string; zone: string | null; deliveredOn: string | null;
}
interface RoundRow {
  id: string; date: string; zone: string; driver: string | null; status: string; started: boolean;
  stops: number; delivered: number; missed: number; pending: number; invoicedCents: number;
  recordedCents: number; handedInCents: number | null; cashVarianceCents: number | null;
  fullOut: number; emptiesRecorded: number; emptiesCounted: number | null; bottleVariance: number | null;
}
interface Rounds {
  totals: { rounds: number; settled: number; stops: number; delivered: number; missed: number;
    invoicedCents: number; recordedCents: number; handedInCents: number; cashVarianceCents: number; roundsShort: number };
  rounds: RoundRow[];
}
interface Margin {
  productId: string; name: string; bottlesPerCase: number; bottlesSold: number; salesCents: number;
  returnable: boolean; bomLines: number; costedLines: number; materialPerBottleCents: number | null;
  materialCents: number | null; marginCents: number | null; marginPercent: number | null;
}
/** The aged schedule (27 Oct 2026); see reports.agingSchedule. */
type Age = 'current' | 'd30' | 'd60' | 'd90';
interface Aging {
  asOf: string;
  totals: { currentCents: number; d30Cents: number; d60Cents: number; d90Cents: number; openCents: number; creditCents: number; netCents: number };
  customers: Array<{ customerId: string; name: string; active: boolean; phone: string | null; currentCents: number; d30Cents: number;
    d60Cents: number; d90Cents: number; openCents: number; creditCents: number; netCents: number; invoices: number; oldestDaysLate: number }>;
  invoices: Array<{ invoiceId: string; number: string; customerId: string; customer: string; invoiceDate: string; dueDate: string | null;
    daysLate: number; bucket: Age; totalCents: number; paidCents: number; balanceCents: number; openingBalance: boolean }>;
}
const AGES: Array<[Age | 'all', string]> = [['current', 'Not yet due'], ['d30', '1–30 days'], ['d60', '31–60 days'], ['d90', 'Over 60 days'], ['all', 'All owed']];
const ageCents = (t: { currentCents: number; d30Cents: number; d60Cents: number; d90Cents: number; openCents: number }, a: Age | 'all') =>
  a === 'all' ? t.openCents : a === 'current' ? t.currentCents : a === 'd30' ? t.d30Cents : a === 'd60' ? t.d60Cents : t.d90Cents;
interface Pool { label: string; clean_ready: number; filled_with_customer: number; returned_dirty: number; lost_damaged: number; in_circulation: number }
interface DiscountTotals { totalDiscountCents: number; discountedDocumentCount: number; averageDiscountPercent: number }
interface PerClient { customerId: string; customerName: string; totalDiscountCents: number; discountedDocumentCount: number; averageDiscountPercent: number }
interface MaterialCost {
  rawMaterialId: string; name: string; unitOfMeasure: string; quantityOnHand: number;
  blendedAverageUnitCostCents: number;
  perSupplier: Array<{ supplierName: string; quantity: number; averageUnitCostCents: number }>;
}

const TABS = [
  ['sales', 'Sales'], ['eod', 'End of day'], ['transactions', 'Sales transactions'], ['margin', 'Margin'], ['rounds', 'Rounds and cash'], ['loadings', 'Truck loadings'],
  ['owed', 'Money owed'], ['bottles', 'Bottles'], ['discounts', 'Discounts'], ['materials', 'Material cost'],
] as const;

/** One truck loading (10 Oct 2026, point 4): every loader is credited with the whole load. */
interface Loading {
  sheetId: string; day: string; zone: string; driverName: string | null; loadedAt: string;
  loadedByName: string | null; loaders: string[]; returned: boolean;
  driverConfirmedName: string | null; driverConfirmedAt: string | null;
  lines: Array<{ product: string; bottlesPerCase: number; loaded: number; added?: number; delivered: number; returned: number | null; difference: number | null }>;
  /** Added after the driver confirmed; credited to their own loaders. */
  additions?: Array<{ addedAt: string; addedByName: string | null; loaderNames: string[]; driverConfirmedName: string | null;
    lines: Array<{ name: string; bottlesPerCase: number; bottles: number }> }>;
}
const qtyOf = (bpc: number, bottles: number) => (bpc > 0 ? `${Math.round((bottles / bpc) * 100) / 100} cs` : `${bottles}`);
type Tab = typeof TABS[number][0];
type Period = 'today' | 'yesterday' | 'week' | 'month' | 'last' | 'year' | 'all' | 'custom';
/** One click each (Everton, 27 Oct 2026). */
const PERIODS: Array<[Period, string]> = [
  ['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week'], ['month', 'This month'],
  ['last', 'Last month'], ['year', 'This year'], ['all', 'All time'], ['custom', 'Choose dates…'],
];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const short = (n: string) => n.replace(/^Alka Vida\s+/i, '');
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

function rangeFor(p: Period, custom: { from: string; to: string }): { from: string; to: string; label: string } {
  const today = todayInJamaica();
  const [y, m] = today.split('-').map(Number);
  const pad = (n: number) => String(n).padStart(2, '0');
  const last = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const shift = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  if (p === 'today') return { from: today, to: today, label: `today, ${day(today)}` };
  if (p === 'yesterday') { const yd = shift(today, -1); return { from: yd, to: yd, label: `yesterday, ${day(yd)}` }; }
  if (p === 'week') {
    // Monday to Sunday, the same week the weekly invoices use.
    const back = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
    const mon = shift(today, -back); const sun = shift(mon, 6);
    return { from: mon, to: sun, label: `this week, ${day(mon)} to ${day(sun)}` };
  }
  if (p === 'month') return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${last(y, m)}`, label: `${MONTHS[m - 1]} ${y}` };
  if (p === 'last') {
    const ly = m === 1 ? y - 1 : y; const lm = m === 1 ? 12 : m - 1;
    return { from: `${ly}-${pad(lm)}-01`, to: `${ly}-${pad(lm)}-${last(ly, lm)}`, label: `${MONTHS[lm - 1]} ${ly}` };
  }
  if (p === 'year') return { from: `${y}-01-01`, to: today, label: `${y} so far` };
  if (p === 'custom') return { from: custom.from, to: custom.to, label: `${custom.from || 'the start'} to ${custom.to || 'today'}` };
  return { from: '', to: '', label: 'all time' };
}

const dollars = (c: number | null) => (c === null ? '' : (c / 100).toFixed(2));

export default function Reports() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'sales') as Tab;
  const age = (AGES.some(([k]) => k === params.get('age')) ? params.get('age') : 'all') as Age | 'all';
  const [period, setPeriodState] = useState<Period>(() => {
    try {
      const saved = localStorage.getItem('reports.period') as Period | null;
      return saved && PERIODS.some(([k]) => k === saved) ? saved : 'month';
    } catch { return 'month'; }
  });
  const setPeriod = (p: Period) => {
    setPeriodState(p);
    try { localStorage.setItem('reports.period', p); } catch { /* not kept; fine */ }
  };
  const [eodDay, setEodDay] = useState(todayInJamaica());
  const [eod, setEod] = useState<EndOfDay | null>(null);
  const [custom, setCustom] = useState({ from: '', to: '' });
  const range = rangeFor(period, custom);

  const [sales, setSales] = useState<Sales | null>(null);
  const [margin, setMargin] = useState<Margin[] | null>(null);
  const [rounds, setRounds] = useState<Rounds | null>(null);
  const [owed, setOwed] = useState<Aging | null>(null);
  const [pool, setPool] = useState<Pool[] | null>(null);
  const [disc, setDisc] = useState<{ totals: DiscountTotals; byClient: PerClient[] } | null>(null);
  const [materials, setMaterials] = useState<MaterialCost[] | null>(null);
  const [txns, setTxns] = useState<Txn[] | null>(null);
  const [loadings, setLoadings] = useState<Loading[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const q = new URLSearchParams();
  if (range.from) q.set('from', range.from);
  if (range.to) q.set('to', range.to);
  const qs = q.toString();

  useEffect(() => {
    setError(null);
    const fail = (e: Error) => setError(e.message);
    if (tab === 'sales' || tab === 'bottles') api.get<Sales>(`/api/reports/sales?${qs}`).then(setSales).catch(fail);
    if (tab === 'rounds') api.get<Rounds>(`/api/reports/rounds?${qs}`).then(setRounds).catch(fail);
    if (tab === 'margin') api.get<Margin[]>(`/api/reports/margin?${qs}`).then(setMargin).catch(fail);
    if (tab === 'loadings') api.get<Loading[]>(`/api/reports/loadings?${qs}`).then(setLoadings).catch(fail);
    if (tab === 'transactions') api.get<Txn[]>(`/api/reports/sales-transactions?${qs}`).then(setTxns).catch(fail);
    if (tab === 'eod') { setEod(null); api.get<EndOfDay>(`/api/reports/end-of-day?day=${eodDay}`).then(setEod).catch(fail); }
    if (tab === 'discounts') api.get<{ totals: DiscountTotals; byClient: PerClient[] }>(`/api/reports/discounts?${qs}`).then(setDisc).catch(fail);
  }, [tab, qs, eodDay]);
  useEffect(() => {
    if (tab === 'owed' && !owed) api.get<Aging>('/api/reports/aging').then(setOwed).catch((e) => setError(e.message));
    if (tab === 'bottles' && !pool) api.get<Pool[]>('/api/reports/bottle-pool').then(setPool).catch(() => setPool([]));
    if (tab === 'materials' && !materials) api.get<MaterialCost[]>('/api/reports/material-costs').then(setMaterials).catch((e) => setError(e.message));
  }, [tab]);

  const periodMatters = !['owed', 'materials', 'eod'].includes(tab);
  const file = (what: string) => `alka-vida-${what}${range.from ? `-${range.from}-to-${range.to}` : ''}.csv`;

  function exportTab() {
    if (tab === 'sales' && sales) {
      downloadCsv(file('sales'), [
        ['Sales', range.label], [],
        ['Invoiced before GCT', dollars(sales.totals.netCents)],
        ['Less credit notes before GCT', dollars(-sales.totals.creditNoteNetCents)],
        ['Net sales before GCT (post this)', dollars(sales.totals.netAfterCreditsCents)],
        ['GCT, after credit notes', dollars(sales.totals.gctAfterCreditsCents)],
        ['Net sales with GCT', dollars(sales.totals.grossAfterCreditsCents)],
        ...(sales.notInvoiced?.deliveries ? [
          ['Delivered to weekly/monthly customers, not invoiced yet, before GCT', dollars(sales.notInvoiced.netCents)],
          ['Total sales before GCT', dollars(sales.totals.totalSalesNetCents ?? sales.totals.netAfterCreditsCents)],
          ['Total sales with GCT', dollars(sales.totals.totalSalesGrossCents ?? sales.totals.grossAfterCreditsCents)],
        ] : []),
        ['Invoices', sales.totals.invoices], ['Credit notes', sales.totals.creditNotes],
        ['Customers buying', sales.totals.customers], [],
        ['Product', 'Cases', 'Bottles', 'Sales (before discount and GCT)'],
        ...sales.byProduct.map((p) => [p.name, p.cases, p.bottles, dollars(p.cents)]), [],
        ['Where it went', 'Invoices', 'Sales before GCT'],
        ...sales.byZone.map((z) => [z.zone, z.invoices, dollars(z.cents)]), [],
        ['Customer', 'Invoices', 'Sales before GCT'],
        ...sales.topCustomers.map((c) => [c.name, c.invoices, dollars(c.cents)]),
        ...(sales.notInvoiced?.deliveries ? [[], ['Not invoiced yet: customer', 'Invoiced', 'Deliveries', 'Before GCT'],
          ...sales.notInvoiced.customers.map((c) => [c.name, c.cycle, c.deliveries, dollars(c.netCents)])] : []),
      ]);
    } else if (tab === 'eod' && eod) {
      const e = eod;
      downloadCsv(`alka-vida-end-of-day-${e.day}.csv`, [
        ['End of day', e.day], [],
        ['Invoiced before GCT', dollars(e.sales.totals.invoicedNetCents)],
        ['Less credit notes before GCT', dollars(-e.sales.totals.creditNetCents)],
        ['Not invoiced yet (weekly/monthly) before GCT', dollars(e.sales.totals.notInvoicedNetCents)],
        ['Total sales before GCT', dollars(e.sales.totals.totalSalesNetCents)],
        ['Money received (confirmed)', dollars(e.money.confirmedCents)],
        ['Recorded on rounds, not settled', dollars(e.money.provisionalCents)], [],
        ['Invoice', 'Customer', 'How', 'Before GCT', 'GCT', 'Total', 'Still owed'],
        ...e.sales.invoices.map((i) => [i.number, i.customer, i.how, dollars(i.netCents), dollars(i.gctCents), dollars(i.totalCents), dollars(Math.max(i.balanceCents, 0))]), [],
        ['Time', 'Customer', 'Method', 'Receipt', 'Invoice', 'Taken by', 'Settled', 'Amount'],
        ...e.money.payments.map((p) => [p.at, p.customer, p.method, p.receipt ?? '', p.invoice ?? 'on account', p.takenBy, p.confirmed ? 'yes' : 'no', dollars(p.amountCents)]), [],
        ['Round', 'Driver', 'Stops', 'Delivered', 'Not delivered', 'Not done', 'Recorded', 'Handed in', 'Bottles out', 'Empties back'],
        ...e.rounds.rounds.map((r) => [r.zone, r.driver ?? '', r.stops, r.delivered, r.missed, r.pending, dollars(r.recordedCents), dollars(r.handedInCents), r.fullOut, r.emptiesCounted ?? r.emptiesRecorded]), [],
        ['Orders taken', 'Customer', 'For', 'Items', 'From'],
        ...e.orders.taken.map((o) => [o.number, o.customer, o.forDay ?? '', o.items, o.source]), [],
        [`Booked for ${e.tomorrow}`, 'Customer', 'Zone', 'Items', 'From'],
        ...e.orders.booked.map((o) => [o.number, o.customer, o.zone ?? (o.mode === 'Pickup' ? 'collect' : ''), o.items, o.source]),
      ]);
    } else if (tab === 'transactions' && txns) {
      downloadCsv(file('sales-transactions'), [
        ['Date', 'Type', 'Number', 'Customer', 'Order', 'Customer PO', 'Against invoice', 'Subtotal', 'Discount',
          'Net before GCT', 'GCT', 'Total', 'Still owed', 'Status', 'Round', 'Delivered'],
        ...txns.map((t) => [t.date, t.type, t.number, t.customer, t.orders ?? '', t.customerPo ?? '', t.against ?? '',
          dollars(t.subtotalCents), dollars(t.discountCents), dollars(t.netCents), dollars(t.gctCents), dollars(t.totalCents),
          t.type === 'Invoice' ? dollars(t.balanceCents) : '', t.status, t.zone ?? '', t.deliveredOn ?? '']),
        [],
        ['', '', '', '', '', '', 'Totals', dollars(txns.reduce((a, t) => a + t.subtotalCents, 0)),
          dollars(txns.reduce((a, t) => a + t.discountCents, 0)), dollars(txns.reduce((a, t) => a + t.netCents, 0)),
          dollars(txns.reduce((a, t) => a + t.gctCents, 0)), dollars(txns.reduce((a, t) => a + t.totalCents, 0))],
      ]);
    } else if (tab === 'rounds' && rounds) {
      downloadCsv(file('rounds-and-cash'), [
        ['Date', 'Round', 'Driver', 'Status', 'Stops', 'Delivered', 'Not delivered', 'Invoiced', 'Recorded by driver', 'Handed in', 'Difference', 'Full bottles out', 'Empties recorded', 'Empties counted'],
        ...rounds.rounds.map((r) => [r.date, r.zone, r.driver ?? '', r.status === 'Completed' ? 'Settled' : 'Open', r.stops, r.delivered, r.missed,
          dollars(r.invoicedCents), dollars(r.recordedCents), dollars(r.handedInCents), dollars(r.cashVarianceCents),
          r.fullOut, r.emptiesRecorded, r.emptiesCounted ?? '']),
      ]);
    } else if (tab === 'margin' && margin) {
      downloadCsv(file('margin'), [
        ['Product', 'Bottles sold', 'Sales', 'Materials per bottle', 'Materials', 'Margin', 'Margin %'],
        ...margin.map((m) => [m.name, m.bottlesSold, dollars(m.salesCents), dollars(m.materialPerBottleCents),
          dollars(m.materialCents), dollars(m.marginCents), m.marginPercent ?? '']),
        [], ['Labour, delivery and overheads are not included.'],
      ]);
    } else if (tab === 'loadings' && loadings) {
      downloadCsv(file('truck-loadings'), [
        ['Day', 'Logged at', 'Round', 'Driver', 'Loaded by', 'Logged by (office)', 'Confirmed by (driver)', 'Product', 'Loaded', 'Delivered', 'Back', 'Difference', 'Unit'],
        ...loadings.flatMap((l) => l.loaders.length ? l.loaders.map((who) => ({ l, who })) : [{ l, who: '' }]).flatMap(({ l, who }) =>
          l.lines.map((x) => {
            const per = x.bottlesPerCase > 0 ? x.bottlesPerCase : 1;
            return [l.day, new Date(l.loadedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Jamaica' }),
              l.zone, l.driverName ?? '', who, l.loadedByName ?? '', l.driverConfirmedName ?? 'not confirmed', short(x.product), x.loaded / per, x.delivered / per,
              x.returned === null ? '' : x.returned / per, x.difference === null ? '' : x.difference / per,
              x.bottlesPerCase > 0 ? 'cases' : 'bottles'];
          })),
        ...loadings.flatMap((l) => (l.additions ?? []).flatMap((a) => (a.loaderNames.length ? a.loaderNames : ['']).flatMap((who) =>
          a.lines.map((x) => {
            const per = x.bottlesPerCase > 0 ? x.bottlesPerCase : 1;
            return [l.day, new Date(a.addedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Jamaica' }),
              `${l.zone} (added later)`, l.driverName ?? '', who, a.addedByName ?? '', a.driverConfirmedName ?? 'not confirmed',
              short(x.name), x.bottles / per, '', '', '', x.bottlesPerCase > 0 ? 'cases' : 'bottles'];
          })))),
      ]);
    } else if (tab === 'owed' && owed) {
      if (age === 'all') {
        downloadCsv(`alka-vida-aged-receivables-${owed.asOf}.csv`, [
          ['Aged receivables', `as of ${owed.asOf}`], [],
          ['Customer', 'Not yet due', '1-30 days', '31-60 days', 'Over 60 days', 'Open invoices', 'Credit not applied', 'Net owed'],
          ...owed.customers.map((c) => [c.name + (c.active ? '' : ' (inactive)'), dollars(c.currentCents), dollars(c.d30Cents), dollars(c.d60Cents),
            dollars(c.d90Cents), dollars(c.openCents), dollars(c.creditCents), dollars(c.netCents)]),
          ['Total', dollars(owed.totals.currentCents), dollars(owed.totals.d30Cents), dollars(owed.totals.d60Cents), dollars(owed.totals.d90Cents),
            dollars(owed.totals.openCents), dollars(owed.totals.creditCents), dollars(owed.totals.netCents)],
        ]);
      } else {
        const list = owed.invoices.filter((i) => i.bucket === age);
        downloadCsv(`alka-vida-owed-${age}-${owed.asOf}.csv`, [
          [`Money owed: ${AGES.find(([k]) => k === age)![1]}`, `as of ${owed.asOf}`], [],
          ['Customer', 'Invoice', 'Invoice date', 'Due', 'Days late', 'Total', 'Paid', 'Owed'],
          ...list.map((i) => [i.customer, i.number, i.invoiceDate, i.dueDate ?? '', i.daysLate, dollars(i.totalCents), dollars(i.paidCents), dollars(i.balanceCents)]),
          ['Total', '', '', '', '', '', '', dollars(list.reduce((a, i) => a + i.balanceCents, 0))],
        ]);
      }
    } else if (tab === 'bottles' && sales) {
      downloadCsv(file('bottles'), [
        ['Returnable bottles', range.label], ['Out full', sales.bottles.out], ['Back empty', sales.bottles.back], ['Lost or damaged', sales.bottles.lost],
        [], ['Pool', 'Clean and ready', 'With customers', 'Back dirty', 'Lost or damaged'],
        ...(pool ?? []).map((p) => [p.label, p.clean_ready, p.filled_with_customer, p.returned_dirty, p.lost_damaged]),
      ]);
    } else if (tab === 'discounts' && disc) {
      downloadCsv(file('discounts'), [
        ['Customer', 'Total discount', 'Documents', 'Average %'],
        ...disc.byClient.map((r) => [r.customerName, dollars(r.totalDiscountCents), r.discountedDocumentCount, r.averageDiscountPercent]),
      ]);
    } else if (tab === 'materials' && materials) {
      downloadCsv('alka-vida-material-cost.csv', [
        ['Material', 'On hand', 'Unit', 'Blended average cost'],
        ...materials.map((m) => [m.name, m.quantityOnHand, m.unitOfMeasure, dollars(m.blendedAverageUnitCostCents)]),
      ]);
    }
  }

  // ---- tabs ----
  const transactionsTab = () => {
    if (!txns) return <p className="muted">Loading…</p>;
    if (txns.length === 0) return <div className="panel"><p className="muted" style={{ margin: 0 }}>No invoices or credit notes in {range.label}.</p></div>;
    const sum = (k: 'subtotalCents' | 'discountCents' | 'netCents' | 'gctCents' | 'totalCents') => txns.reduce((a, t) => a + t[k], 0);
    return (
      <div className="panel" style={{ padding: 0 }}>
        <div className="panel-pad">
          <h2 className="side-h" style={{ margin: 0 }}>What makes up the sales total</h2>
          <div className="muted small">Every invoice and credit note dated {range.label === 'all time' ? 'at any time' : `in ${range.label}`}, with the order it came from. Credit notes are negative, so the totals match the Sales tab.</div>
        </div>
        <table className="orders-table">
          <thead>
            <tr><th>Date</th><th>Number</th><th>Customer</th><th>Order</th>
              <th className="num">Before GCT</th><th className="num">GCT</th><th className="num">Total</th><th>Status</th></tr>
          </thead>
          <tbody>
            {txns.map((t) => (
              <tr key={t.invoiceId}>
                <td data-label="Date">{day(t.date)}</td>
                <td data-label="Number"><Link to={`/invoices/${t.invoiceId}`}>{t.number}</Link>
                  {t.type !== 'Invoice' && <div className="muted small">credit note{t.against ? ` on ${t.against}` : ''}</div>}</td>
                <td data-label="Customer"><Link to={`/customers/${t.customerId}`}>{t.customer}</Link></td>
                <td data-label="Order" className="small">{t.orders ?? '—'}{t.customerPo && <div className="muted">PO {t.customerPo}</div>}</td>
                <td data-label="Before GCT" className="num">{money(t.netCents)}
                  {t.discountCents !== 0 && <div className="muted small">after {money(Math.abs(t.discountCents))} off</div>}</td>
                <td data-label="GCT" className="num">{money(t.gctCents)}</td>
                <td data-label="Total" className="num"><strong>{money(t.totalCents)}</strong></td>
                <td data-label="Status" className="small">{t.status}</td>
              </tr>
            ))}
            <tr className="group-row">
              <td colSpan={4}><strong>{txns.length} documents</strong></td>
              <td className="num"><strong>{money(sum('netCents'))}</strong></td>
              <td className="num"><strong>{money(sum('gctCents'))}</strong></td>
              <td className="num"><strong>{money(sum('totalCents'))}</strong></td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    );
  };

  const salesTab = () => {
    if (!sales) return <p className="muted">Loading…</p>;
    const t = sales.totals;
    const top = sales.byProduct[0];
    const productTotal = sales.byProduct.reduce((s, p) => s + p.cents, 0);
    const zoneTotal = sales.byZone.reduce((s, z) => s + z.cents, 0);
    const wait = sales.notInvoiced;
    const waiting = wait?.deliveries ?? 0;
    if (t.invoices === 0 && waiting === 0) return <div className="panel"><p className="muted" style={{ margin: 0 }}>No sales in {range.label}.</p></div>;
    return (
      <>
        <div className="stat-row">
          <div className="stat"><div className="stat-label">Total sales</div><div className="stat-value">{money(t.totalSalesNetCents ?? t.netAfterCreditsCents)}</div>
            <div className="stat-note">{money(t.totalSalesGrossCents ?? t.grossAfterCreditsCents)} with GCT
              {waiting > 0 ? `; ${money(wait!.netCents)} not invoiced yet` : t.creditNotes > 0 ? ', after credit notes' : ''}</div></div>
          <div className="stat"><div className="stat-label">Deliveries and collections</div><div className="stat-value">{t.invoices + waiting}</div>
            <div className="stat-note">{waiting > 0 ? `${t.invoices} invoiced, ${waiting} not invoiced yet` : `average ${money(Math.round(t.netCents / Math.max(t.invoices, 1)))}`}</div></div>
          <div className="stat"><div className="stat-label">Customers buying</div><div className="stat-value">{t.customers}</div>
            <div className="stat-note">{waiting > 0 ? `+ ${wait!.customers.length} on weekly/monthly invoices` : t.newCustomers !== null ? `${t.newCustomers} new in this period` : ' '}</div></div>
          <div className="stat"><div className="stat-label">Returnable bottles</div><div className="stat-value">{sales.bottles.out} out · {sales.bottles.back} back</div>
            <div className="stat-note">{Math.max(sales.bottles.out - sales.bottles.back - sales.bottles.lost, 0)} still with customers</div></div>
        </div>
        <section className="panel" style={{ maxWidth: 520 }}>
          <h2 className="side-h">For QuickBooks, {range.label}</h2>
          <div className="total-line"><span>Invoiced, before GCT</span><span>{money(t.netCents)}</span></div>
          <div className="total-line"><span>Less {t.creditNotes} credit note{t.creditNotes === 1 ? '' : 's'}, before GCT</span><span>−{money(t.creditNoteNetCents)}</span></div>
          <div className="total-line grand"><span>Net sales, before GCT</span><span>{money(t.netAfterCreditsCents)}</span></div>
          <div className="total-line"><span>GCT collected, after credit notes</span><span>{money(t.gctAfterCreditsCents)}</span></div>
          <div className="total-line"><span>Net sales with GCT</span><span>{money(t.grossAfterCreditsCents)}</span></div>
          {waiting > 0 && (
            <>
              <div className="total-line" style={{ marginTop: 10 }}>
                <span>Delivered to weekly/monthly customers, not invoiced yet ({waiting})</span><span>{money(wait!.netCents)}</span></div>
              <div className="total-line grand"><span>Total sales, before GCT</span><span>{money(t.totalSalesNetCents ?? t.netAfterCreditsCents)}</span></div>
              <div className="total-line"><span>Total sales with GCT</span><span>{money(t.totalSalesGrossCents ?? t.grossAfterCreditsCents)}</span></div>
            </>
          )}
          <p className="muted small" style={{ marginBottom: 0 }}>
            {waiting > 0 && <>Post the invoiced figure; the rest goes on the weekly or monthly invoice, dated the last day of its week or month. </>}
            Credit notes are taken off. The charts below are what was invoiced, before credit notes.{' '}
            <button type="button" className="as-link small" onClick={() => setParams({ tab: 'transactions' }, { replace: true })}>
              See every invoice and credit note
            </button>
          </p>
        </section>
        {t.invoices > 0 && <div className="report-grid">
          <section className="panel">
            {top && <h2 className="side-h">{short(top.name)} brings in the most: {pct(top.cents, productTotal)}% of sales</h2>}
            <div className="muted small" style={{ marginBottom: 10 }}>Sales by product, {range.label}, before discounts and GCT</div>
            <div className="bars">
              {sales.byProduct.map((p) => (
                <div className="bar-row" key={p.productId}>
                  <span className="bar-name">{short(p.name)}</span>
                  <div className="bar-track"><div className="bar-fill" style={{ width: `${Math.max(pct(p.cents, top?.cents ?? 1), 2)}%` }} /></div>
                  <span className="bar-value">{money(p.cents)}</span>
                </div>
              ))}
            </div>
            <table style={{ marginTop: 16 }}>
              <thead><tr><th>Where it went</th><th className="num">Invoices</th><th className="num">Sales</th><th className="num">Share</th></tr></thead>
              <tbody>
                {sales.byZone.map((z) => (
                  <tr key={z.zone}><td>{z.zone}</td><td className="num">{z.invoices}</td><td className="num">{money(z.cents)}</td><td className="num">{pct(z.cents, zoneTotal)}%</td></tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="panel">
            <h2 className="side-h">Top customers</h2>
            {sales.topCustomers.map((c) => (
              <div className="total-line" key={c.customerId}>
                <Link to={`/customers/${c.customerId}`}>{c.name}</Link><span>{money(c.cents)}</span>
              </div>
            ))}
            <p className="muted small" style={{ marginBottom: 0 }}>Before GCT, after approved discounts.</p>
          </section>
        </div>}
        {waiting > 0 && (
          <section className="panel">
            <h2 className="side-h">Delivered, not invoiced yet</h2>
            <div className="muted small" style={{ marginBottom: 8 }}>
              Customers invoiced weekly or monthly. Counted on the day the goods went out; their invoice is raised when the week or month closes.
            </div>
            <table>
              <thead><tr><th>Customer</th><th>Invoiced</th><th className="num">Deliveries</th><th className="num">Before GCT</th><th className="num">With GCT</th></tr></thead>
              <tbody>
                {wait!.customers.map((c) => (
                  <tr key={c.customerId}>
                    <td><Link to={`/customers/${c.customerId}`}>{c.name}</Link></td><td className="small">{c.cycle === 'PerDelivery' ? 'every delivery' : c.cycle.toLowerCase()}</td>
                    <td className="num">{c.deliveries}</td><td className="num">{money(c.netCents)}</td><td className="num">{money(c.grossCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </>
    );
  };

  const qty = (bpc: number, cases: number, bottles: number) => (bpc > 0 && cases > 0
    ? `${cases} cs${bottles > 0 ? ` + ${bottles}` : ''}` : `${bottles} ${bottles === 1 ? 'bottle' : 'bottles'}`);

  const eodTab = () => {
    if (!eod) return <p className="muted">Loading…</p>;
    const t = eod.sales.totals;
    const m = eod.money;
    const rt = eod.rounds.totals;
    const wait = eod.sales.notInvoiced;
    const out = eod.rounds.rounds.reduce((a, r) => a + r.fullOut, 0);
    const back = eod.rounds.rounds.reduce((a, r) => a + (r.emptiesCounted ?? r.emptiesRecorded), 0);
    return (
      <>
        <div className="stat-row">
          <div className="stat"><div className="stat-label">Total sales</div><div className="stat-value">{money(t.totalSalesNetCents)}</div>
            <div className="stat-note">{money(t.totalSalesGrossCents)} with GCT{wait.deliveries ? `; ${money(wait.netCents)} not invoiced yet` : ''}</div></div>
          <div className="stat"><div className="stat-label">Money received</div><div className="stat-value">{money(m.confirmedCents)}</div>
            <div className="stat-note">{m.provisionalCents ? `+ ${money(m.provisionalCents)} on rounds not settled` : `${m.payments.length} payment${m.payments.length === 1 ? '' : 's'}`}</div></div>
          <div className="stat"><div className="stat-label">Stops delivered</div><div className="stat-value">{rt.delivered} of {rt.stops}</div>
            <div className="stat-note">{eod.rounds.rounds.length} round{eod.rounds.rounds.length === 1 ? '' : 's'} · {out} bottles out, {back} back</div></div>
          <div className="stat"><div className="stat-label">Orders taken</div><div className="stat-value">{eod.orders.taken.length}</div>
            <div className="stat-note">{eod.orders.booked.length} booked for {day(eod.tomorrow)}</div></div>
        </div>

        <section className="panel">
          <h2 className="side-h">1. Sales</h2>
          <div style={{ maxWidth: 560 }}>
            <div className="total-line"><span>Invoiced, before GCT ({t.invoices} invoice{t.invoices === 1 ? '' : 's'}, {t.customers} customer{t.customers === 1 ? '' : 's'})</span><span>{money(t.invoicedNetCents)}</span></div>
            {eod.sales.credits.length > 0 && <div className="total-line"><span>Less {eod.sales.credits.length} credit note{eod.sales.credits.length === 1 ? '' : 's'}</span><span>−{money(t.creditNetCents)}</span></div>}
            {wait.deliveries > 0 && <div className="total-line"><span>Delivered to weekly/monthly customers, not invoiced yet ({wait.deliveries})</span><span>{money(wait.netCents)}</span></div>}
            <div className="total-line grand"><span>Total sales, before GCT</span><span>{money(t.totalSalesNetCents)}</span></div>
            <div className="total-line"><span>Paid so far on this day's invoices</span><span>{money(t.paidOnTheseCents)}</span></div>
            <div className="total-line"><span>Still owed on this day's invoices</span><span>{money(t.stillOwedOnTheseCents)}</span></div>
          </div>
          {eod.sales.byHow.length > 0 && (
            <div className="row" style={{ gap: 24, margin: '10px 0' }}>
              {eod.sales.byHow.map((h) => <div key={h.how}><div className="muted small">{h.how} ({h.count})</div><strong>{money(h.netCents)}</strong></div>)}
            </div>
          )}
          {eod.sales.byProduct.length > 0 && (
            <table style={{ marginTop: 8 }}>
              <thead><tr><th>Product</th><th className="num">Quantity</th><th className="num">Before discount and GCT</th></tr></thead>
              <tbody>{eod.sales.byProduct.map((p) => (
                <tr key={p.name}><td>{short(p.name)}</td><td className="num">{qty(p.bottlesPerCase, p.cases, p.bottles)}</td><td className="num">{money(p.cents)}</td></tr>
              ))}</tbody>
            </table>
          )}
          {eod.sales.invoices.length > 0 ? (
            <div className="table-scroll" style={{ marginTop: 12 }}>
              <table className="phone-cards">
                <thead><tr><th>Invoice</th><th>Customer</th><th>How</th><th className="num">Before GCT</th><th className="num">Total</th><th className="num">Still owed</th></tr></thead>
                <tbody>{eod.sales.invoices.map((i) => (
                  <tr key={i.invoiceId}>
                    <td data-label="Invoice"><Link to={`/invoices/${i.invoiceId}`}>{i.number}</Link></td>
                    <td data-label="Customer">{i.customer}</td><td data-label="How" className="small">{i.how}</td>
                    <td data-label="Before GCT" className="num">{money(i.netCents)}</td><td data-label="Total" className="num">{money(i.totalCents)}</td>
                    <td data-label="Still owed" className="num">{i.balanceCents > 0 ? money(i.balanceCents) : <span className="muted">paid</span>}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : <p className="muted">No invoices dated this day.</p>}
          {eod.sales.credits.length > 0 && (
            <p className="small">Credit notes: {eod.sales.credits.map((c) => (
              <span key={c.invoiceId}><Link to={`/invoices/${c.invoiceId}`}>{c.number}</Link> {c.customer} −{money(c.totalCents)}{c.against ? ` on ${c.against}` : ''}; </span>))}</p>
          )}
          {wait.items.length > 0 && (
            <>
              <h3 style={{ marginBottom: 4 }}>Not invoiced yet</h3>
              <table>
                <tbody>{wait.items.map((d) => (
                  <tr key={d.orderNumber}><td>{d.orderNumber}</td><td><Link to={`/customers/${d.customerId}`}>{d.customer}</Link> <span className="muted small">({d.cycle.toLowerCase()})</span></td>
                    <td className="small">{d.lines.map((l) => `${qty(l.bottlesPerCase, l.cases, l.bottles)} ${short(l.name)}`).join(', ')}</td></tr>
                ))}</tbody>
              </table>
            </>
          )}
        </section>

        <section className="panel">
          <h2 className="side-h">2. Money collected</h2>
          {m.payments.length === 0 ? <p className="muted" style={{ margin: 0 }}>No payments dated this day.</p> : (
            <>
              <div className="report-grid">
                <div>
                  <div className="muted small">By method</div>
                  {m.byMethod.map((g) => <div className="total-line" key={g.label}><span>{g.label} ({g.count})</span><span>{money(g.cents)}</span></div>)}
                  <div className="total-line grand"><span>Received and confirmed</span><span>{money(m.confirmedCents)}</span></div>
                  {m.provisionalCents !== 0 && <div className="total-line"><span>On rounds, not settled yet</span><span>{money(m.provisionalCents)}</span></div>}
                </div>
                <div>
                  <div className="muted small">Taken by</div>
                  {m.byWho.map((g) => <div className="total-line" key={g.label}><span>{g.label} ({g.count})</span><span>{money(g.cents)}</span></div>)}
                </div>
              </div>
              <div className="table-scroll" style={{ marginTop: 12 }}>
                <table className="phone-cards">
                  <thead><tr><th>Time</th><th>Customer</th><th>Method</th><th>Receipt · invoice</th><th>Taken by</th><th className="num">Amount</th></tr></thead>
                  <tbody>{m.payments.map((p) => (
                    <tr key={p.id}>
                      <td data-label="Time" className="small">{p.at}</td><td data-label="Customer">{p.customer}</td>
                      <td data-label="Method">{p.method}{p.reversal && <span className="muted small"> (reversed)</span>}</td>
                      <td data-label="Receipt" className="small">{[p.receipt, p.invoice].filter(Boolean).join(' · ') || 'on account'}</td>
                      <td data-label="Taken by" className="small">{p.takenBy}{!p.confirmed && <div className="muted">not settled</div>}</td>
                      <td data-label="Amount" className="num">{money(p.amountCents)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </>
          )}
        </section>

        <section className="panel">
          <h2 className="side-h">3. Rounds and bottles</h2>
          {eod.rounds.rounds.length === 0 ? <p className="muted" style={{ margin: 0 }}>No rounds this day.</p> : (
            <div className="table-scroll">
              <table className="phone-cards">
                <thead><tr><th>Round</th><th>Driver</th><th className="num">Stops</th><th className="num">Recorded</th><th className="num">Handed in</th><th className="num">Bottles out / back</th></tr></thead>
                <tbody>{eod.rounds.rounds.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Round"><Link to={`/delivery/${r.id}`}>{r.zone}</Link>
                      <div className="muted small">{r.status === 'Completed' ? 'settled' : !r.started ? 'not started' : r.pending > 0 ? 'on the road' : 'back, to settle'}</div></td>
                    <td data-label="Driver" className="small">{r.driver ?? '—'}</td>
                    <td data-label="Stops" className="num">{r.delivered} of {r.stops} delivered
                      {(r.missed > 0 || r.pending > 0) && <div className="muted small">{[r.missed ? `${r.missed} not delivered` : '', r.pending ? `${r.pending} not done` : ''].filter(Boolean).join(', ')}</div>}</td>
                    <td data-label="Recorded" className="num">{money(r.recordedCents)}</td>
                    <td data-label="Handed in" className="num">{r.handedInCents === null ? <span className="muted">not settled</span> : money(r.handedInCents)}
                      {r.cashVarianceCents ? <div className={`small ${r.cashVarianceCents < 0 ? 'bad-text' : 'muted'}`}>{r.cashVarianceCents < 0 ? 'short ' : 'over '}{money(Math.abs(r.cashVarianceCents))}</div> : null}</td>
                    <td data-label="Bottles" className="num">{r.fullOut} / {r.emptiesCounted ?? r.emptiesRecorded}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel">
          <h2 className="side-h">4. Orders</h2>
          {([['Taken today', eod.orders.taken, true], [`Booked for ${day(eod.tomorrow)}`, eod.orders.booked, false]] as const).map(([title, rows, withFor]) => (
            <div key={title} style={{ marginBottom: 12 }}>
              <h3 style={{ margin: '4px 0' }}>{title} ({rows.length})</h3>
              {rows.length === 0 ? <p className="muted" style={{ margin: 0 }}>None.</p> : (
                <div className="table-scroll">
                  <table className="phone-cards">
                    <thead><tr><th>Order</th><th>Customer</th><th>{withFor ? 'For' : 'Zone'}</th><th>Items</th><th>From</th></tr></thead>
                    <tbody>{rows.map((o) => (
                      <tr key={o.orderId}>
                        <td data-label="Order"><Link to={`/orders?find=${o.number}`}>{o.number}</Link></td>
                        <td data-label="Customer">{o.customer}</td>
                        <td data-label={withFor ? 'For' : 'Zone'} className="small">{withFor ? `${o.mode === 'Pickup' ? 'collect ' : ''}${o.forDay ? day(o.forDay) : '—'}` : (o.zone ?? (o.mode === 'Pickup' ? 'collect' : '—'))}</td>
                        <td data-label="Items" className="small">{o.items}</td>
                        <td data-label="From" className="small">{o.source}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </section>
      </>
    );
  };

  const marginTab = () => {
    if (!margin) return <p className="muted">Loading…</p>;
    const sold = margin.filter((m) => m.salesCents > 0);
    const costed = sold.filter((m) => m.materialCents !== null);
    const sumSales = costed.reduce((s, m) => s + m.salesCents, 0);
    const sumMat = costed.reduce((s, m) => s + (m.materialCents ?? 0), 0);
    return (
      <>
        <div className="notice warn">
          A first look. Labour, delivery and overheads are not in this yet, so real margin is lower.
          Materials are priced at the average paid for each one across every delivery received.
        </div>
        {costed.length > 0 && (
          <div className="stat-row">
            <div className="stat"><div className="stat-label">Sales (costed products)</div><div className="stat-value">{money(sumSales)}</div></div>
            <div className="stat"><div className="stat-label">Materials</div><div className="stat-value">−{money(sumMat)}</div></div>
            <div className="stat"><div className="stat-label">Margin before labour</div><div className="stat-value">{money(sumSales - sumMat)}</div>
              <div className="stat-note">{pct(sumSales - sumMat, sumSales)}% of sales</div></div>
          </div>
        )}
        <div className="panel" style={{ padding: 0 }}>
          <div className="table-scroll">
            <table className="report-table">
              <thead>
                <tr><th>Product</th><th className="num">Bottles sold</th><th className="num">Sales</th>
                  <th className="num">Materials per bottle</th><th className="num">Materials</th><th className="num">Margin</th></tr>
              </thead>
              <tbody>
                {margin.map((m) => (
                  <tr key={m.productId}>
                    <td>
                      <strong>{short(m.name)}</strong>
                      <div className="muted small">
                        {m.bomLines === 0 ? <>no bill of materials yet · <Link to={`/products/${m.productId}/bom`}>add one</Link></>
                          : m.costedLines < m.bomLines ? `${m.bomLines - m.costedLines} of ${m.bomLines} materials never bought, counted as $0`
                            : m.returnable ? 'the returnable bottle itself is not counted; it comes back' : `${m.bomLines} materials`}
                      </div>
                    </td>
                    <td className="num">{m.bottlesSold.toLocaleString('en-JM')}</td>
                    <td className="num">{money(m.salesCents)}</td>
                    <td className="num">{m.materialPerBottleCents === null ? '—' : money(m.materialPerBottleCents)}</td>
                    <td className="num">{m.materialCents === null || m.salesCents === 0 ? '—' : `−${money(m.materialCents)}`}</td>
                    <td className="num">
                      {m.marginCents === null || m.salesCents === 0 ? <span className="muted">—</span> : (
                        <>
                          <strong className={m.marginCents < 0 ? 'bad-text' : undefined}>{money(m.marginCents)}</strong>
                          <div className="muted small">{m.marginPercent}%</div>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        {sold.length === 0 && <p className="muted">Nothing sold in {range.label}.</p>}
      </>
    );
  };

  const roundsTab = () => {
    if (!rounds) return <p className="muted">Loading…</p>;
    const t = rounds.totals;
    if (t.rounds === 0) return <div className="panel"><p className="muted" style={{ margin: 0 }}>No rounds in {range.label}.</p></div>;
    return (
      <>
        <div className="stat-row">
          <div className="stat"><div className="stat-label">Rounds</div><div className="stat-value">{t.rounds}</div>
            <div className="stat-note">{t.settled} settled</div></div>
          <div className="stat"><div className="stat-label">Stops delivered</div><div className="stat-value">{t.delivered} of {t.stops}</div>
            <div className="stat-note">{t.missed ? `${t.missed} not delivered` : 'none missed'}</div></div>
          <div className="stat"><div className="stat-label">Cash recorded by drivers</div><div className="stat-value">{money(t.recordedCents)}</div>
            <div className="stat-note">{money(t.invoicedCents)} invoiced on these rounds</div></div>
          <div className="stat"><div className="stat-label">Handed in vs recorded</div>
            <div className={`stat-value${t.cashVarianceCents < 0 ? ' bad-text' : ''}`}>
              {t.cashVarianceCents === 0 ? 'Balanced' : `${t.cashVarianceCents < 0 ? '−' : '+'}${money(Math.abs(t.cashVarianceCents))}`}</div>
            <div className="stat-note">{t.roundsShort ? `${t.roundsShort} ${t.roundsShort === 1 ? 'round' : 'rounds'} short` : 'settled rounds only'}</div></div>
        </div>
        <div className="panel" style={{ padding: 0 }}>
          <div className="table-scroll">
            <table className="report-table">
              <thead>
                <tr><th>Round</th><th>Driver</th><th className="num">Delivered</th><th className="num">Invoiced</th>
                  <th className="num">Recorded</th><th className="num">Handed in</th><th className="num">Bottles out / back</th></tr>
              </thead>
              <tbody>
                {rounds.rounds.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={`/delivery/${r.id}`}>{r.zone} · {day(r.date)}</Link>
                      <div className="muted small">{r.status === 'Completed' ? 'settled' : !r.started ? 'not started' : r.pending > 0 ? 'on the road' : 'back, to settle'}</div>
                    </td>
                    <td className="small">{r.driver ?? '—'}</td>
                    <td className="num">{r.delivered} of {r.stops}{r.missed ? <div className="muted small">{r.missed} not delivered</div> : null}</td>
                    <td className="num">{money(r.invoicedCents)}</td>
                    <td className="num">{money(r.recordedCents)}</td>
                    <td className="num">
                      {r.handedInCents === null ? <span className="muted">—</span> : money(r.handedInCents)}
                      {r.cashVarianceCents !== null && r.cashVarianceCents !== 0 && (
                        <div className={`small ${r.cashVarianceCents < 0 ? 'bad-text' : 'muted'}`}>
                          {r.cashVarianceCents < 0 ? 'short ' : 'over '}{money(Math.abs(r.cashVarianceCents))}
                        </div>
                      )}
                    </td>
                    <td className="num">
                      {r.fullOut} / {r.emptiesCounted ?? r.emptiesRecorded}
                      {r.bottleVariance ? <div className={`small ${r.bottleVariance < 0 ? 'bad-text' : 'muted'}`}>{r.bottleVariance > 0 ? '+' : ''}{r.bottleVariance} on count</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <p className="muted small">
          "Recorded" is what drivers entered at each stop (cash, cheque and card). "Handed in" is what was counted at settlement.
          A difference is a check on the round only; it never changes what a customer owes.
        </p>
      </>
    );
  };

  /*
   * Money owed as an aged schedule (Everton, 27 Oct 2026: the dashboard's
   * figures open their schedule). Pick an age to see its invoices by
   * customer, or All owed for every customer across the ages.
   */
  const owedTab = () => {
    if (!owed) return <p className="muted">Loading…</p>;
    const t = owed.totals;
    const pickAge = (a: Age | 'all') => setParams({ tab: 'owed', age: a }, { replace: true });
    const tiles = (
      <div className="age-tiles" role="group" aria-label="How late">
        {AGES.map(([k, label]) => (
          <button key={k} type="button" aria-pressed={age === k} onClick={() => pickAge(k)}
                  className={`age-tile${age === k ? ' on' : ''}${k === 'd90' && t.d90Cents > 0 ? ' over' : ''}`}>
            <b>{label}</b><span>{money(ageCents(t, k))}</span>
          </button>
        ))}
        <div className="age-tile" style={{ cursor: 'default' }}>
          <b>Net, after credits</b><span>{money(t.netCents)}</span>
        </div>
      </div>
    );
    if (age === 'all') {
      return (
        <>
          {tiles}
          <div className="panel" style={{ padding: 0 }}>
            <div className="table-scroll">
              <table className="report-table">
                <thead><tr><th>Customer</th><th className="num">Not yet due</th><th className="num">1–30</th><th className="num">31–60</th>
                  <th className="num">Over 60</th><th className="num">Credit</th><th className="num">Net owed</th></tr></thead>
                <tbody>
                  {owed.customers.map((c) => (
                    <tr key={c.customerId}>
                      <td><Link to={`/customers/${c.customerId}?tab=transactions`}>{c.name}</Link>
                        {!c.active && <span className="muted small"> · inactive</span>}
                        <div className="muted small">{c.invoices} open invoice{c.invoices === 1 ? '' : 's'}{c.oldestDaysLate > 0 ? `, oldest ${c.oldestDaysLate} days late` : ''}</div></td>
                      <td className="num">{c.currentCents ? money(c.currentCents) : '—'}</td>
                      <td className="num">{c.d30Cents ? money(c.d30Cents) : '—'}</td>
                      <td className="num">{c.d60Cents ? money(c.d60Cents) : '—'}</td>
                      <td className={`num${c.d90Cents ? ' bad-text' : ''}`}>{c.d90Cents ? money(c.d90Cents) : '—'}</td>
                      <td className="num">{c.creditCents ? money(c.creditCents) : '—'}</td>
                      <td className="num"><strong>{c.netCents < 0 ? `${money(-c.netCents)} in credit` : money(c.netCents)}</strong></td>
                    </tr>
                  ))}
                  <tr className="group-row">
                    <td><strong>{owed.customers.length} customers</strong></td>
                    <td className="num"><strong>{money(t.currentCents)}</strong></td><td className="num"><strong>{money(t.d30Cents)}</strong></td>
                    <td className="num"><strong>{money(t.d60Cents)}</strong></td><td className="num"><strong>{money(t.d90Cents)}</strong></td>
                    <td className="num"><strong>{money(t.creditCents)}</strong></td><td className="num"><strong>{money(t.netCents)}</strong></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <p className="muted small">Each invoice is aged against its own due date. Credit is money on account and credit notes not yet put against an invoice; net owed matches each customer's account balance.</p>
        </>
      );
    }
    const list = owed.invoices.filter((i) => i.bucket === age);
    const groups: Array<{ customerId: string; customer: string; rows: typeof list }> = [];
    for (const i of list) {
      const g = groups.find((x) => x.customerId === i.customerId);
      if (g) g.rows.push(i); else groups.push({ customerId: i.customerId, customer: i.customer, rows: [i] });
    }
    const sumOf = (rows: typeof list) => rows.reduce((a, i) => a + i.balanceCents, 0);
    groups.sort((a, b) => sumOf(b.rows) - sumOf(a.rows));
    const label = AGES.find(([k]) => k === age)![1];
    return (
      <>
        {tiles}
        {list.length === 0 ? <div className="panel"><p className="muted" style={{ margin: 0 }}>Nothing {age === 'current' ? 'not yet due' : label.toLowerCase() + ' late'}.</p></div> : (
          <div className="panel" style={{ padding: 0 }}>
            <div className="panel-pad">
              <h2 className="side-h" style={{ margin: 0 }}>{label}{age === 'current' ? '' : ' late'}: {money(sumOf(list))}</h2>
              <div className="muted small">{list.length} invoice{list.length === 1 ? '' : 's'}, {groups.length} customer{groups.length === 1 ? '' : 's'}, biggest first. As of {day(owed.asOf)}.</div>
            </div>
            <div className="table-scroll">
              <table className="report-table">
                <thead><tr><th>Invoice</th><th>Date</th><th>Due</th><th className="num">Days late</th><th className="num">Total</th><th className="num">Paid</th><th className="num">Owed</th></tr></thead>
                <tbody>
                  {groups.map((g) => (
                    <Fragment key={g.customerId}>
                      <tr className="group-row">
                        <td colSpan={6}><Link to={`/customers/${g.customerId}?tab=transactions`}><strong>{g.customer}</strong></Link>
                          <span className="muted small"> · {g.rows.length} invoice{g.rows.length === 1 ? '' : 's'}</span></td>
                        <td className="num"><strong>{money(sumOf(g.rows))}</strong></td>
                      </tr>
                      {g.rows.map((i) => (
                        <tr key={i.invoiceId}>
                          <td><Link to={`/invoices/${i.invoiceId}`}>{i.number}</Link>{i.openingBalance && <span className="muted small"> · from QuickBooks</span>}</td>
                          <td className="small">{day(i.invoiceDate)} {i.invoiceDate.slice(0, 4)}</td>
                          <td className="small">{i.dueDate ? `${day(i.dueDate)} ${i.dueDate.slice(0, 4)}` : '—'}</td>
                          <td className="num">{i.daysLate > 0 ? i.daysLate : '—'}</td>
                          <td className="num">{money(i.totalCents)}</td>
                          <td className="num">{i.paidCents ? money(i.paidCents) : '—'}</td>
                          <td className="num">{money(i.balanceCents)}</td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </>
    );
  };

  const bottlesTab = () => (
    <>
      {sales && (
        <div className="stat-row">
          <div className="stat"><div className="stat-label">Out full</div><div className="stat-value">{sales.bottles.out}</div><div className="stat-note">{range.label}</div></div>
          <div className="stat"><div className="stat-label">Back empty</div><div className="stat-value">{sales.bottles.back}</div><div className="stat-note">{pct(sales.bottles.back, sales.bottles.out)}% of what went out</div></div>
          <div className="stat"><div className="stat-label">Lost or damaged</div><div className="stat-value">{sales.bottles.lost}</div><div className="stat-note"> </div></div>
        </div>
      )}
      <div className="panel">
        <h2 className="side-h">Where the bottles are now</h2>
        {(pool ?? []).map((p) => (
          <div key={p.label} className="row" style={{ gap: 28, marginBottom: 8 }}>
            <div><div className="muted small">Clean and ready</div><strong>{p.clean_ready}</strong></div>
            <div><div className="muted small">With customers</div><strong>{p.filled_with_customer}</strong></div>
            <div><div className="muted small">Back, to wash</div><strong>{p.returned_dirty}</strong></div>
            <div><div className="muted small">Lost or damaged</div><strong>{p.lost_damaged}</strong></div>
          </div>
        ))}
        <Link to="/bottle-pool">Open the bottle pool</Link>
      </div>
    </>
  );

  const discountsTab = () => {
    if (!disc) return <p className="muted">Loading…</p>;
    return (
      <>
        <div className="stat-row">
          <div className="stat"><div className="stat-label">Total discounts</div><div className="stat-value">{money(disc.totals.totalDiscountCents)}</div></div>
          <div className="stat"><div className="stat-label">Discounted invoices</div><div className="stat-value">{disc.totals.discountedDocumentCount}</div></div>
          <div className="stat"><div className="stat-label">Average discount</div><div className="stat-value">{disc.totals.averageDiscountPercent}%</div></div>
        </div>
        <div className="panel" style={{ padding: 0 }}>
          <table className="report-table">
            <thead><tr><th>Customer</th><th className="num">Total discounted</th><th className="num">Invoices</th><th className="num">Average %</th></tr></thead>
            <tbody>
              {disc.byClient.map((r) => (
                <tr key={r.customerId}>
                  <td>{r.customerName}</td><td className="num">{money(r.totalDiscountCents)}</td>
                  <td className="num">{r.discountedDocumentCount}</td><td className="num">{r.averageDiscountPercent}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          {disc.byClient.length === 0 && <p className="muted" style={{ padding: 16, margin: 0 }}>No approved discounts in {range.label}.</p>}
        </div>
        <p className="muted small">Approved discounts only. One still waiting for a decision has not taken anything off.</p>
      </>
    );
  };

  const loadingsTab = () => {
    if (!loadings) return <p className="muted">Loading…</p>;
    if (loadings.length === 0) return <div className="panel"><p className="muted" style={{ margin: 0 }}>No truck loadings recorded in {range.label}.</p></div>;
    // By day and loader: how many loadings each person did, and what they loaded.
    const byDayLoader = new Map<string, { day: string; who: string; loads: number; units: Map<string, number> }>();
    for (const l of loadings) {
      for (const who of l.loaders.length ? l.loaders : ['(nobody named)']) {
        const key = `${l.day}|${who}`;
        const row = byDayLoader.get(key) ?? { day: l.day, who, loads: 0, units: new Map<string, number>() };
        row.loads += 1;
        for (const x of l.lines) row.units.set(short(x.product), (row.units.get(short(x.product)) ?? 0) + x.loaded / (x.bottlesPerCase > 0 ? x.bottlesPerCase : 1));
        byDayLoader.set(key, row);
      }
      for (const a of l.additions ?? []) {
        for (const who of a.loaderNames.length ? a.loaderNames : ['(nobody named)']) {
          const key = `${l.day}|${who}`;
          const row = byDayLoader.get(key) ?? { day: l.day, who, loads: 0, units: new Map<string, number>() };
          row.loads += 1;
          for (const x of a.lines) row.units.set(short(x.name), (row.units.get(short(x.name)) ?? 0) + x.bottles / (x.bottlesPerCase > 0 ? x.bottlesPerCase : 1));
          byDayLoader.set(key, row);
        }
      }
    }
    return (
      <>
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>By day and loader</h2>
          <table>
            <thead><tr><th>Day</th><th>Loader</th><th className="num">Loadings</th><th>Loaded</th></tr></thead>
            <tbody>
              {[...byDayLoader.values()].sort((a, b) => b.day.localeCompare(a.day) || a.who.localeCompare(b.who)).map((r) => (
                <tr key={`${r.day}|${r.who}`}>
                  <td>{day(r.day)}</td><td>{r.who}</td><td className="num">{r.loads}</td>
                  <td className="small">{[...r.units].map(([p, n]) => `${Math.round(n * 100) / 100} ${p}`).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Every loading</h2>
          <table>
            <thead><tr><th>Round</th><th>Loaded by</th><th>Product</th><th className="num">Loaded</th><th className="num">Delivered</th><th className="num">Back</th><th className="num">Difference</th></tr></thead>
            <tbody>
              {loadings.flatMap((l) => l.lines.map((x, i) => (
                <tr key={`${l.sheetId}-${i}`}>
                  <td>{i === 0 && <><Link to={`/delivery/${l.sheetId}`}>{day(l.day)} · {l.zone}</Link><div className="muted small">{l.driverName ?? ''}</div></>}</td>
                  <td className="small">{i === 0 && <>{l.loaders.join(', ')}<div className="muted">logged by {l.loadedByName ?? '—'}; {l.driverConfirmedName ? `confirmed by ${l.driverConfirmedName}` : 'driver not confirmed'}</div></>}</td>
                  <td>{short(x.product)}</td>
                  <td className="num">{qtyOf(x.bottlesPerCase, x.loaded + (x.added ?? 0))}{(x.added ?? 0) > 0 && <div className="muted small">incl. {qtyOf(x.bottlesPerCase, x.added!)} added later</div>}</td>
                  <td className="num">{qtyOf(x.bottlesPerCase, x.delivered)}</td>
                  <td className="num">{x.returned === null ? <span className="muted">not yet</span> : qtyOf(x.bottlesPerCase, x.returned)}</td>
                  <td className="num">{x.difference === null || x.difference === 0 ? <span className="muted">—</span>
                    : <span className="chip bad">{qtyOf(x.bottlesPerCase, Math.abs(x.difference))} {x.difference > 0 ? 'missing' : 'over'}</span>}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
      </>
    );
  };

  const materialsTab = () => {
    if (!materials) return <p className="muted">Loading…</p>;
    const held = materials.filter((m) => m.quantityOnHand > 0);
    return (
      <div className="panel" style={{ padding: 0 }}>
        <p className="muted small" style={{ padding: '14px 16px 0', margin: 0 }}>
          A blended figure across stock on hand. Production is charged the real cost of the batches it actually uses (oldest first), which will differ.
        </p>
        <table className="report-table">
          <thead><tr><th>Material</th><th className="num">On hand</th><th className="num">Blended average</th><th>Per supplier</th></tr></thead>
          <tbody>
            {held.map((m) => (
              <tr key={m.rawMaterialId}>
                <td>{m.name}</td>
                <td className="num">{m.quantityOnHand} {m.unitOfMeasure}</td>
                <td className="num">{money(m.blendedAverageUnitCostCents)}</td>
                <td className="small muted">
                  {m.perSupplier.map((s, n) => <div key={n}>{s.supplierName}: {money(s.averageUnitCostCents)} ({s.quantity})</div>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {held.length === 0 && <p className="muted" style={{ padding: 16, margin: 0 }}>No material in stock yet.</p>}
      </div>
    );
  };

  const body = tab === 'sales' ? salesTab() : tab === 'eod' ? eodTab() : tab === 'transactions' ? transactionsTab() : tab === 'margin' ? marginTab() : tab === 'rounds' ? roundsTab() : tab === 'loadings' ? loadingsTab() : tab === 'owed' ? owedTab()
    : tab === 'bottles' ? bottlesTab() : tab === 'discounts' ? discountsTab() : materialsTab();

  return (
    <>
      <div className="panel-head record-head">
        <div>
          <h1>Reports</h1>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            {tab === 'eod' ? <>One day: sales, money collected, rounds and orders.</>
              : !periodMatters ? 'As of today.'
              : tab === 'bottles' ? <>From rounds dated {range.label === 'all time' ? 'at any time' : `in ${range.label}`}, and where the bottles are today.</>
                : tab === 'rounds' ? <>Rounds dated {range.label === 'all time' ? 'at any time' : `in ${range.label}`}.</>
                : <>From invoices dated {range.label === 'all time' ? 'at any time' : `in ${range.label}`}, before GCT unless it says otherwise.</>}
          </p>
        </div>
        <div className="record-actions">
          {tab === 'eod' && (
            <button className="secondary" onClick={() => { setError(null); openPdf(`/api/reports/end-of-day.pdf?day=${eodDay}`).catch((e) => setError(e.message)); }}>
              Open PDF</button>
          )}
          <button className="secondary" onClick={exportTab}>Export to Excel</button>
          {tab !== 'eod' && <button className="secondary" onClick={() => window.print()}>Print</button>}
        </div>
      </div>
      {periodMatters && (
        <div className="pills" role="group" aria-label="Period">
          {PERIODS.map(([k, label]) => (
            <button key={k} type="button" className={`pill${period === k ? ' active' : ''}`} aria-pressed={period === k}
                    onClick={() => setPeriod(k)}>{label}</button>
          ))}
        </div>
      )}
      {tab === 'eod' && (
        <div className="row" style={{ marginBottom: 10, alignItems: 'center', gap: 8 }}>
          <div className="pills" role="group" aria-label="Day" style={{ margin: 0 }}>
            {([['Today', todayInJamaica()], ['Yesterday', new Date(Date.parse(`${todayInJamaica()}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10)]] as const).map(([label, d]) => (
              <button key={label} type="button" className={`pill${eodDay === d ? ' active' : ''}`} aria-pressed={eodDay === d} onClick={() => setEodDay(d)}>{label}</button>
            ))}
          </div>
          <label htmlFor="eod-day" className="visually-hidden">Day</label>
          <input id="eod-day" type="date" value={eodDay} max={todayInJamaica()} onChange={(e) => e.target.value && setEodDay(e.target.value)} />
          <span className="muted small">{day(eodDay)}</span>
        </div>
      )}
      {periodMatters && period === 'custom' && (
        <div className="row" style={{ marginBottom: 10 }}>
          <div className="field"><label htmlFor="rf">From</label>
            <input id="rf" type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /></div>
          <div className="field"><label htmlFor="rt">To</label>
            <input id="rt" type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></div>
        </div>
      )}

      <nav className="tabs" aria-label="Report">
        {TABS.map(([k, label]) => (
          <button key={k} type="button" className={`tab${tab === k ? ' active' : ''}`} aria-current={tab === k ? 'page' : undefined}
                  onClick={() => setParams({ tab: k }, { replace: true })}>{label}</button>
        ))}
      </nav>

      {error && <div className="notice error">{error}</div>}
      {body}
    </>
  );
}
