/**
 * Delivery sheets and stops (Section 3, Steps 2-3; Sections 7-8).
 *
 * The two rules that broke the prior build and are enforced here:
 *
 *  1. Marking a stop Delivered ALWAYS succeeds. Payment amount, method or
 *     status can never block completing a delivery. The payment fields are
 *     recorded as given and validated nowhere in this path.
 *
 *  2. Any amount presented to the driver as owed is TAX-INCLUSIVE - the
 *     invoice grand_total once one exists, otherwise the order's own live
 *     grand_total. Never a pre-tax subtotal.
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, num, requireRole } from './core.ts';
import type { Cents, PaymentMethod, StopOutcome } from '@alka/shared';
import { RuleViolation, validateAllocation, assertQuantityShape, totalBottles } from '@alka/shared';
import { createInvoice, openInvoicesForCustomer } from './invoices.ts';
import {
  addBottleChargeLine, bottleChargeProduct, deliveryTarget, placeOnDeliverySheet, recomputeDelivered,
  refreshOrderStatus, summariseOrderLines, summariseRemaining,
} from './orders.ts';
import { applyDeliveryMovement, bottleAccount, recordBottlesSold } from './bottles.ts';
import { takeFinishedGoods, stopBottles } from './stockmoves.ts';
import { computeTotals, computeLineTotal } from '@alka/shared';
import { businessToday } from './core.ts';

export interface DeliveredLineInput {
  orderLineId: string;
  cases?: number;
  looseBottles?: number;
}

export interface MarkStopInput {
  stopId: string;
  outcome: StopOutcome;
  outcomeNotes?: string | null;
  deliveredLines?: DeliveredLineInput[];
  bottlesDeliveredFull?: number;
  bottlesEmptiesPickedUp?: number;
  bottlesLostDamaged?: number;
  paymentReceived?: boolean;
  paymentMethod?: PaymentMethod | null;
  /** Actual cash collected. Stored as-is, UNVALIDATED, reference only. */
  paymentAmountCents?: Cents;
  driverNotes?: string | null;
  signature?: string | null;
  /** "Another day": the day it should go instead, and why. */
  rescheduleTo?: string | null;
  rescheduleReason?: string | null;
  /**
   * Partially delivered (7 Oct 2026, point 9): with outcome Delivered and the
   * quantities actually handed over, the day the rest should go. The rest is
   * put on that day's round straight away; only what was handed over is
   * invoiced now.
   */
  remainderTo?: string | null;
  /**
   * 5-gallon bottles to charge at the door because fewer empties were handed
   * over than expected (point 13). Added to the order as "5-gallon bottle".
   */
  bottlesCharged?: number | null;
}

export interface MarkStopResult {
  stopId: string;
  outcome: StopOutcome;
  invoiceId: string | null;
  invoiceNumber: string | null;
  /** Tax-inclusive. This is the only figure a driver is ever shown as owed. */
  amountOwedCents: Cents;
  orderStatus: string | null;
  /** When rescheduled: the round it went on to. */
  rescheduledTo?: string | null;
  /** When part delivered: the day the rest goes. */
  remainderTo?: string | null;
}

/**
 * Record the outcome of a stop.
 *
 * When the outcome is Delivered this generates the Invoice from the ACTUAL
 * delivered quantities. Every individual delivery gets its own real invoice
 * at the moment of delivery - there is no batching or cycle-close step, and
 * recurring orders behave identically to one-off ones.
 */
