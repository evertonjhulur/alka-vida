/**
 * Customer orders (Section 3, Step 1).
 *
 * An Order is a commitment to fulfil, NOT a bill. No Invoice is created here
 * under any circumstance - invoicing happens at actual delivery.
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, businessTimeNow, businessToday, getSetting, nextNumber, num, requireRole } from './core.ts';
import type { Cents, DeliveryMode, PaymentMethod, RecurrencePattern } from '@alka/shared';
import {
  computeTotals, computeLineTotal, totalBottles, RuleViolation, composeAddress,
  addDays, nextRunDate,
} from '@alka/shared';

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
  /** A discount as an amount rather than a percentage (wins over percent). */
  discountFixedCents?: Cents;
  /** No GCT on this order. Defaults to the customer's own exemption. */
  gctExempt?: boolean | null;
  /** One of the customer's extra delivery addresses; blank = main address. */
  addressId?: string | null;
  quotationId?: string | null;
  /** The customer's own purchase order number, printed on the invoice. */
  customerPo?: string | null;
  paymentMethod?: PaymentMethod | null;
  notes?: string | null;
  source?: 'Admin' | 'Portal';
  /**
   * For today, but placed after the same-day cut-off: it waits in Approvals
   * instead of going straight onto today's round. Set by sameDayCheck.
   */
  needsReview?: boolean;
  isRecurring?: boolean;
  recurrencePattern?: RecurrencePattern | null;
  parentRecurringId?: string | null;
  /**
   * 5-gallon empties the customer will hand over (7 Oct 2026, point 13).
   * Fewer than the full 5-gallon bottles ordered and the difference is added
   * as "5-gallon bottle" at its price on the Products screen. Left out (null),
   * nothing is added - older screens and standing orders.
   */
  emptiesExpected?: number | null;
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
  /** The delivery date it was booked for (filled in when none was asked for). */
  deliveryDate?: string | null;
  /** True when it is waiting for the office to approve a late same-day order. */
  needsReview?: boolean;
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

    // The customer's own special price for this product, if the office set one.
    const special = await t.maybeOne<{ price_per_case_cents: number; price_per_bottle_cents: number }>(
      `SELECT price_per_case_cents, price_per_bottle_cents FROM customer_prices
       WHERE customer_id = $1 AND product_id = $2`, [customerId, line.productId],
    );

    const tierPrice = customer.price_tier_id
      ? await t.maybeOne<{ price_per_case_cents: number; price_per_bottle_cents: number; tier: string }>(
          `SELECT pl.price_per_case_cents, pl.price_per_bottle_cents, pt.name AS tier
           FROM price_lists pl JOIN price_tiers pt ON pt.id = pl.price_tier_id
           WHERE pl.price_tier_id = $1 AND pl.product_id = $2`,
          [customer.price_tier_id, line.productId],
        )
      : null;

    // Precedence: explicit override > customer special price > customer tier
    // rate > product list price.
    const pricePerCaseCents = num(line.pricePerCaseCents
      ?? special?.price_per_case_cents
      ?? tierPrice?.price_per_case_cents
      ?? product.price_per_case_cents);
    const pricePerBottleCents = num(line.pricePerBottleCents
      ?? special?.price_per_bottle_cents
      ?? tierPrice?.price_per_bottle_cents
      ?? product.price_per_bottle_cents);

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
      priceTier: special ? 'Special price' : tierPrice?.tier ?? null,
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
    const empties = input.emptiesExpected == null || (input.emptiesExpected as unknown) === ''
      ? null : Math.max(0, Math.round(Number(input.emptiesExpected) || 0));
    const lines = await resolveLines(t, input.customerId,
      await withBottleShortfall(t, input.lines, empties));

    const cust = await t.one<{ gct_exempt: boolean }>(
      `SELECT gct_exempt FROM customers WHERE id = $1`, [input.customerId],
    );
    const gctExempt = input.gctExempt ?? cust.gct_exempt;
    const fixed = Math.max(0, Math.round(Number(input.discountFixedCents) || 0));
    const pct = fixed > 0 ? 0 : (input.discountPercent ?? 0);

    if (input.addressId) {
      const a = await t.maybeOne<{ customer_id: string; is_delivery: boolean; active: boolean }>(
        `SELECT customer_id, is_delivery, active FROM customer_addresses WHERE id = $1`,
        [input.addressId],
      );
      if (!a || a.customer_id !== input.customerId || !a.active || !a.is_delivery) {
        throw new RuleViolation('that delivery address is not one of this customer\'s');
      }
    }

    // Order totals are calculated live at entry, mirroring the invoice
    // calculation exactly, so staff and customer see a real tax-inclusive
    // expected total immediately. This is REFERENCE ONLY - the invoice
    // generated at delivery recalculates from actual delivered quantities.
    const totals = computeTotals(lines, pct, !gctExempt, fixed);
    const orderNumber = await nextNumber(t, 'order_number_seq', 'SO');

    const order = await t.one<{ id: string }>(
      `INSERT INTO customer_orders
         (order_number, customer_id, order_date, requested_delivery_date, notes,
          is_recurring, recurrence_pattern, parent_recurring_id, payment_method,
          source, delivery_mode, discount_percent,
          subtotal_cents, discount_amount_cents, gct_cents, grand_total_cents,
          discount_fixed_cents, gct_exempt, address_id, quotation_id,
          customer_po, needs_review, empties_expected)
       VALUES ($1,$2,COALESCE($3::date, business_today()),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
               $17,$18,$19,$20,$21,$22,$23)
       RETURNING id`,
      [
        orderNumber, input.customerId, input.orderDate ?? null,
        input.requestedDeliveryDate ?? null, input.notes ?? null,
        input.isRecurring ?? false, input.recurrencePattern ?? null,
        input.parentRecurringId ?? null, input.paymentMethod ?? null,
        input.source ?? 'Admin', input.deliveryMode, pct,
        totals.subtotal, totals.discountAmount, totals.gct, totals.grandTotal,
        fixed, gctExempt, input.addressId ?? null, input.quotationId ?? null,
        input.customerPo?.trim() || null, input.needsReview === true, empties,
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
    // recurring orders. Pickup orders never touch a delivery sheet at all,
    // and nor does a late same-day order until the office approves it.
    if (input.needsReview) {
      const req = await t.one<{ id: string }>(
        `INSERT INTO approval_requests
           (request_type, entity_type, entity_id, entity_label, customer_id,
            amount_cents, reason, requested_by_id, payload)
         VALUES ('SameDayOrder','CustomerOrder',$1,$2,$3,$4,$5,$6,$7::jsonb)
         RETURNING id`,
        [order.id, orderNumber, input.customerId, totals.grandTotal,
         `Wanted today (${input.requestedDeliveryDate}), placed after the same-day cut-off`,
         actor.id,
         JSON.stringify({ requestedDeliveryDate: input.requestedDeliveryDate, source: input.source ?? 'Admin' })],
      );
      warnings.push(
        `${orderNumber} is for today but came in after the same-day cut-off, so it is waiting `
        + 'under Needs a decision. Approve it there to put it on today\'s round.',
      );
      void req;
    } else if (input.deliveryMode === 'Delivery') {
      const placement = await placeOnDeliverySheet(t, order.id, input.customerId,
        input.requestedDeliveryDate ?? null, input.addressId ?? null);
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
      deliveryDate: input.requestedDeliveryDate ?? null,
      needsReview: input.needsReview === true,
    };
  });
}

