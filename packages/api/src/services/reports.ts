/**
 * Reporting (Section 9).
 *
 * Discount reports count ONLY approved discounts. A discount still sitting in
 * the approval queue has not reduced anything and must not appear as if it
 * had; a rejected one never applied at all.
 */

import type { Db } from '../db/index.ts';
import type { Cents } from '@alka/shared';
import { num } from './core.ts';

export interface DiscountTotals {
  from: string | null;
  to: string | null;
  totalDiscountCents: Cents;
  discountedDocumentCount: number;
  averageDiscountPercent: number;
}

export interface PerClientDiscount {
  customerId: string;
  customerName: string;
  totalDiscountCents: Cents;
  discountedDocumentCount: number;
  averageDiscountPercent: number;
}

const APPROVED_ONLY = `
  i.discount_status = 'Approved'
  AND i.discount_amount_cents > 0
  AND i.lifecycle <> 'Cancelled'
  AND ($1::date IS NULL OR i.invoice_date >= $1::date)
  AND ($2::date IS NULL OR i.invoice_date <= $2::date)`;

export async function totalDiscounts(
  db: Db,
  from?: string | null,
  to?: string | null,
): Promise<DiscountTotals> {
  const row = await db.one<{ total: number; cnt: number; avg_pct: number | null }>(
    `SELECT COALESCE(SUM(i.discount_amount_cents),0)::bigint AS total,
            COUNT(*)::int AS cnt,
            AVG(i.discount_percent) AS avg_pct
     FROM invoices i
     WHERE ${APPROVED_ONLY}`,
    [from ?? null, to ?? null],
  );
  return {
    from: from ?? null,
    to: to ?? null,
    totalDiscountCents: num(row.total),
    discountedDocumentCount: num(row.cnt),
    averageDiscountPercent: row.avg_pct === null ? 0 : Math.round(num(row.avg_pct) * 100) / 100,
  };
}

export async function discountsByClient(
  db: Db,
  from?: string | null,
  to?: string | null,
): Promise<PerClientDiscount[]> {
  const rows = await db.query<{
    customer_id: string; name: string; total: number; cnt: number; avg_pct: number | null;
  }>(
    `SELECT i.customer_id, c.name,
            COALESCE(SUM(i.discount_amount_cents),0)::bigint AS total,
            COUNT(*)::int AS cnt,
            AVG(i.discount_percent) AS avg_pct
     FROM invoices i JOIN customers c ON c.id = i.customer_id
     WHERE ${APPROVED_ONLY}
     GROUP BY i.customer_id, c.name
     ORDER BY total DESC`,
    [from ?? null, to ?? null],
  );
  return rows.map((r) => ({
    customerId: r.customer_id,
    customerName: r.name,
    totalDiscountCents: num(r.total),
    discountedDocumentCount: num(r.cnt),
    averageDiscountPercent: r.avg_pct === null ? 0 : Math.round(num(r.avg_pct) * 100) / 100,
  }));
}

/** Outstanding balances across all active customers. */
export async function receivablesSummary(db: Db) {
  return db.query(
    `SELECT b.customer_id, b.name, b.invoiced_cents, b.paid_cents, b.balance_cents
     FROM customer_balances b
     JOIN customers c ON c.id = b.customer_id
     WHERE c.active AND b.balance_cents <> 0
     ORDER BY b.balance_cents DESC`,
  );
}

/** Materials at or below their reorder point. */
export async function reorderReport(db: Db) {
  return db.query(
    `SELECT id, name, category, quantity_on_hand, reorder_point, unit_of_measure
     FROM raw_materials
     WHERE quantity_on_hand <= reorder_point
     ORDER BY (quantity_on_hand - reorder_point), name`,
  );
}

/** The 5-gallon pool, including bottles written off as a business loss. */
export async function bottlePoolReport(db: Db) {
  return db.query(
    `SELECT label, clean_ready, filled_with_customer, returned_dirty, lost_damaged,
            (clean_ready + filled_with_customer + returned_dirty) AS in_circulation
     FROM five_gal_bottle_pool ORDER BY label`,
  );
}

