import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { money, day } from '../lib/format';

/**
 * The Production and Purchasing tabs on Reports (Everton, 13 Nov 2026).
 * The data comes from /api/reports/production and /api/reports/purchasing;
 * the spreadsheet rows are built here too, so the screen and the file match.
 */

export type ProductionBy = 'day' | 'week' | 'month';

export interface ProductionReport {
  by: ProductionBy;
  totals: { runs: number; bottles: number; costCents: number };
  products: Array<{
    productId: string; product: string; bottlesPerCase: number; runs: number; bottles: number;
    cases: number | null; costCents: number; costPerBottleCents: number | null; costPerCaseCents: number | null;
  }>;
  periods: Array<{ key: string; label: string; from: string; to: string; runs: number; bottles: Record<string, number>; totalBottles: number; costCents: number }>;
  runs: Array<{
    id: string; runNumber: string; batchCode: string | null; date: string; productId: string; product: string; bottlesPerCase: number;
    cases: number; looseBottles: number; bottles: number; costCents: number;
    operator: string | null; enteredBy: string | null; enteredAt: string | null; editedBy: string | null;
    jugsScrapped: number; notes: string | null;
  }>;
}

export interface PurchasingReport {
  asOf: string;
  totals: { pos: number; orderedCents: number; receivedCents: number; toComeCents: number; overdue: number; suppliers: number };
  suppliers: Array<{
    supplierId: string; supplier: string; pos: number; orderedCents: number; receivedCents: number; toComeCents: number; overdue: number;
    orders: Array<{
      poId: string; poNumber: string; orderDate: string; expectedDate: string | null; lastReceived: string | null;
      status: string; overdue: boolean; raisedInPeriod: boolean;
      orderedCents: number; receivedCents: number; toComeCents: number;
      lines: Array<{
        lineId: string; material: string; unit: string; ordered: number; received: number; toCome: number; notComing: number;
        unitCostCents: number; orderedCents: number; receivedCents: number; toComeCents: number;
      }>;
    }>;
  }>;
}

const short = (n: string) => n.replace(/^Alka Vida\s+/i, '');
const dollars = (c: number | null) => (c === null ? '' : (c / 100).toFixed(2));
const qty = (n: number) => (Math.round(n * 1000) / 1000).toLocaleString('en-JM');
/** "12 cs" for a cased product (with loose bottles if any), "40 btl" otherwise. */
const made = (bottles: number, bpc: number) => {
  if (!(bpc > 0)) return `${bottles} btl`;
  const cs = Math.floor(bottles / bpc); const loose = bottles - cs * bpc;
  return `${cs} cs${loose ? ` + ${loose} btl` : ''}`;
};
const STATUS_WORDS: Record<string, string> = {
  Draft: 'Draft, not sent', Sent: 'Ordered', 'Partially Received': 'Part received', Received: 'Received', 'Partially Received - Closed': 'Closed short',
};

/* ------------------------------------------------------------- Production */