/** The only things a customer ordering through the portal actually chooses. */
export interface PortalOrderInput {
  lines: Array<{ productId: string; cases?: number; looseBottles?: number }>;
  deliveryMode?: 'Delivery' | 'Pickup';
  requestedDeliveryDate?: string | null;
  notes?: string | null;
  /** One of their own delivery addresses (createOrder checks it is theirs). */
  addressId?: string | null;
  /** Their own purchase order number, if their accounts department needs one. */
  customerPo?: string | null;
  /** How many 5-gallon empties they will hand over (7 Oct 2026, point 13). */
  emptiesExpected?: number | null;
}

/**
 * The same-day cut-off (team feedback, 1 Oct 2026, point 10).
 *
 * After the cut-off time (Settings, 10:00 to start) an order for TODAY is
 * still taken - nobody should be turned away - but it waits in Approvals
 * rather than landing on a round the driver may already have loaded. An
 * administrator's own order goes straight through: approving it is theirs.
 *
 * With no date asked for, the order goes on the customer's next delivery day
 * (their own days, else their zone's run days, else any day), counting from
 * tomorrow once the cut-off has passed. That needs no approval at all.
 */
export async function sameDayCheck(
  t: Queryable, actor: Actor, customerId: string, mode: DeliveryMode,
  requested: string | null, addressId: string | null = null,
): Promise<{ date: string | null; needsReview: boolean; afterCutoff: boolean; cutoff: string }> {
  const cutoff = (await getSetting(t, 'same_day_cutoff', '10:00')).trim() || '10:00';
  const today = businessToday();
  const afterCutoff = businessTimeNow() >= cutoff.padStart(5, '0');
  if (mode === 'Pickup' || mode === 'Counter') {
    return { date: requested, needsReview: false, afterCutoff, cutoff };
  }
  if (requested) {
    const needsReview = requested === today && afterCutoff && actor.role !== 'admin';
    return { date: requested, needsReview, afterCutoff, cutoff };
  }
  const target = await deliveryTarget(t, customerId, addressId);
  const c = await t.one<{ delivery_days: string[] | null }>(
    `SELECT delivery_days FROM customers WHERE id = $1`, [customerId],
  );
  let days: string[] = (c.delivery_days ?? []).filter(Boolean);
  if (days.length === 0 && target.delivery_zone) {
    const z = await t.maybeOne<{ run_days: string[] | null }>(
      `SELECT run_days FROM delivery_zones WHERE name = $1`, [target.delivery_zone],
    );
    days = (z?.run_days ?? []).filter(Boolean);
  }
  const from = afterCutoff ? addDays(today, 1) : today;
  return { date: nextRunDate(from, days), needsReview: false, afterCutoff, cutoff };
}

