/**
 * Discount / credit-note approval queue (Section 5).
 *
 * This covers the ORDINARY discretionary case: a discount a User applies, or
 * a credit note a User raises. It is deliberately distinct from an
 * Admin-driven invoice correction, where the Admin's own edit is the
 * authorisation and no request is raised at all.
 *
 * A queued discount is saved immediately and the sale or delivery proceeds
 * without delay - but it does not reduce what is owed until an Admin approves
 * it. An alert is raised the moment it is submitted so approval never
 * bottlenecks operations.
 */

import type { Db } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, requireRole, num } from './core.ts';
import type { Cents } from '@alka/shared';
import { computeTotals, RuleViolation } from '@alka/shared';
import { applyStopCorrection, type StopCorrection } from './settlement.ts';
import { applyPaymentChange, type PaymentChange } from './payments.ts';
import { applyApprovedPaymentFix, type PaymentFix } from './paymentfix.ts';
import { placeOnDeliverySheet, sameDayCheck } from './orders.ts';
import { businessToday } from './core.ts';
import { autoApplyLinked } from './creditapply.ts';

export interface PendingApproval {
  /** For a StopCorrection, the proposed changes awaiting approval. */
  payload?: Record<string, unknown> | null;
  id: string;
  requestType: 'Discount' | 'CreditNote' | 'StopCorrection' | 'SameDayOrder' | 'PaymentChange' | 'SpecialDayOrder';
  entityType: string;
  entityId: string;
  entityLabel: string | null;
  customerId: string | null;
  customerName: string | null;
  amountCents: Cents;
  discountPercent: number | null;
  discountFixedCents?: number | null;
  reason: string | null;
  requestedByName: string | null;
  requestedDate: string;
}

