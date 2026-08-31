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
