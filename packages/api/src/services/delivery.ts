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
import { refreshOrderStatus, summariseOrderLines } from './orders.ts';
import { applyDeliveryMovement } from './bottles.ts';

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
}

export interface MarkStopResult {
  stopId: string;
  outcome: StopOutcome;
  invoiceId: string | null;
  invoiceNumber: string | null;
  /** Tax-inclusive. This is the only figure a driver is ever shown as owed. */
  amountOwedCents: Cents;
  orderStatus: string | null;
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
    }>(
      `SELECT id, order_id, customer_id, delivery_sheet_id, invoice_id, settled_at
       FROM delivery_stops WHERE id = $1`, [input.stopId],
    );
    if (!stop) throw new RuleViolation(`delivery stop ${input.stopId} not found`);

    const sheet = await t.one<{ status: string }>(
      `SELECT status FROM delivery_sheets WHERE id = $1`, [stop.delivery_sheet_id],
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

    if (input.outcome === 'Delivered' && stop.order_id) {
      await writeDeliveredQuantities(t, input.stopId, stop.order_id, input.deliveredLines);
      await moveBottlePool(t, actor, input.stopId, stop.customer_id, input);

      // An invoice is generated only here, and only once per stop.
      if (!invoiceId) {
        const created = await invoiceFromDelivery(t, actor, stop.order_id, stop.customer_id);
        invoiceId = created.id;
        invoiceNumber = created.invoiceNumber;
        await t.query(`UPDATE delivery_stops SET invoice_id = $2 WHERE id = $1`,
          [input.stopId, invoiceId]);
      }
      orderStatus = await refreshOrderStatus(t, stop.order_id);
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
             amountOwedCents, orderStatus };
  });
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
  const orderLines = await t.query<{
    id: string; product_id: string; cases: number; loose_bottles: number; bpc: number;
  }>(
    `SELECT oli.id, oli.product_id, oli.cases, oli.loose_bottles, p.bottles_per_case AS bpc
     FROM order_line_items oli JOIN products p ON p.id = oli.product_id
     WHERE oli.order_id = $1`, [orderId],
  );

  const byId = new Map(delivered?.map((d) => [d.orderLineId, d]) ?? []);

  for (const line of orderLines) {
    const explicit = byId.get(line.id);
    const bpc = num(line.bpc);
    const cases = explicit ? (explicit.cases ?? 0) : num(line.cases);
    const loose = explicit ? (explicit.looseBottles ?? 0) : num(line.loose_bottles);
    assertQuantityShape(bpc, cases, loose);
    const total = totalBottles(bpc, cases, loose);

    await t.query(
      `UPDATE order_line_items
       SET delivered_cases = $2, delivered_loose = $3, delivered_total = $4
       WHERE id = $1`,
      [line.id, cases, loose, total],
    );
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
}

/** Build the invoice from what was actually delivered, not what was ordered. */
async function invoiceFromDelivery(
  t: Queryable,
  actor: Actor,
  orderId: string,
  customerId: string,
): Promise<{ id: string; invoiceNumber: string }> {
  const lines = await t.query<{
    product_id: string; delivered_cases: number; delivered_loose: number;
    price_per_case_cents: number; price_per_bottle_cents: number;
  }>(
    `SELECT product_id, delivered_cases, delivered_loose,
            price_per_case_cents, price_per_bottle_cents
     FROM order_line_items
     WHERE order_id = $1 AND delivered_total > 0`,
    [orderId],
  );
  if (lines.length === 0) {
    throw new RuleViolation('cannot invoice a delivery with no delivered quantities');
  }

  const order = await t.one<{ discount_percent: number; order_number: string }>(
    `SELECT discount_percent, order_number FROM customer_orders WHERE id = $1`, [orderId],
  );

  return createInvoice(t, actor, {
    customerId,
    orderIds: [orderId],
    discountPercent: num(order.discount_percent),
    notes: `Delivery of ${order.order_number}`,
    lines: lines.map((l) => ({
      productId: l.product_id,
      cases: num(l.delivered_cases),
      looseBottles: num(l.delivered_loose),
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
  const row = await t.maybeOne<{ invoice_total: number | null; order_total: number | null }>(
    `SELECT i.grand_total_cents AS invoice_total,
            o.grand_total_cents AS order_total
     FROM delivery_stops s
     LEFT JOIN invoices i ON i.id = s.invoice_id
     LEFT JOIN customer_orders o ON o.id = s.order_id
     WHERE s.id = $1`,
    [stopId],
  );
  if (!row) return 0;
  return row.invoice_total !== null ? num(row.invoice_total) : num(row.order_total);
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
    `SELECT s.*, c.name AS customer_name
     FROM delivery_stops s JOIN customers c ON c.id = s.customer_id
     WHERE s.id = $1`, [stopId],
  );
  if (!stop) return null;

  const amountOwedCents = await amountOwedForStop(db, stopId);
  const otherOpenInvoices = await openInvoicesForCustomer(db, stop.customer_id as string);
  const lines = await db.query(
    `SELECT oli.id AS order_line_id, p.name AS product_name, p.bottles_per_case,
            oli.cases, oli.loose_bottles
     FROM order_line_items oli JOIN products p ON p.id = oli.product_id
     WHERE oli.order_id = $1`, [stop.order_id],
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

  return {
    ...stop,
    // Tax-inclusive, always.
    amountOwedCents,
    lines,
    openInvoices,
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
    const order = await t.one<{ customer_id: string; order_number: string; status: string }>(
      `SELECT customer_id, order_number, status FROM customer_orders WHERE id = $1`, [orderId],
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
    const customer = await t.one<{
      delivery_address: string | null; phone: string | null; route_sequence: number;
    }>(
      `SELECT delivery_address, phone, route_sequence FROM customers WHERE id = $1`,
      [order.customer_id],
    );

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
    `SELECT s.*, c.name AS customer_name
     FROM delivery_stops s JOIN customers c ON c.id = s.customer_id
     WHERE s.delivery_sheet_id = $1
     ORDER BY s.sequence_no, c.name`,
    [sheetId],
  );
  return { ...sheet, stops };
}
