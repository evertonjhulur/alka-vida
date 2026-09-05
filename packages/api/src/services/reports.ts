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
    `SELECT s.id, s.zone, business_date(s.delivery_date::timestamptz)::text AS delivery_date,
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