export async function markStop(
  db: Db,
  actor: Actor,
  input: MarkStopInput,
): Promise<MarkStopResult> {
  return db.tx(async (t) => {
    const stop = await t.maybeOne<{
      id: string; order_id: string | null; customer_id: string;
      delivery_sheet_id: string; invoice_id: string | null; settled_at: string | null;
      stop_outcome: string;
    }>(
      `SELECT id, order_id, customer_id, delivery_sheet_id, invoice_id, settled_at, stop_outcome
       FROM delivery_stops WHERE id = $1 FOR UPDATE`, [input.stopId],
    );
    if (!stop) throw new RuleViolation(`delivery stop ${input.stopId} not found`);

    const sheet = await t.one<{ status: string; delivery_date: string }>(
      `SELECT status, delivery_date::text AS delivery_date FROM delivery_sheets WHERE id = $1`,
      [stop.delivery_sheet_id],
    );
    // Once a sheet is Completed it locks. Corrections go through the
    // reversal / reassignment / invoice-editing mechanisms instead.
    if (sheet.status === 'Completed') {
      throw new RuleViolation(
        'this route is already settled and locked; correct it through a payment ' +
        'reversal, reassignment or invoice edit rather than reopening the route',
      );
    }

    // Record what the driver reported. Payment fields are stored exactly as
    // entered and are NOT validated here - nothing about money may prevent a
    // delivery from being marked complete.
    await t.query(
      `UPDATE delivery_stops
       SET stop_outcome = $2, outcome_notes = $3,
           bottles_delivered_full = COALESCE($4, bottles_delivered_full),
           bottles_empties_picked_up = COALESCE($5, bottles_empties_picked_up),
           bottles_lost_damaged = COALESCE($6, bottles_lost_damaged),
           payment_received = COALESCE($7, payment_received),
           payment_method = COALESCE($8, payment_method),
           payment_amount_cents = COALESCE($9, payment_amount_cents),
           driver_notes = COALESCE($10, driver_notes),
           signature = COALESCE($11, signature)
       WHERE id = $1`,
      [input.stopId, input.outcome, input.outcomeNotes ?? null,
       input.bottlesDeliveredFull ?? null, input.bottlesEmptiesPickedUp ?? null,
       input.bottlesLostDamaged ?? null, input.paymentReceived ?? null,
       input.paymentMethod ?? null, input.paymentAmountCents ?? null,
       input.driverNotes ?? null, input.signature ?? null],
    );

    let invoiceId = stop.invoice_id;
    let invoiceNumber: string | null = null;
    let orderStatus: string | null = null;

    // A stop already recorded Delivered has moved its stock and bottles; doing
    // it again would move them twice.
    if (input.outcome === 'Delivered' && stop.stop_outcome === 'Delivered') {
      throw new RuleViolation(
        'this stop is already recorded as delivered. To change it, correct it on the round.',
      );
    }

    if (input.remainderTo && input.outcome !== 'Delivered') {
      throw new RuleViolation('a date for the rest only goes with a partial delivery');
    }
    if (input.outcome === 'Delivered' && !stop.order_id) {
      throw new RuleViolation('this stop has no order to deliver. Record the payment only.');
    }

    let rescheduledTo: string | null = null;
    if (input.outcome === 'Rescheduled' && stop.order_id && input.rescheduleTo) {
      rescheduledTo = await rescheduleStop(t, stop.id, stop.order_id, stop.customer_id,
        sheet.delivery_date, input.rescheduleTo, input.rescheduleReason ?? null);
    }

    let remainderTo: string | null = null;
    if (input.outcome === 'Delivered' && stop.order_id) {
      await writeDeliveredQuantities(t, input.stopId, stop.order_id, input.deliveredLines);

      // Fewer empties than expected: the bottles go on the order and on this
      // stop, so they are invoiced with what was handed over.
      const charged = Math.max(0, Math.round(Number(input.bottlesCharged) || 0));
      if (charged > 0) {
        const line = await addBottleChargeLine(t, stop.order_id, charged);
        if (line) {
          await t.query(
            `INSERT INTO delivery_stop_lines (stop_id, order_line_id, product_id, cases, loose_bottles, total_bottles)
             VALUES ($1,$2,$3,0,$4,$4)
             ON CONFLICT (stop_id, order_line_id) DO UPDATE
               SET loose_bottles = delivery_stop_lines.loose_bottles + EXCLUDED.loose_bottles,
                   total_bottles = delivery_stop_lines.total_bottles + EXCLUDED.total_bottles`,
            [input.stopId, line.orderLineId, line.productId, charged],
          );
        }
      }
      await recomputeDelivered(t, stop.order_id);

      await moveBottlePool(t, actor, input.stopId, stop.customer_id, input);
      const ref = await t.one<{ order_number: string }>(
        `SELECT order_number FROM customer_orders WHERE id = $1`, [stop.order_id],
      );
      await takeFinishedGoods(t, await stopBottles(t, input.stopId), ref.order_number,
        `Delivered on the ${sheet.delivery_date} round`);

      // Bottles bought here are the customer's from now on.
      const bottle = await bottleChargeProduct(t);
      if (bottle) {
        const sold = await t.one<{ n: number }>(
          `SELECT COALESCE(SUM(total_bottles), 0)::int AS n FROM delivery_stop_lines
           WHERE stop_id = $1 AND product_id = $2`, [input.stopId, bottle.id],
        );
        await recordBottlesSold(t, actor, {
          customerId: stop.customer_id, quantity: num(sold.n), reference: ref.order_number,
          orderId: stop.order_id, day: sheet.delivery_date,
        });
      }

      // An invoice is generated only here, and only once per stop - unless the
      // customer is billed weekly or monthly, when the delivery waits on the
      // account for the cycle invoice (cycles.ts) instead. It covers what THIS
      // stop handed over: a partial delivery is invoiced now, the rest when
      // it arrives.
      if (!invoiceId && !(await billedOnCycle(t, stop.customer_id))) {
        const created = await invoiceFromDelivery(t, actor, stop.order_id, stop.customer_id, input.stopId);
        invoiceId = created.id;
        invoiceNumber = created.invoiceNumber;
        await t.query(`UPDATE delivery_stops SET invoice_id = $2 WHERE id = $1`,
          [input.stopId, invoiceId]);
      }
      orderStatus = await refreshOrderStatus(t, stop.order_id);
      await t.query(
        `UPDATE customer_orders o SET fulfilled_on = ds.delivery_date
         FROM delivery_sheets ds WHERE o.id = $1 AND ds.id = $2`,
        [stop.order_id, stop.delivery_sheet_id],
      );

      if (input.remainderTo) {
        if (orderStatus !== 'Partially Delivered') {
          throw new RuleViolation('everything on the order was handed over, so there is nothing left '
            + 'to send another day. Press Delivered instead.');
        }
        remainderTo = await sendRemainder(t, stop.id, stop.order_id, stop.customer_id,
          sheet.delivery_date, input.remainderTo);
      }
    }

    const amountOwedCents = await amountOwedForStop(t, input.stopId);

    await audit(t, actor, 'deliver', 'DeliveryStop', input.stopId, stop.order_id ?? input.stopId, {
      outcome: input.outcome,
      invoiceId,
      paymentAmountCents: input.paymentAmountCents ?? 0,
      paymentMethod: input.paymentMethod ?? null,
    });

    if (invoiceId && !invoiceNumber) {
      const row = await t.one<{ invoice_number: string }>(
        `SELECT invoice_number FROM invoices WHERE id = $1`, [invoiceId],
      );
      invoiceNumber = row.invoice_number;
    }

    return { stopId: input.stopId, outcome: input.outcome, invoiceId, invoiceNumber,
             amountOwedCents, orderStatus, rescheduledTo, remainderTo };
  });
}