export function ProductionTab({ data, by, setBy, label }: {
  data: ProductionReport | null; by: ProductionBy; setBy: (b: ProductionBy) => void; label: string;
}) {
  if (!data) return <p className="muted">Loading…</p>;
  const cols = data.products;
  return (
    <>
      <div className="stat-row">
        <div className="stat"><div className="stat-label">Runs</div><div className="stat-value">{data.totals.runs}</div></div>
        <div className="stat"><div className="stat-label">Bottles made</div><div className="stat-value">{data.totals.bottles.toLocaleString()}</div></div>
        <div className="stat"><div className="stat-label">Material cost</div><div className="stat-value">{money(data.totals.costCents)}</div></div>
      </div>
      {data.totals.runs === 0 ? (
        <div className="panel"><p className="muted" style={{ margin: 0 }}>No production entered in {label}.</p></div>
      ) : (
        <>
          <div className="panel" style={{ padding: 0 }}>
            <div className="panel-pad"><h2 className="side-h" style={{ margin: 0 }}>Made, by product</h2></div>
            <div className="table-scroll">
              <table className="report-table">
                <thead><tr><th>Product</th><th className="num">Runs</th><th className="num">Made</th><th className="num">Bottles</th>
                  <th className="num">Material cost</th><th className="num">Per bottle</th><th className="num">Per case</th></tr></thead>
                <tbody>
                  {data.products.map((p) => (
                    <tr key={p.productId}>
                      <td>{short(p.product)}</td>
                      <td className="num">{p.runs}</td>
                      <td className="num">{made(p.bottles, p.bottlesPerCase)}</td>
                      <td className="num">{p.bottles.toLocaleString()}</td>
                      <td className="num">{money(p.costCents)}</td>
                      <td className="num">{p.costPerBottleCents === null ? '—' : money(p.costPerBottleCents)}</td>
                      <td className="num">{p.costPerCaseCents === null ? '—' : money(p.costPerCaseCents)}</td>
                    </tr>
                  ))}
                  <tr className="total-row"><td><strong>Total</strong></td><td className="num"><strong>{data.totals.runs}</strong></td><td />
                    <td className="num"><strong>{data.totals.bottles.toLocaleString()}</strong></td><td className="num"><strong>{money(data.totals.costCents)}</strong></td><td /><td /></tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel" style={{ padding: 0 }}>
            <div className="panel-pad row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <h2 className="side-h" style={{ margin: 0 }}>By {by}</h2>
              <div className="pills" role="group" aria-label="Break down by" style={{ margin: 0 }}>
                {(['day', 'week', 'month'] as const).map((b) => (
                  <button key={b} type="button" className={`pill${by === b ? ' active' : ''}`} aria-pressed={by === b} onClick={() => setBy(b)}>
                    {b === 'day' ? 'Day' : b === 'week' ? 'Week' : 'Month'}
                  </button>
                ))}
              </div>
            </div>
            <div className="table-scroll">
              <table className="report-table">
                <thead><tr><th>{by === 'day' ? 'Day' : by === 'week' ? 'Week' : 'Month'}</th><th className="num">Runs</th>
                  {cols.map((c) => <th key={c.productId} className="num">{short(c.product)}</th>)}
                  <th className="num">Material cost</th></tr></thead>
                <tbody>
                  {data.periods.map((p) => (
                    <tr key={p.key}>
                      <td>{p.label}</td>
                      <td className="num">{p.runs}</td>
                      {cols.map((c) => <td key={c.productId} className="num">{p.bottles[c.productId] ? made(p.bottles[c.productId], c.bottlesPerCase) : <span className="muted">—</span>}</td>)}
                      <td className="num">{money(p.costCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel" style={{ padding: 0 }}>
            <div className="panel-pad">
              <h2 className="side-h" style={{ margin: 0 }}>Every run</h2>
              <div className="muted small">Newest first. Deleted runs are left out; an edited run shows as it stands now.</div>
            </div>
            <div className="table-scroll">
              <table className="report-table phone-cards">
                <thead><tr><th>Run</th><th>Batch</th><th>Date</th><th>Product</th><th className="num">Made</th><th className="num">Material cost</th>
                  <th>Operator</th><th>Entered by</th></tr></thead>
                <tbody>
                  {data.runs.map((r) => (
                    <tr key={r.id}>
                      <td data-label="Run">{r.runNumber || '—'}</td>
                      <td data-label="Batch">{r.batchCode ?? <span className="muted">—</span>}</td>
                      <td data-label="Date">{day(r.date)}</td>
                      <td data-label="Product">{short(r.product)}</td>
                      <td data-label="Made" className="num">{made(r.bottles, r.bottlesPerCase)}
                        {r.jugsScrapped > 0 && <div className="muted small">{r.jugsScrapped} jugs scrapped</div>}</td>
                      <td data-label="Material cost" className="num">{money(r.costCents)}</td>
                      <td data-label="Operator">{r.operator ?? '—'}</td>
                      <td data-label="Entered by">{r.enteredBy ?? '—'}
                        {r.enteredAt && <div className="muted small">{new Date(r.enteredAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'America/Jamaica' })}</div>}
                        {r.editedBy && <div className="muted small">edited by {r.editedBy}</div>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}

export function productionCsv(data: ProductionReport, label: string) {
  const cols = data.products;
  return [
    ['Production', label], [],
    ['Runs', data.totals.runs], ['Bottles made', data.totals.bottles], ['Material cost', dollars(data.totals.costCents)], [],
    ['Product', 'Runs', 'Cases', 'Bottles', 'Material cost', 'Cost per bottle', 'Cost per case'],
    ...data.products.map((p) => [p.product, p.runs, p.cases ?? '', p.bottles, dollars(p.costCents), dollars(p.costPerBottleCents), dollars(p.costPerCaseCents)]),
    [],
    [`By ${data.by}`, 'From', 'To', 'Runs', ...cols.map((c) => `${short(c.product)} (${c.bottlesPerCase > 0 ? 'cases' : 'bottles'})`), 'Material cost'],
    ...data.periods.map((p) => [p.label, p.from, p.to, p.runs,
      ...cols.map((c) => (p.bottles[c.productId] ? (c.bottlesPerCase > 0 ? Math.round((p.bottles[c.productId] / c.bottlesPerCase) * 100) / 100 : p.bottles[c.productId]) : 0)),
      dollars(p.costCents)]),
    [],
    ['Run', 'Batch number', 'Date', 'Product', 'Cases', 'Loose bottles', 'Bottles', 'Material cost', 'Operator', 'Entered by', 'Entered at', 'Last edited by', 'Jugs scrapped', 'Notes'],
    ...data.runs.map((r) => [r.runNumber, r.batchCode ?? '', r.date, r.product, r.cases, r.looseBottles, r.bottles, dollars(r.costCents), r.operator ?? '',
      r.enteredBy ?? '', r.enteredAt ? new Date(r.enteredAt).toLocaleString('en-GB', { timeZone: 'America/Jamaica' }) : '', r.editedBy ?? '', r.jugsScrapped, r.notes ?? '']),
  ];
}

/* ------------------------------------------------------------- Purchasing */

export function PurchasingTab({ data, label }: { data: PurchasingReport | null; label: string }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [onlyToCome, setOnlyToCome] = useState(false);
  if (!data) return <p className="muted">Loading…</p>;
  const t = data.totals;
  const suppliers = data.suppliers
    .map((s) => ({ ...s, orders: onlyToCome ? s.orders.filter((o) => o.toComeCents > 0 || o.lines.some((l) => l.toCome > 0)) : s.orders }))
    .filter((s) => s.orders.length > 0);
  return (
    <>
      <div className="stat-row">
        <div className="stat"><div className="stat-label">Ordered</div><div className="stat-value">{money(t.orderedCents)}</div><div className="stat-note">{t.pos} POs, {t.suppliers} suppliers</div></div>
        <div className="stat"><div className="stat-label">Received</div><div className="stat-value">{money(t.receivedCents)}</div></div>
        <div className="stat"><div className="stat-label">Still to come</div><div className="stat-value">{money(t.toComeCents)}</div>
          {t.overdue > 0 && <div className="stat-note bad-text">{t.overdue} overdue</div>}</div>
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        Purchase orders raised in {label}, plus any older ones with something still to come. Values include GCT and the levy.
        Cancelled POs are left out; a draft not emailed from the app is shown as "Draft, not sent".
      </p>
      <label className="check" style={{ marginBottom: 10 }}>
        <input type="checkbox" checked={onlyToCome} onChange={(e) => setOnlyToCome(e.target.checked)} /> Only what is still to come
      </label>
      {suppliers.length === 0 && <div className="panel"><p className="muted" style={{ margin: 0 }}>Nothing to show for {label}.</p></div>}
      {suppliers.map((s) => (
        <div className="panel" key={s.supplierId} style={{ padding: 0 }}>
          <div className="panel-pad row" style={{ justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
            <h2 className="side-h" style={{ margin: 0 }}>{s.supplier}</h2>
            <span className="small">
              {s.orders.length} {s.orders.length === 1 ? 'PO' : 'POs'} · ordered <strong>{money(s.orderedCents)}</strong> · received <strong>{money(s.receivedCents)}</strong> · to come <strong>{money(s.toComeCents)}</strong>
              {s.overdue > 0 && <span className="bad-text"> · {s.overdue} overdue</span>}
            </span>
          </div>
          <div className="table-scroll">
            <table className="report-table">
              <thead><tr><th>PO</th><th>Ordered on</th><th>Expected</th><th>Status</th>
                <th className="num">Ordered</th><th className="num">Received</th><th className="num">Still to come</th></tr></thead>
              <tbody>
                {s.orders.map((o) => {
                  const shown = !!open[o.poId];
                  return (
                    <Fragment key={o.poId}>
                      <tr>
                        <td>
                          <button type="button" className="as-link" aria-expanded={shown} onClick={() => setOpen({ ...open, [o.poId]: !shown })}>
                            {shown ? '▾' : '▸'} {o.poNumber}
                          </button>
                          <div className="small"><Link to={`/purchase-orders?po=${o.poId}`}>Open</Link></div>
                        </td>
                        <td>{day(o.orderDate)}{!o.raisedInPeriod && <div className="muted small">earlier, still open</div>}</td>
                        <td>{o.expectedDate ? day(o.expectedDate) : '—'}{o.overdue && <div><span className="chip warn">overdue</span></div>}</td>
                        <td>{STATUS_WORDS[o.status] ?? o.status}{o.lastReceived && <div className="muted small">last in {day(o.lastReceived)}</div>}</td>
                        <td className="num">{money(o.orderedCents)}</td>
                        <td className="num">{money(o.receivedCents)}</td>
                        <td className="num">{o.toComeCents > 0 ? <strong>{money(o.toComeCents)}</strong> : <span className="muted">—</span>}</td>
                      </tr>
                      {shown && o.lines.map((l) => (
                        <tr key={l.lineId} className="sub-row">
                          <td colSpan={4} className="small" style={{ paddingLeft: 28 }}>
                            {l.material} <span className="muted">· {qty(l.ordered)} {l.unit} at {money(l.unitCostCents)}</span>
                            <div className="muted">received {qty(l.received)}{l.toCome > 0 ? `, ${qty(l.toCome)} to come` : ''}{l.notComing > 0 ? `, ${qty(l.notComing)} not coming (closed)` : ''}</div>
                          </td>
                          <td className="num small">{money(l.orderedCents)}</td>
                          <td className="num small">{money(l.receivedCents)}</td>
                          <td className="num small">{l.toComeCents > 0 ? money(l.toComeCents) : '—'}</td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </>
  );
}

export function purchasingCsv(data: PurchasingReport, label: string) {
  const t = data.totals;
  return [
    ['Purchasing', label, `as of ${data.asOf}`], [],
    ['Ordered', dollars(t.orderedCents)], ['Received', dollars(t.receivedCents)], ['Still to come', dollars(t.toComeCents)],
    ['Purchase orders', t.pos], ['Overdue', t.overdue], [],
    ['Supplier', 'POs', 'Ordered', 'Received', 'Still to come', 'Overdue'],
    ...data.suppliers.map((s) => [s.supplier, s.pos, dollars(s.orderedCents), dollars(s.receivedCents), dollars(s.toComeCents), s.overdue]),
    [],
    ['Supplier', 'PO', 'Ordered on', 'Expected', 'Status', 'Overdue', 'Material', 'Unit', 'Qty ordered', 'Qty received', 'Qty to come',
      'Qty not coming', 'Cost each', 'Value ordered', 'Value received', 'Value to come'],
    ...data.suppliers.flatMap((s) => s.orders.flatMap((o) => o.lines.map((l) => [
      s.supplier, o.poNumber, o.orderDate, o.expectedDate ?? '', STATUS_WORDS[o.status] ?? o.status, o.overdue ? 'yes' : '',
      l.material, l.unit, l.ordered, l.received, l.toCome, l.notComing, dollars(l.unitCostCents),
      dollars(l.orderedCents), dollars(l.receivedCents), dollars(l.toComeCents)]))),
  ];
}
