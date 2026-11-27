/**
 * Stray cents on credit (Everton, 27 Nov 2026).
 *
 * Before GCT was worked out per bottle (4 Nov 2026), some 5-gallon invoices
 * came to J$999.99 and customers paid J$1,000, leaving J$0.01 on account.
 * That cent then goes on each next invoice and the whole-dollar cash leaves
 * a new one, so the driver keeps being asked for J$999.99 and it never clears
 * by itself. His ruling: clear any odd cents of J$0.04 or less sitting on a
 * customer's credit, whatever the rest of their balance is - a credit of
 * exactly J$0.01, a J$0.01 credit inside a balance owed, or the tail of a
 * real credit (J$3,700.01 keeps J$3,700.00). Admins only, from a list ticked
 * first; each clear-out is a "Rounding adjustment" on the account and
 * statement, and receipts stay as they were.
 *
 * How: the cents are reversed off the payment left on account that carries
 * them (split first when the payment is larger), so the cent can never go on
 * an invoice again. The reversal is tagged kind 'Rounding': statements call
 * it a rounding adjustment and money-taken reports leave it out.
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, num, requireRole } from './core.ts';
import { RuleViolation } from '@alka/shared';

/** The most that counts as a stray tail: J$0.04. */
export const STRAY_LIMIT_CENTS = 4;

interface CreditRow {
  id: string; amount_cents: number; receipt_number: string | null; day: string;
  method: string; reference: string | null; payment_date: string; delivery_sheet_id: string | null;
  delivery_stop_id: string | null; kind: string | null; order_id: string | null; notes: string | null;
}

/** Money left on the account that can go on an invoice (the same rows the app applies as credit). */
async function creditRows(t: Queryable, customerId: string, lock = false): Promise<CreditRow[]> {
  return t.query<CreditRow>(
    `SELECT p.id, p.amount_cents, p.receipt_number, business_date(p.payment_date)::text AS day,
            p.method, p.reference, p.payment_date::text AS payment_date, p.delivery_sheet_id,
            p.delivery_stop_id, p.kind, p.order_id, p.notes
     FROM payments p
     WHERE p.customer_id = $1 AND p.invoice_id IS NULL AND p.status = 'Confirmed'
       AND NOT p.is_reversal AND p.amount_cents > 0
       AND NOT EXISTS (SELECT 1 FROM payments r WHERE r.reverses_payment_id = p.id)
       -- Money paid ahead for an order still to go is kept for that order.
       AND NOT COALESCE((SELECT o.status NOT IN ('Delivered', 'Cancelled')
                           FROM customer_orders o WHERE o.id = p.order_id), false)
     ORDER BY p.payment_date DESC, p.created_at DESC
     ${lock ? 'FOR UPDATE OF p' : ''}`, [customerId]);
}

/** Which rows give up how many cents: the newest odd amounts first. */
function plan(rows: CreditRow[]): { tail: number; take: Array<{ row: CreditRow; cents: number }> } {
  const total = rows.reduce((s, r) => s + num(r.amount_cents), 0);
  const tail = total % 100;
  if (tail < 1 || tail > STRAY_LIMIT_CENTS) return { tail: 0, take: [] };
  const take: Array<{ row: CreditRow; cents: number }> = [];
  let left = tail;
  for (const r of rows) {
    if (left <= 0) break;
    const odd = num(r.amount_cents) % 100;
    if (odd === 0) continue;
    const c = Math.min(odd, left);
    take.push({ row: r, cents: c });
    left -= c;
  }
  return { tail, take };
}

export interface StrayCustomer {
  customerId: string; name: string; active: boolean;
  strayCents: number; creditCents: number;
  balanceCents: number; balanceAfterCents: number;
  from: Array<{ paymentId: string; receiptNumber: string | null; day: string; amountCents: number; cents: number }>;
}

