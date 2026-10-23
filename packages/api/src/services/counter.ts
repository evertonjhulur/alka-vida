/**
 * Counter / pickup sales (Section 3, final paragraph).
 *
 * A counter sale NEVER touches a delivery sheet. The invoice and the payment
 * are created in the same motion as the sale, and the payment goes straight
 * to Confirmed - there is no Provisional step, because there is no route to
 * reconcile.
 *
 * Every sale is still tied to a real Customer record, so a receipt can always
 * be issued - including for a cash walk-in.
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { assertMethodAllowed, audit, businessToday, getSetting, requireRole, withIdempotency, num } from './core.ts';
import type { Cents, PaymentMethod } from '@alka/shared';
import { RuleViolation, computeTotals } from '@alka/shared';
import { createOrder, resolveLines, withBottleShortfall, type OrderLineInput } from './orders.ts';
import { createInvoice, getInvoiceLedger } from './invoices.ts';
import { applyAccountCredit, insertPayment } from './payments.ts';
import { refreshOrderStatus } from './orders.ts';
import { billedOnCycle } from './delivery.ts';
import { takeFinishedGoods, deliveredBottles } from './stockmoves.ts';
import { applyDeliveryMovement, recordBottlesSold } from './bottles.ts';

const cashText = (cents: number) => `$${(cents / 100).toLocaleString('en-JM', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Goods going out of the door at the counter or on a collection: take them
 * off finished-goods stock, and move any 5-gallon bottles - out to the
 * customer, and any empties they handed in back to the pool - recording both
 * against the customer as a delivery stop would (team feedback, point 12).
 */
async function goodsLeave(
  t: Queryable, actor: Actor, orderId: string, customerId: string, emptiesBack: number, note?: string,
): Promise<void> {
  const o = await t.one<{ order_number: string; delivery_mode: string }>(
    `SELECT order_number, delivery_mode FROM customer_orders WHERE id = $1`, [orderId],
  );
  const lines = await deliveredBottles(t, orderId);
  await takeFinishedGoods(t, lines, o.order_number,
    note ?? (o.delivery_mode === 'Counter' ? 'Counter sale' : 'Collected at the plant'));
  const out = lines.reduce((sum, l) => sum + l.returnable, 0);
  const back = Math.max(0, Math.round(Number(emptiesBack) || 0));
  if (out > 0 || back > 0) {
    const c = await t.maybeOne<{ name: string }>(`SELECT name FROM customers WHERE id = $1`, [customerId]);
    await applyDeliveryMovement(t, actor, {
      delivered: out, emptiesPickedUp: back, reference: o.order_number, customerName: c?.name,
    });
    await t.query(
      `INSERT INTO customer_bottle_moves (customer_id, delivered, returned, order_id, reference)
       VALUES ($1,$2,$3,$4,$5)`,
      [customerId, out, back, orderId, o.order_number],
    );
  }
  // Any "5-gallon bottle" on the order was bought: theirs from now on.
  const sold = await t.one<{ n: number }>(
    `SELECT COALESCE(SUM(oli.total_bottles), 0)::int AS n FROM order_line_items oli
     JOIN products p ON p.id = oli.product_id WHERE oli.order_id = $1 AND p.is_bottle_charge`, [orderId],
  );
  await recordBottlesSold(t, actor, { customerId, quantity: num(sold.n), reference: o.order_number, orderId });
}

/**
 * The shared walk-in record ("Cash Walk-In"), for a counter sale with no
 * customer chosen. Made the first time it is needed.
 */
export async function walkInCustomer(t: Queryable): Promise<string> {
  const found = await t.maybeOne<{ id: string }>(
    `SELECT id FROM customers WHERE is_walk_in AND active
     ORDER BY (lower(name) = 'cash walk-in') DESC, created_at LIMIT 1`,
  );
  if (found) return found.id;
  const made = await t.one<{ id: string }>(
    `INSERT INTO customers (name, phone, email, is_walk_in, payment_terms, notes)
     VALUES ('Cash Walk-In', '000', '', true, 'Cash on delivery', 'Shared record for counter sales to walk-ins')
     RETURNING id`,
  );
  return made.id;
}

