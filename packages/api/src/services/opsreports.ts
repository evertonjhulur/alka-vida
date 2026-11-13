/**
 * Production and Purchasing reports (Everton, 13 Nov 2026), two tabs on
 * Reports over the same period picker.
 *
 * Production: what was made in the period, by product and by day, week or
 * month, and every run with its number and who entered it. Deleted runs are
 * left out; an edited run counts as it stands now. Cost is the materials the
 * run drew (FIFO), the same figure the Production page shows.
 *
 * Purchasing: what was ordered, what came in and what is still to come,
 * grouped by supplier, then purchase order, then line. A PO is in the report
 * when it was raised in the period, OR it still has something to come
 * whenever it was raised - so nothing outstanding drops off. Cancelled POs
 * are left out. A Draft stays in (marked "not sent"): a PO only becomes Sent
 * when it is emailed from the app, and one printed or phoned through is still
 * an order. Values include GCT and the environmental levy, split by quantity.
 */
import type { Queryable } from '../db/index.ts';
import type { Cents } from '@alka/shared';
import { num, businessToday } from './core.ts';

export type ProductionBy = 'day' | 'week' | 'month';

export interface ProductionRun {
  id: string; runNumber: string; batchCode: string | null; date: string; productId: string; product: string; bottlesPerCase: number;
  cases: number; looseBottles: number; bottles: number; costCents: Cents;
  operator: string | null; enteredBy: string | null; enteredAt: string | null; editedBy: string | null;
  jugsScrapped: number; notes: string | null;
}

export interface ProductionReport {
  from: string | null; to: string | null; by: ProductionBy;
  totals: { runs: number; bottles: number; costCents: Cents };
  products: Array<{
    productId: string; product: string; bottlesPerCase: number; runs: number; bottles: number;
    cases: number | null; costCents: Cents; costPerBottleCents: Cents | null; costPerCaseCents: Cents | null;
  }>;
  /** One row per day, week (Monday to Sunday) or month that had production. */
  periods: Array<{
    key: string; label: string; from: string; to: string; runs: number;
    bottles: Record<string, number>; totalBottles: number; costCents: Cents;
  }>;
  runs: ProductionRun[];
}

export const runNumber = (n: number | string | null | undefined) =>
  n === null || n === undefined ? '' : `PR-${String(n).padStart(4, '0')}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shift = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const nice = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

/** The day, week or month a date falls in. Weeks run Monday to Sunday, like the weekly invoices. */
export function bucketOf(iso: string, by: ProductionBy): { key: string; label: string; from: string; to: string } {
  if (by === 'day') return { key: iso, label: nice(iso), from: iso, to: iso };
  if (by === 'week') {
    const back = (new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7;
    const mon = shift(iso, -back); const sun = shift(mon, 6);
    return { key: mon, label: `Week of ${nice(mon)}`, from: mon, to: sun };
  }
  const [y, m] = iso.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return { key: `${y}-${mm}`, label: `${MONTHS[m - 1]} ${y}`, from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}` };
}