/** Everyone with stray cents on their credit, for the admin to tick. */
export async function listStrayCents(db: Queryable): Promise<StrayCustomer[]> {
  const who = await db.query<{ id: string; name: string; active: boolean; balance_cents: number }>(
    `SELECT c.id, c.name, c.active, COALESCE(b.balance_cents, 0) AS balance_cents
     FROM customers c LEFT JOIN customer_balances b ON b.customer_id = c.id
     WHERE NOT c.is_walk_in AND EXISTS (
       SELECT 1 FROM payments p WHERE p.customer_id = c.id AND p.invoice_id IS NULL
         AND p.status = 'Confirmed' AND NOT p.is_reversal AND p.amount_cents % 100 <> 0)
     ORDER BY c.name`);
  const out: StrayCustomer[] = [];
  for (const c of who) {
    const rows = await creditRows(db, c.id);
    const { tail, take } = plan(rows);
    if (!tail) continue;
    out.push({
      customerId: c.id, name: c.name, active: !!c.active,
      strayCents: tail, creditCents: rows.reduce((s, r) => s + num(r.amount_cents), 0),
      balanceCents: num(c.balance_cents), balanceAfterCents: num(c.balance_cents) + tail,
      from: take.map((x) => ({
        paymentId: x.row.id, receiptNumber: x.row.receipt_number, day: x.row.day,
        amountCents: num(x.row.amount_cents), cents: x.cents,
      })),
    });
  }
  return out;
}

/** Clear the stray cents for the customers ticked. */
export async function clearStrayCents(
  db: Db, actor: Actor, input: { customerIds?: string[] },
): Promise<{ cleared: Array<{ name: string; cents: number }> }> {
  requireRole(actor, 'admin');
  const ids = [...new Set((input.customerIds ?? []).map(String).filter(Boolean))];
  if (ids.length === 0) throw new RuleViolation('tick the customers to clear');
  const cleared: Array<{ name: string; cents: number }> = [];
  for (const customerId of ids) {
    const done = await db.tx(async (t) => {
      const c = await t.maybeOne<{ name: string; is_walk_in: boolean }>(
        `SELECT name, is_walk_in FROM customers WHERE id = $1 FOR UPDATE`, [customerId]);
      if (!c || c.is_walk_in) return null;
      const { tail, take } = plan(await creditRows(t, customerId, true));
      if (!tail) return null; // cleared already, or no longer stray
      for (const { row, cents } of take) {
        let target = row.id;
        if (cents < num(row.amount_cents)) {
          // Split off the cents as a row of their own, same receipt, so the
          // rest of the credit stays usable and the receipt still adds up.
          await t.query(`UPDATE payments SET amount_cents = amount_cents - $2 WHERE id = $1`, [row.id, cents]);
          target = (await t.one<{ id: string }>(
            `INSERT INTO payments (customer_id, amount_cents, payment_date, method, reference, notes, status,
                                   delivery_sheet_id, delivery_stop_id, kind, created_by_id, order_id, receipt_number)
             VALUES ($1,$2,$3::timestamptz,$4,$5,$6,'Confirmed',$7,$8,$9,$10,$11,$12) RETURNING id`,
            [customerId, cents, row.payment_date, row.method, row.reference,
             `The odd ${cents === 1 ? 'cent' : 'cents'} of ${row.receipt_number ?? 'an earlier payment'}`,
             row.delivery_sheet_id, row.delivery_stop_id, row.kind, actor.id, row.order_id, row.receipt_number])).id;
        }
        await t.query(
          `INSERT INTO payments (customer_id, invoice_id, amount_cents, method, status, is_reversal,
                                 reverses_payment_id, notes, created_by_id, receipt_number, kind)
           VALUES ($1, NULL, $2, $3, 'Confirmed', true, $4, $5, $6, $7, 'Rounding')`,
          [customerId, -cents, row.method, target,
           `Rounding adjustment: stray ${cents === 1 ? 'cent' : 'cents'} cleared by ${actor.name}`,
           actor.id, row.receipt_number]);
      }
      await audit(t, actor, 'adjust', 'Customer', customerId, c.name, {
        roundingAdjustmentCents: tail,
        from: take.map((x) => ({ receipt: x.row.receipt_number, cents: x.cents })),
      });
      return { name: c.name, cents: tail };
    });
    if (done) cleared.push(done);
  }
  return { cleared };
}