export interface CounterSaleInput {
  /** Blank for a walk-in: the shared Cash Walk-In record is used. */
  customerId?: string | null;
  lines: OrderLineInput[];
  discountPercent?: number;
  discountFixedCents?: Cents;
  gctExempt?: boolean | null;
  /**
   * What is paid now. A walk-in must pay in full (left out, it is taken as
   * paid in full); only a customer with an account may pay part, or nothing
   * (Everton, 7 Oct 2026, point 12).
   */
  amountPaidCents?: Cents | null;
  method?: PaymentMethod;
  /** Cheque number or transfer reference, for the receipt. */
  reference?: string | null;
  notes?: string | null;
  idempotencyKey?: string | null;
  /** 5-gallon empties the customer handed in with this sale. */
  emptiesReturned?: number;
}

export async function counterSale(
  db: Db,
  actor: Actor,
  input: CounterSaleInput,
): Promise<{
  orderId: string; invoiceId: string; invoiceNumber: string;
  grandTotalCents: Cents; amountPaidCents: Cents; balanceCents: Cents;
  status: string; replayed: boolean;
}> {
  requireRole(actor, 'admin', 'user');

  const customerId = input.customerId || await db.tx((t) => walkInCustomer(t));
  const who = await db.one<{ is_walk_in: boolean; name: string }>(
    `SELECT is_walk_in, name FROM customers WHERE id = $1`, [customerId],
  );
  // Bottles short of the empties handed in are bought (point 13), so the
  // total - and so what "in full" means - includes them. Not said (older
  // callers), nothing is added.
  const empties = input.emptiesReturned == null ? null
    : Math.max(0, Math.round(Number(input.emptiesReturned) || 0));
  const lines = await withBottleShortfall(db, input.lines ?? [], empties);
  const fixed = Math.max(0, Math.round(Number(input.discountFixedCents) || 0));
  const priced = await resolveLines(db, customerId, lines);
  const cust = await db.one<{ gct_exempt: boolean }>(`SELECT gct_exempt FROM customers WHERE id = $1`, [customerId]);
  const total = computeTotals(priced, fixed > 0 ? 0 : (input.discountPercent ?? 0),
    !(input.gctExempt ?? cust.gct_exempt), fixed).grandTotal;
  // Left out: a walk-in pays in full; an account customer pays nothing now
  // (as the API always meant). The screen sends the figure either way.
  const paying = input.amountPaidCents == null || (input.amountPaidCents as unknown) === ''
    ? (who.is_walk_in ? total : 0) : Math.max(0, Math.round(Number(input.amountPaidCents) || 0));
  if (paying > 0) await assertMethodAllowed(db, input.method ?? 'Cash');
  if (who.is_walk_in && paying < total) {
    throw new RuleViolation(
      `a walk-in pays in full: ${cashText(total)}. To let them pay part, choose (or add) their customer account first.`,
    );
  }

  // The order records what was sold; delivery_mode Counter keeps it off every
  // delivery sheet (createOrder only auto-routes Delivery orders).
  const order = await createOrder(db, actor, {
    customerId,
    lines,
    deliveryMode: 'Counter',
    discountPercent: input.discountPercent ?? 0,
    discountFixedCents: input.discountFixedCents ?? 0,
    gctExempt: input.gctExempt ?? null,
    paymentMethod: input.method === 'Cheque' || input.method === 'Other'
      ? null : (input.method ?? 'Cash'),
    notes: input.notes ?? 'Counter sale',
  });

  return db.tx(async (t) => {
    const run = () => invoiceAndTakePayment(t, actor, {
      orderId: order.id,
      customerId,
      notes: input.notes ?? 'Counter sale',
      amountPaidCents: paying,
      method: input.method ?? 'Cash',
      reference: input.reference ?? null,
      emptiesBack: input.emptiesReturned ?? 0,
    });

    const outcome = await withIdempotency(t, input.idempotencyKey, 'counterSale', run);
    const invoiceId = outcome.resultId;
    if (!invoiceId) throw new RuleViolation('counter sale did not produce an invoice');

    const ledger = await getInvoiceLedger(t, invoiceId);
    return {
      orderId: order.id,
      invoiceId,
      invoiceNumber: ledger!.invoiceNumber,
      grandTotalCents: ledger!.grandTotalCents,
      amountPaidCents: ledger!.amountPaidCents,
      balanceCents: ledger!.balanceCents,
      status: ledger!.status,
      replayed: outcome.replayed,
    };
  });
}