/**
 * "Another day" (team feedback, 1 Oct 2026, point 15): the driver or office
 * says which day and why. The order's delivery date moves, and it goes on
 * that day's round for its zone (made if there is none yet). This stop stays
 * on today's round marked Rescheduled, so the round still shows what happened.
 */
async function rescheduleStop(
  t: Queryable, stopId: string, orderId: string, customerId: string,
  fromDate: string, to: string, reason: string | null,
): Promise<string> {
  const day = String(to).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RuleViolation('choose the day it should go instead');
  if (day < businessToday()) throw new RuleViolation('the new day cannot be in the past');
  if (day === fromDate) throw new RuleViolation('choose a different day from this round\'s');
  const order = await t.one<{ address_id: string | null; status: string; order_number: string }>(
    `SELECT address_id, status, order_number FROM customer_orders WHERE id = $1`, [orderId],
  );
  if (order.status === 'Cancelled' || order.status === 'Delivered') {
    throw new RuleViolation(`${order.order_number} is ${order.status.toLowerCase()}`);
  }
  await t.query(
    `UPDATE delivery_stops SET rescheduled_to = $2, reschedule_reason = $3,
            outcome_notes = COALESCE(outcome_notes, $4)
     WHERE id = $1`,
    [stopId, day, reason?.trim() || null, reason?.trim() ? `Moved to ${day}: ${reason.trim()}` : `Moved to ${day}`],
  );
  await t.query(`UPDATE customer_orders SET requested_delivery_date = $2 WHERE id = $1`, [orderId, day]);
  // Already on that day's round (moved twice)? Leave it where it is.
  const there = await t.maybeOne(
    `SELECT 1 FROM delivery_stops st JOIN delivery_sheets ds ON ds.id = st.delivery_sheet_id
     WHERE st.order_id = $1 AND ds.delivery_date = $2::date AND ds.status = 'Open' AND st.id <> $3`,
    [orderId, day, stopId],
  );
  if (!there) await placeOnDeliverySheet(t, orderId, customerId, day, order.address_id);
  return day;
}

/**
 * Partially delivered (Everton, 7 Oct 2026, point 9): what was handed over
 * is already recorded and invoiced; the rest goes on the round for the day
 * the driver chose (made if there is none), and the order's delivery date
 * moves to it so the customer's screen says when.
 */
