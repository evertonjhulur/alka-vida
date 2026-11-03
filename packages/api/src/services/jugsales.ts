/**
 * Selling 5-gallon jugs outright (Everton, 3 Nov 2026: "Sell jugs" on the
 * customer's Bottles tab).
 *
 * A customer may buy jugs on their own, without water - Andrew Warwar kept a
 * full jug with no empty back and may buy it, or want extras. Before this the
 * bottle charge only ever went on through a 5-gallon sale short of empties.
 *
 * It bills like any sale: an invoice dated the day of the sale, money taken
 * now or left on the account, and a weekly / monthly customer gets it on the
 * period invoice instead (counter.recordPastDelivery does all of that).
 * The jugs are theirs from then on:
 *
 *   - up to what they hold of OURS, the jugs are already with them and just
 *     change hands: they come off "out with customers";
 *   - any beyond that are handed over from the plant: they come off the
 *     empties at the plant, and are recorded as handed to the customer so
 *     what they hold of ours never goes below zero.
 *
 * Office staff can date it up to `backdate_days` back, administrators any day
 * - the same rule as New sale's "It already went out on an earlier day".
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { requireRole, businessToday, audit, num } from './core.ts';
import type { Cents, PaymentMethod } from '@alka/shared';
import { RuleViolation } from '@alka/shared';
import { recordPastDelivery } from './counter.ts';
import { bottleChargeProduct } from './orders.ts';
import { bottleAccount, moveEmpties } from './bottles.ts';

export interface SellJugsInput {
  quantity: number;
  /** YYYY-MM-DD; blank = today. */
  soldOn?: string | null;
  amountPaidCents?: Cents | null;
  method?: PaymentMethod;
  reference?: string | null;
  notes?: string | null;
  idempotencyKey?: string | null;
}

export async function sellJugs(db: Db, actor: Actor, customerId: string, input: SellJugsInput) {
  requireRole(actor, 'admin', 'user');
  const qty = Math.round(Number(input.quantity));
  if (!Number.isFinite(qty) || qty <= 0) throw new RuleViolation('enter how many jugs they are buying');
  const day = (input.soldOn ?? '').trim() || businessToday();

  const c = await db.maybeOne<{ name: string; is_walk_in: boolean; active: boolean }>(
    `SELECT name, is_walk_in, active FROM customers WHERE id = $1`, [customerId]);
  if (!c) throw new RuleViolation('customer not found');
  if (c.is_walk_in) throw new RuleViolation('jugs are sold to a customer account, not the walk-in record');

  const bottle = await db.tx((t) => bottleChargeProduct(t));
  if (!bottle.active) throw new RuleViolation(`"${bottle.name}" is switched off on the Products screen`);

  // What they hold of ours on that day decides how many change hands and how
  // many come from the plant.
  const held = Math.max(0, (await bottleAccount(db, customerId, { to: day })).closingHolding);
  const fromHolding = Math.min(qty, held);
  const fromPlant = qty - fromHolding;

  const note = [
    `${qty} 5-gallon jug${qty === 1 ? '' : 's'} sold - theirs from now on`
      + (fromPlant > 0 ? ` (${fromHolding} they already had of ours, ${fromPlant} from the plant)` : ''),
    input.notes?.trim() || null,
  ].filter(Boolean).join('. ');

  const sale = await recordPastDelivery(db, actor, {
    customerId,
    lines: [{ productId: bottle.id, looseBottles: qty }],
    deliveredOn: day,
    how: 'Collected',
    amountPaidCents: input.amountPaidCents ?? 0,
    method: input.method ?? 'Cash',
    reference: input.reference ?? null,
    notes: note,
    idempotencyKey: input.idempotencyKey ?? null,
  });

  await db.tx(async (t) => {
    // A sale for today is not "recorded late".
    if (day === businessToday()) {
      await t.query(`UPDATE customer_orders SET recorded_late = false WHERE id = $1`, [sale.orderId]);
    }
    // The jugs changed hands on the day of the sale, not the day it was typed.
    await t.query(`UPDATE customer_bottle_moves SET moved_on = $2::date WHERE order_id = $1`, [sale.orderId, day]);
    if (fromPlant > 0 && !sale.replayed) {
      // Handed over from the plant: off the empties, and onto the customer so
      // the sale takes them back off again (net: theirs, none of ours).
      await t.query(
        `INSERT INTO customer_bottle_moves (customer_id, moved_on, delivered, order_id, reference, note)
         VALUES ($1, $2::date, $3, $4, $5, 'Jugs handed over from the plant, sold')`,
        [customerId, day, fromPlant, sale.orderId, sale.orderNumber],
      );
      await moveEmpties(t, -fromPlant, 'Sale', sale.orderNumber,
        `${fromPlant} jug${fromPlant === 1 ? '' : 's'} handed over to ${c.name}, sold`, { day });
    }
    await audit(t, actor, 'create', 'CustomerOrder', sale.orderId, sale.orderNumber, {
      jugsSold: qty, fromHolding, fromPlant, soldOn: day,
    });
  });

  return { ...sale, quantity: qty, fromHolding, fromPlant, soldOn: day };
}

/**
 * Undo of a jug sale (undodelivery.ts): jugs handed over from the plant go
 * back into the empties. Nothing to do for any other order.
 */
export async function returnJugsHandedOver(t: Queryable, orderNumber: string): Promise<void> {
  const r = await t.one<{ n: number }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'out' THEN quantity ELSE -quantity END), 0)::int AS n
     FROM inventory_transactions it
     WHERE it.item_type = 'RawMaterial' AND it.reference_type = 'Sale' AND it.reference = $1
       AND it.item_id IN (SELECT id FROM raw_materials WHERE is_returnable_jug)`, [orderNumber]);
  const n = num(r.n);
  if (n > 0) {
    await moveEmpties(t, n, 'Sale', orderNumber,
      `${n} jug${n === 1 ? '' : 's'} back into the empties: sale recorded in error, undone`);
  }
}
