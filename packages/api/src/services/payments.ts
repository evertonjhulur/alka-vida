/**
 * Payments and ledger corrections (Section 3 Step 4, Section 4, Section 5).
 *
 * A payment is always simply a Payment. Whether invoice_id is filled in or
 * left blank is a detail of that one record - never a distinct category,
 * label or code branch. There is deliberately no "on-account credit" concept
 * anywhere in this file, and none may be added.
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, BUSINESS_TIMEZONE, requireRole, withIdempotency, num } from './core.ts';
import type { Cents, PaymentMethod } from '@alka/shared';
import { RuleViolation, planPayments, validateAllocation } from '@alka/shared';

export interface RecordPaymentInput {
  customerId: string;
  amountCents: Cents;
  method: PaymentMethod;
  /** Optional. Blank simply means the payment is not attached to an invoice. */
  invoiceId?: string | null;
  reference?: string | null;
  notes?: string | null;
  paymentDate?: string | null;
  deliverySheetId?: string | null;
  deliveryStopId?: string | null;
  kind?: string | null;
  /** Duplicate-submission guard for the office "Record Payment" button. */
  idempotencyKey?: string | null;
}

/** The one low-level insert every Confirmed payment goes through. */
export async function insertPayment(
  t: Queryable,
  actor: Actor | null,
  input: RecordPaymentInput & { status?: 'Provisional' | 'Confirmed' },
): Promise<{ id: string }> {
  if (input.amountCents === 0) throw new RuleViolation('a payment cannot be for zero');

  const row = await t.one<{ id: string }>(
    `INSERT INTO payments
       (customer_id, invoice_id, amount_cents, payment_date, method, reference,
        notes, status, delivery_sheet_id, delivery_stop_id, kind, created_by_id)
     VALUES ($1,$2,$3,COALESCE($4::timestamptz, now()),$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [input.customerId, input.invoiceId ?? null, input.amountCents,
     input.paymentDate ?? null, input.method, input.reference ?? null,
     input.notes ?? null, input.status ?? 'Confirmed',
     input.deliverySheetId ?? null, input.deliveryStopId ?? null,
     input.kind ?? null, actor?.id ?? null],
  );

  await audit(t, actor, 'pay', 'Payment', row.id, input.reference ?? row.id, {
    customerId: input.customerId,
    invoiceId: input.invoiceId ?? null,
    amountCents: input.amountCents,
    method: input.method,
    status: input.status ?? 'Confirmed',
  });
  return row;
}

/** Office "Record Payment". Guarded against double submission. */
export async function recordPayment(
  db: Db,
  actor: Actor,
  input: RecordPaymentInput,
): Promise<{ id: string | null; replayed: boolean }> {
  requireRole(actor, 'admin', 'user');
  return db.tx(async (t) => {
    const outcome = await withIdempotency(
      t, input.idempotencyKey, 'recordPayment',
      () => insertPayment(t, actor, { ...input, status: 'Confirmed' }),
    );
    return { id: outcome.resultId, replayed: outcome.replayed };
  });
}

/**
 * Payment reversal (Admin only).
 *
 * Creates a paired, negated offsetting Payment. The original is NEVER deleted
 * or edited - it stays fully visible in the ledger next to its reversal.
 * A reason may be prompted for but is never required; the reversal is always
 * logged either way.
 */
export async function reversePayment(
  db: Db,
  actor: Actor,
  paymentId: string,
  reason?: string,
): Promise<{ reversalId: string }> {
  requireRole(actor, 'admin');

  return db.tx(async (t) => {
    const original = await t.maybeOne<{
      id: string; customer_id: string; invoice_id: string | null;
      amount_cents: number; method: PaymentMethod; is_reversal: boolean; status: string;
    }>(
      `SELECT id, customer_id, invoice_id, amount_cents, method, is_reversal, status
       FROM payments WHERE id = $1`, [paymentId],
    );
    if (!original) throw new RuleViolation(`payment ${paymentId} not found`);
    if (original.is_reversal) throw new RuleViolation('a reversal cannot itself be reversed');

    const existing = await t.maybeOne(
      `SELECT id FROM payments WHERE reverses_payment_id = $1`, [paymentId],
    );
    if (existing) throw new RuleViolation('this payment has already been reversed');

    const reversal = await t.one<{ id: string }>(
      `INSERT INTO payments
         (customer_id, invoice_id, amount_cents, method, status,
          is_reversal, reverses_payment_id, notes, created_by_id)
       VALUES ($1,$2,$3,$4,$5,true,$6,$7,$8)
       RETURNING id`,
      [original.customer_id, original.invoice_id, -num(original.amount_cents),
       original.method, original.status, paymentId,
       reason ?? 'Payment reversed', actor.id],
    );

    await audit(t, actor, 'adjust', 'Payment', reversal.id, `reversal of ${paymentId}`, {
      reversesPaymentId: paymentId,
      amountCents: -num(original.amount_cents),
      reason: reason ?? null,
      originalPreserved: true,
    });

    return { reversalId: reversal.id };
  });
}

/**
 * Payment reassignment (Admin only), for a payment logged against the wrong
 * invoice or the wrong customer.
 *
 *  - to a different invoice for the SAME customer: invoice_id is updated and
 *    both invoices re-derive their status from the ledger.
 *  - to a DIFFERENT customer: customer_id changes and invoice_id is CLEARED,
 *    because an invoice link belonging to the wrong customer's books must
 *    never carry over. It lands unattached on the correct customer.
 */
export async function reassignPayment(
  db: Db,
  actor: Actor,
  paymentId: string,
  target: { customerId?: string; invoiceId?: string | null },
  reason?: string,
): Promise<{ customerId: string; invoiceId: string | null }> {
  requireRole(actor, 'admin');

  return db.tx(async (t) => {
    const p = await t.maybeOne<{
      id: string; customer_id: string; invoice_id: string | null; status: string;
    }>(
      `SELECT id, customer_id, invoice_id, status FROM payments WHERE id = $1`, [paymentId],
    );
    if (!p) throw new RuleViolation(`payment ${paymentId} not found`);
    if (p.status !== 'Confirmed') {
      throw new RuleViolation('only a Confirmed payment can be reassigned');
    }

    const movingCustomer = !!target.customerId && target.customerId !== p.customer_id;
    const newCustomerId = target.customerId ?? p.customer_id;

    let newInvoiceId: string | null;
    if (movingCustomer) {
      // Cross-customer: never carry the old invoice link across the books.
      newInvoiceId = null;
    } else {
      newInvoiceId = target.invoiceId === undefined ? p.invoice_id : target.invoiceId;
      if (newInvoiceId) {
        const inv = await t.maybeOne<{ customer_id: string }>(
          `SELECT customer_id FROM invoices WHERE id = $1`, [newInvoiceId],
        );
        if (!inv) throw new RuleViolation(`invoice ${newInvoiceId} not found`);
        if (inv.customer_id !== newCustomerId) {
          throw new RuleViolation(
            'that invoice belongs to a different customer; reassign the payment to ' +
            'the customer first, then apply it to one of their invoices',
          );
        }
      }
    }

    await t.query(
      `UPDATE payments SET customer_id = $2, invoice_id = $3 WHERE id = $1`,
      [paymentId, newCustomerId, newInvoiceId],
    );

    await audit(t, actor, 'adjust', 'Payment', paymentId, paymentId, {
      reason: reason ?? null,
      before: { customerId: p.customer_id, invoiceId: p.invoice_id },
      after: { customerId: newCustomerId, invoiceId: newInvoiceId },
      invoiceLinkClearedForCustomerChange: movingCustomer,
    });

    return { customerId: newCustomerId, invoiceId: newInvoiceId };
  });
}

/**
 * The customer's ONE running balance (Section 4).
 * Every Confirmed payment counts, attached to an invoice or not. There is no
 * separate "credit balance".
 */
export async function getCustomerBalance(
  db: Queryable,
  customerId: string,
): Promise<{ invoicedCents: Cents; paidCents: Cents; balanceCents: Cents }> {
  const row = await db.maybeOne<{
    invoiced_cents: number; paid_cents: number; balance_cents: number;
  }>(
    `SELECT invoiced_cents, paid_cents, balance_cents
     FROM customer_balances WHERE customer_id = $1`, [customerId],
  );
  return {
    invoicedCents: num(row?.invoiced_cents),
    paidCents: num(row?.paid_cents),
    balanceCents: num(row?.balance_cents),
  };
}

/**
 * Record money received and put it against invoices in one motion.
 *
 * This is the bank-transfer path: a customer pays a lump sum covering several
 * invoices, or pays now against nothing in particular. It creates ONE payment
 * row per invoice it covers, plus a final unattached one for any remainder -
 * the same uniform shape route settlement produces, via the same planPayments
 * function, so nothing downstream has to tell the two apart.
 *
 * There is deliberately no "credit balance" concept: an unattached payment is
 * simply a payment, and it reduces what the customer owes overall.
 */
export async function receivePayment(
  db: Db,
  actor: Actor,
  input: {
    customerId: string;
    amountCents: Cents;
    method: PaymentMethod;
    paymentDate?: string | null;
    reference?: string | null;
    notes?: string | null;
    /** Optional: which invoices this covers, in the order to apply them. */
    allocations?: ReadonlyArray<{ invoiceId: string; amountCents: Cents }>;
    idempotencyKey?: string | null;
  },
): Promise<{ paymentIds: string[]; allocatedCents: Cents; unappliedCents: Cents }> {
  requireRole(actor, 'admin', 'user');
  if (!(input.amountCents > 0)) throw new RuleViolation('a payment must be more than zero');

  const check = validateAllocation(input.amountCents, input.allocations ?? []);
  if (!check.ok) throw new RuleViolation(check.error);

  return db.tx(async (t) => {
    const customer = await t.maybeOne<{ name: string }>(
      `SELECT name FROM customers WHERE id = $1`, [input.customerId],
    );
    if (!customer) throw new RuleViolation('that customer no longer exists');

    // Every invoice named must belong to this customer, or the money lands on
    // somebody else's account.
    for (const a of input.allocations ?? []) {
      const inv = await t.maybeOne<{ customer_id: string; invoice_number: string }>(
        `SELECT customer_id, invoice_number FROM invoices WHERE id = $1`, [a.invoiceId],
      );
      if (!inv) throw new RuleViolation('one of those invoices no longer exists');
      if (inv.customer_id !== input.customerId) {
        throw new RuleViolation(
          `${inv.invoice_number} belongs to a different customer`,
        );
      }
    }

    const run = async () => {
      const planned = planPayments(input.amountCents, input.allocations ?? []);
      const ids: string[] = [];
      for (const plan of planned) {
        const row = await insertPayment(t, actor, {
          customerId: input.customerId,
          invoiceId: plan.invoiceId,
          amountCents: plan.amountCents,
          method: input.method,
          paymentDate: input.paymentDate ?? null,
          reference: input.reference ?? null,
          notes: input.notes ?? null,
          status: 'Confirmed',
        });
        ids.push(row.id);
      }
      await audit(t, actor, 'pay', 'Customer', input.customerId, customer.name, {
        amountCents: input.amountCents,
        method: input.method,
        reference: input.reference ?? null,
        allocations: input.allocations ?? [],
      });
      // withIdempotency needs a single id to remember the operation by.
      return { id: ids[0] ?? '', ids };
    };

    const outcome = await withIdempotency(t, input.idempotencyKey, 'receivePayment', run);
    const ids = (outcome.result as { ids?: string[] } | null)?.ids ?? [];
    const allocated = (input.allocations ?? []).reduce((sum, a) => sum + a.amountCents, 0);
    return {
      paymentIds: ids,
      allocatedCents: Math.min(allocated, input.amountCents),
      unappliedCents: Math.max(input.amountCents - allocated, 0),
    };
  });
}

/**
 * Payments that are not against any invoice yet.
 *
 * These are what reconciling a bank statement produces: money that arrived
 * before the invoice it belongs to, or a lump sum still to be spread.
 */
export async function unappliedPayments(db: Db, customerId?: string) {
  return db.query<{
    id: string; customer_id: string; customer_name: string; amount_cents: number;
    payment_date: string; method: string; reference: string | null; notes: string | null;
  }>(
    `SELECT p.id, p.customer_id, c.name AS customer_name, p.amount_cents,
            to_char(p.payment_date AT TIME ZONE $2, 'YYYY-MM-DD') AS payment_date,
            p.method, p.reference, p.notes
     FROM payments p JOIN customers c ON c.id = p.customer_id
     WHERE p.invoice_id IS NULL AND p.status = 'Confirmed' AND NOT p.is_reversal
       AND ($1::uuid IS NULL OR p.customer_id = $1::uuid)
     ORDER BY p.payment_date DESC, c.name`,
    [customerId ?? null, BUSINESS_TIMEZONE],
  );
}