async function sendRemainder(
  t: Queryable, stopId: string, orderId: string, customerId: string, fromDate: string, to: string,
): Promise<string> {
  const day = String(to).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RuleViolation('choose the day the rest should go');
  if (day < businessToday()) throw new RuleViolation('the day for the rest cannot be in the past');
  if (day === fromDate) throw new RuleViolation('choose a later day for the rest than this round\'s');
  const order = await t.one<{ address_id: string | null }>(
    `SELECT address_id FROM customer_orders WHERE id = $1`, [orderId],
  );
  await t.query(`UPDATE delivery_stops SET remainder_to = $2 WHERE id = $1`, [stopId, day]);
  await t.query(`UPDATE customer_orders SET requested_delivery_date = $2 WHERE id = $1`, [orderId, day]);
  const there = await t.maybeOne<{ id: string }>(
    `SELECT st.id FROM delivery_stops st JOIN delivery_sheets ds ON ds.id = st.delivery_sheet_id
     WHERE st.order_id = $1 AND ds.delivery_date = $2::date AND ds.status = 'Open' AND st.id <> $3`,
    [orderId, day, stopId],
  );
  const placed = there ? { stopId: there.id }
    : await placeOnDeliverySheet(t, orderId, customerId, day, order.address_id);
  if (!placed.stopId) {
    throw new RuleViolation('the rest could not be put on a round: the customer has no delivery zone. '
      + 'Set one on the customer and add the order to that day\'s round.');
  }
  // The driver that day sees what is left, not the whole order again.
  await t.query(`UPDATE delivery_stops SET line_items_summary = $2 WHERE id = $1`,
    [placed.stopId, `Rest of order: ${await summariseRemaining(t, orderId)}`]);
  return day;
}

/**
 * Write actual delivered quantities back onto the order lines.
 * If the driver supplied no explicit quantities, the ordered quantity is
 * treated as fully delivered.
 */
async function writeDeliveredQuantities(
  t: Queryable,
  stopId: string,
  orderId: string,
  delivered: readonly DeliveredLineInput[] | undefined,
): Promise<void> {
  // What is still to come on each line: ordered, less what other stops of
  // this order have already handed over (an order can go out in parts).
  const orderLines = await t.query<{
    id: string; product_id: string; cases: number; loose_bottles: number; bpc: number;
    done_cases: number; done_loose: number;
  }>(
    `SELECT oli.id, oli.product_id, oli.cases, oli.loose_bottles, p.bottles_per_case AS bpc,
            COALESCE(d.cases, 0)::int AS done_cases, COALESCE(d.loose, 0)::int AS done_loose
     FROM order_line_items oli JOIN products p ON p.id = oli.product_id
     LEFT JOIN (
       SELECT sl.order_line_id, SUM(sl.cases) AS cases, SUM(sl.loose_bottles) AS loose
       FROM delivery_stop_lines sl JOIN delivery_stops st ON st.id = sl.stop_id
       WHERE st.order_id = $1 AND st.stop_outcome = 'Delivered' AND st.id <> $2
       GROUP BY sl.order_line_id
     ) d ON d.order_line_id = oli.id
     WHERE oli.order_id = $1`, [orderId, stopId],
  );

  const byId = new Map(delivered?.map((d) => [d.orderLineId, d]) ?? []);

  for (const line of orderLines) {
    const explicit = byId.get(line.id);
    const bpc = num(line.bpc);
    const cases = explicit ? (explicit.cases ?? 0)
      : Math.max(num(line.cases) - num(line.done_cases), 0);
    const loose = explicit ? (explicit.looseBottles ?? 0)
      : Math.max(num(line.loose_bottles) - num(line.done_loose), 0);
    assertQuantityShape(bpc, cases, loose);
    const total = totalBottles(bpc, cases, loose);

    await t.query(
      `INSERT INTO delivery_stop_lines
         (stop_id, order_line_id, product_id, cases, loose_bottles, total_bottles)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (stop_id, order_line_id) DO UPDATE
         SET cases = EXCLUDED.cases, loose_bottles = EXCLUDED.loose_bottles,
             total_bottles = EXCLUDED.total_bottles`,
      [stopId, line.id, line.product_id, cases, loose, total],
    );
  }
  // The order's own delivered figures are recounted from its stops by the
  // caller (recomputeDelivered), once any bottle charge is on the stop too.
}

/** Is this customer invoiced once a week or month rather than per delivery? */
export async function billedOnCycle(t: Queryable, customerId: string): Promise<boolean> {
  const c = await t.one<{ invoice_cycle: string }>(
    `SELECT invoice_cycle FROM customers WHERE id = $1`, [customerId],
  );
  return c.invoice_cycle === 'Weekly' || c.invoice_cycle === 'Monthly';
}

/**
 * Build the invoice from what THIS stop actually handed over, not what was
 * ordered - and not the order's running total either, since an order can go
 * out over two stops (point 9) and each part is invoiced once.
 *
 * A fixed-amount discount comes off once per order: on the first invoice
 * raised from it. A percentage applies to each part.
 */
