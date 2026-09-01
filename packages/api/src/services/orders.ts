/**
 * Customer orders (Section 3, Step 1).
 *
 * An Order is a commitment to fulfil, NOT a bill. No Invoice is created here
 * under any circumstance - invoicing happens at actual delivery.
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, businessToday, nextNumber, num, requireRole } from './core.ts';
import type { Cents, DeliveryMode, PaymentMethod, RecurrencePattern } from '@alka/shared';
import { computeTotals, computeLineTotal, totalBottles, RuleViolation } from '@alka/shared';

export interface OrderLineInput {
  productId: string;
  cases?: number;
  looseBottles?: number;
  /** Optional override; otherwise resolved from the customer price tier. */
  pricePerCaseCents?: Cents;
  pricePerBottleCents?: Cents;
}

export interface CreateOrderInput {
  customerId: string;
  lines: OrderLineInput[];
  deliveryMode: DeliveryMode;
  requestedDeliveryDate?: string | null;
  orderDate?: string;
  discountPercent?: number;
  paymentMethod?: PaymentMethod | null;
  notes?: string | null;
  source?: 'Admin' | 'Portal';
  isRecurring?: boolean;
  recurrencePattern?: RecurrencePattern | null;
  parentRecurringId?: string | null;
}

export interface CreateOrderResult {
  id: string;
  orderNumber: string;
  subtotalCents: Cents;
  discountAmountCents: Cents;
  gctCents: Cents;
  grandTotalCents: Cents;
  deliverySheetId: string | null;
  deliveryStopId: string | null;
  /** Non-fatal advisories, e.g. a missing delivery zone. */
  warnings: string[];
}

interface ResolvedLine {
  productId: string;
  bottlesPerCase: number;
  cases: number;
  looseBottles: number;
  totalBottles: number;
  pricePerCaseCents: Cents;
  pricePerBottleCents: Cents;
  priceTier: string | null;
  lineTotal: Cents;
}

/**
 * Resolve the price for each line from the customer's tier, honouring any
 * explicit override, and enforce the case-vs-bottle rule.
 *
 * Tier prices are LOCKED IN onto the order line at creation, so a later
 * price-list change never rewrites an existing order.
 */
export async function resolveLines(
  t: Queryable,
  customerId: string,
  lines: readonly OrderLineInput[],
): Promise<ResolvedLine[]> {
  if (lines.length === 0) throw new RuleViolation('an order must have at least one line');

  const customer = await t.maybeOne<{ price_tier_id: string | null; active: boolean; name: string }>(
    `SELECT price_tier_id, active, name FROM customers WHERE id = $1`,
    [customerId],
  );
  if (!customer) throw new RuleViolation(`customer ${customerId} not found`);
  if (!customer.active) {
    throw new RuleViolation(
      `${customer.name} is inactive (merged away) and cannot be selected for new orders`,
    );
  }

  const resolved: ResolvedLine[] = [];
  for (const line of lines) {
    const product = await t.maybeOne<{
      id: string; bottles_per_case: number;
      price_per_case_cents: number; price_per_bottle_cents: number; active: boolean; name: string;
    }>(
      `SELECT id, bottles_per_case, price_per_case_cents, price_per_bottle_cents, active, name
       FROM products WHERE id = $1`,
      [line.productId],
    );
    if (!product) throw new RuleViolation(`product ${line.productId} not found`);
    if (!product.active) throw new RuleViolation(`product ${product.name} is no longer sold`);

    const tierPrice = customer.price_tier_id
      ? await t.maybeOne<{ price_per_case_cents: number; price_per_bottle_cents: number; tier: string }>(
          `SELECT pl.price_per_case_cents, pl.price_per_bottle_cents, pt.name AS tier
           FROM price_lists pl JOIN price_tiers pt ON pt.id = pl.price_tier_id
           WHERE pl.price_tier_id = $1 AND pl.product_id = $2`,
          [customer.price_tier_id, line.productId],
        )
      : null;

    // Precedence: explicit override > customer tier rate > product list price.
    const pricePerCaseCents = line.pricePerCaseCents
      ?? tierPrice?.price_per_case_cents
      ?? product.price_per_case_cents;
    const pricePerBottleCents = line.pricePerBottleCents
      ?? tierPrice?.price_per_bottle_cents
      ?? product.price_per_bottle_cents;

    const cases = line.cases ?? 0;
    const looseBottles = line.looseBottles ?? 0;

    const lineTotal = computeLineTotal({
      bottlesPerCase: product.bottles_per_case,
      cases, looseBottles,
      pricePerCase: pricePerCaseCents,
      pricePerBottle: pricePerBottleCents,
    });

    resolved.push({
      productId: product.id,
      bottlesPerCase: product.bottles_per_case,
      cases, looseBottles,
      totalBottles: totalBottles(product.bottles_per_case, cases, looseBottles),
      pricePerCaseCents, pricePerBottleCents,
      priceTier: tierPrice?.tier ?? null,
      lineTotal,
    });
  }
  return resolved;
}