/**
 * An order placed by a customer through the portal.
 *
 * Deliberately NOT `createOrder` with the customer's id attached. Order entry
 * accepts several things only the office may decide - a price for a line, a
 * discount, a standing-order schedule, a back-dated order date - and a line
 * price BEATS the customer's tier rate by design, because that is how the
 * office overrides a rate for a single order (see resolveLines). Handing a
 * request body from a browser straight to it would let a customer name their
 * own price and hand themselves a hundred percent discount.
 *
 * So this is an allowlist rather than a filter: quantities, delivery or
 * pickup, when they want it, and a note. Everything else is set here, not
 * taken from the request. Extra fields are ignored rather than rejected - the
 * caller is a browser we wrote, and a field it never sends should not be the
 * reason a customer's order fails.
 */
export async function createPortalOrder(
  db: Db, actor: Actor, customerId: string, input: PortalOrderInput,
): Promise<CreateOrderResult> {
  // Counter is a sale paid for at the counter, which is an office action.
  // Anything that is not an explicit Pickup is an ordinary delivery.
  const deliveryMode: DeliveryMode = input.deliveryMode === 'Pickup' ? 'Pickup' : 'Delivery';

  const requested = input.requestedDeliveryDate?.trim() || null;
  if (requested && requested < businessToday()) {
    throw new RuleViolation('a delivery cannot be requested for a date that has passed');
  }
  const addressId = deliveryMode === 'Delivery' ? (input.addressId || null) : null;
  const when = await sameDayCheck(db, actor, customerId, deliveryMode, requested, addressId);

  return createOrder(db, actor, {
    customerId,
    // Quantities ONLY. A price on a line outranks the customer's tier rate,
    // so it must not survive the trip from a browser.
    lines: (input.lines ?? []).map((l) => ({
      productId: l.productId,
      cases: l.cases,
      looseBottles: l.looseBottles,
    })),
    deliveryMode,
    requestedDeliveryDate: when.date,
    needsReview: when.needsReview,
    notes: input.notes?.trim() || null,
    customerPo: input.customerPo?.trim() || null,
    addressId,
    source: 'Portal',
    emptiesExpected: input.emptiesExpected ?? null,
    // Not the customer's to decide. A discount is the office's to give, a
    // standing order is an arrangement rather than an order, how it will be
    // paid is settled at delivery, and the order date is today.
    discountPercent: 0,
    paymentMethod: null,
    isRecurring: false,
    recurrencePattern: null,
    parentRecurringId: null,
  });
}

/**
 * A customer cancelling their own order from the portal.
 *
 * Two things separate this from the office's cancelOrder: it proves the order
 * belongs to the person asking, and it says so in the words a customer needs.
 * The rule underneath is the same and is not relaxed - only a Pending order
 * can be cancelled. Once the water has gone out it has been invoiced, and
 * unwinding that is a credit note, which is the office's to raise.
 */
