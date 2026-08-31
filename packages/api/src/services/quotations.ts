/**
 * Quotations (Section 2).
 *
 * Optional and low-frequency by design - most orders skip this step entirely.
 *
 * A quotation carries NO GCT: it has no tax impact. Its prices are freely
 * editable estimates rather than locked tier rates. When accepted it converts
 * into a real CustomerOrder, carrying its line items and pricing across, and
 * the order recalculates tax-inclusive totals in the normal way.
 */

import type { Db } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, nextNumber, requireRole, num } from './core.ts';
import type { Cents } from '@alka/shared';
import {
  computeTotals, computeLineTotal, totalBottles, RuleViolation,
} from '@alka/shared';
import { createOrder, type CreateOrderInput } from './orders.ts';

export interface QuotationLineInput {
  productId: string;
  cases?: number;
  looseBottles?: number;
  /** Freely editable estimate prices, not locked tier rates. */
  pricePerCaseCents?: Cents;
  pricePerBottleCents?: Cents;
}

export async function createQuotation(
  db: Db,
  actor: Actor,
  input: {
    customerId: string;
    lines: QuotationLineInput[];
    validUntil?: string | null;
    discountPercent?: number;
    notes?: string | null;
  },
): Promise<{ id: string; quoteNumber: string; subtotalCents: Cents; grandTotalCents: Cents }> {
  requireRole(actor, 'admin', 'user');
  if (input.lines.length === 0) throw new RuleViolation('a quotation needs at least one line');

  return db.tx(async (t) => {
    const priced = [];
    for (const l of input.lines) {
      const product = await t.one<{
        bottles_per_case: number; price_per_case_cents: number; price_per_bottle_cents: number;
      }>(
        `SELECT bottles_per_case, price_per_case_cents, price_per_bottle_cents
         FROM products WHERE id = $1`, [l.productId],
      );
      const bpc = num(product.bottles_per_case);
      const cases = l.cases ?? 0;
      const loose = l.looseBottles ?? 0;
      const pricePerCase = l.pricePerCaseCents ?? num(product.price_per_case_cents);
      const pricePerBottle = l.pricePerBottleCents ?? num(product.price_per_bottle_cents);

      priced.push({
        productId: l.productId, bottlesPerCase: bpc, cases, looseBottles: loose,
        pricePerCase, pricePerBottle,
        totalBottles: totalBottles(bpc, cases, loose),
        lineTotal: computeLineTotal({
          bottlesPerCase: bpc, cases, looseBottles: loose,
          pricePerCase, pricePerBottle,
        }),
      });
    }

    // applyGct = false: a quotation has no tax impact.
    const totals = computeTotals(priced, input.discountPercent ?? 0, false);
    const quoteNumber = await nextNumber(t, 'quote_number_seq', 'QT');

    const quote = await t.one<{ id: string }>(
      `INSERT INTO quotations
         (quote_number, customer_id, valid_until, notes, subtotal_cents,
          discount_percent, discount_amount_cents, grand_total_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [quoteNumber, input.customerId, input.validUntil ?? null, input.notes ?? null,
       totals.subtotal, input.discountPercent ?? 0, totals.discountAmount, totals.grandTotal],
    );

    for (const l of priced) {
      await t.query(
        `INSERT INTO quotation_line_items
           (quote_id, product_id, cases, loose_bottles, total_bottles,
            price_per_case_cents, price_per_bottle_cents, line_total_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [quote.id, l.productId, l.cases, l.looseBottles, l.totalBottles,
         l.pricePerCase, l.pricePerBottle, l.lineTotal],
      );
    }

    await audit(t, actor, 'create', 'Quotation', quote.id, quoteNumber, {
      customerId: input.customerId, grandTotalCents: totals.grandTotal, gctApplied: false,
    });

    return {
      id: quote.id, quoteNumber,
      subtotalCents: totals.subtotal,
      grandTotalCents: totals.grandTotal,
    };
  });
}