export async function productionReport(
  db: Queryable, from?: string | null, to?: string | null, by: ProductionBy = 'day',
): Promise<ProductionReport> {
  const rows = await db.query<{
    id: string; run_number: number | null; batch_code: string | null; batch_date: string; product_id: string; product: string;
    bottles_per_case: number; cases: number; loose_bottles: number; total_bottles: number;
    cost: string; operator: string | null; entered_by: string | null; entered_at: string | null;
    edited_by: string | null; jugs_scrapped: number; notes: string | null;
  }>(
    `SELECT pb.id, pb.run_number, pb.batch_code, pb.batch_date::text AS batch_date, p.id AS product_id, p.name AS product,
            p.bottles_per_case, li.cases, li.loose_bottles, li.total_bottles, pb.jugs_scrapped, pb.notes, pb.operator,
            (SELECT COALESCE(SUM(total_cost_cents), 0) FROM inventory_transactions it
              WHERE it.reference = 'Production ' || pb.id::text AND it.item_type = 'RawMaterial')::text AS cost,
            (SELECT a.user_name FROM audit_log a WHERE a.entity_type = 'ProductionBatch' AND a.entity_id = pb.id
               AND a.action = 'create' ORDER BY a.ts LIMIT 1) AS entered_by,
            COALESCE((SELECT a.ts FROM audit_log a WHERE a.entity_type = 'ProductionBatch' AND a.entity_id = pb.id
               AND a.action = 'create' ORDER BY a.ts LIMIT 1), pb.created_at)::text AS entered_at,
            (SELECT a.user_name FROM audit_log a WHERE a.entity_type = 'ProductionBatch' AND a.entity_id = pb.id
               AND a.action = 'update' ORDER BY a.ts DESC LIMIT 1) AS edited_by
     FROM production_batches pb
     JOIN production_batch_line_items li ON li.batch_id = pb.id
     JOIN products p ON p.id = li.product_id
     WHERE pb.status = 'Completed'
       AND ($1::date IS NULL OR pb.batch_date >= $1::date)
       AND ($2::date IS NULL OR pb.batch_date <= $2::date)
     ORDER BY pb.batch_date, pb.run_number NULLS LAST, pb.created_at`,
    [from || null, to || null],
  );

  const runs: ProductionRun[] = rows.map((r) => ({
    id: r.id, runNumber: runNumber(r.run_number), batchCode: r.batch_code, date: String(r.batch_date).slice(0, 10),
    productId: r.product_id, product: r.product, bottlesPerCase: num(r.bottles_per_case),
    cases: num(r.cases), looseBottles: num(r.loose_bottles), bottles: num(r.total_bottles), costCents: num(r.cost),
    operator: r.operator, enteredBy: r.entered_by, enteredAt: r.entered_at, editedBy: r.edited_by,
    jugsScrapped: num(r.jugs_scrapped), notes: r.notes,
  }));

  const byProduct = new Map<string, ProductionReport['products'][number]>();
  for (const r of runs) {
    const p = byProduct.get(r.productId) ?? {
      productId: r.productId, product: r.product, bottlesPerCase: r.bottlesPerCase, runs: 0, bottles: 0,
      cases: null, costCents: 0, costPerBottleCents: null, costPerCaseCents: null,
    };
    p.runs += 1; p.bottles += r.bottles; p.costCents += r.costCents;
    byProduct.set(r.productId, p);
  }
  const products = [...byProduct.values()].map((p) => ({
    ...p,
    cases: p.bottlesPerCase > 0 ? Math.round((p.bottles / p.bottlesPerCase) * 100) / 100 : null,
    costPerBottleCents: p.bottles > 0 ? Math.round(p.costCents / p.bottles) : null,
    costPerCaseCents: p.bottlesPerCase > 0 && p.bottles > 0 ? Math.round((p.costCents / p.bottles) * p.bottlesPerCase) : null,
  })).sort((a, b) => a.product.localeCompare(b.product));

  const byPeriod = new Map<string, ProductionReport['periods'][number]>();
  for (const r of runs) {
    const b = bucketOf(r.date, by);
    const row = byPeriod.get(b.key) ?? { ...b, runs: 0, bottles: {}, totalBottles: 0, costCents: 0 };
    row.runs += 1;
    row.bottles[r.productId] = (row.bottles[r.productId] ?? 0) + r.bottles;
    row.totalBottles += r.bottles; row.costCents += r.costCents;
    byPeriod.set(b.key, row);
  }

  return {
    from: from || null, to: to || null, by,
    totals: {
      runs: runs.length,
      bottles: runs.reduce((s, r) => s + r.bottles, 0),
      costCents: runs.reduce((s, r) => s + r.costCents, 0),
    },
    products,
    periods: [...byPeriod.values()].sort((a, b) => a.key.localeCompare(b.key)),
    // Newest first in the list of runs.
    runs: [...runs].reverse(),
  };
}

/* ------------------------------------------------------------------ */

export interface PurchasingLine {
  lineId: string; material: string; unit: string;
  ordered: number; received: number; toCome: number; notComing: number;
  unitCostCents: Cents; orderedCents: Cents; receivedCents: Cents; toComeCents: Cents;
}
export interface PurchasingPo {
  poId: string; poNumber: string; orderDate: string; expectedDate: string | null; lastReceived: string | null;
  status: string; overdue: boolean; raisedInPeriod: boolean;
  orderedCents: Cents; receivedCents: Cents; toComeCents: Cents; lines: PurchasingLine[];
}
export interface PurchasingReport {
  from: string | null; to: string | null; asOf: string;
  totals: { pos: number; orderedCents: Cents; receivedCents: Cents; toComeCents: Cents; overdue: number; suppliers: number };
  suppliers: Array<{
    supplierId: string; supplier: string; pos: number;
    orderedCents: Cents; receivedCents: Cents; toComeCents: Cents; overdue: number;
    orders: PurchasingPo[];
  }>;
}

const CLOSED = ['Received', 'Partially Received - Closed', 'Cancelled'];

