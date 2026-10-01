/**
 * Quotations (Everton's revisions, 30 Sep 2026, point 1).
 *
 * A quote is prepared for a customer, sent to them for acceptance, and once
 * accepted becomes an order that moves through delivery and invoicing like
 * any other.
 *
 * WHAT CHANGED. Quotations used to carry no GCT at all. A customer reading a
 * quote needs the price they will actually pay, so a quote now SHOWS the GCT
 * the order will attract (none for a GCT-exempt customer). It still books
 * nothing: a quote is not a sale, has no effect on any balance, and its GCT is
 * a figure on a page rather than a liability.
 *
 * Prices start at the customer's own (special price, their list, or list
 * price) and can be changed per line - a quote is where the office offers a
 * price. Converting carries the quoted prices across as explicit overrides.
 *
 * ACCEPTING. Two ways (Everton chose both):
 *   - the office marks it Accepted when the customer says yes, or the
 *     customer accepts it in their portal;
 *   - the emailed quote carries an "accept" link that works without signing
 *     in. Only a hash of the link's token is stored, the same rule
 *     invitations follow. The link works once the app is on the web; on a
 *     machine that is only reachable locally it points at localhost.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, nextNumber, requireRole, num, siteUrl } from './core.ts';
import type { Cents } from '@alka/shared';
import { computeTotals, RuleViolation } from '@alka/shared';
import { createOrder, resolveLines, type CreateOrderInput } from './orders.ts';

export interface QuotationLineInput {
  productId: string;
  cases?: number;
  looseBottles?: number;
  /** Freely editable; otherwise the customer's own price. */
  pricePerCaseCents?: Cents;
  pricePerBottleCents?: Cents;
}

export interface QuotationInput {
  customerId: string;
  lines: QuotationLineInput[];
  validUntil?: string | null;
  discountPercent?: number;
  discountFixedCents?: Cents;
  gctExempt?: boolean | null;
  deliveryMode?: 'Delivery' | 'Pickup';
  notes?: string | null;
}

const EDITABLE = ['Draft', 'Sent'];
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

function portalBaseUrl(): string {
  return siteUrl();
}
export const quoteAcceptLink = (token: string) => `${portalBaseUrl()}/#/quote/${token}`;

async function priceQuote(t: Queryable, input: QuotationInput) {
  if (!input.lines || input.lines.length === 0) {
    throw new RuleViolation('a quotation needs at least one line');
  }
  const lines = await resolveLines(t, input.customerId, input.lines);
  const cust = await t.one<{ gct_exempt: boolean }>(
    `SELECT gct_exempt FROM customers WHERE id = $1`, [input.customerId],
  );
  const gctExempt = input.gctExempt ?? cust.gct_exempt;
  const fixed = Math.max(0, Math.round(Number(input.discountFixedCents) || 0));
  const pct = fixed > 0 ? 0 : (Number(input.discountPercent) || 0);
  const totals = computeTotals(lines, pct, !gctExempt, fixed);
  return { lines, totals, gctExempt, fixed, pct };
}

async function writeLines(t: Queryable, quoteId: string,
  lines: Awaited<ReturnType<typeof resolveLines>>) {
  await t.query(`DELETE FROM quotation_line_items WHERE quote_id = $1`, [quoteId]);
  for (const l of lines) {
    await t.query(
      `INSERT INTO quotation_line_items
         (quote_id, product_id, cases, loose_bottles, total_bottles,
          price_per_case_cents, price_per_bottle_cents, line_total_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [quoteId, l.productId, l.cases, l.looseBottles, l.totalBottles,
       l.pricePerCaseCents, l.pricePerBottleCents, l.lineTotal],
    );
  }
}

export async function createQuotation(
  db: Db,
  actor: Actor,
  input: QuotationInput,
): Promise<{ id: string; quoteNumber: string; subtotalCents: Cents; gctCents: Cents; grandTotalCents: Cents }> {
  requireRole(actor, 'admin', 'user');

  return db.tx(async (t) => {
    const { lines, totals, gctExempt, fixed, pct } = await priceQuote(t, input);
    const quoteNumber = await nextNumber(t, 'quote_number_seq', 'QT');

    const quote = await t.one<{ id: string }>(
      `INSERT INTO quotations
         (quote_number, customer_id, valid_until, notes, subtotal_cents,
          discount_percent, discount_amount_cents, grand_total_cents,
          discount_fixed_cents, gct_exempt, gct_cents, delivery_mode, created_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [quoteNumber, input.customerId, input.validUntil || null, input.notes?.trim() || null,
       totals.subtotal, pct, totals.discountAmount, totals.grandTotal,
       fixed, gctExempt, totals.gct, input.deliveryMode === 'Pickup' ? 'Pickup' : 'Delivery',
       actor.id],
    );
    await writeLines(t, quote.id, lines);

    await audit(t, actor, 'create', 'Quotation', quote.id, quoteNumber, {
      customerId: input.customerId, grandTotalCents: totals.grandTotal, gctCents: totals.gct,
    });

    return {
      id: quote.id, quoteNumber,
      subtotalCents: totals.subtotal,
      gctCents: totals.gct,
      grandTotalCents: totals.grandTotal,
    };
  });
}