/**
 * Convert an accepted quotation into a real order, carrying over its line
 * items and their quoted prices. The resulting order calculates GCT normally.
 */
export async function convertQuotation(
  db: Db,
  actor: Actor,
  quoteId: string,
  options: {
    deliveryMode: CreateOrderInput['deliveryMode'];
    requestedDeliveryDate?: string | null;
  },
): Promise<{ orderId: string; orderNumber: string; grandTotalCents: Cents }> {
  requireRole(actor, 'admin', 'user');

  const quote = await db.maybeOne<{
    id: string; customer_id: string; status: string;
    quote_number: string; discount_percent: number; valid_until: string | null;
  }>(
    `SELECT id, customer_id, status, quote_number, discount_percent, valid_until
     FROM quotations WHERE id = $1`, [quoteId],
  );
  if (!quote) throw new RuleViolation(`quotation ${quoteId} not found`);
  if (quote.status === 'Converted') {
    throw new RuleViolation('this quotation has already been converted to an order');
  }
  if (quote.status === 'Declined') throw new RuleViolation('this quotation was declined');

  const lines = await db.query<{
    product_id: string; cases: number; loose_bottles: number;
    price_per_case_cents: number; price_per_bottle_cents: number;
  }>(
    `SELECT product_id, cases, loose_bottles, price_per_case_cents, price_per_bottle_cents
     FROM quotation_line_items WHERE quote_id = $1`, [quoteId],
  );

  // The quoted prices carry across as explicit overrides, so the customer is
  // charged what they were quoted rather than their current tier rate.
  const order = await createOrder(db, actor, {
    customerId: quote.customer_id,
    deliveryMode: options.deliveryMode,
    requestedDeliveryDate: options.requestedDeliveryDate ?? null,
    discountPercent: num(quote.discount_percent),
    notes: `Converted from quotation ${quote.quote_number}`,
    lines: lines.map((l) => ({
      productId: l.product_id,
      cases: num(l.cases),
      looseBottles: num(l.loose_bottles),
      pricePerCaseCents: num(l.price_per_case_cents),
      pricePerBottleCents: num(l.price_per_bottle_cents),
    })),
  });

  await db.tx(async (t) => {
    await t.query(
      `UPDATE quotations SET status = 'Converted', converted_order_id = $2 WHERE id = $1`,
      [quoteId, order.id],
    );
    await audit(t, actor, 'update', 'Quotation', quoteId, quote.quote_number, {
      convertedOrderId: order.id, orderNumber: order.orderNumber,
    });
  });

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    grandTotalCents: order.grandTotalCents,
  };
}

export async function setQuotationStatus(
  db: Db,
  actor: Actor,
  quoteId: string,
  status: 'Draft' | 'Sent' | 'Accepted' | 'Expired' | 'Declined',
): Promise<void> {
  requireRole(actor, 'admin', 'user');
  await db.tx(async (t) => {
    const current = await t.one<{ status: string }>(
      `SELECT status FROM quotations WHERE id = $1`, [quoteId],
    );
    if (current.status === 'Converted') {
      throw new RuleViolation('a converted quotation can no longer change status');
    }
    await t.query(`UPDATE quotations SET status = $2 WHERE id = $1`, [quoteId, status]);
    await audit(t, actor, 'update', 'Quotation', quoteId, quoteId, { status });
  });
}

export async function getQuotation(db: Db, quoteId: string) {
  const quote = await db.maybeOne(`SELECT * FROM quotations WHERE id = $1`, [quoteId]);
  if (!quote) return null;
  const lines = await db.query(
    `SELECT q.*, p.name AS product_name, p.bottles_per_case
     FROM quotation_line_items q JOIN products p ON p.id = q.product_id
     WHERE q.quote_id = $1`, [quoteId],
  );
  return { ...quote, lines };
}