/* ------------------------------------------------------------------ */
/* The dashboard                                                       */
/* ------------------------------------------------------------------ */

/**
 * Everything the opening screen shows, in one call.
 *
 * One round trip rather than six: this is the first screen of the morning and
 * the one loaded most often, and six separate requests means six chances for
 * a slow one to leave the page half-drawn.
 *
 * The screen is built to answer "what needs me today?", so every figure here
 * is chosen for whether it prompts an action - money that is LATE rather than
 * merely large, rounds still running rather than rounds that exist, and the
 * things that are actually blocked on a decision.
 */
export async function dashboard(db: Db) {
  /*
   * Age of what is owed, business-wide. The same shape the statement PDF
   * carries per customer, and for the same reason: a total invites a shrug,
   * an age invites a phone call. Each invoice is judged against its OWN due
   * date, so terms agreed per customer are respected.
   */
  const aging = await db.one<{
    current: string; d30: string; d60: string; d90: string; total: string;
  }>(
    `SELECT
       COALESCE(SUM(balance_cents) FILTER (
         WHERE due_date IS NULL OR business_today() - due_date <= 0), 0)::text AS current,
       COALESCE(SUM(balance_cents) FILTER (
         WHERE business_today() - due_date BETWEEN 1 AND 30), 0)::text AS d30,
       COALESCE(SUM(balance_cents) FILTER (
         WHERE business_today() - due_date BETWEEN 31 AND 60), 0)::text AS d60,
       COALESCE(SUM(balance_cents) FILTER (
         WHERE business_today() - due_date > 60), 0)::text AS d90,
       COALESCE(SUM(balance_cents), 0)::text AS total
     FROM invoice_ledger WHERE balance_cents > 0`,
  );

  /*
   * Who to ring, ordered by how LATE rather than how large. A big balance
   * inside its terms is ordinary business; a small one at ninety days is a
   * problem. An invoice with no due date is not overdue at all, so it sorts
   * last rather than first.
   */
  const debtors = await db.query(
    `SELECT c.id AS customer_id, c.name,
            SUM(l.balance_cents)::text AS balance_cents,
            MAX(business_today() - l.due_date) AS days_overdue
     FROM invoice_ledger l
     JOIN customers c ON c.id = l.customer_id
     WHERE l.balance_cents > 0 AND c.active
     GROUP BY c.id, c.name
     ORDER BY MAX(business_today() - l.due_date) DESC NULLS LAST,
              SUM(l.balance_cents) DESC
     LIMIT 6`,
  );

  /*
   * Rounds still open, with how far along they are.
   *
   * "Worth" is the value of the orders on the truck, NOT what the driver is
   * expected to hand over - most customers are on terms and pay nothing at
   * the door. Calling it cash expected would invite the office to chase a
   * driver for money nobody was ever going to collect.
   */
  const rounds = await db.query(
    `SELECT s.id, s.zone, s.delivery_date::text AS delivery_date,
            s.driver_name, s.status,
            (SELECT COUNT(*)::int FROM delivery_stops st
              WHERE st.delivery_sheet_id = s.id) AS stops,
            (SELECT COUNT(*)::int FROM delivery_stops st
              WHERE st.delivery_sheet_id = s.id AND st.stop_outcome <> 'Pending') AS done,
            (SELECT COALESCE(SUM(st.payment_amount_cents), 0)::text FROM delivery_stops st
              WHERE st.delivery_sheet_id = s.id) AS collected_cents,
            (SELECT COALESCE(SUM(o.grand_total_cents), 0)::text
               FROM delivery_stops st JOIN customer_orders o ON o.id = st.order_id
              WHERE st.delivery_sheet_id = s.id) AS worth_cents
     FROM delivery_sheets s
     WHERE s.status = 'Open'
     ORDER BY s.delivery_date, s.zone`,
  );

  const applications = await db.one<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM customer_applications WHERE status = 'Pending'`,
  );
  const approvals = await db.query(
    `SELECT ar.id, ar.request_type, ar.entity_label, ar.reason,
            ar.amount_cents::text AS amount_cents, ar.discount_percent,
            c.name AS customer_name, u.name AS raised_by
     FROM approval_requests ar
     LEFT JOIN customers c ON c.id = ar.customer_id
     LEFT JOIN users u ON u.id = ar.requested_by_id
     WHERE ar.status = 'Pending'
     ORDER BY ar.requested_date
     LIMIT 5`,
  );
  const pendingApplications = await db.query(
    `SELECT id, account_type, business_name, first_name, last_name, parish,
            business_date(created_at)::text AS asked_on
     FROM customer_applications WHERE status = 'Pending'
     ORDER BY created_at LIMIT 5`,
  );

  const lowStock = await reorderReport(db);

  return {
    aging: {
      currentCents: num(aging.current),
      d30Cents: num(aging.d30),
      d60Cents: num(aging.d60),
      d90Cents: num(aging.d90),
      totalCents: num(aging.total),
    },
    debtors,
    rounds,
    waiting: {
      applications: Number(applications.n),
      approvals: approvals.length,
      approvalDetail: approvals,
      applicationDetail: pendingApplications,
    },
    lowStock,
  };
}

/**
 * Deliveries that carried returnable bottles but recorded none going out.
 *
 * The count of bottles delivered is typed by the driver; it is not taken from
 * the order. So a driver who leaves the box blank silently understates how
 * many bottles are out with customers - and the per-customer holding, which
 * is what you would use to chase bottles back, is understated the same way.
 * It is an error that never announces itself, which is why it is worth a
 * report of its own.
 *
 * Read-only. It reports the gap; it does not close it.
 */
export async function bottlesNotRecorded(db: Db) {
  return db.query(
    `SELECT s.id AS stop_id,
            sh.delivery_date::text AS delivery_date,
            sh.zone, sh.driver_name,
            c.id AS customer_id, c.name AS customer_name,
            o.order_number,
            SUM(oli.total_bottles)::int AS bottles_on_the_order,
            s.bottles_delivered_full::int AS bottles_recorded,
            s.bottles_empties_picked_up::int AS empties_recorded
     FROM delivery_stops s
     JOIN delivery_sheets sh ON sh.id = s.delivery_sheet_id
     JOIN customers c ON c.id = s.customer_id
     JOIN customer_orders o ON o.id = s.order_id
     JOIN order_line_items oli ON oli.order_id = o.id
     JOIN products p ON p.id = oli.product_id AND p.is_returnable
     WHERE s.stop_outcome = 'Delivered'
     GROUP BY s.id, sh.delivery_date, sh.zone, sh.driver_name,
              c.id, c.name, o.order_number,
              s.bottles_delivered_full, s.bottles_empties_picked_up
     HAVING SUM(oli.total_bottles) > 0
        AND COALESCE(s.bottles_delivered_full, 0) < SUM(oli.total_bottles)
     ORDER BY sh.delivery_date DESC, c.name`,
  );
}

/* ------------------------------------------------------------------ */
/* Sales and a first look at margin (Reports screen, 29 Sep 2026)      */
/* ------------------------------------------------------------------ */

/**
 * Invoices that count as sales: real invoices (not credit notes), not
 * cancelled, dated inside the period. Sales are before GCT and after any
 * approved discount; a discount still waiting for a decision has not
 * reduced anything, so it is not taken off.
 */
const SALES_WHERE = `
  NOT i.is_credit_note AND i.lifecycle <> 'Cancelled'
  AND ($1::date IS NULL OR i.invoice_date >= $1::date)
  AND ($2::date IS NULL OR i.invoice_date <= $2::date)`;
const NET = `(i.subtotal_cents - CASE WHEN i.discount_status = 'Approved' THEN i.discount_amount_cents ELSE 0 END)`;

export async function salesReport(db: Db, from?: string | null, to?: string | null) {
  const p = [from ?? null, to ?? null];

  const totals = await db.one<{
    net: number; gross: number; invoices: number; customers: number; new_customers: number;
  }>(
    `SELECT COALESCE(SUM(${NET}),0)::bigint AS net,
            COALESCE(SUM(i.grand_total_cents),0)::bigint AS gross,
            COUNT(*)::int AS invoices,
            COUNT(DISTINCT i.customer_id)::int AS customers,
            COUNT(DISTINCT i.customer_id) FILTER (
              WHERE NOT EXISTS (SELECT 1 FROM invoices e
                                 WHERE e.customer_id = i.customer_id AND NOT e.is_credit_note
                                   AND e.lifecycle <> 'Cancelled'
                                   AND $1::date IS NOT NULL AND e.invoice_date < $1::date))::int AS new_customers
     FROM invoices i WHERE ${SALES_WHERE}`, p,
  );

  const credits = await db.one<{ cents: number; n: number; net: number; gct: number }>(
    `SELECT COALESCE(SUM(ABS(i.grand_total_cents)),0)::bigint AS cents, COUNT(*)::int AS n,
            COALESCE(SUM(ABS(i.subtotal_cents) - ABS(i.discount_amount_cents)),0)::bigint AS net,
            COALESCE(SUM(ABS(i.gct_cents)),0)::bigint AS gct
     FROM invoices i
     WHERE i.is_credit_note AND i.credit_status = 'Approved' AND i.lifecycle <> 'Cancelled'
       AND ($1::date IS NULL OR i.invoice_date >= $1::date)
       AND ($2::date IS NULL OR i.invoice_date <= $2::date)`, p,
  );

  const byProduct = await db.query<{
    product_id: string; name: string; bottles_per_case: number; cases: number; bottles: number; cents: number;
  }>(
    `SELECT pr.id AS product_id, pr.name, pr.bottles_per_case,
            COALESCE(SUM(l.cases),0)::int AS cases, COALESCE(SUM(l.loose_bottles),0)::int AS bottles,
            COALESCE(SUM(l.line_total_cents),0)::bigint AS cents
     FROM invoice_line_items l
     JOIN invoices i ON i.id = l.invoice_id
     JOIN products pr ON pr.id = l.product_id
     WHERE ${SALES_WHERE}
     GROUP BY pr.id, pr.name, pr.bottles_per_case
     ORDER BY cents DESC`, p,
  );

  // Where it went: the round an invoice was delivered on, or "Collected or
  // counter" when no round raised it.
  const byZone = await db.query<{ zone: string; invoices: number; cents: number }>(
    `SELECT COALESCE(ds.zone, 'Collected or counter') AS zone,
            COUNT(DISTINCT i.id)::int AS invoices,
            COALESCE(SUM(${NET}),0)::bigint AS cents
     FROM invoices i
     LEFT JOIN LATERAL (
       SELECT d.zone FROM delivery_stops st JOIN delivery_sheets d ON d.id = st.delivery_sheet_id
        WHERE st.invoice_id = i.id LIMIT 1) ds ON true
     WHERE ${SALES_WHERE}
     GROUP BY 1 ORDER BY cents DESC`, p,
  );

  const topCustomers = await db.query<{ customer_id: string; name: string; invoices: number; cents: number }>(
    `SELECT i.customer_id, c.name, COUNT(*)::int AS invoices, COALESCE(SUM(${NET}),0)::bigint AS cents
     FROM invoices i JOIN customers c ON c.id = i.customer_id
     WHERE ${SALES_WHERE}
     GROUP BY i.customer_id, c.name ORDER BY cents DESC LIMIT 8`, p,
  );

  // Returnable bottles out and back on rounds dated in the period.
  const bottles = await db.one<{ out: number; back: number; lost: number }>(
    `SELECT COALESCE(SUM(st.bottles_delivered_full),0)::int AS out,
            COALESCE(SUM(st.bottles_empties_picked_up),0)::int AS back,
            COALESCE(SUM(st.bottles_lost_damaged),0)::int AS lost
     FROM delivery_stops st JOIN delivery_sheets d ON d.id = st.delivery_sheet_id
     WHERE ($1::date IS NULL OR d.delivery_date >= $1::date)
       AND ($2::date IS NULL OR d.delivery_date <= $2::date)`, p,
  );

  return {
    from: from ?? null,
    to: to ?? null,
    totals: {
      netCents: num(totals.net), grossCents: num(totals.gross), invoices: num(totals.invoices),
      customers: num(totals.customers), newCustomers: from ? num(totals.new_customers) : null,
      creditNoteCents: num(credits.cents), creditNotes: num(credits.n),
      creditNoteNetCents: num(credits.net), creditNoteGctCents: num(credits.gct),
      // Credit notes come OFF sales (team feedback, point 21): these are the
      // figures to post to QuickBooks for the period.
      netAfterCreditsCents: num(totals.net) - num(credits.net),
      grossAfterCreditsCents: num(totals.gross) - num(credits.cents),
      gctCents: num(totals.gross) - num(totals.net),
      gctAfterCreditsCents: (num(totals.gross) - num(totals.net)) - num(credits.gct),
    },
    byProduct: byProduct.map((r) => ({
      productId: r.product_id, name: r.name, bottlesPerCase: num(r.bottles_per_case),
      cases: num(r.cases), bottles: num(r.bottles), cents: num(r.cents),
    })),
    byZone: byZone.map((r) => ({ zone: r.zone, invoices: num(r.invoices), cents: num(r.cents) })),
    topCustomers: topCustomers.map((r) => ({
      customerId: r.customer_id, name: r.name, invoices: num(r.invoices), cents: num(r.cents),
    })),
    bottles: { out: num(bottles.out), back: num(bottles.back), lost: num(bottles.lost) },
  };
}

/**
 * Margin, a first look: what each product sold for in the period, less what
 * its bill of materials costs at the average price actually paid for each
 * material (every batch received, weighted by quantity). Labour, delivery
 * and overheads are NOT in it, so real margin is lower; the screen says so.
 */
export async function marginReport(db: Db, from?: string | null, to?: string | null) {
  const p = [from ?? null, to ?? null];
  const rows = await db.query<{
    product_id: string; name: string; bottles_per_case: number; is_returnable: boolean;
    units_bottles: number; cents: number; bom_lines: number; costed_lines: number;
    material_per_bottle: number | null;
  }>(
    `WITH cost AS (
       SELECT raw_material_id,
              SUM(unit_cost_cents * quantity_received) / NULLIF(SUM(quantity_received), 0) AS avg_cents
       FROM material_batches GROUP BY raw_material_id
     ),
     -- A returnable bottle (the 5 gallon) comes back and is filled again,
     -- so its cost is not a cost of each sale; it is left out of the fill.
     bom AS (
       SELECT b.product_id, COUNT(*)::int AS bom_lines,
              COUNT(c.avg_cents)::int AS costed_lines,
              SUM(CASE WHEN pr.is_returnable AND b.component_type = 'Bottle' THEN 0
                       ELSE b.quantity * COALESCE(c.avg_cents, 0) END) AS per_bottle
       FROM bom_line_items b
       JOIN products pr ON pr.id = b.product_id
       LEFT JOIN cost c ON c.raw_material_id = b.raw_material_id
       GROUP BY b.product_id
     ),
     sold AS (
       SELECT l.product_id,
              SUM(l.cases * pr.bottles_per_case + l.loose_bottles)::int AS units_bottles,
              SUM(l.line_total_cents)::bigint AS cents
       FROM invoice_line_items l
       JOIN invoices i ON i.id = l.invoice_id
       JOIN products pr ON pr.id = l.product_id
       WHERE ${SALES_WHERE}
       GROUP BY l.product_id
     )
     SELECT pr.id AS product_id, pr.name, pr.bottles_per_case, pr.is_returnable,
            COALESCE(s.units_bottles, 0) AS units_bottles, COALESCE(s.cents, 0) AS cents,
            COALESCE(b.bom_lines, 0) AS bom_lines, COALESCE(b.costed_lines, 0) AS costed_lines,
            b.per_bottle AS material_per_bottle
     FROM products pr
     LEFT JOIN sold s ON s.product_id = pr.id
     LEFT JOIN bom b ON b.product_id = pr.id
     WHERE pr.active OR s.cents IS NOT NULL
     ORDER BY COALESCE(s.cents, 0) DESC, pr.name`, p,
  );

  return rows.map((r) => {
    const perBottle = r.material_per_bottle === null ? null : Math.round(Number(r.material_per_bottle));
    const bottles = num(r.units_bottles);
    const sales = num(r.cents);
    const materials = perBottle === null ? null : perBottle * bottles;
    return {
      productId: r.product_id,
      name: r.name,
      bottlesPerCase: num(r.bottles_per_case),
      bottlesSold: bottles,
      salesCents: sales,
      returnable: !!r.is_returnable,
      bomLines: num(r.bom_lines),
      costedLines: num(r.costed_lines),
      materialPerBottleCents: perBottle,
      materialCents: materials,
      marginCents: materials === null ? null : sales - materials,
      marginPercent: materials === null || sales <= 0 ? null
        : Math.round(((sales - materials) / sales) * 1000) / 10,
    };
  });
}

/**
 * Rounds and cash: every round dated in the period, what it delivered, what
 * the driver recorded collecting against what was handed in at settlement,
 * and the bottle count. The cash difference is a check on the round only; it
 * never touches a customer's account (see settlement.ts).
 */
export async function roundsReport(db: Db, from?: string | null, to?: string | null) {
  const rows = await db.query<{
    id: string; delivery_date: string; zone: string; status: string; driver: string | null;
    started: boolean; stops: number; delivered: number; missed: number; pending: number;
    invoiced_cents: number; recorded_cents: number; actual_cash_cents: number | null;
    cash_variance_cents: number | null; empties_recorded: number; bottle_actual_returned: number | null;
    bottle_variance: number | null; full_out: number;
  }>(
    `SELECT d.id, d.delivery_date::text AS delivery_date, d.zone, d.status,
            COALESCE(u.name, d.driver_name) AS driver, (d.started_at IS NOT NULL) AS started,
            COUNT(s.id)::int AS stops,
            COUNT(s.id) FILTER (WHERE s.stop_outcome = 'Delivered')::int AS delivered,
            COUNT(s.id) FILTER (WHERE s.stop_outcome NOT IN ('Delivered','Pending'))::int AS missed,
            COUNT(s.id) FILTER (WHERE s.stop_outcome = 'Pending')::int AS pending,
            COALESCE(SUM(i.grand_total_cents), 0)::bigint AS invoiced_cents,
            COALESCE(SUM(s.payment_amount_cents), 0)::bigint AS recorded_cents,
            d.actual_cash_cents, d.cash_variance_cents,
            COALESCE(SUM(s.bottles_empties_picked_up), 0)::int AS empties_recorded,
            COALESCE(SUM(s.bottles_delivered_full), 0)::int AS full_out,
            d.bottle_actual_returned, d.bottle_variance
     FROM delivery_sheets d
     LEFT JOIN users u ON u.id = d.assigned_driver_id
     LEFT JOIN delivery_stops s ON s.delivery_sheet_id = d.id
     LEFT JOIN invoices i ON i.id = s.invoice_id
     WHERE ($1::date IS NULL OR d.delivery_date >= $1::date)
       AND ($2::date IS NULL OR d.delivery_date <= $2::date)
     GROUP BY d.id, u.name
     ORDER BY d.delivery_date DESC, d.zone`,
    [from ?? null, to ?? null],
  );

  const rounds = rows.map((r) => ({
    id: r.id, date: r.delivery_date, zone: r.zone, driver: r.driver, status: r.status,
    started: !!r.started, stops: num(r.stops), delivered: num(r.delivered), missed: num(r.missed),
    pending: num(r.pending), invoicedCents: num(r.invoiced_cents), recordedCents: num(r.recorded_cents),
    handedInCents: r.actual_cash_cents === null ? null : num(r.actual_cash_cents),
    cashVarianceCents: r.status === 'Completed' && r.cash_variance_cents !== null ? num(r.cash_variance_cents) : null,
    fullOut: num(r.full_out), emptiesRecorded: num(r.empties_recorded),
    emptiesCounted: r.bottle_actual_returned === null ? null : num(r.bottle_actual_returned),
    bottleVariance: r.bottle_variance === null ? null : num(r.bottle_variance),
  }));

  const settled = rounds.filter((r) => r.status === 'Completed');
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return {
    totals: {
      rounds: rounds.length,
      settled: settled.length,
      stops: sum(rounds.map((r) => r.stops)),
      delivered: sum(rounds.map((r) => r.delivered)),
      missed: sum(rounds.map((r) => r.missed)),
      invoicedCents: sum(rounds.map((r) => r.invoicedCents)),
      recordedCents: sum(rounds.map((r) => r.recordedCents)),
      handedInCents: sum(settled.map((r) => r.handedInCents ?? 0)),
      cashVarianceCents: sum(settled.map((r) => r.cashVarianceCents ?? 0)),
      roundsShort: settled.filter((r) => (r.cashVarianceCents ?? 0) < 0).length,
    },
    rounds,
  };
}

/**
 * Every invoice and credit note in the period, one line each, with the order
 * it came from (team feedback, point 21): what makes up the sales total, and
 * what to post to QuickBooks. Credit notes are negative, so the columns add
 * up to the net figures on the Sales report.
 */
export async function salesTransactions(db: Db, from?: string | null, to?: string | null) {
  const rows = await db.query<{
    invoice_id: string; invoice_number: string; invoice_date: string; is_credit_note: boolean;
    customer_name: string; customer_id: string; orders: string | null; customer_po: string | null;
    linked_number: string | null; subtotal_cents: number; discount_cents: number; gct_cents: number;
    total_cents: number; balance_cents: number; status: string; zone: string | null;
    delivered_on: string | null; notes: string | null;
  }>(
    `SELECT i.id AS invoice_id, i.invoice_number, i.invoice_date::text AS invoice_date, i.is_credit_note,
            c.name AS customer_name, c.id AS customer_id,
            (SELECT string_agg(o.order_number, ', ' ORDER BY o.order_number)
               FROM invoice_orders io JOIN customer_orders o ON o.id = io.order_id
              WHERE io.invoice_id = i.id) AS orders,
            (SELECT string_agg(DISTINCT o.customer_po, ', ')
               FROM invoice_orders io JOIN customer_orders o ON o.id = io.order_id
              WHERE io.invoice_id = i.id AND o.customer_po IS NOT NULL) AS customer_po,
            li.invoice_number AS linked_number,
            i.subtotal_cents,
            CASE WHEN i.discount_status = 'Approved' THEN i.discount_amount_cents ELSE 0 END AS discount_cents,
            i.gct_cents, i.grand_total_cents AS total_cents,
            l.balance_cents, l.status,
            ds.zone, ds.delivery_date::text AS delivered_on, i.notes
     FROM invoices i
     JOIN customers c ON c.id = i.customer_id
     JOIN invoice_ledger l ON l.invoice_id = i.id
     LEFT JOIN invoices li ON li.id = i.linked_invoice_id
     LEFT JOIN LATERAL (
       SELECT d.zone, d.delivery_date FROM delivery_stops st JOIN delivery_sheets d ON d.id = st.delivery_sheet_id
        WHERE st.invoice_id = i.id LIMIT 1) ds ON true
     WHERE i.lifecycle <> 'Cancelled'
       AND (NOT i.is_credit_note OR i.credit_status = 'Approved')
       AND ($1::date IS NULL OR i.invoice_date >= $1::date)
       AND ($2::date IS NULL OR i.invoice_date <= $2::date)
     ORDER BY i.invoice_date, i.invoice_number`,
    [from ?? null, to ?? null],
  );
  return rows.map((r) => {
    const sign = r.is_credit_note ? -1 : 1;
    const subtotal = sign * Math.abs(num(r.subtotal_cents));
    const discount = sign * Math.abs(num(r.discount_cents));
    return {
      invoiceId: r.invoice_id, number: r.invoice_number, date: r.invoice_date,
      type: r.is_credit_note ? 'Credit note' : 'Invoice',
      customerId: r.customer_id, customer: r.customer_name,
      orders: r.orders, customerPo: r.customer_po, against: r.linked_number,
      subtotalCents: subtotal, discountCents: discount,
      netCents: subtotal - discount,
      gctCents: sign * Math.abs(num(r.gct_cents)),
      totalCents: sign * Math.abs(num(r.total_cents)),
      balanceCents: num(r.balance_cents), status: r.status,
      zone: r.zone, deliveredOn: r.delivered_on, notes: r.notes,
    };
  });
}