/**
 * Invoice an order from what is actually going out of the door, and take
 * whatever is being paid for it now.
 *
 * Shared by a walk-in counter sale and by a pickup order being collected -
 * the two differ in WHEN they happen, not in what happens - so both bill the
 * same way and neither can drift from the other.
 */
async function invoiceAndTakePayment(
  t: Queryable,
  actor: Actor,
  args: {
    orderId: string; customerId: string;
    notes: string; amountPaidCents: Cents; method: PaymentMethod; emptiesBack?: number;
    reference?: string | null;
    /** The day it really went out, when recorded later (23 Oct 2026). Blank = today. */
    on?: string | null;
  },
): Promise<{ id: string }> {
  // What is handed over is the whole order, so delivered quantities are the
  // ordered ones - the same fields a delivery fills in at the stop.
  await t.query(
    `UPDATE order_line_items
     SET delivered_cases = cases, delivered_loose = loose_bottles,
         delivered_total = total_bottles
     WHERE order_id = $1`, [args.orderId],
  );
  await refreshOrderStatus(t, args.orderId);
  await t.query(`UPDATE customer_orders SET fulfilled_on = COALESCE($2::date, business_today()) WHERE id = $1`,
    [args.orderId, args.on ?? null]);
  await goodsLeave(t, actor, args.orderId, args.customerId, args.emptiesBack ?? 0,
    args.on ? `Went out on ${args.on}, recorded later` : undefined);

  const lines = await t.query<{
    product_id: string; delivered_cases: number; delivered_loose: number;
    price_per_case_cents: number; price_per_bottle_cents: number;
  }>(
    `SELECT product_id, delivered_cases, delivered_loose,
            price_per_case_cents, price_per_bottle_cents
     FROM order_line_items WHERE order_id = $1`, [args.orderId],
  );

  // The discount and GCT decided on the order are the ones billed.
  const order = await t.one<{ discount_percent: number; discount_fixed_cents: number; gct_exempt: boolean }>(
    `SELECT discount_percent, discount_fixed_cents, gct_exempt FROM customer_orders WHERE id = $1`,
    [args.orderId],
  );
  const invoice = await createInvoice(t, actor, {
    customerId: args.customerId,
    orderIds: [args.orderId],
    invoiceDate: args.on ?? null,
    discountPercent: num(order.discount_percent),
    discountFixedCents: num(order.discount_fixed_cents),
    gctExempt: order.gct_exempt,
    notes: args.notes,
    lines: lines.map((l) => ({
      productId: l.product_id,
      cases: num(l.delivered_cases),
      looseBottles: num(l.delivered_loose),
      pricePerCaseCents: num(l.price_per_case_cents),
      pricePerBottleCents: num(l.price_per_bottle_cents),
    })),
  });

  // Money already on their account (paid with this order, or credit) goes on
  // first (11 Oct 2026), so what is handed over now pays what is left.
  await applyAccountCredit(t, actor, invoice.id);
  const left = Math.max(0, (await getInvoiceLedger(t, invoice.id))!.balanceCents);

  if (args.amountPaidCents > 0) {
    // Straight to Confirmed - no route, so nothing to reconcile later.
    const onInvoice = Math.min(args.amountPaidCents, left);
    if (onInvoice > 0) {
      await insertPayment(t, actor, {
        customerId: args.customerId,
        invoiceId: invoice.id,
        amountCents: onInvoice,
        method: args.method,
        reference: args.reference ?? null,
        status: 'Confirmed',
        notes: args.notes,
        paymentDate: args.on ?? null,
      });
    }
    // Anything above the invoice is simply a second, unattached payment -
    // the same uniform treatment used at route settlement.
    const excess = args.amountPaidCents - onInvoice;
    if (excess > 0) {
      await insertPayment(t, actor, {
        customerId: args.customerId,
        invoiceId: null,
        amountCents: excess,
        method: args.method,
        reference: args.reference ?? null,
        status: 'Confirmed',
        notes: args.notes,
        paymentDate: args.on ?? null,
      });
    }
  }
  return { id: invoice.id };
}