async function invoiceFromDelivery(
  t: Queryable,
  actor: Actor,
  orderId: string,
  customerId: string,
  stopId: string,
): Promise<{ id: string; invoiceNumber: string }> {
  const lines = await t.query<{
    product_id: string; cases: number; loose_bottles: number;
    price_per_case_cents: number; price_per_bottle_cents: number;
  }>(
    `SELECT sl.product_id, sl.cases, sl.loose_bottles,
            oli.price_per_case_cents, oli.price_per_bottle_cents
     FROM delivery_stop_lines sl JOIN order_line_items oli ON oli.id = sl.order_line_id
     WHERE sl.stop_id = $1 AND sl.total_bottles > 0`,
    [stopId],
  );
  if (lines.length === 0) {
    throw new RuleViolation('cannot invoice a delivery with no delivered quantities');
  }

  const order = await t.one<{
    discount_percent: number; order_number: string; discount_fixed_cents: number; gct_exempt: boolean;
  }>(
    `SELECT discount_percent, order_number, discount_fixed_cents, gct_exempt
     FROM customer_orders WHERE id = $1`, [orderId],
  );
  const invoicedBefore = await t.maybeOne(
    `SELECT 1 FROM invoice_orders io JOIN invoices i ON i.id = io.invoice_id
     WHERE io.order_id = $1 AND NOT i.is_credit_note AND i.lifecycle <> 'Cancelled'`, [orderId],
  );

  return createInvoice(t, actor, {
    customerId,
    orderIds: [orderId],
    discountPercent: num(order.discount_percent),
    discountFixedCents: invoicedBefore ? 0 : num(order.discount_fixed_cents),
    gctExempt: order.gct_exempt,
    notes: invoicedBefore ? `Delivery of ${order.order_number} (the rest)` : `Delivery of ${order.order_number}`,
    lines: lines.map((l) => ({
      productId: l.product_id,
      cases: num(l.cases),
      looseBottles: num(l.loose_bottles),
      pricePerCaseCents: num(l.price_per_case_cents),
      pricePerBottleCents: num(l.price_per_bottle_cents),
    })),
  });
}

/**
 * Move the 5-gallon bottle pool for this stop.
 *
 * Delegates to the pool service so the movement is recorded in the stock
 * ledger as well as in the running totals. A loss is a BUSINESS LOSS and
 * never produces an invoice line.
 */
async function moveBottlePool(
  t: Queryable,
  actor: Actor,
  stopId: string,
  customerId: string,
  input: MarkStopInput,
): Promise<void> {
  const customer = await t.maybeOne<{ name: string }>(
    `SELECT name FROM customers WHERE id = $1`, [customerId],
  );
  await applyDeliveryMovement(t, actor, {
    delivered: input.bottlesDeliveredFull,
    emptiesPickedUp: input.bottlesEmptiesPickedUp,
    lostDamaged: input.bottlesLostDamaged,
    reference: `Stop ${stopId}`,
    customerName: customer?.name,
  });
}

/**
 * The amount to show a driver as owed for a stop. ALWAYS tax-inclusive.
 * Prefers the invoice grand_total; falls back to the order's own live
 * grand_total when no invoice exists yet. Never returns a subtotal.
 */
export async function amountOwedForStop(t: Queryable, stopId: string): Promise<Cents> {
  const row = await t.maybeOne<{
    invoice_total: number | null; order_total: number | null; order_id: string | null;
    outcome: string; part: boolean;
  }>(
    `SELECT i.grand_total_cents AS invoice_total,
            o.grand_total_cents AS order_total, s.order_id, s.stop_outcome AS outcome,
            -- Another stop of this order has already delivered part of it.
            EXISTS (SELECT 1 FROM delivery_stops x WHERE x.order_id = s.order_id
                     AND x.id <> s.id AND x.stop_outcome = 'Delivered') AS part
     FROM delivery_stops s
     LEFT JOIN invoices i ON i.id = s.invoice_id
     LEFT JOIN customer_orders o ON o.id = s.order_id
     WHERE s.id = $1`,
    [stopId],
  );
  if (!row) return 0;
  if (row.invoice_total !== null) return num(row.invoice_total);
  if (!row.order_id) return 0;
  // The rest of a part-delivered order: what is left, at the order's prices.
  if (row.part && row.outcome !== 'Delivered') return remainingValue(t, row.order_id);
  return num(row.order_total);
}

/** What the undelivered part of an order comes to, tax-inclusive. */
export async function remainingValue(t: Queryable, orderId: string): Promise<Cents> {
  const o = await t.one<{ discount_percent: number; gct_exempt: boolean }>(
    `SELECT discount_percent, gct_exempt FROM customer_orders WHERE id = $1`, [orderId],
  );
  const lines = await t.query<{ bpc: number; cases: number; loose: number; ppc: number; ppb: number }>(
    `SELECT p.bottles_per_case AS bpc,
            GREATEST(oli.cases - oli.delivered_cases, 0) AS cases,
            GREATEST(oli.loose_bottles - oli.delivered_loose, 0) AS loose,
            oli.price_per_case_cents AS ppc, oli.price_per_bottle_cents AS ppb
     FROM order_line_items oli JOIN products p ON p.id = oli.product_id
     WHERE oli.order_id = $1`, [orderId],
  );
  const priced = lines.map((l) => ({
    lineTotal: computeLineTotal({
      bottlesPerCase: num(l.bpc), cases: num(l.bpc) > 0 ? num(l.cases) : 0,
      looseBottles: num(l.bpc) > 0 ? 0 : num(l.loose), pricePerCase: num(l.ppc), pricePerBottle: num(l.ppb),
    }),
  }));
  // A fixed discount went on the first part's invoice; a percentage applies again.
  return computeTotals(priced, num(o.discount_percent), !o.gct_exempt, 0).grandTotal;
}