/** Change a quote that has not been accepted yet. */
export async function updateQuotation(
  db: Db, actor: Actor, quoteId: string, input: QuotationInput,
): Promise<{ grandTotalCents: Cents }> {
  requireRole(actor, 'admin', 'user');
  return db.tx(async (t) => {
    const q = await t.maybeOne<{ status: string; quote_number: string; customer_id: string }>(
      `SELECT status, quote_number, customer_id FROM quotations WHERE id = $1 FOR UPDATE`, [quoteId],
    );
    if (!q) throw new RuleViolation('that quotation no longer exists');
    if (!EDITABLE.includes(q.status)) {
      throw new RuleViolation(`quotation ${q.quote_number} is ${q.status.toLowerCase()} and can no longer be changed`);
    }
    const { lines, totals, gctExempt, fixed, pct } = await priceQuote(t,
      { ...input, customerId: input.customerId || q.customer_id });
    await t.query(
      `UPDATE quotations SET customer_id = $2, valid_until = $3, notes = $4, subtotal_cents = $5,
         discount_percent = $6, discount_amount_cents = $7, grand_total_cents = $8,
         discount_fixed_cents = $9, gct_exempt = $10, gct_cents = $11, delivery_mode = $12,
         updated_at = now()
       WHERE id = $1`,
      [quoteId, input.customerId || q.customer_id, input.validUntil || null,
       input.notes?.trim() || null, totals.subtotal, pct, totals.discountAmount,
       totals.grandTotal, fixed, gctExempt, totals.gct,
       input.deliveryMode === 'Pickup' ? 'Pickup' : 'Delivery'],
    );
    await writeLines(t, quoteId, lines);
    await audit(t, actor, 'update', 'Quotation', quoteId, q.quote_number,
      { grandTotalCents: totals.grandTotal });
    return { grandTotalCents: totals.grandTotal };
  });
}