/**
 * A pickup order is collected.
 *
 * This is the plant-counter equivalent of marking a delivery stop Delivered:
 * nothing is billed until the goods actually leave, and the invoice is built
 * from what was handed over. Payment is optional here - a corporate customer
 * collecting on account is normal.
 */
export async function collectOrder(
  db: Db,
  actor: Actor,
  input: {
    orderId: string;
    amountPaidCents?: Cents;
    method?: PaymentMethod;
    notes?: string | null;
    idempotencyKey?: string | null;
    emptiesReturned?: number;
  },
): Promise<{
  invoiceId: string; invoiceNumber: string; grandTotalCents: Cents;
  amountPaidCents: Cents; balanceCents: Cents; status: string; replayed: boolean;
}> {
  requireRole(actor, 'admin', 'user');

  return db.tx(async (t) => {
    const order = await t.maybeOne<{
      customer_id: string; status: string; delivery_mode: string;
      order_number: string; discount_percent: number;
    }>(
      `SELECT customer_id, status, delivery_mode, order_number, discount_percent
       FROM customer_orders WHERE id = $1`, [input.orderId],
    );
    if (!order) throw new RuleViolation('that order no longer exists');
    if (order.delivery_mode !== 'Pickup') {
      throw new RuleViolation(
        `${order.order_number} is a ${order.delivery_mode.toLowerCase()} order, ` +
        `not a pickup`,
      );
    }
    if (order.status === 'Cancelled') {
      throw new RuleViolation(`${order.order_number} was cancelled`);
    }
    if (order.status === 'Delivered') {
      throw new RuleViolation(`${order.order_number} has already been collected`);
    }
    if ((input.amountPaidCents ?? 0) > 0) await assertMethodAllowed(t, input.method ?? 'Cash');

    // Billed weekly or monthly: the collection goes on the account and waits
    // for the cycle invoice. Anything paid now simply sits on the account and
    // is applied when that invoice is raised.
    if (await billedOnCycle(t, order.customer_id)) {
      await t.query(
        `UPDATE order_line_items
         SET delivered_cases = cases, delivered_loose = loose_bottles,
             delivered_total = total_bottles
         WHERE order_id = $1`, [input.orderId],
      );
      await refreshOrderStatus(t, input.orderId);
      await t.query(`UPDATE customer_orders SET fulfilled_on = business_today() WHERE id = $1`,
        [input.orderId]);
      await goodsLeave(t, actor, input.orderId, order.customer_id, input.emptiesReturned ?? 0);
      const paid = input.amountPaidCents ?? 0;
      if (paid > 0) {
        await insertPayment(t, actor, {
          customerId: order.customer_id, invoiceId: null, amountCents: paid,
          method: input.method ?? 'Cash', status: 'Confirmed', orderId: input.orderId,
          notes: `Paid on collecting ${order.order_number}`,
        });
      }
      const bal = await t.one<{ b: string }>(
        `SELECT COALESCE(balance_cents,0)::text AS b FROM customer_balances WHERE customer_id = $1`,
        [order.customer_id],
      );
      return {
        invoiceId: null as unknown as string, invoiceNumber: null as unknown as string,
        grandTotalCents: 0, amountPaidCents: paid, balanceCents: Number(bal.b),
        status: 'On the cycle invoice', replayed: false, onCycle: true,
      };
    }

    const run = () => invoiceAndTakePayment(t, actor, {
      orderId: input.orderId,
      customerId: order.customer_id,
      notes: input.notes ?? `Collected at the plant`,
      amountPaidCents: input.amountPaidCents ?? 0,
      method: input.method ?? 'Cash',
      emptiesBack: input.emptiesReturned ?? 0,
    });

    const outcome = await withIdempotency(t, input.idempotencyKey, 'collectOrder', run);
    const invoiceId = outcome.resultId;
    if (!invoiceId) throw new RuleViolation('collection did not produce an invoice');

    const ledger = await getInvoiceLedger(t, invoiceId);
    return {
      invoiceId,
      invoiceNumber: ledger!.invoiceNumber,
      grandTotalCents: ledger!.grandTotalCents,
      amountPaidCents: ledger!.amountPaidCents,
      balanceCents: ledger!.balanceCents,
      status: ledger!.status,
      replayed: outcome.replayed,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Recorded on a later day (23 Oct 2026)                               */
/* ------------------------------------------------------------------ */

/** How many days back office staff may record (Settings › Invoices & payments). */
export async function backdateDays(t: Queryable): Promise<number> {
  const n = Math.round(Number(await getSetting(t, 'backdate_days', '3')));
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

export interface PastDeliveryInput extends CounterSaleInput {
  /** YYYY-MM-DD: the day it really went out. */
  deliveredOn: string;
  /** Delivered by our truck, or collected / sold at the plant. */
  how: 'Delivered' | 'Collected';
}

/**
 * A delivery or sale that went out but was never entered (Everton, 23 Oct
 * 2026: "we need to be able to enter invoices for prior days").
 *
 * Everything is dated the day it really happened: the order, the invoice and
 * its due date, and any money taken at the time. It never goes on a round.
 * Office staff may go back `backdate_days` days (3 for now); administrators
 * may enter any date. Customers invoiced weekly or monthly get no invoice
 * now: it waits for the invoice of the week or month it went out in.
 */
export async function recordPastDelivery(
  db: Db, actor: Actor, input: PastDeliveryInput,
): Promise<{
  orderId: string; orderNumber: string; deliveredOn: string;
  invoiceId: string | null; invoiceNumber: string | null; onCycle: boolean;
  grandTotalCents: Cents; amountPaidCents: Cents; balanceCents: Cents | null; replayed: boolean;
}> {
  requireRole(actor, 'admin', 'user');
  const on = String(input.deliveredOn ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on) || Number.isNaN(Date.parse(on))) {
    throw new RuleViolation('choose the day it went out');
  }
  const today = businessToday();
  const back = daysBetween(on, today);
  if (back < 0) throw new RuleViolation('that day has not happened yet - for a future day, make an order');
  const limit = await backdateDays(db);
  if (actor.role !== 'admin' && back > limit) {
    throw new RuleViolation(
      `office staff can record up to ${limit} ${limit === 1 ? 'day' : 'days'} back. For ${on}, ask an administrator to enter it`);
  }

  const customerId = input.customerId || await db.tx((t) => walkInCustomer(t));
  const who = await db.one<{ is_walk_in: boolean; name: string }>(
    `SELECT is_walk_in, name FROM customers WHERE id = $1`, [customerId],
  );
  const empties = input.emptiesReturned == null ? null
    : Math.max(0, Math.round(Number(input.emptiesReturned) || 0));
  const lines = await withBottleShortfall(db, input.lines ?? [], empties);
  const fixed = Math.max(0, Math.round(Number(input.discountFixedCents) || 0));
  const priced = await resolveLines(db, customerId, lines);
  const cust = await db.one<{ gct_exempt: boolean }>(`SELECT gct_exempt FROM customers WHERE id = $1`, [customerId]);
  const total = computeTotals(priced, fixed > 0 ? 0 : (input.discountPercent ?? 0),
    !(input.gctExempt ?? cust.gct_exempt), fixed).grandTotal;
  const paying = input.amountPaidCents == null || (input.amountPaidCents as unknown) === ''
    ? (who.is_walk_in ? total : 0) : Math.max(0, Math.round(Number(input.amountPaidCents) || 0));
  if (paying > 0) await assertMethodAllowed(db, input.method ?? 'Cash');
  if (who.is_walk_in && paying < total) {
    throw new RuleViolation(`a walk-in pays in full: ${cashText(total)}. To record part payment, choose their customer account.`);
  }

  const how = input.how === 'Collected' ? 'Collected' : 'Delivered';
  const notes = [input.notes?.trim(), `${how} on ${on}; recorded on ${today}.`].filter(Boolean).join(' ');
  const order = await createOrder(db, actor, {
    customerId, lines,
    deliveryMode: how === 'Delivered' ? 'Delivery' : 'Pickup',
    noRound: true,
    orderDate: on,
    requestedDeliveryDate: on,
    discountPercent: input.discountPercent ?? 0,
    discountFixedCents: input.discountFixedCents ?? 0,
    gctExempt: input.gctExempt ?? null,
    paymentMethod: input.method === 'Cheque' || input.method === 'Other' ? null : (input.method ?? 'Cash'),
    notes,
  });

  return db.tx(async (t) => {
    await t.query(`UPDATE customer_orders SET recorded_late = true WHERE id = $1`, [order.id]);
    await audit(t, actor, 'create', 'CustomerOrder', order.id, order.orderNumber,
      { recordedLate: true, deliveredOn: on, daysBack: back, how });

    const onCycle = !who.is_walk_in && await billedOnCycle(t, customerId);
    if (onCycle) {
      // Weekly / monthly: recorded as delivered on that day; it goes on the
      // invoice for that week or month. Money taken then sits on the account.
      await t.query(
        `UPDATE order_line_items SET delivered_cases = cases, delivered_loose = loose_bottles,
                delivered_total = total_bottles WHERE order_id = $1`, [order.id]);
      await refreshOrderStatus(t, order.id);
      await t.query(`UPDATE customer_orders SET fulfilled_on = $2::date WHERE id = $1`, [order.id, on]);
      await goodsLeave(t, actor, order.id, customerId, input.emptiesReturned ?? 0, `Went out on ${on}, recorded later`);
      if (paying > 0) {
        await insertPayment(t, actor, {
          customerId, invoiceId: null, amountCents: paying, method: input.method ?? 'Cash',
          reference: input.reference ?? null, status: 'Confirmed', notes, paymentDate: on,
        });
      }
      return {
        orderId: order.id, orderNumber: order.orderNumber, deliveredOn: on,
        invoiceId: null, invoiceNumber: null, onCycle: true,
        grandTotalCents: total, amountPaidCents: paying, balanceCents: null, replayed: false,
      };
    }

    const run = () => invoiceAndTakePayment(t, actor, {
      orderId: order.id, customerId, notes, amountPaidCents: paying,
      method: input.method ?? 'Cash', reference: input.reference ?? null,
      emptiesBack: input.emptiesReturned ?? 0, on,
    });
    const outcome = await withIdempotency(t, input.idempotencyKey, 'pastDelivery', run);
    const invoiceId = outcome.resultId;
    if (!invoiceId) throw new RuleViolation('the delivery did not produce an invoice');
    const ledger = await getInvoiceLedger(t, invoiceId);
    return {
      orderId: order.id, orderNumber: order.orderNumber, deliveredOn: on,
      invoiceId, invoiceNumber: ledger!.invoiceNumber, onCycle: false,
      grandTotalCents: ledger!.grandTotalCents, amountPaidCents: ledger!.amountPaidCents,
      balanceCents: ledger!.balanceCents, replayed: outcome.replayed,
    };
  });
}