/**
 * A payment taken at a stop where nothing was delivered (Everton, 7 Oct
 * 2026, point 10). The driver adds the customer to their round as a
 * "Payment only" stop with what they took. Like round cash it is only a
 * record until the office settles the round, which is when it becomes a real
 * payment on the customer's account (settlement.ts, the one place that
 * happens).
 */
export async function addPaymentStop(
  db: Db, actor: Actor, sheetId: string,
  input: { customerId: string; method?: PaymentMethod | null; amountCents: Cents; notes?: string | null },
): Promise<{ stopId: string }> {
  requireRole(actor, 'admin', 'user', 'driver');
  const amount = Math.round(Number(input.amountCents) || 0);
  if (!(amount > 0)) throw new RuleViolation('enter how much they paid');
  const method = (input.method || 'Cash') as PaymentMethod;
  return db.tx(async (t) => {
    const sheet = await t.maybeOne<{ status: string; assigned_driver_id: string | null }>(
      `SELECT status, assigned_driver_id FROM delivery_sheets WHERE id = $1`, [sheetId],
    );
    if (!sheet) throw new RuleViolation('that round no longer exists');
    if (sheet.status !== 'Open') throw new RuleViolation('this round is settled; take the payment in the office instead');
    if (actor.role === 'driver' && sheet.assigned_driver_id && sheet.assigned_driver_id !== actor.id) {
      throw new RuleViolation('this is not your round');
    }
    const c = await t.maybeOne<{ name: string; phone: string | null; delivery_address: string | null; route_sequence: number; active: boolean }>(
      `SELECT name, phone, delivery_address, route_sequence, active FROM customers WHERE id = $1`, [input.customerId],
    );
    if (!c || !c.active) throw new RuleViolation('choose the customer who paid');
    const stop = await t.one<{ id: string }>(
      `INSERT INTO delivery_stops
         (delivery_sheet_id, customer_id, order_id, delivery_address, contact_phone, order_ref,
          line_items_summary, sequence_no, stop_outcome, outcome_notes, payment_received,
          payment_method, payment_amount_cents, driver_notes, payment_only)
       VALUES ($1,$2,NULL,$3,$4,NULL,'Payment only - nothing delivered',$5,'Payment Only',$6,true,$7,$8,$6,true)
       RETURNING id`,
      [sheetId, input.customerId, c.delivery_address, c.phone, num(c.route_sequence),
       input.notes?.trim() || null, method, amount],
    );
    await audit(t, actor, 'update', 'DeliverySheet', sheetId, c.name, {
      paymentOnlyStop: stop.id, amountCents: amount, method, waitsForSettlement: true,
    });
    return { stopId: stop.id };
  });
}

/** Customers a driver can pick for a payment-only stop: name, zone, what they owe. */
export async function customersForDriver(db: Db) {
  return db.query(
    `SELECT c.id, c.name, c.delivery_zone, c.phone, COALESCE(b.balance_cents, 0)::bigint AS balance_cents
     FROM customers c LEFT JOIN customer_balances b ON b.customer_id = c.id
     WHERE c.active AND NOT c.is_walk_in ORDER BY c.name`,
  );
}

/**
 * Save the driver's provisional allocation of collected cash.
 *
 * PROVISIONAL ONLY: creates no Payment and changes no balance. The narrow
 * constraint - allocated total may not exceed cash collected - is enforced
 * here and ONLY here, inside the allocation inputs. It is deliberately not
 * reachable from markStop, so it can never block completing a delivery.
 */
export async function saveStopAllocation(
  db: Db,
  actor: Actor,
  stopId: string,
  allocations: ReadonlyArray<{ invoiceId: string; amountCents: Cents }>,
): Promise<void> {
  await db.tx(async (t) => {
    const stop = await t.one<{ payment_amount_cents: number; settled_at: string | null }>(
      `SELECT payment_amount_cents, settled_at FROM delivery_stops WHERE id = $1`, [stopId],
    );
    if (stop.settled_at) throw new RuleViolation('this stop has already been settled');

    const check = validateAllocation(num(stop.payment_amount_cents), allocations);
    if (!check.ok) throw new RuleViolation(check.error);

    await t.query(`DELETE FROM delivery_stop_allocations WHERE stop_id = $1`, [stopId]);
    for (const a of allocations) {
      await t.query(
        `INSERT INTO delivery_stop_allocations (stop_id, invoice_id, amount_cents)
         VALUES ($1,$2,$3)`,
        [stopId, a.invoiceId, a.amountCents],
      );
    }
    await audit(t, actor, 'update', 'DeliveryStop', stopId, stopId, {
      provisionalAllocation: allocations, createsPayments: false,
    });
  });
}