export async function purchasingReport(db: Queryable, from?: string | null, to?: string | null): Promise<PurchasingReport> {
  const today = businessToday();
  const lines = await db.query<{
    po_id: string; po_number: string; order_date: string; expected: string | null; receiving_date: string | null;
    status: string; supplier_id: string; supplier: string;
    line_id: string; material: string; unit: string | null; ordered: string; received: string;
    unit_cost_cents: string; value: string;
  }>(
    `SELECT po.id AS po_id, po.po_number, po.order_date::text AS order_date,
            po.expected_delivery_date::text AS expected, po.receiving_date::text AS receiving_date,
            po.status, s.id AS supplier_id, s.name AS supplier,
            l.id AS line_id, rm.name AS material, rm.unit_of_measure AS unit,
            l.quantity_ordered::text AS ordered, l.quantity_received::text AS received,
            l.unit_cost_cents::text AS unit_cost_cents,
            (l.line_total_cents + l.gct_cents + l.env_tax_cents)::text AS value
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     JOIN po_line_items l ON l.po_id = po.id
     JOIN raw_materials rm ON rm.id = l.raw_material_id
     WHERE po.status <> 'Cancelled'
       AND (
         (($1::date IS NULL OR po.order_date >= $1::date) AND ($2::date IS NULL OR po.order_date <= $2::date))
         OR (po.status IN ('Draft', 'Sent', 'Partially Received')
             AND EXISTS (SELECT 1 FROM po_line_items x WHERE x.po_id = po.id AND x.quantity_received < x.quantity_ordered))
       )
     ORDER BY s.name, po.order_date, po.po_number, rm.name`,
    [from || null, to || null],
  );

  const inPeriod = (d: string) => (!from || d >= from) && (!to || d <= to);
  const pos = new Map<string, PurchasingPo & { supplierId: string; supplier: string }>();
  for (const r of lines) {
    const closed = CLOSED.includes(r.status);
    const ordered = Number(r.ordered); const received = Number(r.received);
    const gap = Math.max(ordered - received, 0);
    const value = num(r.value);
    const share = (q: number) => (ordered > 0 ? Math.round((value * q) / ordered) : 0);
    const line: PurchasingLine = {
      lineId: r.line_id, material: r.material, unit: r.unit ?? '',
      ordered, received, toCome: closed ? 0 : gap, notComing: closed ? gap : 0,
      unitCostCents: num(r.unit_cost_cents), orderedCents: value,
      receivedCents: share(Math.min(received, ordered)), toComeCents: closed ? 0 : share(gap),
    };
    const day = String(r.order_date).slice(0, 10);
    const po = pos.get(r.po_id) ?? {
      poId: r.po_id, poNumber: r.po_number, orderDate: day,
      expectedDate: r.expected ? String(r.expected).slice(0, 10) : null,
      lastReceived: r.receiving_date ? String(r.receiving_date).slice(0, 10) : null,
      status: r.status, overdue: false, raisedInPeriod: inPeriod(day),
      orderedCents: 0, receivedCents: 0, toComeCents: 0, lines: [],
      supplierId: r.supplier_id, supplier: r.supplier,
    };
    po.lines.push(line);
    po.orderedCents += line.orderedCents; po.receivedCents += line.receivedCents; po.toComeCents += line.toComeCents;
    pos.set(r.po_id, po);
  }
  for (const po of pos.values()) {
    po.overdue = !!po.expectedDate && po.expectedDate < today && po.lines.some((l) => l.toCome > 0);
  }

  const bySupplier = new Map<string, PurchasingReport['suppliers'][number]>();
  for (const po of pos.values()) {
    const s = bySupplier.get(po.supplierId) ?? {
      supplierId: po.supplierId, supplier: po.supplier, pos: 0,
      orderedCents: 0, receivedCents: 0, toComeCents: 0, overdue: 0, orders: [],
    };
    const { supplierId: _a, supplier: _b, ...order } = po;
    s.orders.push(order);
    s.pos += 1; s.orderedCents += po.orderedCents; s.receivedCents += po.receivedCents; s.toComeCents += po.toComeCents;
    if (po.overdue) s.overdue += 1;
    bySupplier.set(po.supplierId, s);
  }
  const suppliers = [...bySupplier.values()].sort((a, b) => a.supplier.localeCompare(b.supplier));
  return {
    from: from || null, to: to || null, asOf: today,
    totals: {
      pos: pos.size,
      orderedCents: suppliers.reduce((t, s) => t + s.orderedCents, 0),
      receivedCents: suppliers.reduce((t, s) => t + s.receivedCents, 0),
      toComeCents: suppliers.reduce((t, s) => t + s.toComeCents, 0),
      overdue: suppliers.reduce((t, s) => t + s.overdue, 0),
      suppliers: suppliers.length,
    },
    suppliers,
  };
}
