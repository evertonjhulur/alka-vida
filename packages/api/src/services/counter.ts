/**
 * Counter / pickup sales (Section 3, final paragraph).
 *
 * A pickup order NEVER touches a delivery sheet. The invoice and the payment
 * are created in the same motion as the sale, and the payment goes straight
 * to Confirmed - there is no Provisional step, because there is no route to
 * reconcile.
 *
 * Every sale is still tied to a real Customer record, so a receipt can always
 * be issued - including for a cash walk-in.
 */

import type { Db } from '../db/index.ts';
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

  // The order records what was sold; delivery_mode Pickup keeps it off every
  // delivery sheet (createOrder only auto-routes Delivery orders).
  const order = await createOrder(db, actor, {
    customerId: input.customerId,
    lines: input.lines,
    deliveryMode: 'Pickup',
    discountPercent: input.discountPercent ?? 0,
    paymentMethod: input.method === 'Cheque' || input.method === 'Other'
      ? null : (input.method ?? 'Cash'),
    notes: input.notes ?? 'Counter sale',
  });

  return db.tx(async (t) => {
    const run = async () => {
      // A pickup is delivered the moment it is sold, so the invoice is built
      // from the same quantities via the shared delivered-quantity fields.
      await t.query(
        `UPDATE order_line_items
         SET delivered_cases = cases, delivered_loose = loose_bottles,
             delivered_total = total_bottles
         WHERE order_id = $1`, [order.id],
      );
      await refreshOrderStatus(t, order.id);

      const lines = await t.query<{
        product_id: string; delivered_cases: number; delivered_loose: number;
        price_per_case_cents: number; price_per_bottle_cents: number;
      }>(
        `SELECT product_id, delivered_cases, delivered_loose,
                price_per_case_cents, price_per_bottle_cents
         FROM order_line_items WHERE order_id = $1`, [order.id],
      );

      const invoice = await createInvoice(t, actor, {
        customerId: input.customerId,
        orderIds: [order.id],
        discountPercent: input.discountPercent ?? 0,
        notes: input.notes ?? 'Counter sale',
        lines: lines.map((l) => ({
          productId: l.product_id,
          cases: num(l.delivered_cases),
          looseBottles: num(l.delivered_loose),
          pricePerCaseCents: num(l.price_per_case_cents),
          pricePerBottleCents: num(l.price_per_bottle_cents),
        })),
      });

      const paid = input.amountPaidCents ?? 0;
      if (paid > 0) {
        // Straight to Confirmed - no route, so nothing to reconcile later.
        await insertPayment(t, actor, {
          customerId: input.customerId,
          invoiceId: invoice.id,
          amountCents: Math.min(paid, invoice.grandTotalCents),
          method: input.method ?? 'Cash',
          status: 'Confirmed',
          notes: 'Counter sale',
        });
        // Anything above the invoice is simply a second, unattached payment -
        // the same uniform treatment used at route settlement.
        const excess = paid - invoice.grandTotalCents;
        if (excess > 0) {
          await insertPayment(t, actor, {
            customerId: input.customerId,
            invoiceId: null,
            amountCents: excess,
            method: input.method ?? 'Cash',
            status: 'Confirmed',
            notes: 'Counter sale',
          });
        }
      }
      return { id: invoice.id };
    };

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