export async function createOrder(
  db: Db,
  actor: Actor,
  input: CreateOrderInput,
): Promise<CreateOrderResult> {
  return db.tx(async (t) => {
    const warnings: string[] = [];
    const lines = await resolveLines(t, input.customerId, input.lines);

    // Order totals are calculated live at entry, mirroring the invoice
    // calculation exactly, so staff and customer see a real tax-inclusive
    // expected total immediately. This is REFERENCE ONLY - the invoice
    // generated at delivery recalculates from actual delivered quantities.
    const totals = computeTotals(lines, input.discountPercent ?? 0);
    const orderNumber = await nextNumber(t, 'order_number_seq', 'SO');

    const order = await t.one<{ id: string }>(
      `INSERT INTO customer_orders
         (order_number, customer_id, order_date, requested_delivery_date, notes,
          is_recurring, recurrence_pattern, parent_recurring_id, payment_method,
          source, delivery_mode, discount_percent,
          subtotal_cents, discount_amount_cents, gct_cents, grand_total_cents)
       VALUES ($1,$2,COALESCE($3::date, business_today()),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id`,
      [
        orderNumber, input.customerId, input.orderDate ?? null,
        input.requestedDeliveryDate ?? null, input.notes ?? null,
        input.isRecurring ?? false, input.recurrencePattern ?? null,
        input.parentRecurringId ?? null, input.paymentMethod ?? null,
        input.source ?? 'Admin', input.deliveryMode, input.discountPercent ?? 0,
        totals.subtotal, totals.discountAmount, totals.gct, totals.grandTotal,
      ],
    );

    for (const l of lines) {
      await t.query(
        `INSERT INTO order_line_items
           (order_id, product_id, cases, loose_bottles, total_bottles,
            price_per_case_cents, price_per_bottle_cents, price_tier)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [order.id, l.productId, l.cases, l.looseBottles, l.totalBottles,
         l.pricePerCaseCents, l.pricePerBottleCents, l.priceTier],
      );
    }

    let sheetId: string | null = null;
    let stopId: string | null = null;

    // Auto-place onto a delivery sheet. Applies IDENTICALLY to one-off and
    // recurring orders. Pickup orders never touch a delivery sheet at all.
    if (input.deliveryMode === 'Delivery') {
      const placement = await placeOnDeliverySheet(t, order.id, input.customerId,
        input.requestedDeliveryDate ?? null);
      sheetId = placement.sheetId;
      stopId = placement.stopId;
      warnings.push(...placement.warnings);
    }

    await audit(t, actor, 'create', 'CustomerOrder', order.id, orderNumber, {
      customerId: input.customerId,
      deliveryMode: input.deliveryMode,
      grandTotalCents: totals.grandTotal,
      deliverySheetId: sheetId,
    });

    return {
      id: order.id, orderNumber,
      subtotalCents: totals.subtotal,
      discountAmountCents: totals.discountAmount,
      gctCents: totals.gct,
      grandTotalCents: totals.grandTotal,
      deliverySheetId: sheetId, deliveryStopId: stopId, warnings,
    };
  });
}

/**
 * Place an order as a stop on the delivery sheet matching the customer's zone
 * and the requested date, creating that sheet if it does not exist.
 *
 * If a matching sheet exists but is already Completed we do NOT attach to it;
 * a new Open sheet is created instead, so a late order can never be added to
 * a route that has already been settled and locked.
 */
export async function placeOnDeliverySheet(
  t: Queryable,
  orderId: string,
  customerId: string,
  requestedDate: string | null,
): Promise<{ sheetId: string | null; stopId: string | null; warnings: string[] }> {
  const warnings: string[] = [];
  const customer = await t.one<{
    name: string; delivery_zone: string | null; delivery_address: string | null;
    phone: string | null; route_sequence: number;
  }>(
    `SELECT name, delivery_zone, delivery_address, phone, route_sequence
     FROM customers WHERE id = $1`,
    [customerId],
  );

  // Warn rather than silently proceeding, so the office is prompted to set one.
  if (!customer.delivery_zone) {
    warnings.push(
      `${customer.name} has no delivery zone set, so this order could not be auto-routed. ` +
      `Set a delivery zone on the customer, or add the order to a sheet manually.`,
    );
    return { sheetId: null, stopId: null, warnings };
  }

  const date = requestedDate ?? businessToday();

  // The partial unique index permits only one OPEN sheet per (date, zone), so
  // this either finds the live sheet or creates it.
  let sheet = await t.maybeOne<{ id: string }>(
    `SELECT id FROM delivery_sheets
     WHERE delivery_date = $1::date AND zone = $2 AND status = 'Open'`,
    [date, customer.delivery_zone],
  );
  if (!sheet) {
    sheet = await t.one<{ id: string }>(
      `INSERT INTO delivery_sheets (delivery_date, zone) VALUES ($1::date, $2) RETURNING id`,
      [date, customer.delivery_zone],
    );
  }

  const orderRef = await t.one<{ order_number: string }>(
    `SELECT order_number FROM customer_orders WHERE id = $1`, [orderId],
  );
  const summary = await summariseOrderLines(t, orderId);

  const stop = await t.one<{ id: string }>(
    `INSERT INTO delivery_stops
       (delivery_sheet_id, customer_id, order_id, delivery_address, contact_phone,
        order_ref, line_items_summary, sequence_no)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [sheet.id, customerId, orderId, customer.delivery_address, customer.phone,
     orderRef.order_number, summary, customer.route_sequence],
  );

  return { sheetId: sheet.id, stopId: stop.id, warnings };
}

export async function summariseOrderLines(t: Queryable, orderId: string): Promise<string> {
  const rows = await t.query<{ name: string; cases: number; loose_bottles: number; bpc: number }>(
    `SELECT p.name, oli.cases, oli.loose_bottles, p.bottles_per_case AS bpc
     FROM order_line_items oli JOIN products p ON p.id = oli.product_id
     WHERE oli.order_id = $1`,
    [orderId],
  );
  return rows
    .map((r) => (num(r.bpc) > 0 ? `${r.cases} cs ${r.name}` : `${r.loose_bottles} x ${r.name}`))
    .join(', ');
}

/**
 * Edit an order that has not been delivered yet.
 *
 * Only a Pending order can be changed. Once any of it has been delivered the
 * quantities are historical fact and an invoice exists against them, so the
 * correction belongs on the invoice (Section 5) rather than on the order -
 * editing the order at that point would silently disagree with what the
 * customer was billed.
 *
 * Re-resolves prices and totals, and re-summarises the delivery stop so the
 * driver sees the change.
 */
export async function editOrder(
  db: Db,
  actor: Actor,
  orderId: string,
  changes: {
    lines?: OrderLineInput[];
    requestedDeliveryDate?: string | null;
    discountPercent?: number;
    notes?: string | null;
  },
): Promise<{ subtotalCents: Cents; gctCents: Cents; grandTotalCents: Cents; warnings: string[] }> {
  requireRole(actor, 'admin', 'user');

  return db.tx(async (t) => {
    const order = await t.maybeOne<{
      id: string; customer_id: string; status: string; order_number: string;
      discount_percent: number; requested_delivery_date: string | null;
    }>(
      `SELECT id, customer_id, status, order_number, discount_percent,
              requested_delivery_date
       FROM customer_orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    if (!order) throw new RuleViolation(`order ${orderId} not found`);
    if (order.status === 'Cancelled') throw new RuleViolation('this order was cancelled');
    if (order.status !== 'Pending') {
      throw new RuleViolation(
        `this order is already ${order.status.toLowerCase()}. Correct the invoice ` +
        `instead - editing a delivered order would disagree with what was billed`,
      );
    }

    const warnings: string[] = [];
    const lines = changes.lines
      ? await resolveLines(t, order.customer_id, changes.lines)
      : null;

    if (lines) {
      await t.query(`DELETE FROM order_line_items WHERE order_id = $1`, [orderId]);
      for (const l of lines) {
        await t.query(
          `INSERT INTO order_line_items
             (order_id, product_id, cases, loose_bottles, total_bottles,
              price_per_case_cents, price_per_bottle_cents, price_tier)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [orderId, l.productId, l.cases, l.looseBottles, l.totalBottles,
           l.pricePerCaseCents, l.pricePerBottleCents, l.priceTier],
        );
      }
    }

    // Recalculate from whatever the lines now are, using the same shared
    // calculation as invoicing.
    const current = await t.query<{ line_total: number }>(
      `SELECT CASE WHEN p.bottles_per_case > 0
                   THEN oli.cases * oli.price_per_case_cents
                   ELSE oli.loose_bottles * oli.price_per_bottle_cents END AS line_total
       FROM order_line_items oli JOIN products p ON p.id = oli.product_id
       WHERE oli.order_id = $1`,
      [orderId],
    );
    const discountPercent = changes.discountPercent ?? num(order.discount_percent);
    const totals = computeTotals(
      current.map((l) => ({ lineTotal: num(l.line_total) })), discountPercent,
    );

    await t.query(
      `UPDATE customer_orders
       SET requested_delivery_date = COALESCE($2::date, requested_delivery_date),
           discount_percent = $3, notes = COALESCE($4, notes),
           subtotal_cents = $5, discount_amount_cents = $6,
           gct_cents = $7, grand_total_cents = $8
       WHERE id = $1`,
      [orderId, changes.requestedDeliveryDate ?? null, discountPercent,
       changes.notes ?? null, totals.subtotal, totals.discountAmount,
       totals.gct, totals.grandTotal],
    );

    // Keep the driver's stop description in step with the change.
    const summary = await summariseOrderLines(t, orderId);
    await t.query(
      `UPDATE delivery_stops SET line_items_summary = $2
       WHERE order_id = $1 AND stop_outcome = 'Pending'`,
      [orderId, summary],
    );

    await audit(t, actor, 'update', 'CustomerOrder', orderId, order.order_number, {
      linesReplaced: !!changes.lines,
      discountPercent,
      grandTotalCents: totals.grandTotal,
    });

    return {
      subtotalCents: totals.subtotal,
      gctCents: totals.gct,
      grandTotalCents: totals.grandTotal,
      warnings,
    };
  });
}

/** Cancel a Pending order and drop it off any route it was placed on. */
export async function cancelOrder(
  db: Db,
  actor: Actor,
  orderId: string,
  reason?: string,
): Promise<void> {
  requireRole(actor, 'admin', 'user');

  await db.tx(async (t) => {
    const order = await t.one<{ status: string; order_number: string }>(
      `SELECT status, order_number FROM customer_orders WHERE id = $1 FOR UPDATE`, [orderId],
    );
    if (order.status !== 'Pending') {
      throw new RuleViolation(
        `only a pending order can be cancelled; this one is ${order.status.toLowerCase()}`,
      );
    }
    await t.query(
      `UPDATE customer_orders SET status = 'Cancelled' WHERE id = $1`, [orderId],
    );
    await t.query(
      `DELETE FROM delivery_stops WHERE order_id = $1 AND stop_outcome = 'Pending'`,
      [orderId],
    );
    await audit(t, actor, 'update', 'CustomerOrder', orderId, order.order_number, {
      status: 'Cancelled', reason: reason ?? null,
    });
  });
}

/** Orders for the office list, newest first. */
export async function listOrders(
  db: Db,
  opts: { status?: string; customerId?: string; limit?: number } = {},
) {
  return db.query(
    `SELECT o.*, c.name AS customer_name
     FROM customer_orders o JOIN customers c ON c.id = o.customer_id
     WHERE ($1::text IS NULL OR o.status = $1)
       AND ($2::uuid IS NULL OR o.customer_id = $2::uuid)
     ORDER BY o.created_at DESC
     LIMIT $3`,
    [opts.status ?? null, opts.customerId ?? null, opts.limit ?? 100],
  );
}

export async function getOrder(db: Db, orderId: string) {
  const order = await db.maybeOne(`SELECT * FROM customer_orders WHERE id = $1`, [orderId]);
  if (!order) return null;
  const lines = await db.query(
    `SELECT oli.*, p.name AS product_name, p.bottles_per_case
     FROM order_line_items oli JOIN products p ON p.id = oli.product_id
     WHERE oli.order_id = $1 ORDER BY p.name`,
    [orderId],
  );
  return { ...order, lines };
}

/**
 * Recalculate an order's status from what its lines have actually had
 * delivered. Called after each delivery touches the order.
 */
export async function refreshOrderStatus(t: Queryable, orderId: string): Promise<string> {
  const agg = await t.one<{ ordered: number; delivered: number }>(
    `SELECT COALESCE(SUM(total_bottles),0)::int AS ordered,
            COALESCE(SUM(delivered_total),0)::int AS delivered
     FROM order_line_items WHERE order_id = $1`,
    [orderId],
  );
  const current = await t.one<{ status: string }>(
    `SELECT status FROM customer_orders WHERE id = $1`, [orderId],
  );
  if (current.status === 'Cancelled') return current.status;

  const status = num(agg.delivered) === 0
    ? 'Pending'
    : num(agg.delivered) >= num(agg.ordered)
      ? 'Delivered'
      : 'Partially Delivered';

  await t.query(`UPDATE customer_orders SET status = $2 WHERE id = $1`, [orderId, status]);
  return status;
}