/** What the driver's app shows for a stop, including allocatable invoices. */
export async function getStopForDriver(db: Db, stopId: string) {
  const stop = await db.maybeOne<Record<string, unknown>>(
    // Where the stop sits on its round ("Stop 3 of 5", same order as the
    // round page), the customer's terms, and their standing notes.
    `SELECT s.*, c.name AS customer_name, c.payment_terms, c.notes AS customer_notes, c.invoice_cycle,
            COALESCE(ca.delivery_instructions, c.delivery_instructions) AS delivery_instructions,
            o.notes AS order_notes, o.customer_po, o.requested_delivery_date::text AS order_date_wanted,
            o.empties_expected, o.status AS order_status,
            d.zone AS sheet_zone, d.delivery_date::text AS sheet_date,
            (SELECT COUNT(*) FROM delivery_stops x
              WHERE x.delivery_sheet_id = s.delivery_sheet_id)::int AS stop_count,
            (SELECT COUNT(*) FROM delivery_stops x JOIN customers xc ON xc.id = x.customer_id
              WHERE x.delivery_sheet_id = s.delivery_sheet_id
                AND (x.sequence_no < s.sequence_no
                     OR (x.sequence_no = s.sequence_no AND xc.name <= c.name)))::int AS stop_position
     FROM delivery_stops s JOIN customers c ON c.id = s.customer_id
     JOIN delivery_sheets d ON d.id = s.delivery_sheet_id
     LEFT JOIN customer_orders o ON o.id = s.order_id
     LEFT JOIN customer_addresses ca ON ca.id = o.address_id
     WHERE s.id = $1`, [stopId],
  );
  if (!stop) return null;

  const amountOwedCents = await amountOwedForStop(db, stopId);
  const otherOpenInvoices = await openInvoicesForCustomer(db, stop.customer_id as string);
  const lines = await db.query(
    // is_returnable and total_bottles come along so the driver's screen can
    // fill the bottles-delivered box from the order rather than relying on
    // somebody remembering to type a number the system already knows.
    //
    // cases / loose_bottles are what is still to come at THIS stop: ordered,
    // less what an earlier part delivery of the same order handed over.
    `SELECT oli.id AS order_line_id, p.name AS product_name, p.bottles_per_case,
            p.is_returnable, p.is_bottle_charge, oli.total_bottles,
            GREATEST(oli.cases - COALESCE(d.cases, 0), 0)::int AS cases,
            GREATEST(oli.loose_bottles - COALESCE(d.loose, 0), 0)::int AS loose_bottles,
            oli.cases AS ordered_cases, oli.loose_bottles AS ordered_loose
     FROM order_line_items oli JOIN products p ON p.id = oli.product_id
     LEFT JOIN (
       SELECT sl.order_line_id, SUM(sl.cases) AS cases, SUM(sl.loose_bottles) AS loose
       FROM delivery_stop_lines sl JOIN delivery_stops st ON st.id = sl.stop_id
       WHERE st.order_id = $1 AND st.stop_outcome = 'Delivered' AND st.id <> $2
       GROUP BY sl.order_line_id
     ) d ON d.order_line_id = oli.id
     WHERE oli.order_id = $1
     ORDER BY p.is_bottle_charge, p.name`, [stop.order_id, stopId],
  );

  /*
   * EVERY open invoice, this delivery's included and listed first.
   *
   * It used to be filtered out, on the reasoning that the office would settle
   * today's delivery separately. The effect was that a driver handed $5,000
   * for $3,864 of water could only offer the cash to OLDER invoices - so the
   * delivery the money was actually for went down unpaid, and whatever the
   * driver did not allocate became a payment attached to no invoice at all.
   * The customer at the door is paying for today first.
   */
  const openInvoices = otherOpenInvoices
    .map((i) => ({ ...i, isThisDelivery: i.invoiceId === stop.invoice_id }))
    .sort((a, b) => Number(b.isThisDelivery) - Number(a.isThisDelivery));

  // How many of our 5-gallon bottles they are holding, so the driver's
  // screen can expect the empties back (an exchange) rather than assume none.
  const bottlesHeld = (await bottleAccount(db, stop.customer_id as string)).closingHolding;

  // The 5-gallon bottle itself, for the "add the bottle charge" button when
  // fewer empties come back than expected (point 13).
  const bottle = (lines as Array<{ is_returnable: boolean }>).some((l) => l.is_returnable)
    ? await bottleChargeProduct(db) : null;
  const balance = await db.one<{ b: number }>(
    `SELECT COALESCE((SELECT balance_cents FROM customer_balances WHERE customer_id = $1), 0)::bigint AS b`,
    [stop.customer_id],
  );

  return {
    ...stop,
    // Tax-inclusive, always.
    amountOwedCents,
    lines,
    openInvoices,
    bottlesHeld,
    accountBalanceCents: num(balance.b),
    bottleCharge: bottle?.active
      ? { productId: bottle.id, name: bottle.name, priceCents: num(bottle.price_per_bottle_cents) } : null,
  };
}

