/**
 * Undo a delivery recorded in error (Everton, 26 Oct 2026: "two orders were
 * entered and marked delivered in error and now can't be deleted even by
 * administrator"). His rulings: an administrator's button, with a reason;
 * the order ends up Cancelled.
 *
 * A delivered order is never deleted - it has an invoice, stock left and
 * bottles moved - so this reverses each of those and keeps the trail:
 *   - its invoice is CANCELLED (kept, marked cancelled, out of the balance);
 *   - money taken WITH it (paid with the order, or collected at its stop) is
 *     reversed; money from elsewhere that was only applied to its invoice is
 *     moved back onto the account as credit, never lost;
 *   - finished goods go back on the warehouse stock (on a loaded round they
 *     simply stay on the truck and are counted back at the returns);
 *   - 5-gallon bottles go back to the pool and off the customer's holding;
 *   - its stop comes off the round;
 *   - the order is Cancelled, with the reason, in the audit log.
 *
 * It refuses where undoing would rewrite something already closed: a stop on
 * a SETTLED round, an invoice shared with other orders (a weekly/monthly
 * invoice), or one that already has a credit note against it. Those are
 * corrected with a credit note, as before.
 *
 * The same call answers a dry run (what will happen) for the screen.
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, num, requireRole } from './core.ts';
import { RuleViolation } from '@alka/shared';
import { deliveredBottles, stopBottles } from './stockmoves.ts';
import { deliversFromTruck } from './trucks.ts';
import { reverseDeliveryMovement } from './bottles.ts';

export interface UndoPlan {
  orderId: string;
  orderNumber: string;
  customerName: string;
  invoices: Array<{ id: string; number: string; totalCents: number }>;
  paymentsReversed: Array<{ id: string; receipt: string | null; method: string; amountCents: number }>;
  paymentsToCredit: Array<{ id: string; receipt: string | null; method: string; amountCents: number }>;
  cashAtStopRemovedCents: number;
  stockBack: Array<{ productId: string; name: string; bottles: number }>;
  stockStaysOnTruck: boolean;
  bottlesBack: { delivered: number; empties: number; lost: number; sold: number };
  roundsLeft: Array<{ zone: string; date: string }>;
  done: boolean;
}

async function buildPlan(t: Queryable, orderId: string) {
  const order = await t.maybeOne<{
    id: string; order_number: string; customer_id: string; status: string; customer_name: string;
  }>(
    `SELECT o.id, o.order_number, o.customer_id, o.status, c.name AS customer_name
     FROM customer_orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1`, [orderId],
  );
  if (!order) throw new RuleViolation('that order no longer exists');
  if (order.status === 'Cancelled') throw new RuleViolation(`${order.order_number} is already cancelled`);
  if (order.status !== 'Delivered' && order.status !== 'Partially Delivered') {
    throw new RuleViolation(`${order.order_number} has not been delivered - cancel it instead`);
  }

  const invoices = await t.query<{ id: string; invoice_number: string; grand_total_cents: number; created_at: string }>(
    `SELECT i.id, i.invoice_number, i.grand_total_cents, i.created_at FROM invoices i
     WHERE NOT i.is_credit_note AND i.lifecycle <> 'Cancelled' AND i.id IN (
       SELECT invoice_id FROM invoice_orders WHERE order_id = $1
       UNION SELECT invoice_id FROM invoice_line_items WHERE order_id = $1
       UNION SELECT invoice_id FROM delivery_stops WHERE order_id = $1 AND invoice_id IS NOT NULL)`,
    [orderId],
  );
  for (const inv of invoices) {
    const shared = await t.maybeOne(
      `SELECT 1 FROM invoice_orders WHERE invoice_id = $1 AND order_id <> $2
       UNION SELECT 1 FROM invoice_line_items WHERE invoice_id = $1 AND order_id IS NOT NULL AND order_id <> $2`,
      [inv.id, orderId]);
    if (shared) {
      throw new RuleViolation(`invoice ${inv.invoice_number} also covers other orders (a weekly or monthly invoice). `
        + 'Raise a credit note for this order instead');
    }
    const credited = await t.maybeOne(
      `SELECT 1 FROM invoices WHERE linked_invoice_id = $1 AND is_credit_note AND lifecycle <> 'Cancelled'`, [inv.id]);
    if (credited) {
      throw new RuleViolation(`invoice ${inv.invoice_number} already has a credit note against it. Correct it there instead`);
    }
  }

  const stops = await t.query<{
    id: string; stop_outcome: string; settled_at: string | null; delivery_sheet_id: string;
    sheet_status: string; zone: string; delivery_date: string; payment_amount_cents: number;
    bottles_delivered_full: number; bottles_empties_picked_up: number; bottles_lost_damaged: number;
  }>(
    `SELECT s.id, s.stop_outcome, s.settled_at, s.delivery_sheet_id, d.status AS sheet_status, d.zone,
            d.delivery_date::text AS delivery_date, s.payment_amount_cents,
            s.bottles_delivered_full, s.bottles_empties_picked_up, s.bottles_lost_damaged
     FROM delivery_stops s JOIN delivery_sheets d ON d.id = s.delivery_sheet_id
     WHERE s.order_id = $1`, [orderId],
  );
  const delivered = stops.filter((s) => s.stop_outcome === 'Delivered');
  for (const s of delivered) {
    if (s.sheet_status !== 'Open' || s.settled_at) {
      throw new RuleViolation(`it was delivered on the ${s.zone} round of ${s.delivery_date}, which is settled. `
        + 'Raise a credit note instead');
    }
  }
  const stopIds = stops.map((s) => s.id);
  // Any payment-after-delivery stops hang off these and go with them.
  const childStops = stopIds.length ? await t.query<{ id: string; payment_amount_cents: number }>(
    `SELECT id, payment_amount_cents FROM delivery_stops WHERE after_stop_id = ANY($1::uuid[])`, [stopIds]) : [];

  type P = { id: string; receipt_number: string | null; method: string; amount_cents: number };
  const live = `p.status = 'Confirmed' AND NOT p.is_reversal
                AND NOT EXISTS (SELECT 1 FROM payments r WHERE r.reverses_payment_id = p.id)`;
  // Taken WITH it: tied to the order or its stop, or recorded in the same
  // step as its invoice (a counter sale or a sale for an earlier day writes
  // the invoice and the payment in one transaction, so they share created_at).
  const own = await t.query<P>(
    `SELECT p.id, p.receipt_number, p.method, p.amount_cents FROM payments p
     WHERE ${live} AND (p.order_id = $1 OR p.delivery_stop_id = ANY($2::uuid[])
       OR (p.customer_id = $3 AND p.created_at IN (
             SELECT created_at FROM invoices WHERE id = ANY($4::uuid[]))))`,
    [orderId, [...stopIds, ...childStops.map((c) => c.id)], order.customer_id, invoices.map((i) => i.id)],
  );
  const ownIds = new Set(own.map((p) => p.id));
  const applied = invoices.length ? (await t.query<P>(
    `SELECT p.id, p.receipt_number, p.method, p.amount_cents FROM payments p
     WHERE ${live} AND p.invoice_id = ANY($1::uuid[])`, [invoices.map((i) => i.id)],
  )).filter((p) => !ownIds.has(p.id)) : [];

  // Stock: off the shelf for a sale with no round; per stop on a round with no load.
  const stockBack = new Map<string, number>();
  let stockStaysOnTruck = false;
  if (delivered.length === 0) {
    for (const l of await deliveredBottles(t, orderId)) stockBack.set(l.productId, (stockBack.get(l.productId) ?? 0) + l.bottles);
  } else {
    for (const s of delivered) {
      if (await deliversFromTruck(t, s.delivery_sheet_id)) { stockStaysOnTruck = true; continue; }
      for (const l of await stopBottles(t, s.id)) stockBack.set(l.productId, (stockBack.get(l.productId) ?? 0) + l.bottles);
    }
  }
  const names = new Map((await t.query<{ id: string; name: string }>(
    `SELECT id, name FROM products WHERE id = ANY($1::uuid[])`, [[...stockBack.keys()]])).map((p) => [p.id, p.name]));

  const moves = await t.one<{ d: number; r: number; l: number; s: number }>(
    `SELECT COALESCE(SUM(delivered),0)::int AS d, COALESCE(SUM(returned),0)::int AS r,
            COALESCE(SUM(lost),0)::int AS l, COALESCE(SUM(sold),0)::int AS s
     FROM customer_bottle_moves WHERE order_id = $1`, [orderId]);
  const bottlesBack = {
    delivered: num(moves.d) + delivered.reduce((a, s) => a + num(s.bottles_delivered_full), 0),
    empties: num(moves.r) + delivered.reduce((a, s) => a + num(s.bottles_empties_picked_up), 0),
    lost: num(moves.l) + delivered.reduce((a, s) => a + num(s.bottles_lost_damaged), 0),
    sold: num(moves.s),
  };

  const plan: UndoPlan = {
    orderId, orderNumber: order.order_number, customerName: order.customer_name,
    invoices: invoices.map((i) => ({ id: i.id, number: i.invoice_number, totalCents: num(i.grand_total_cents) })),
    paymentsReversed: own.map((p) => ({ id: p.id, receipt: p.receipt_number, method: p.method, amountCents: num(p.amount_cents) })),
    paymentsToCredit: applied.map((p) => ({ id: p.id, receipt: p.receipt_number, method: p.method, amountCents: num(p.amount_cents) })),
    cashAtStopRemovedCents: [...stops.filter((s) => !s.settled_at), ...childStops]
      .reduce((a, s) => a + num(s.payment_amount_cents), 0),
    stockBack: [...stockBack].filter(([, b]) => b > 0)
      .map(([productId, bottles]) => ({ productId, name: names.get(productId) ?? 'Product', bottles })),
    stockStaysOnTruck,
    bottlesBack,
    roundsLeft: stops.map((s) => ({ zone: s.zone, date: s.delivery_date })),
    done: false,
  };
  return { plan, order, stops };
}

export async function undoDelivery(
  db: Db, actor: Actor, orderId: string, input: { reason?: string | null; dryRun?: boolean },
): Promise<UndoPlan> {
  requireRole(actor, 'admin');
  if (input.dryRun) return (await buildPlan(db, orderId)).plan;
  const reason = String(input.reason ?? '').trim();
  if (!reason) throw new RuleViolation('say why the delivery is being undone');

  return db.tx(async (t) => {
    await t.query(`SELECT 1 FROM customer_orders WHERE id = $1 FOR UPDATE`, [orderId]);
    const { plan, order, stops } = await buildPlan(t, orderId);
    const why = `Delivered in error, undone by ${actor.name}: ${reason}`;

    // Money taken with it: reversed. Money applied to it from elsewhere: back to credit.
    for (const p of plan.paymentsReversed) {
      const orig = await t.one<{ customer_id: string; invoice_id: string | null; method: string; status: string }>(
        `SELECT customer_id, invoice_id, method, status FROM payments WHERE id = $1`, [p.id]);
      await t.query(
        `INSERT INTO payments (customer_id, invoice_id, amount_cents, method, status, is_reversal,
                               reverses_payment_id, notes, created_by_id, receipt_number, order_id)
         VALUES ($1,$2,$3,$4,$5,true,$6,$7,$8,(SELECT receipt_number FROM payments WHERE id = $6),$9)`,
        [orig.customer_id, orig.invoice_id, -p.amountCents, orig.method, orig.status, p.id, why, actor.id, orderId]);
      await audit(t, actor, 'adjust', 'Payment', p.id, `reversal of ${p.receipt ?? p.id}`, { reason: why, amountCents: -p.amountCents });
    }
    for (const p of plan.paymentsToCredit) {
      await t.query(`UPDATE payments SET invoice_id = NULL WHERE id = $1`, [p.id]);
      await audit(t, actor, 'adjust', 'Payment', p.id, p.receipt ?? p.id, { movedToCredit: true, reason: why });
    }

    for (const inv of plan.invoices) {
      await t.query(
        `UPDATE invoices SET lifecycle = 'Cancelled', updated_at = now(),
                notes = concat_ws(E'\\n', NULLIF(notes, ''), $2::text) WHERE id = $1`, [inv.id, why]);
      await audit(t, actor, 'update', 'Invoice', inv.id, inv.number, { lifecycle: 'Cancelled', reason: why });
    }

    // Goods back on the shelf.
    for (const l of plan.stockBack) {
      await t.query(
        `INSERT INTO finished_goods_stock (product_id, quantity_on_hand) VALUES ($1, $2)
         ON CONFLICT (product_id) DO UPDATE
           SET quantity_on_hand = finished_goods_stock.quantity_on_hand + EXCLUDED.quantity_on_hand`,
        [l.productId, l.bottles]);
      await t.query(
        `INSERT INTO inventory_transactions (item_type, item_id, item_name, quantity, direction, reference, reference_type, notes)
         VALUES ('FinishedGoods',$1,$2,$3,'in',$4,'Adjustment',$5)`,
        [l.productId, l.name, l.bottles, order.order_number, why]);
    }

    // Bottles back to the pool and off the customer.
    const b = plan.bottlesBack;
    await reverseDeliveryMovement(t, actor, {
      delivered: b.delivered, emptiesPickedUp: b.empties, lostDamaged: b.lost, sold: b.sold, reference: order.order_number,
    });
    await t.query(`DELETE FROM customer_bottle_moves WHERE order_id = $1`, [orderId]);

    // Off the round (and any payment-after-delivery stops with it).
    if (stops.length) {
      await t.query(`DELETE FROM delivery_stops WHERE after_stop_id = ANY($1::uuid[])`, [stops.map((s) => s.id)]);
      await t.query(`DELETE FROM delivery_stops WHERE order_id = $1`, [orderId]);
    }

    await t.query(
      `UPDATE order_line_items SET delivered_cases = 0, delivered_loose = 0, delivered_total = 0 WHERE order_id = $1`, [orderId]);
    await t.query(`UPDATE customer_orders SET status = 'Cancelled' WHERE id = $1`, [orderId]);
    await audit(t, actor, 'update', 'CustomerOrder', orderId, order.order_number, {
      status: 'Cancelled', undoneDelivery: true, reason,
      invoicesCancelled: plan.invoices.map((i) => i.number),
      paymentsReversed: plan.paymentsReversed.length, paymentsToCredit: plan.paymentsToCredit.length,
      stockBack: plan.stockBack, bottlesBack: plan.bottlesBack,
    });
    return { ...plan, done: true };
  });
}