/** A quote never sent can be thrown away; after that it is declined instead. */
export async function deleteQuotation(db: Db, actor: Actor, quoteId: string): Promise<void> {
  requireRole(actor, 'admin', 'user');
  await db.tx(async (t) => {
    const q = await t.one<{ status: string; quote_number: string }>(
      `SELECT status, quote_number FROM quotations WHERE id = $1`, [quoteId],
    );
    if (q.status !== 'Draft') {
      throw new RuleViolation(`${q.quote_number} has gone to the customer; mark it declined instead`);
    }
    await t.query(`DELETE FROM quotations WHERE id = $1`, [quoteId]);
    await audit(t, actor, 'delete', 'Quotation', quoteId, q.quote_number, {});
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
    deliveryMode?: CreateOrderInput['deliveryMode'];
    requestedDeliveryDate?: string | null;
    addressId?: string | null;
  } = {},
): Promise<{ orderId: string; orderNumber: string; grandTotalCents: Cents; warnings: string[] }> {
  requireRole(actor, 'admin', 'user');

  const quote = await db.maybeOne<{
    id: string; customer_id: string; status: string; quote_number: string;
    discount_percent: number; discount_fixed_cents: number; gct_exempt: boolean;
    delivery_mode: string; notes: string | null;
  }>(
    `SELECT id, customer_id, status, quote_number, discount_percent, discount_fixed_cents,
            gct_exempt, delivery_mode, notes
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
    deliveryMode: options.deliveryMode ?? (quote.delivery_mode as 'Delivery' | 'Pickup'),
    requestedDeliveryDate: options.requestedDeliveryDate ?? null,
    addressId: options.addressId ?? null,
    discountPercent: num(quote.discount_percent),
    discountFixedCents: num(quote.discount_fixed_cents),
    gctExempt: quote.gct_exempt,
    quotationId: quote.id,
    notes: `From quotation ${quote.quote_number}` + (quote.notes ? ` - ${quote.notes}` : ''),
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
      `UPDATE quotations SET status = 'Converted', converted_order_id = $2,
         accepted_at = COALESCE(accepted_at, now()),
         accepted_via = COALESCE(accepted_via, 'Office'), updated_at = now()
       WHERE id = $1`,
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
    warnings: order.warnings,
  };
}

export async function setQuotationStatus(
  db: Db,
  actor: Actor,
  quoteId: string,
  status: 'Draft' | 'Sent' | 'Accepted' | 'Expired' | 'Declined',
  reason?: string | null,
): Promise<void> {
  requireRole(actor, 'admin', 'user', 'customer');
  await db.tx(async (t) => {
    const current = await t.one<{ status: string; quote_number: string }>(
      `SELECT status, quote_number FROM quotations WHERE id = $1`, [quoteId],
    );
    if (current.status === 'Converted') {
      throw new RuleViolation('a converted quotation can no longer change status');
    }
    const via = actor.role === 'customer' ? 'Portal' : 'Office';
    await t.query(
      `UPDATE quotations SET status = $2, updated_at = now(),
         accepted_at = CASE WHEN $2 = 'Accepted' THEN now() ELSE accepted_at END,
         accepted_via = CASE WHEN $2 = 'Accepted' THEN $3 ELSE accepted_via END,
         decline_reason = CASE WHEN $2 = 'Declined' THEN $4 ELSE decline_reason END
       WHERE id = $1`, [quoteId, status, via, reason ?? null],
    );
    await audit(t, actor, 'update', 'Quotation', quoteId, current.quote_number, { status, via, reason });
  });
}

/** A portal customer accepting or declining a quote made out to them. */
export async function respondAsCustomer(
  db: Db, actor: Actor, customerId: string, quoteId: string,
  decision: 'Accepted' | 'Declined', reason?: string | null,
): Promise<void> {
  const q = await db.maybeOne<{ customer_id: string; status: string; valid_until: string | null }>(
    `SELECT customer_id, status, valid_until::text AS valid_until FROM quotations WHERE id = $1`,
    [quoteId],
  );
  if (!q || q.customer_id !== customerId) throw new RuleViolation('that quotation could not be found');
  if (q.status !== 'Sent') throw new RuleViolation('this quotation is no longer waiting for an answer');
  await setQuotationStatus(db, actor, quoteId, decision, reason);
}

/** A fresh accept link, replacing any earlier one. Marks the quote Sent. */
export async function issueAcceptToken(t: Queryable, quoteId: string): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  await t.query(
    `UPDATE quotations SET accept_token_hash = $2,
       status = CASE WHEN status = 'Draft' THEN 'Sent' ELSE status END,
       sent_date = business_today(), updated_at = now()
     WHERE id = $1`, [quoteId, hashToken(token)],
  );
  return token;
}

/** PUBLIC: what the accept link shows. Nothing beyond the quote itself. */
export async function quoteByToken(db: Db, token: string) {
  if (!token || token.length < 20) return null;
  const q = await db.maybeOne<Record<string, unknown>>(
    `SELECT q.id, q.quote_number, q.quote_date::text AS quote_date,
            q.valid_until::text AS valid_until, q.status, q.subtotal_cents,
            q.discount_amount_cents, q.gct_cents, q.gct_exempt, q.grand_total_cents,
            q.notes, q.delivery_mode, c.name AS customer_name
     FROM quotations q JOIN customers c ON c.id = q.customer_id
     WHERE q.accept_token_hash = $1`, [hashToken(token)],
  );
  if (!q) return null;
  const lines = await db.query(
    `SELECT p.name AS product_name, p.bottles_per_case, l.cases, l.loose_bottles,
            l.price_per_case_cents, l.price_per_bottle_cents, l.line_total_cents
     FROM quotation_line_items l JOIN products p ON p.id = l.product_id
     WHERE l.quote_id = $1 ORDER BY p.name`, [q.id],
  );
  const { id: _id, ...rest } = q;
  return { ...rest, lines };
}

/** PUBLIC: the customer answers through the link. */
export async function answerByToken(
  db: Db, token: string, decision: 'Accepted' | 'Declined', reason?: string | null,
): Promise<{ status: string; quoteNumber: string }> {
  const q = await db.maybeOne<{ id: string; status: string; quote_number: string; valid_until: string | null }>(
    `SELECT id, status, quote_number, valid_until::text AS valid_until
     FROM quotations WHERE accept_token_hash = $1`, [hashToken(token ?? '')],
  );
  if (!q) throw new RuleViolation('this link is not valid. Please contact us for a fresh copy of the quote.');
  if (q.status === 'Accepted' || q.status === 'Converted') {
    return { status: 'Accepted', quoteNumber: q.quote_number };
  }
  if (q.status !== 'Sent') {
    throw new RuleViolation(`quotation ${q.quote_number} is ${q.status.toLowerCase()} and can no longer be answered here`);
  }
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Jamaica' }).format(new Date());
  if (decision === 'Accepted' && q.valid_until && q.valid_until < today) {
    throw new RuleViolation(`quotation ${q.quote_number} expired on ${q.valid_until}. Please contact us for an updated quote.`);
  }
  await db.tx(async (t) => {
    await t.query(
      `UPDATE quotations SET status = $2, updated_at = now(),
         accepted_at = CASE WHEN $2 = 'Accepted' THEN now() ELSE accepted_at END,
         accepted_via = CASE WHEN $2 = 'Accepted' THEN 'Email link' ELSE accepted_via END,
         decline_reason = CASE WHEN $2 = 'Declined' THEN $3 ELSE decline_reason END
       WHERE id = $1`, [q.id, decision, reason?.trim() || null],
    );
    await audit(t, null, 'update', 'Quotation', q.id, q.quote_number,
      { status: decision, via: 'Email link', reason: reason ?? null });
  });
  return { status: decision, quoteNumber: q.quote_number };
}

export async function listQuotations(db: Db, opts: { customerId?: string | null; status?: string | null } = {}) {
  return db.query(
    `SELECT q.id, q.quote_number, q.quote_date::text AS quote_date,
            q.valid_until::text AS valid_until, q.status, q.grand_total_cents,
            q.customer_id, c.name AS customer_name, q.sent_date::text AS sent_date,
            q.accepted_at, q.accepted_via, q.converted_order_id, o.order_number AS converted_order_number,
            (SELECT string_agg(
                      CASE WHEN l.cases > 0 THEN l.cases || ' cs ' ELSE l.loose_bottles || ' x ' END
                      || p.name, ', ' ORDER BY p.name)
               FROM quotation_line_items l JOIN products p ON p.id = l.product_id
              WHERE l.quote_id = q.id) AS lines_summary,
            (q.valid_until IS NOT NULL AND q.valid_until < business_today()
              AND q.status IN ('Draft','Sent')) AS expired
     FROM quotations q
     JOIN customers c ON c.id = q.customer_id
     LEFT JOIN customer_orders o ON o.id = q.converted_order_id
     WHERE ($1::uuid IS NULL OR q.customer_id = $1::uuid)
       AND ($2::text IS NULL OR q.status = $2)
     ORDER BY q.created_at DESC
     LIMIT 300`,
    [opts.customerId ?? null, opts.status ?? null],
  );
}

export async function getQuotation(db: Db, quoteId: string) {
  const quote = await db.maybeOne(
    `SELECT q.*, q.quote_date::text AS quote_date, q.valid_until::text AS valid_until,
            q.sent_date::text AS sent_date, c.name AS customer_name, c.email AS customer_email,
            o.order_number AS converted_order_number
     FROM quotations q JOIN customers c ON c.id = q.customer_id
     LEFT JOIN customer_orders o ON o.id = q.converted_order_id
     WHERE q.id = $1`, [quoteId],
  );
  if (!quote) return null;
  const lines = await db.query(
    `SELECT q.*, p.name AS product_name, p.bottles_per_case
     FROM quotation_line_items q JOIN products p ON p.id = q.product_id
     WHERE q.quote_id = $1 ORDER BY p.name`, [quoteId],
  );
  return { ...quote, lines };
}
