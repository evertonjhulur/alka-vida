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
import { placeOnDeliverySheet, sameDayCheck } from './orders.ts';
import { businessToday } from './core.ts';

export interface PendingApproval {
  /** For a StopCorrection, the proposed changes awaiting approval. */
  payload?: Record<string, unknown> | null;
  id: string;
  requestType: 'Discount' | 'CreditNote' | 'StopCorrection' | 'SameDayOrder' | 'PaymentChange';
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
  const lines = await t.query<{ line_total_cents: number }>(
    `SELECT line_total_cents FROM invoice_line_items WHERE invoice_id = $1`, [invoiceId],
  );
  const inv = await t.one<{ gct_exempt: boolean }>(
    `SELECT gct_exempt FROM invoices WHERE id = $1`, [invoiceId],
  );
  const fixed = Math.max(0, num(discountFixedCents));
  const pct = fixed > 0 ? 0 : discountPercent;
  const totals = computeTotals(
    lines.map((l) => ({ lineTotal: num(l.line_total_cents) })), pct, !inv.gct_exempt, fixed,
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
): Promise<{ status: string }> {
  requireRole(actor, 'admin');

  return db.tx(async (t) => {
    const req = await t.one<{
      id: string; request_type: string; entity_id: string; status: string;
      discount_percent: number | null; amount_cents: number;
      payload: StopCorrection | null; reason: string | null; discount_fixed_cents: number | null;
    }>(
      `SELECT id, request_type, entity_id, status, discount_percent, amount_cents,
              payload, reason, discount_fixed_cents
       FROM approval_requests WHERE id = $1 FOR UPDATE`, [requestId],
    );
    if (req.status !== 'Pending') {
      throw new RuleViolation(`this request was already ${req.status.toLowerCase()}`);
    }

    if (req.request_type === 'SameDayOrder') {
      await decideSameDayOrder(t, actor, req.entity_id, decision);
    } else if (req.request_type === 'PaymentChange') {
      if (decision === 'Approved') {
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
        const p = (req.payload ?? {}) as unknown as { subtotalCents?: number; gctCents?: number };
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
    });

    return { status: decision };
  });
}

/**
 * A same-day order that came in after the cut-off.
 *
 * Approved: it goes on today's round after all (or the day it asked for, if
 * that has not passed). Not approved: it is NOT cancelled - the customer
 * still wants the water - it goes on their next delivery day instead.
 */
async function decideSameDayOrder(
  t: Parameters<typeof audit>[0], actor: Actor, orderId: string, decision: 'Approved' | 'Rejected',
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
  const today = businessToday();
  let date: string | null;
  if (decision === 'Approved') {
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
    sameDayDecision: decision, deliveryDate: date,
  });
}