export async function cancelOwnOrder(
  db: Db, actor: Actor, customerId: string, orderId: string, reason?: string,
): Promise<void> {
  const order = await db.maybeOne<{ customer_id: string; status: string; order_number: string }>(
    `SELECT customer_id, status, order_number FROM customer_orders WHERE id = $1`, [orderId],
  );
  // Says the same thing for an order that is not theirs as for one that does
  // not exist: a customer must not be able to discover other people's orders
  // by trying ids.
  if (!order || order.customer_id !== customerId) {
    throw new RuleViolation('that order could not be found on your account');
  }
  if (order.status !== 'Pending') {
    throw new RuleViolation(
      order.status === 'Delivered'
        ? `order ${order.order_number} has already been delivered, so it cannot be `
          + 'cancelled. Please call us and we will put it right.'
        : `order ${order.order_number} is ${order.status.toLowerCase()} and can no `
          + 'longer be cancelled.',
    );
  }

  // Once the driver has set off with it, it is on the van: the customer has
  // to ring the office instead (team feedback, 1 Oct 2026, point 7).
  const onTheRoad = await db.maybeOne(
    `SELECT 1 FROM delivery_stops st JOIN delivery_sheets ds ON ds.id = st.delivery_sheet_id
     WHERE st.order_id = $1 AND st.stop_outcome = 'Pending' AND ds.started_at IS NOT NULL`,
    [orderId],
  );
  if (onTheRoad) {
    throw new RuleViolation(
      `order ${order.order_number} is already out for delivery, so it can no longer be `
      + 'cancelled here. Please call us.',
    );
  }

  await db.tx(async (t) => {
    await t.query(`UPDATE customer_orders SET status = 'Cancelled' WHERE id = $1`, [orderId]);
    await t.query(
      `DELETE FROM delivery_stops WHERE order_id = $1 AND stop_outcome = 'Pending'`,
      [orderId],
    );
    await t.query(
      `UPDATE approval_requests SET status = 'Rejected', review_notes = 'Cancelled by the customer',
              reviewed_date = now()
       WHERE entity_id = $1 AND request_type = 'SameDayOrder' AND status = 'Pending'`,
      [orderId],
    );
    await audit(t, actor, 'update', 'CustomerOrder', orderId, order.order_number, {
      status: 'Cancelled', cancelledByCustomer: true, reason: reason ?? null,
    });
  });
}

/**
 * Where an order goes and which round carries it: an extra delivery address
 * (its own zone, falling back to the customer's) or the main address.
 */
