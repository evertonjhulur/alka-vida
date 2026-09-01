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

export interface PendingApproval {
  /** For a StopCorrection, the proposed changes awaiting approval. */
  payload?: Record<string, unknown> | null;
  id: string;
  requestType: 'Discount' | 'CreditNote';
  entityType: string;
  entityId: string;
  entityLabel: string | null;
  customerId: string | null;
  customerName: string | null;
  amountCents: Cents;
  discountPercent: number | null;
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
): Promise<{ approvalRequestId: string; appliedImmediately: boolean }> {
  requireRole(actor, 'admin', 'user');

  return db.tx(async (t) => {
    const inv = await t.one<{
      customer_id: string; invoice_number: string; subtotal_cents: number;
    }>(
      `SELECT customer_id, invoice_number, subtotal_cents FROM invoices WHERE id = $1`,
      [invoiceId],
    );

    const impact = computeTotals(
      [{ lineTotal: num(inv.subtotal_cents) }], discountPercent,
    ).discountAmount;

    // An Admin approves their own action inherently; a User's is queued.
    if (actor.role === 'admin') {
      await applyDiscountToInvoice(t, invoiceId, discountPercent);
      await audit(t, actor, 'update', 'Invoice', invoiceId, inv.invoice_number, {
        discountPercent, reason, approvedInline: true,
      });
      const req = await t.one<{ id: string }>(
        `INSERT INTO approval_requests
           (request_type, status, entity_type, entity_id, entity_label, customer_id,
            amount_cents, discount_percent, reason, requested_by_id,
            reviewed_by_id, reviewed_date)
         VALUES ('Discount','Approved','Invoice',$1,$2,$3,$4,$5,$6,$7,$7,now())
         RETURNING id`,
        [invoiceId, inv.invoice_number, inv.customer_id, impact,
         discountPercent, reason, actor.id],
      );
      return { approvalRequestId: req.id, appliedImmediately: true };
    }

    // Record the intent; the money does NOT move yet.
    await t.query(
      `UPDATE invoices SET discount_percent = $2, discount_status = 'Pending'
       WHERE id = $1`, [invoiceId, discountPercent],
    );
    const req = await t.one<{ id: string }>(
      `INSERT INTO approval_requests
         (request_type, entity_type, entity_id, entity_label, customer_id,
          amount_cents, discount_percent, reason, requested_by_id)
       VALUES ('Discount','Invoice',$1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [invoiceId, inv.invoice_number, inv.customer_id, impact,
       discountPercent, reason, actor.id],
    );
    await t.query(`UPDATE invoices SET approval_request_id = $2 WHERE id = $1`,
      [invoiceId, req.id]);

    await audit(t, actor, 'create', 'ApprovalRequest', req.id, inv.invoice_number, {
      requestType: 'Discount', discountPercent, reason,
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
): Promise<void> {
  const lines = await t.query<{ line_total_cents: number }>(
    `SELECT line_total_cents FROM invoice_line_items WHERE invoice_id = $1`, [invoiceId],
  );
  const totals = computeTotals(
    lines.map((l) => ({ lineTotal: num(l.line_total_cents) })), discountPercent,
  );
  await t.query(
    `UPDATE invoices
     SET subtotal_cents = $2, discount_percent = $3, discount_amount_cents = $4,
         gct_cents = $5, grand_total_cents = $6,
         discount_status = 'Approved', updated_at = now()
     WHERE id = $1`,
    [invoiceId, totals.subtotal, discountPercent, totals.discountAmount,
     totals.gct, totals.grandTotal],
  );
}

/** Everything awaiting an Admin, newest request last. */
export async function listPendingApprovals(db: Db): Promise<PendingApproval[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ar.*, c.name AS customer_name, u.name AS requested_by_name
     FROM approval_requests ar
     LEFT JOIN customers c ON c.id = ar.customer_id
     LEFT JOIN users u ON u.id = ar.requested_by_id
     WHERE ar.status = 'Pending'
     ORDER BY ar.requested_date`,
  );
  return rows.map((r) => ({
    id: r.id as string,
    requestType: r.request_type as 'Discount' | 'CreditNote' | 'StopCorrection',
    payload: (r.payload as Record<string, unknown>) ?? null,
    entityType: r.entity_type as string,
    entityId: r.entity_id as string,
    entityLabel: (r.entity_label as string) ?? null,
    customerId: (r.customer_id as string) ?? null,
    customerName: (r.customer_name as string) ?? null,
    amountCents: num(r.amount_cents),
    discountPercent: r.discount_percent === null ? null : num(r.discount_percent),
    reason: (r.reason as string) ?? null,
    requestedByName: (r.requested_by_name as string) ?? null,
    requestedDate: String(r.requested_date),
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
      payload: StopCorrection | null; reason: string | null;
    }>(
      `SELECT id, request_type, entity_id, status, discount_percent, amount_cents,
              payload, reason
       FROM approval_requests WHERE id = $1 FOR UPDATE`, [requestId],
    );
    if (req.status !== 'Pending') {
      throw new RuleViolation(`this request was already ${req.status.toLowerCase()}`);
    }

    if (decision === 'Approved') {
      if (req.request_type === 'StopCorrection') {
        // Applied by the same code path an admin correcting directly uses,
        // and attributed to the admin who approved it.
        await applyStopCorrection(t, actor, req.entity_id, req.payload ?? {},
          req.reason ?? 'approved correction');
      } else if (req.request_type === 'Discount') {
        await applyDiscountToInvoice(t, req.entity_id, num(req.discount_percent));
      } else {
        // A credit note becomes live: its value posts to the ledger.
        await t.query(
          `UPDATE invoices
           SET credit_status = 'Approved',
               subtotal_cents = $2, grand_total_cents = $2, updated_at = now()
           WHERE id = $1`,
          [req.entity_id, num(req.amount_cents)],
        );
      }
    } else if (req.request_type === 'StopCorrection') {
      // Rejected: the stop keeps exactly what the driver recorded.
    } else if (req.request_type === 'Discount') {
      // Rejected: the invoice reverts to no discount, unchanged in value.
      await t.query(
        `UPDATE invoices SET discount_status = 'Rejected', discount_percent = 0
         WHERE id = $1`, [req.entity_id],
      );
    } else {
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
