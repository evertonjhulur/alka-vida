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
import { requireRole, withIdempotency, num } from './core.ts';
import type { Cents, PaymentMethod } from '@alka/shared';
import { RuleViolation } from '@alka/shared';
import { createOrder, type OrderLineInput } from './orders.ts';
import { createInvoice, getInvoiceLedger } from './invoices.ts';
import { insertPayment } from './payments.ts';
import { refreshOrderStatus } from './orders.ts';

export interface CounterSaleInput {
  customerId: string;
  lines: OrderLineInput[];
  discountPercent?: number;
  /** Omit or pass 0 for an unpaid pickup (e.g. stated bank transfer). */
  amountPaidCents?: Cents;
  method?: PaymentMethod;
  notes?: string | null;
  idempotencyKey?: string | null;
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

  // The order records what was sold; delivery_mode Counter keeps it off every
  // delivery sheet (createOrder only auto-routes Delivery orders).
  const order = await createOrder(db, actor, {
    customerId: input.customerId,
    lines: input.lines,
    deliveryMode: 'Counter',
    discountPercent: input.discountPercent ?? 0,
    paymentMethod: input.method === 'Cheque' || input.method === 'Other'
      ? null : (input.method ?? 'Cash'),
    notes: input.notes ?? 'Counter sale',
  });

  return db.tx(async (t) => {
    const run = () => invoiceAndTakePayment(t, actor, {
      orderId: order.id,
      customerId: input.customerId,
      discountPercent: input.discountPercent ?? 0,
      notes: input.notes ?? 'Counter sale',
      amountPaidCents: input.amountPaidCents ?? 0,
      method: input.method ?? 'Cash',
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
    orderId: string; customerId: string; discountPercent: number;
    notes: string; amountPaidCents: Cents; method: PaymentMethod;
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

  const lines = await t.query<{
    product_id: string; delivered_cases: number; delivered_loose: number;
    price_per_case_cents: number; price_per_bottle_cents: number;
  }>(
    `SELECT product_id, delivered_cases, delivered_loose,
            price_per_case_cents, price_per_bottle_cents
     FROM order_line_items WHERE order_id = $1`, [args.orderId],
  );

  const invoice = await createInvoice(t, actor, {
    customerId: args.customerId,
    orderIds: [args.orderId],
    discountPercent: args.discountPercent,
    notes: args.notes,
    lines: lines.map((l) => ({
      productId: l.product_id,
      cases: num(l.delivered_cases),
      looseBottles: num(l.delivered_loose),
      pricePerCaseCents: num(l.price_per_case_cents),
      pricePerBottleCents: num(l.price_per_bottle_cents),
    })),
  });

  if (args.amountPaidCents > 0) {
    // Straight to Confirmed - no route, so nothing to reconcile later.
    await insertPayment(t, actor, {
      customerId: args.customerId,
      invoiceId: invoice.id,
      amountCents: Math.min(args.amountPaidCents, invoice.grandTotalCents),
      method: args.method,
      status: 'Confirmed',
      notes: args.notes,
    });
    // Anything above the invoice is simply a second, unattached payment -
    // the same uniform treatment used at route settlement.
    const excess = args.amountPaidCents - invoice.grandTotalCents;
    if (excess > 0) {
      await insertPayment(t, actor, {
        customerId: args.customerId,
        invoiceId: null,
        amountCents: excess,
        method: args.method,
        status: 'Confirmed',
        notes: args.notes,
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

    const run = () => invoiceAndTakePayment(t, actor, {
      orderId: input.orderId,
      customerId: order.customer_id,
      discountPercent: num(order.discount_percent),
      notes: input.notes ?? `Collected at the plant`,
      amountPaidCents: input.amountPaidCents ?? 0,
      method: input.method ?? 'Cash',
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
