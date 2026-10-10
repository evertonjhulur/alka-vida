import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
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
  };
  byProduct: Array<{ productId: string; name: string; bottlesPerCase: number; cases: number; bottles: number; cents: number }>;
  byZone: Array<{ zone: string; invoices: number; cents: number }>;
  topCustomers: Array<{ customerId: string; name: string; invoices: number; cents: number }>;
  bottles: { out: number; back: number; lost: number };
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
interface Owed { customer_id: string; name: string; invoiced_cents: number | string; paid_cents: number | string; balance_cents: number | string }
interface Pool { label: string; clean_ready: number; filled_with_customer: number; returned_dirty: number; lost_damaged: number; in_circulation: number }
interface DiscountTotals { totalDiscountCents: number; discountedDocumentCount: number; averageDiscountPercent: number }
interface PerClient { customerId: string; customerName: string; totalDiscountCents: number; discountedDocumentCount: number; averageDiscountPercent: number }
interface MaterialCost {
  rawMaterialId: string; name: string; unitOfMeasure: string; quantityOnHand: number;
  blendedAverageUnitCostCents: number;
  perSupplier: Array<{ supplierName: string; quantity: number; averageUnitCostCents: number }>;
}

const TABS = [
  ['sales', 'Sales'], ['transactions', 'Sales transactions'], ['margin', 'Margin'], ['rounds', 'Rounds and cash'], ['loadings', 'Truck loadings'],
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
type Period = 'month' | 'last' | 'year' | 'all' | 'custom';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const short = (n: string) => n.replace(/^Alka Vida\s+/i, '');
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

function rangeFor(p: Period, custom: { from: string; to: string }): { from: string; to: string; label: string } {
  const today = todayInJamaica();
  const [y, m] = today.split('-').map(Number);
  const pad = (n: number) => String(n).padStart(2, '0');
  const last = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
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
  const [period, setPeriod] = useState<Period>('month');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const range = rangeFor(period, custom);

  const [sales, setSales] = useState<Sales | null>(null);
  const [margin, setMargin] = useState<Margin[] | null>(null);
  const [rounds, setRounds] = useState<Rounds | null>(null);
  const [owed, setOwed] = useState<Owed[] | null>(null);
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
    if (tab === 'discounts') api.get<{ totals: DiscountTotals; byClient: PerClient[] }>(`/api/reports/discounts?${qs}`).then(setDisc).catch(fail);
  }, [tab, qs]);
  useEffect(() => {
    if (tab === 'owed' && !owed) api.get<Owed[]>('/api/reports/receivables').then(setOwed).catch((e) => setError(e.message));
    if (tab === 'bottles' && !pool) api.get<Pool[]>('/api/reports/bottle-pool').then(setPool).catch(() => setPool([]));
    if (tab === 'materials' && !materials) api.get<MaterialCost[]>('/api/reports/material-costs').then(setMaterials).catch((e) => setError(e.message));
  }, [tab]);

  const periodMatters = !['owed', 'materials'].includes(tab);
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
        ['Invoices', sales.totals.invoices], ['Credit notes', sales.totals.creditNotes],
        ['Customers buying', sales.totals.customers], [],
        ['Product', 'Cases', 'Bottles', 'Sales (before discount and GCT)'],
        ...sales.byProduct.map((p) => [p.name, p.cases, p.bottles, dollars(p.cents)]), [],
        ['Where it went', 'Invoices', 'Sales before GCT'],
        ...sales.byZone.map((z) => [z.zone, z.invoices, dollars(z.cents)]), [],
        ['Customer', 'Invoices', 'Sales before GCT'],
        ...sales.topCustomers.map((c) => [c.name, c.invoices, dollars(c.cents)]),
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
      downloadCsv('alka-vida-money-owed.csv', [
        ['Customer', 'Invoiced', 'Paid', 'Owes'],
        ...owed.map((o) => [o.name, dollars(Number(o.invoiced_cents)), dollars(Number(o.paid_cents)), dollars(Number(o.balance_cents))]),
      ]);
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
    if (t.invoices === 0) return <div className="panel"><p className="muted" style={{ margin: 0 }}>No sales in {range.label}.</p></div>;
    return (
      <>
        <div className="stat-row">
          <div className="stat"><div className="stat-label">Net sales</div><div className="stat-value">{money(t.netAfterCreditsCents)}</div>
            <div className="stat-note">{money(t.grossAfterCreditsCents)} with GCT{t.creditNotes > 0 ? ', after credit notes' : ''}</div></div>
          <div className="stat"><div className="stat-label">Deliveries and collections</div><div className="stat-value">{t.invoices}</div>
            <div className="stat-note">average {money(Math.round(t.netCents / Math.max(t.invoices, 1)))}</div></div>
          <div className="stat"><div className="stat-label">Customers buying</div><div className="stat-value">{t.customers}</div>
            <div className="stat-note">{t.newCustomers !== null ? `${t.newCustomers} new in this period` : ' '}</div></div>
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
          <p className="muted small" style={{ marginBottom: 0 }}>
            Credit notes are taken off. The charts below are what was invoiced, before credit notes.{' '}
            <button type="button" className="as-link small" onClick={() => setParams({ tab: 'transactions' }, { replace: true })}>
              See every invoice and credit note
            </button>
          </p>
        </section>
        <div className="report-grid">
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
        </div>
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

  const owedTab = () => {
    if (!owed) return <p className="muted">Loading…</p>;
    const owing = owed.filter((o) => Number(o.balance_cents) > 0);
    const credit = owed.filter((o) => Number(o.balance_cents) < 0);
    const total = owing.reduce((s, o) => s + Number(o.balance_cents), 0);
    return (
      <>
        <div className="stat-row">
          <div className="stat"><div className="stat-label">Owed to you</div><div className="stat-value">{money(total)}</div>
            <div className="stat-note">{owing.length} {owing.length === 1 ? 'customer' : 'customers'}, as of today</div></div>
          {credit.length > 0 && (
            <div className="stat"><div className="stat-label">In credit</div>
              <div className="stat-value">{money(-credit.reduce((s, o) => s + Number(o.balance_cents), 0))}</div>
              <div className="stat-note">{credit.length} paid ahead</div></div>
          )}
        </div>
        <div className="panel" style={{ padding: 0 }}>
          <table className="report-table">
            <thead><tr><th>Customer</th><th className="num">Invoiced</th><th className="num">Paid</th><th className="num">Owes</th></tr></thead>
            <tbody>
              {owed.map((o) => (
                <tr key={o.customer_id}>
                  <td><Link to={`/customers/${o.customer_id}?tab=invoices`}>{o.name}</Link></td>
                  <td className="num">{money(Number(o.invoiced_cents))}</td>
                  <td className="num">{money(Number(o.paid_cents))}</td>
                  <td className="num"><strong>{Number(o.balance_cents) < 0 ? `${money(-Number(o.balance_cents))} in credit` : money(Number(o.balance_cents))}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
          {owed.length === 0 && <p className="muted" style={{ padding: 16, margin: 0 }}>Nobody owes anything.</p>}
        </div>
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

  const body = tab === 'sales' ? salesTab() : tab === 'transactions' ? transactionsTab() : tab === 'margin' ? marginTab() : tab === 'rounds' ? roundsTab() : tab === 'loadings' ? loadingsTab() : tab === 'owed' ? owedTab()
    : tab === 'bottles' ? bottlesTab() : tab === 'discounts' ? discountsTab() : materialsTab();

  return (
    <>
      <div className="panel-head record-head">
        <div>
          <h1>Reports</h1>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            {!periodMatters ? 'As of today.'
              : tab === 'bottles' ? <>From rounds dated {range.label === 'all time' ? 'at any time' : `in ${range.label}`}, and where the bottles are today.</>
                : tab === 'rounds' ? <>Rounds dated {range.label === 'all time' ? 'at any time' : `in ${range.label}`}.</>
                : <>From invoices dated {range.label === 'all time' ? 'at any time' : `in ${range.label}`}, before GCT unless it says otherwise.</>}
          </p>
        </div>
        <div className="record-actions">
          {periodMatters && (
            <>
              <label htmlFor="period" className="visually-hidden">Period</label>
              <select id="period" value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
                <option value="month">{rangeFor('month', custom).label}</option>
                <option value="last">{rangeFor('last', custom).label}</option>
                <option value="year">{rangeFor('year', custom).label}</option>
                <option value="all">All time</option>
                <option value="custom">Choose dates…</option>
              </select>
            </>
          )}
          <button className="secondary" onClick={exportTab}>Export for accountant</button>
          <button className="secondary" onClick={() => window.print()}>Print</button>
        </div>
      </div>
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