/** Manually add an order onto an OPEN sheet that auto-routing missed. */
export async function addOrderToSheet(
  db: Db,
  actor: Actor,
  sheetId: string,
  orderId: string,
): Promise<{ stopId: string }> {
  requireRole(actor, 'admin', 'user');
  return db.tx(async (t) => {
    const sheet = await t.one<{ status: string }>(
      `SELECT status FROM delivery_sheets WHERE id = $1`, [sheetId],
    );
    if (sheet.status !== 'Open') {
      throw new RuleViolation('orders can only be added to an Open delivery sheet');
    }
    const order = await t.one<{
      customer_id: string; order_number: string; status: string; address_id: string | null;
    }>(
      `SELECT customer_id, order_number, status, address_id FROM customer_orders WHERE id = $1`,
      [orderId],
    );
    if (order.status === 'Delivered' || order.status === 'Cancelled') {
      throw new RuleViolation(
        `${order.order_number} is ${order.status.toLowerCase()} and cannot be added to a route`,
      );
    }

    // The same order sitting on two open sheets gets delivered twice and
    // invoiced twice. The table's UNIQUE (sheet, order) only stops that
    // within ONE sheet, so the cross-sheet check has to happen here.
    const elsewhere = await t.maybeOne<{ zone: string; delivery_date: string }>(
      `SELECT ds.zone, ds.delivery_date::text AS delivery_date
       FROM delivery_stops st JOIN delivery_sheets ds ON ds.id = st.delivery_sheet_id
       WHERE st.order_id = $1 AND st.delivery_sheet_id <> $2 AND ds.status = 'Open'`,
      [orderId, sheetId],
    );
    if (elsewhere) {
      throw new RuleViolation(
        `${order.order_number} is already on the ${elsewhere.zone} route for ` +
        `${elsewhere.delivery_date}. Take it off that route first.`,
      );
    }
    const customer = await deliveryTarget(t, order.customer_id, order.address_id);

    // Without this the driver gets a stop with no idea what to put on the
    // van - the auto-routed path has always filled it, the manual one did not.
    const summary = await summariseOrderLines(t, orderId);

    const stop = await t.one<{ id: string }>(
      `INSERT INTO delivery_stops
         (delivery_sheet_id, customer_id, order_id, delivery_address,
          contact_phone, order_ref, line_items_summary, sequence_no)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [sheetId, order.customer_id, orderId, customer.delivery_address,
       customer.phone, order.order_number, summary, customer.route_sequence],
    );
    await audit(t, actor, 'update', 'DeliverySheet', sheetId, sheetId, {
      addedOrderId: orderId, manual: true,
    });
    return { stopId: stop.id };
  });
}

/** Reorder stops within a sheet (one-off exceptions to the zone template). */
export async function resequenceStops(
  db: Db,
  actor: Actor,
  sheetId: string,
  order: ReadonlyArray<{ stopId: string; sequenceNo: number }>,
): Promise<void> {
  await db.tx(async (t) => {
    for (const s of order) {
      await t.query(
        `UPDATE delivery_stops SET sequence_no = $2
         WHERE id = $1 AND delivery_sheet_id = $3`,
        [s.stopId, s.sequenceNo, sheetId],
      );
    }
    await audit(t, actor, 'update', 'DeliverySheet', sheetId, sheetId, { resequenced: order });
  });
}

export async function getSheet(db: Db, sheetId: string) {
  const sheet = await db.maybeOne(`SELECT * FROM delivery_sheets WHERE id = $1`, [sheetId]);
  if (!sheet) return null;
  const stops = await db.query(
    `SELECT s.*, c.name AS customer_name,
            o.grand_total_cents AS order_total_cents, o.delivery_mode,
            o.notes AS order_notes, o.customer_po,
            COALESCE(ca.delivery_instructions, c.delivery_instructions) AS delivery_instructions,
            i.invoice_number
     FROM delivery_stops s JOIN customers c ON c.id = s.customer_id
     LEFT JOIN customer_orders o ON o.id = s.order_id
     LEFT JOIN customer_addresses ca ON ca.id = o.address_id
     LEFT JOIN invoices i ON i.id = s.invoice_id
     WHERE s.delivery_sheet_id = $1
     ORDER BY s.sequence_no, c.name`,
    [sheetId],
  );
  return { ...sheet, stops };
}