export async function deliveryTarget(
  t: Queryable, customerId: string, addressId: string | null,
): Promise<{
  name: string; delivery_zone: string | null; delivery_address: string | null;
  phone: string | null; route_sequence: number;
}> {
  const customer = await t.one<{
    name: string; delivery_zone: string | null; delivery_address: string | null;
    phone: string | null; route_sequence: number;
  }>(
    `SELECT name, delivery_zone, delivery_address, phone, route_sequence
     FROM customers WHERE id = $1`,
    [customerId],
  );
  if (!addressId) return customer;
  const a = await t.maybeOne<{
    label: string; address_line1: string | null; address_line2: string | null;
    city: string | null; parish: string | null; delivery_zone: string | null;
    route_sequence: number; phone: string | null;
  }>(
    `SELECT label, address_line1, address_line2, city, parish, delivery_zone,
            route_sequence, phone
     FROM customer_addresses WHERE id = $1 AND customer_id = $2`,
    [addressId, customerId],
  );
  if (!a) return customer;
  const line = composeAddress({ addressLine1: a.address_line1, addressLine2: a.address_line2,
    city: a.city, parish: a.parish });
  return {
    name: customer.name,
    delivery_zone: a.delivery_zone ?? customer.delivery_zone,
    delivery_address: line ? `${a.label}: ${line}` : customer.delivery_address,
    phone: a.phone ?? customer.phone,
    route_sequence: num(a.route_sequence) || num(customer.route_sequence),
  };
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
  addressId: string | null = null,
): Promise<{ sheetId: string | null; stopId: string | null; warnings: string[] }> {
  const warnings: string[] = [];
  const customer = await deliveryTarget(t, customerId, addressId);

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
    discountFixedCents?: Cents;
    gctExempt?: boolean;
    notes?: string | null;
    customerPo?: string | null;
    /** Change where it goes: one of their addresses, or '' / null for the main one. */
    addressId?: string | null;
  },
): Promise<{ subtotalCents: Cents; gctCents: Cents; grandTotalCents: Cents; warnings: string[] }> {
  requireRole(actor, 'admin', 'user');

  return db.tx(async (t) => {
    const order = await t.maybeOne<{
      id: string; customer_id: string; status: string; order_number: string;
      discount_percent: number; requested_delivery_date: string | null;
      discount_fixed_cents: number; gct_exempt: boolean; delivery_mode: string;
      address_id: string | null; needs_review: boolean;
    }>(
      `SELECT id, customer_id, status, order_number, discount_percent,
              requested_delivery_date::text AS requested_delivery_date,
              discount_fixed_cents, gct_exempt, delivery_mode, address_id, needs_review
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
    const fixed = changes.discountFixedCents !== undefined
      ? Math.max(0, Math.round(Number(changes.discountFixedCents) || 0))
      : (changes.discountPercent !== undefined ? 0 : num(order.discount_fixed_cents));
    const discountPercent = fixed > 0 ? 0 : (changes.discountPercent ?? num(order.discount_percent));
    const gctExempt = changes.gctExempt ?? order.gct_exempt;
    const totals = computeTotals(
      current.map((l) => ({ lineTotal: num(l.line_total) })), discountPercent, !gctExempt, fixed,
    );

    await t.query(
      `UPDATE customer_orders
       SET requested_delivery_date = COALESCE($2::date, requested_delivery_date),
           discount_percent = $3, notes = COALESCE($4, notes),
           subtotal_cents = $5, discount_amount_cents = $6,
           gct_cents = $7, grand_total_cents = $8,
           discount_fixed_cents = $9, gct_exempt = $10
       WHERE id = $1`,
      [orderId, changes.requestedDeliveryDate ?? null, discountPercent,
       changes.notes ?? null, totals.subtotal, totals.discountAmount,
       totals.gct, totals.grandTotal, fixed, gctExempt],
    );

    if (changes.customerPo !== undefined) {
      await t.query(`UPDATE customer_orders SET customer_po = $2 WHERE id = $1`,
        [orderId, changes.customerPo?.trim() || null]);
    }
    let addressId = order.address_id;
    if (changes.addressId !== undefined) {
      addressId = changes.addressId || null;
      if (addressId) {
        const a = await t.maybeOne<{ customer_id: string; active: boolean; is_delivery: boolean }>(
          `SELECT customer_id, active, is_delivery FROM customer_addresses WHERE id = $1`, [addressId],
        );
        if (!a || a.customer_id !== order.customer_id || !a.active || !a.is_delivery) {
          throw new RuleViolation('that delivery address is not one of this customer\'s');
        }
      }
      await t.query(`UPDATE customer_orders SET address_id = $2 WHERE id = $1`, [orderId, addressId]);
    }

    // Keep the driver's stop description in step with the change.
    const summary = await summariseOrderLines(t, orderId);
    await t.query(
      `UPDATE delivery_stops SET line_items_summary = $2
       WHERE order_id = $1 AND stop_outcome = 'Pending'`,
      [orderId, summary],
    );

    /*
     * A new delivery date (or address) moves the order to the right round
     * (team feedback, 1 Oct 2026, point 9: the date changed on the order but
     * the stop stayed on the old round). The pending stop comes off whatever
     * round it was on and the order is placed again, exactly as a new order
     * would be. A round already on the road keeps the stop, with a warning,
     * because the water may be on the van.
     */
    const newDate = changes.requestedDeliveryDate ?? null;
    const dateMoved = !!newDate && newDate !== order.requested_delivery_date;
    const addressMoved = changes.addressId !== undefined && addressId !== order.address_id;
    if ((dateMoved || addressMoved) && order.delivery_mode === 'Delivery' && !order.needs_review) {
      const current = await t.maybeOne<{ id: string; started: boolean; zone: string; day: string }>(
        `SELECT st.id, (ds.started_at IS NOT NULL) AS started, ds.zone, ds.delivery_date::text AS day
         FROM delivery_stops st JOIN delivery_sheets ds ON ds.id = st.delivery_sheet_id
         WHERE st.order_id = $1 AND st.stop_outcome = 'Pending' AND ds.status = 'Open'
         ORDER BY ds.delivery_date DESC LIMIT 1`,
        [orderId],
      );
      if (current?.started) {
        warnings.push(
          `The ${current.zone} round for ${current.day} has already started, so ${order.order_number} `
          + 'was left on it. Take it off that round first if it is not going today.',
        );
      } else {
        if (current) await t.query(`DELETE FROM delivery_stops WHERE id = $1`, [current.id]);
        const placed = await placeOnDeliverySheet(t, orderId, order.customer_id,
          newDate ?? order.requested_delivery_date, addressId);
        warnings.push(...placed.warnings);
      }
    }

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

/**
 * What happened to an order on the way (7 Oct 2026, points 8 and 9), oldest
 * first: each move to another day ("Rescheduled from Mon 5 Oct to Wed 7
 * Oct", and why) and each part delivery ("Part delivered on ..., the rest on
 * ..."). Shown on the office's Orders screen and on the customer's portal.
 */
export const ORDER_EVENTS = `(
  SELECT COALESCE(json_agg(json_build_object(
           'kind', CASE WHEN ev.rescheduled_to IS NOT NULL THEN 'Rescheduled' ELSE 'Part delivered' END,
           'from', ev.day, 'to', COALESCE(ev.rescheduled_to, ev.remainder_to)::text,
           'reason', ev.reschedule_reason) ORDER BY ev.day, ev.created), '[]'::json)
    FROM (SELECT s9.rescheduled_to, s9.remainder_to, s9.reschedule_reason,
                 d9.delivery_date::text AS day, d9.created_at AS created
            FROM delivery_stops s9 JOIN delivery_sheets d9 ON d9.id = s9.delivery_sheet_id
           WHERE s9.order_id = o.id
             AND ((s9.stop_outcome = 'Rescheduled' AND s9.rescheduled_to IS NOT NULL)
                  OR (s9.stop_outcome = 'Delivered' AND s9.remainder_to IS NOT NULL))) ev)`;

/** Orders for the office list, newest first. */
export async function listOrders(
  db: Db,
  opts: {
    status?: string; customerId?: string; limit?: number;
    /** A date range, on the delivery date (default) or the day it was placed. */
    from?: string | null; to?: string | null; dateBy?: 'delivery' | 'placed';
  } = {},
) {
  /*
   * Besides the order itself, what the Orders screen needs to say where it
   * stands without opening it: what is on it ("120 cs 500ml, 4 x 5 Gallon"),
   * the round it is on (the latest stop for it, if any), whether it came from
   * a standing order, and the business day to judge "missed" and "today"
   * against.
   */
  return db.query(
    `SELECT o.*, c.name AS customer_name, c.delivery_zone AS customer_zone,
            business_today() AS today,
            (SELECT string_agg(
                      CASE WHEN oli.cases > 0 AND oli.loose_bottles > 0
                             THEN oli.cases || ' cs + ' || oli.loose_bottles || ' '
                           WHEN oli.cases > 0 THEN oli.cases || ' cs '
                           ELSE oli.loose_bottles || ' x ' END || p.name,
                      ', ' ORDER BY p.name)
               FROM order_line_items oli JOIN products p ON p.id = oli.product_id
              WHERE oli.order_id = o.id) AS lines_summary,
            st.id AS stop_id, st.stop_outcome, ds.id AS sheet_id, ds.zone AS sheet_zone,
            ds.delivery_date AS sheet_date, ds.status AS sheet_status,
            (ds.started_at IS NOT NULL) AS sheet_started,
            ${ORDER_EVENTS} AS events,
            CASE WHEN o.status = 'Partially Delivered' THEN (
              SELECT string_agg(
                       CASE WHEN p.bottles_per_case > 0
                            THEN GREATEST(oli.cases - oli.delivered_cases, 0) || ' cs '
                            ELSE GREATEST(oli.loose_bottles - oli.delivered_loose, 0) || ' x ' END || p.name,
                       ', ' ORDER BY p.name)
                FROM order_line_items oli JOIN products p ON p.id = oli.product_id
               WHERE oli.order_id = o.id AND oli.delivered_total < oli.total_bottles) END AS remaining_summary
     FROM customer_orders o
     JOIN customers c ON c.id = o.customer_id
     LEFT JOIN LATERAL (
       SELECT s2.* FROM delivery_stops s2 JOIN delivery_sheets d2 ON d2.id = s2.delivery_sheet_id
        WHERE s2.order_id = o.id ORDER BY d2.delivery_date DESC, d2.created_at DESC LIMIT 1
     ) st ON true
     LEFT JOIN delivery_sheets ds ON ds.id = st.delivery_sheet_id
     WHERE ($1::text IS NULL OR o.status = $1)
       AND ($2::uuid IS NULL OR o.customer_id = $2::uuid)
       AND ($4::date IS NULL OR (CASE WHEN $6 THEN o.order_date
                                      ELSE COALESCE(o.requested_delivery_date, o.order_date) END) >= $4::date)
       AND ($5::date IS NULL OR (CASE WHEN $6 THEN o.order_date
                                      ELSE COALESCE(o.requested_delivery_date, o.order_date) END) <= $5::date)
     ORDER BY o.created_at DESC
     LIMIT $3`,
    [opts.status ?? null, opts.customerId ?? null, opts.limit ?? 100,
     opts.from ?? null, opts.to ?? null, opts.dateBy === 'placed'],
  );
}

export async function getOrder(db: Db, orderId: string) {
  const order = await db.maybeOne(`SELECT o.*, ${ORDER_EVENTS} AS events FROM customer_orders o WHERE o.id = $1`, [orderId]);
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

/* ------------------------------------------------------------------ */
/* 5-gallon bottles bought (Everton, 7 Oct 2026, point 13)             */
/* ------------------------------------------------------------------ */

/**
 * The product that IS the 5-gallon bottle, sold on its own when a customer
 * hands over fewer empties than the full bottles they take. Its price is set
 * on the Products screen like any other ($1,200 to start); nothing here
 * knows the figure.
 */
export async function bottleChargeProduct(t: Queryable): Promise<{
  id: string; name: string; price_per_bottle_cents: number; active: boolean;
}> {
  const found = await t.maybeOne<{ id: string; name: string; price_per_bottle_cents: number; active: boolean }>(
    `SELECT id, name, price_per_bottle_cents, active FROM products
     WHERE is_bottle_charge ORDER BY active DESC, created_at LIMIT 1`,
  );
  if (found) return found;
  // First use (or first start): put it on the Products screen at $1,200,
  // where the office changes it like any other price.
  return t.one(
    `INSERT INTO products (name, size, bottles_per_case, price_per_case_cents,
                           price_per_bottle_cents, is_returnable, is_bottle_charge)
     VALUES ('5-gallon bottle', '5gal', 0, 0, 120000, false, true)
     RETURNING id, name, price_per_bottle_cents, active`,
  );
}

/** Full 5-gallon (returnable) bottles on a set of lines. */
async function returnableBottles(t: Queryable, lines: readonly OrderLineInput[]): Promise<number> {
  let n = 0;
  for (const l of lines) {
    const p = await t.maybeOne<{ is_returnable: boolean; bottles_per_case: number }>(
      `SELECT is_returnable, bottles_per_case FROM products WHERE id = $1`, [l.productId],
    );
    if (p?.is_returnable) n += totalBottles(num(p.bottles_per_case), l.cases ?? 0, l.looseBottles ?? 0);
  }
  return n;
}

/**
 * The lines as ordered, plus bottles for any shortfall in empties. A line
 * for the bottle the office typed in themselves is left as it is.
 */
export async function withBottleShortfall(
  t: Queryable, lines: readonly OrderLineInput[], emptiesExpected: number | null,
): Promise<OrderLineInput[]> {
  if (emptiesExpected === null) return [...lines];
  const short = (await returnableBottles(t, lines)) - emptiesExpected;
  if (short <= 0) return [...lines];
  const bottle = await bottleChargeProduct(t);
  if (!bottle.active) return [...lines];
  if (lines.some((l) => l.productId === bottle.id)) return [...lines];
  return short > 0 ? [...lines, { productId: bottle.id, looseBottles: short }] : [...lines];
}

/** Recalculate an order's stored totals from its lines (same sum as invoicing). */
export async function recomputeOrderTotals(t: Queryable, orderId: string): Promise<void> {
  const o = await t.one<{ discount_percent: number; discount_fixed_cents: number; gct_exempt: boolean }>(
    `SELECT discount_percent, discount_fixed_cents, gct_exempt FROM customer_orders WHERE id = $1`, [orderId],
  );
  const current = await t.query<{ line_total: number }>(
    `SELECT CASE WHEN p.bottles_per_case > 0
                 THEN oli.cases * oli.price_per_case_cents
                 ELSE oli.loose_bottles * oli.price_per_bottle_cents END AS line_total
     FROM order_line_items oli JOIN products p ON p.id = oli.product_id
     WHERE oli.order_id = $1`, [orderId],
  );
  const fixed = num(o.discount_fixed_cents);
  const totals = computeTotals(current.map((l) => ({ lineTotal: num(l.line_total) })),
    fixed > 0 ? 0 : num(o.discount_percent), !o.gct_exempt, fixed);
  await t.query(
    `UPDATE customer_orders SET subtotal_cents = $2, discount_amount_cents = $3,
       gct_cents = $4, grand_total_cents = $5 WHERE id = $1`,
    [orderId, totals.subtotal, totals.discountAmount, totals.gct, totals.grandTotal],
  );
}

/**
 * The driver adds the bottle charge at the door (fewer empties than
 * expected): n more "5-gallon bottle" on the order, at the customer's price
 * for it. Returns the order line it went on.
 */
export async function addBottleChargeLine(
  t: Queryable, orderId: string, quantity: number,
): Promise<{ orderLineId: string; productId: string } | null> {
  const n = Math.max(0, Math.round(Number(quantity) || 0));
  if (n === 0) return null;
  const bottle = await bottleChargeProduct(t);
  const order = await t.one<{ customer_id: string }>(`SELECT customer_id FROM customer_orders WHERE id = $1`, [orderId]);
  const existing = await t.maybeOne<{ id: string }>(
    `SELECT id FROM order_line_items WHERE order_id = $1 AND product_id = $2 LIMIT 1`, [orderId, bottle.id],
  );
  let lineId: string;
  if (existing) {
    await t.query(
      `UPDATE order_line_items SET loose_bottles = loose_bottles + $2, total_bottles = total_bottles + $2
       WHERE id = $1`, [existing.id, n],
    );
    lineId = existing.id;
  } else {
    const [r] = await resolveLines(t, order.customer_id, [{ productId: bottle.id, looseBottles: n }]);
    const row = await t.one<{ id: string }>(
      `INSERT INTO order_line_items
         (order_id, product_id, cases, loose_bottles, total_bottles,
          price_per_case_cents, price_per_bottle_cents, price_tier)
       VALUES ($1,$2,0,$3,$3,$4,$5,$6) RETURNING id`,
      [orderId, bottle.id, n, r.pricePerCaseCents, r.pricePerBottleCents, r.priceTier],
    );
    lineId = row.id;
  }
  await recomputeOrderTotals(t, orderId);
  return { orderLineId: lineId, productId: bottle.id };
}

/* ------------------------------------------------------------------ */
/* Deliveries over more than one stop (7 Oct 2026, point 9)            */
/* ------------------------------------------------------------------ */

/**
 * What the order's lines have had delivered, from every stop recorded
 * Delivered. Always recounted from the stops rather than added to, so a
 * correction to one stop cannot leave the order's figure out of step.
 * Orders that never go on a round (counter, collection) set their own.
 */
export async function recomputeDelivered(t: Queryable, orderId: string): Promise<void> {
  await t.query(
    `UPDATE order_line_items oli
     SET delivered_cases = COALESCE(d.cases, 0), delivered_loose = COALESCE(d.loose, 0),
         delivered_total = COALESCE(d.total, 0)
     FROM order_line_items x
     LEFT JOIN (
       SELECT sl.order_line_id, SUM(sl.cases)::int AS cases, SUM(sl.loose_bottles)::int AS loose,
              SUM(sl.total_bottles)::int AS total
       FROM delivery_stop_lines sl JOIN delivery_stops st ON st.id = sl.stop_id
       WHERE st.order_id = $1 AND st.stop_outcome = 'Delivered'
       GROUP BY sl.order_line_id
     ) d ON d.order_line_id = x.id
     WHERE oli.id = x.id AND x.order_id = $1`,
    [orderId],
  );
}

/** "2 cs 500ml, 1 x 5 Gallon" for what is still to come. */
export async function summariseRemaining(t: Queryable, orderId: string): Promise<string> {
  const rows = await t.query<{ name: string; cases: number; loose: number; bpc: number }>(
    `SELECT p.name, GREATEST(oli.cases - oli.delivered_cases, 0) AS cases,
            GREATEST(oli.loose_bottles - oli.delivered_loose, 0) AS loose, p.bottles_per_case AS bpc
     FROM order_line_items oli JOIN products p ON p.id = oli.product_id
     WHERE oli.order_id = $1 AND oli.delivered_total < oli.total_bottles`, [orderId],
  );
  return rows
    .filter((r) => num(r.cases) > 0 || num(r.loose) > 0)
    .map((r) => (num(r.bpc) > 0 ? `${num(r.cases)} cs ${r.name}` : `${num(r.loose)} x ${r.name}`))
    .join(', ');
}