/** Request a discount on an already-issued invoice. Saved, but not yet live. */
export async function requestInvoiceDiscount(
  db: Db,
  actor: Actor,
  invoiceId: string,
  discountPercent: number,
  reason: string,
  discountFixedCents = 0,
): Promise<{ approvalRequestId: string; appliedImmediately: boolean }> {
  requireRole(actor, 'admin', 'user');
  const fixed = Math.max(0, Math.round(Number(discountFixedCents) || 0));
  const pct = fixed > 0 ? 0 : (Number(discountPercent) || 0);

  return db.tx(async (t) => {
    const inv = await t.one<{
      customer_id: string; invoice_number: string; subtotal_cents: number;
    }>(
      `SELECT customer_id, invoice_number, subtotal_cents FROM invoices WHERE id = $1`,
      [invoiceId],
    );

    const impact = computeTotals(
      [{ lineTotal: num(inv.subtotal_cents) }], pct, true, fixed,
    ).discountAmount;

    // An Admin approves their own action inherently; a User's is queued.
    if (actor.role === 'admin') {
      await applyDiscountToInvoice(t, invoiceId, pct, fixed);
      await audit(t, actor, 'update', 'Invoice', invoiceId, inv.invoice_number, {
        discountPercent: pct, discountFixedCents: fixed, reason, approvedInline: true,
      });
      const req = await t.one<{ id: string }>(
        `INSERT INTO approval_requests
           (request_type, status, entity_type, entity_id, entity_label, customer_id,
            amount_cents, discount_percent, reason, requested_by_id,
            reviewed_by_id, reviewed_date, discount_fixed_cents)
         VALUES ('Discount','Approved','Invoice',$1,$2,$3,$4,$5,$6,$7,$7,now(),$8)
         RETURNING id`,
        [invoiceId, inv.invoice_number, inv.customer_id, impact,
         pct, reason, actor.id, fixed],
      );
      return { approvalRequestId: req.id, appliedImmediately: true };
    }

    // Record the intent; the money does NOT move yet.
    await t.query(
      `UPDATE invoices SET discount_percent = $2, discount_fixed_cents = $3,
         discount_status = 'Pending'
       WHERE id = $1`, [invoiceId, pct, fixed],
    );
    const req = await t.one<{ id: string }>(
      `INSERT INTO approval_requests
         (request_type, entity_type, entity_id, entity_label, customer_id,
          amount_cents, discount_percent, reason, requested_by_id, discount_fixed_cents)
       VALUES ('Discount','Invoice',$1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [invoiceId, inv.invoice_number, inv.customer_id, impact,
       pct, reason, actor.id, fixed],
    );
    await t.query(`UPDATE invoices SET approval_request_id = $2 WHERE id = $1`,
      [invoiceId, req.id]);

    await audit(t, actor, 'create', 'ApprovalRequest', req.id, inv.invoice_number, {
      requestType: 'Discount', discountPercent: pct, discountFixedCents: fixed, reason,
      note: 'saved immediately; does not reduce the amount owed until approved',
    });
    return { approvalRequestId: req.id, appliedImmediately: false };
  });
}

/** Recalculate an invoice with the discount actually in force. */
async function applyDiscountToInvoice(
  t: Parameters<typeof audit>[0],
  invoiceId: string,
  discountPercent: number,
  discountFixedCents = 0,
): Promise<void> {
  const lines = await t.query<{
    line_total_cents: number; cases: number; loose_bottles: number;
    price_per_case_cents: number; price_per_bottle_cents: number;
  }>(
    `SELECT line_total_cents, cases, loose_bottles, price_per_case_cents, price_per_bottle_cents
     FROM invoice_line_items WHERE invoice_id = $1`, [invoiceId],
  );
  const inv = await t.one<{ gct_exempt: boolean }>(
    `SELECT gct_exempt FROM invoices WHERE id = $1`, [invoiceId],
  );
  const fixed = Math.max(0, num(discountFixedCents));
  const pct = fixed > 0 ? 0 : discountPercent;
  const totals = computeTotals(
    lines.map((l) => ({
      lineTotal: num(l.line_total_cents), cases: num(l.cases), looseBottles: num(l.loose_bottles),
      pricePerCaseCents: num(l.price_per_case_cents), pricePerBottleCents: num(l.price_per_bottle_cents),
    })), pct, !inv.gct_exempt, fixed,
  );
  await t.query(
    `UPDATE invoices
     SET subtotal_cents = $2, discount_percent = $3, discount_amount_cents = $4,
         gct_cents = $5, grand_total_cents = $6, discount_fixed_cents = $7,
         discount_status = 'Approved', updated_at = now()
     WHERE id = $1`,
    [invoiceId, totals.subtotal, pct, totals.discountAmount,
     totals.gct, totals.grandTotal, fixed],
  );
}

/**
 * An order's discount decided (19 Nov 2026). The order and any of its
 * standing-order runs still waiting on it take the decision; invoices already
 * raised from them are put right:
 *  - approved: each invoice's discount starts to count (on a weekly/monthly
 *    invoice, once no order on it is still waiting);
 *  - turned down: the discount comes off the order(s) and their invoices.
 */
async function decideOrderDiscount(
  t: Parameters<typeof audit>[0], orderId: string, decision: 'Approved' | 'Rejected',
): Promise<void> {
  const orders = (await t.query<{ id: string }>(
    `SELECT id FROM customer_orders
     WHERE id = $1 OR (parent_recurring_id = $1 AND discount_status = 'Pending')`, [orderId])).map((r) => r.id);

  if (decision === 'Approved') {
    await t.query(`UPDATE customer_orders SET discount_status = 'Approved' WHERE id = ANY($1::uuid[])`, [orders]);
  } else {
    // Off the order, its totals worked out again without it.
    for (const id of orders) {
      const o = await t.one<{ gct_exempt: boolean }>(`SELECT gct_exempt FROM customer_orders WHERE id = $1`, [id]);
      const lines = await t.query<{ line_total: number }>(
        `SELECT CASE WHEN p.bottles_per_case > 0 THEN oli.cases * oli.price_per_case_cents
                     ELSE oli.loose_bottles * oli.price_per_bottle_cents END AS line_total
         FROM order_line_items oli JOIN products p ON p.id = oli.product_id WHERE oli.order_id = $1`, [id]);
      const totals = computeTotals(lines.map((l) => ({ lineTotal: num(l.line_total) })), 0, !o.gct_exempt, 0);
      await t.query(
        `UPDATE customer_orders
         SET discount_status = 'Rejected', discount_percent = 0, discount_fixed_cents = 0,
             subtotal_cents = $2, discount_amount_cents = 0, gct_cents = $3, grand_total_cents = $4
         WHERE id = $1`, [id, totals.subtotal, totals.gct, totals.grandTotal]);
    }
  }

  const invoices = await t.query<{
    id: string; discount_percent: number; discount_fixed_cents: number; orders: number;
  }>(
    `SELECT i.id, i.discount_percent, i.discount_fixed_cents,
            (SELECT COUNT(*)::int FROM invoice_orders x WHERE x.invoice_id = i.id) AS orders
     FROM invoices i
     WHERE NOT i.is_credit_note AND i.lifecycle <> 'Cancelled' AND i.discount_status = 'Pending'
       AND i.id IN (SELECT invoice_id FROM invoice_orders WHERE order_id = ANY($1::uuid[]))`, [orders]);
  for (const inv of invoices) {
    if (num(inv.orders) <= 1) {
      if (decision === 'Approved') {
        await applyDiscountToInvoice(t, inv.id, num(inv.discount_percent), num(inv.discount_fixed_cents));
      } else {
        await t.query(
          `UPDATE invoices SET discount_status = 'Rejected', discount_percent = 0, discount_fixed_cents = 0
           WHERE id = $1`, [inv.id]);
      }
      continue;
    }
    // A weekly/monthly invoice: each order's own discount on its own lines.
    const parts = await t.query<{ status: string; pct: number; fixed: number; sub: number }>(
      `SELECT o.discount_status AS status, o.discount_percent AS pct, o.discount_fixed_cents AS fixed,
              COALESCE(SUM(li.line_total_cents), 0)::bigint AS sub
       FROM invoice_orders io
       JOIN customer_orders o ON o.id = io.order_id
       LEFT JOIN invoice_line_items li ON li.invoice_id = io.invoice_id AND li.order_id = o.id
       WHERE io.invoice_id = $1
       GROUP BY o.id, o.discount_status, o.discount_percent, o.discount_fixed_cents`, [inv.id]);
    if (parts.some((p) => p.status === 'Pending' && (num(p.pct) > 0 || num(p.fixed) > 0))) continue;
    let discount = 0;
    for (const p of parts) {
      if (p.status !== 'Approved') continue;
      discount += num(p.fixed) > 0 ? Math.min(num(p.fixed), num(p.sub)) : Math.round(num(p.sub) * (num(p.pct) / 100));
    }
    await applyDiscountToInvoice(t, inv.id, 0, discount);
  }
}

/** Everything awaiting an Admin, newest request last. */
export async function listPendingApprovals(db: Db): Promise<PendingApproval[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ar.*, business_date(ar.requested_date)::text AS requested_on,
            c.name AS customer_name, u.name AS requested_by_name
     FROM approval_requests ar
     LEFT JOIN customers c ON c.id = ar.customer_id
     LEFT JOIN users u ON u.id = ar.requested_by_id
     WHERE ar.status = 'Pending'
     ORDER BY ar.requested_date`,
  );
  return rows.map((r) => ({
    id: r.id as string,
    requestType: r.request_type as PendingApproval['requestType'],
    payload: (r.payload as Record<string, unknown>) ?? null,
    entityType: r.entity_type as string,
    entityId: r.entity_id as string,
    entityLabel: (r.entity_label as string) ?? null,
    customerId: (r.customer_id as string) ?? null,
    customerName: (r.customer_name as string) ?? null,
    amountCents: num(r.amount_cents),
    discountPercent: r.discount_percent === null ? null : num(r.discount_percent),
    discountFixedCents: r.discount_fixed_cents == null ? null : num(r.discount_fixed_cents),
    reason: (r.reason as string) ?? null,
    requestedByName: (r.requested_by_name as string) ?? null,
    requestedDate: String(r.requested_on),
  }));
}

/**
 * Approve or reject. Admin only, and a User can never approve their own or
 * anyone else's request.
 *
 * Approving adjusts the invoice; rejecting leaves it unchanged but visible
 * for reference.
 */
export async function reviewApproval(
  db: Db,
  actor: Actor,
  requestId: string,
  decision: 'Approved' | 'Rejected',
  reviewNotes?: string,
  /**
   * For an order waiting on its day (15 Oct 2026): approve it for a date the
   * admin chooses, or cancel it outright.
   */
  opts: { deliveryDate?: string | null; cancel?: boolean } = {},
): Promise<{ status: string; orderCancelled?: boolean; orderId?: string }> {
  requireRole(actor, 'admin');

  return db.tx(async (t) => {
    const req = await t.one<{
      id: string; request_type: string; entity_id: string; status: string; entity_type: string;
      discount_percent: number | null; amount_cents: number;
      payload: StopCorrection | null; reason: string | null; discount_fixed_cents: number | null;
    }>(
      `SELECT id, request_type, entity_id, entity_type, status, discount_percent, amount_cents,
              payload, reason, discount_fixed_cents
       FROM approval_requests WHERE id = $1 FOR UPDATE`, [requestId],
    );
    if (req.status !== 'Pending') {
      throw new RuleViolation(`this request was already ${req.status.toLowerCase()}`);
    }

    let orderCancelled = false;
    if (req.request_type === 'Discount' && req.entity_type === 'CustomerOrder') {
      // A discount put on an order by office staff (19 Nov 2026).
      await decideOrderDiscount(t, req.entity_id, decision);
    } else if (req.request_type === 'SameDayOrder' || req.request_type === 'SpecialDayOrder') {
      if (opts.cancel) {
        await cancelWaitingOrder(t, actor, req.entity_id, reviewNotes ?? null);
        orderCancelled = true;
        decision = 'Rejected';
      } else {
        await decideSameDayOrder(t, actor, req.entity_id, decision, opts.deliveryDate ?? null,
          req.request_type === 'SpecialDayOrder');
      }
    } else if (req.request_type === 'PaymentChange') {
      const fix = (req.payload as unknown as { fix?: PaymentFix } | null)?.fix;
      if (decision === 'Approved' && fix) {
        // The payment ⋯ menu (4 Nov 2026): edit, move, reverse or delete.
        await applyApprovedPaymentFix(t, actor, req.entity_id, fix, req.reason ?? null);
      } else if (decision === 'Approved') {
        await applyPaymentChange(t, actor, req.entity_id,
          (req.payload ?? {}) as unknown as PaymentChange, req.reason ?? 'approved change');
      }
      // Rejected: the payment stays exactly as posted.
    } else if (decision === 'Approved') {
      if (req.request_type === 'StopCorrection') {
        // Applied by the same code path an admin correcting directly uses,
        // and attributed to the admin who approved it.
        await applyStopCorrection(t, actor, req.entity_id, req.payload ?? {},
          req.reason ?? 'approved correction');
      } else if (req.request_type === 'Discount') {
        await applyDiscountToInvoice(t, req.entity_id, num(req.discount_percent),
          num(req.discount_fixed_cents ?? 0));
      } else if (req.request_type === 'CreditNote') {
        // A credit note becomes live: its value posts to the ledger, with the
        // GCT split it was raised with (older requests carry none).
        const p = (req.payload ?? {}) as unknown as { subtotalCents?: number; gctCents?: number; applyToOpenInvoices?: boolean };
        const total = num(req.amount_cents);
        const gct = p.gctCents !== undefined ? num(p.gctCents) : 0;
        const subtotal = p.subtotalCents !== undefined ? num(p.subtotalCents) : total;
        await t.query(
          `UPDATE invoices
           SET credit_status = 'Approved',
               subtotal_cents = $2, gct_cents = $3, grand_total_cents = $4, updated_at = now()
           WHERE id = $1`,
          [req.entity_id, subtotal, gct, total],
        );
        // Raised against an invoice: it settles that invoice (4 Nov 2026).
        await autoApplyLinked(t, actor, req.entity_id, { toOpenInvoices: !!p.applyToOpenInvoices });
      }
    } else if (req.request_type === 'StopCorrection') {
      // Rejected: the stop keeps exactly what the driver recorded.
    } else if (req.request_type === 'Discount') {
      // Rejected: the invoice reverts to no discount, unchanged in value.
      await t.query(
        `UPDATE invoices SET discount_status = 'Rejected', discount_percent = 0,
           discount_fixed_cents = 0
         WHERE id = $1`, [req.entity_id],
      );
    } else if (req.request_type === 'CreditNote') {
      await t.query(
        `UPDATE invoices SET credit_status = 'Rejected' WHERE id = $1`, [req.entity_id],
      );
    }

    await t.query(
      `UPDATE approval_requests
       SET status = $2, reviewed_by_id = $3, reviewed_date = now(), review_notes = $4
       WHERE id = $1`,
      [requestId, decision, actor.id, reviewNotes ?? null],
    );

    await audit(t, actor, 'update', 'ApprovalRequest', requestId, req.request_type, {
      decision, reviewNotes: reviewNotes ?? null, entityId: req.entity_id,
      ...(opts.deliveryDate ? { deliveryDate: opts.deliveryDate } : {}),
      ...(orderCancelled ? { orderCancelled: true } : {}),
    });

    return { status: decision, orderCancelled, orderId: req.entity_id };
  });
}

/**
 * A same-day order that came in after the cut-off.
 *
 * Approved: it goes on today's round after all (or the day it asked for, if
 * that has not passed). Not approved: it is NOT cancelled - the customer
 * still wants the water - it goes on their next delivery day instead.
 */
/** Cancel an order that was waiting for its day to be decided. */
async function cancelWaitingOrder(
  t: Parameters<typeof audit>[0], actor: Actor, orderId: string, reason: string | null,
): Promise<void> {
  const o = await t.one<{ status: string; order_number: string }>(
    `SELECT status, order_number FROM customer_orders WHERE id = $1 FOR UPDATE`, [orderId],
  );
  if (o.status === 'Cancelled') return;
  if (o.status !== 'Pending') throw new RuleViolation(`${o.order_number} is ${o.status.toLowerCase()} and cannot be cancelled`);
  await t.query(`UPDATE customer_orders SET status = 'Cancelled', needs_review = false WHERE id = $1`, [orderId]);
  await t.query(`DELETE FROM delivery_stops WHERE order_id = $1 AND stop_outcome = 'Pending'`, [orderId]);
  await audit(t, actor, 'update', 'CustomerOrder', orderId, o.order_number, {
    status: 'Cancelled', reason: reason ?? 'declined under Needs a decision',
  });
}

async function decideSameDayOrder(
  t: Parameters<typeof audit>[0], actor: Actor, orderId: string, decision: 'Approved' | 'Rejected',
  chosenDate: string | null = null, specialDay = false,
): Promise<void> {
  const o = await t.one<{
    customer_id: string; status: string; requested_delivery_date: string | null;
    address_id: string | null; delivery_mode: string; order_number: string;
  }>(
    `SELECT customer_id, status, requested_delivery_date::text AS requested_delivery_date,
            address_id, delivery_mode, order_number
     FROM customer_orders WHERE id = $1 FOR UPDATE`, [orderId],
  );
  if (o.status === 'Cancelled') return;
  // Already delivered (or part delivered) while it waited for this decision:
  // nothing to place and no date to change (27 Oct 2026, SO-001018).
  if (o.status === 'Delivered' || o.status === 'Partially Delivered') {
    await t.query(`UPDATE customer_orders SET needs_review = false WHERE id = $1`, [orderId]);
    await audit(t, actor, 'update', 'CustomerOrder', orderId, o.order_number, {
      [specialDay ? 'specialDayDecision' : 'sameDayDecision']: decision, alreadyDelivered: true,
    });
    return;
  }
  const today = businessToday();
  let date: string | null;
  if (chosenDate) {
    // The admin picked the day (15 Oct 2026).
    if (!/^\d{4}-\d{2}-\d{2}$/.test(chosenDate)) throw new RuleViolation('that is not a date');
    if (chosenDate < today) throw new RuleViolation('choose today or a later day');
    date = chosenDate;
  } else if (decision === 'Approved') {
    date = o.requested_delivery_date && o.requested_delivery_date > today ? o.requested_delivery_date : today;
  } else {
    // Next delivery day from tomorrow: sameDayCheck with no date asked for.
    const next = await sameDayCheck(t, { ...actor, role: 'admin' }, o.customer_id,
      o.delivery_mode as never, null, o.address_id);
    date = next.date && next.date > today ? next.date : null;
    if (!date) {
      const tomorrow = await t.one<{ d: string }>(`SELECT (business_today() + 1)::text AS d`);
      date = tomorrow.d;
    }
  }
  await t.query(
    `UPDATE customer_orders SET needs_review = false, requested_delivery_date = $2 WHERE id = $1`,
    [orderId, date],
  );
  if (o.delivery_mode === 'Delivery') {
    await placeOnDeliverySheet(t, orderId, o.customer_id, date, o.address_id);
  }
  await audit(t, actor, 'update', 'CustomerOrder', orderId, o.order_number, {
    [specialDay ? 'specialDayDecision' : 'sameDayDecision']: chosenDate ? 'Date changed' : decision, deliveryDate: date,
  });
}
