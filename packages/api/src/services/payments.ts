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
import { audit, requireRole, withIdempotency, num } from './core.ts';
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

/**
 * A payment date typed as a bare day ('2026-10-01') means that day in
 * Jamaica. Cast straight to a timestamp it is midnight UTC - 7pm the evening
 * BEFORE in Kingston - so the payment showed a day early. Noon Jamaica time
 * (UTC-5, no daylight saving) is safely inside the day whichever way it is read.
 */
export function paymentInstant(d: string | null | undefined): string | null {
  if (!d) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00-05:00` : d;
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
     paymentInstant(input.paymentDate), input.method, input.reference ?? null,
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
    round_zone: string | null;
  }>(
    `SELECT p.id, p.customer_id, c.name AS customer_name, p.amount_cents,
            business_date(p.payment_date)::text AS payment_date,
            p.method, p.reference, p.notes, ds.zone AS round_zone
     FROM payments p JOIN customers c ON c.id = p.customer_id
     LEFT JOIN delivery_sheets ds ON ds.id = p.delivery_sheet_id
     WHERE p.invoice_id IS NULL AND p.status = 'Confirmed' AND NOT p.is_reversal
       AND ($1::uuid IS NULL OR p.customer_id = $1::uuid)
     ORDER BY p.payment_date DESC, c.name`,
    [customerId ?? null],
  );
}

/**
 * Attach money already received, but not yet against any invoice, to one
 * invoice of the same customer.
 *
 * Oldest payment first, up to what the invoice still owes (or `amountCents`
 * if smaller). A payment larger than what is needed is split in two: the
 * part used becomes its own payment against the invoice, with the same date,
 * method, reference and route links, and the original keeps the rest,
 * still unattached. The customer's running balance does not change - only
 * which invoice the money is shown against - so this is office work, not an
 * administrator's correction like moving a payment between customers.
 */
export async function applyToInvoice(
  db: Db,
  actor: Actor,
  args: { invoiceId: string; paymentId?: string | null; amountCents?: Cents | null },
): Promise<{ appliedCents: Cents; paymentIds: string[] }> {
  requireRole(actor, 'admin', 'user');

  return db.tx(async (t) => {
    const inv = await t.maybeOne<{
      customer_id: string; invoice_number: string; balance_cents: number;
      is_credit_note: boolean; status: string;
    }>(
      `SELECT customer_id, invoice_number, balance_cents, is_credit_note, status
       FROM invoice_ledger WHERE invoice_id = $1`, [args.invoiceId],
    );
    if (!inv) throw new RuleViolation('that invoice no longer exists');
    if (inv.is_credit_note) throw new RuleViolation('a credit note is not paid');
    if (inv.status === 'Cancelled') throw new RuleViolation('that invoice is cancelled');
    // Lock the invoice row so two people applying at once cannot overpay it.
    await t.query(`SELECT id FROM invoices WHERE id = $1 FOR UPDATE`, [args.invoiceId]);

    const owed = num(inv.balance_cents);
    if (owed <= 0) throw new RuleViolation(`${inv.invoice_number} is already paid`);
    let remaining = Math.min(owed, args.amountCents && args.amountCents > 0 ? args.amountCents : owed);

    const pool = await t.query<{
      id: string; amount_cents: number; payment_date: string; method: PaymentMethod;
      reference: string | null; notes: string | null; delivery_sheet_id: string | null;
      delivery_stop_id: string | null; kind: string | null;
    }>(
      `SELECT id, amount_cents, payment_date::text AS payment_date, method, reference, notes,
              delivery_sheet_id, delivery_stop_id, kind
       FROM payments
       WHERE customer_id = $1 AND invoice_id IS NULL AND status = 'Confirmed'
         AND NOT is_reversal AND amount_cents > 0
         AND ($2::uuid IS NULL OR id = $2::uuid)
       ORDER BY payment_date, created_at
       FOR UPDATE`,
      [inv.customer_id, args.paymentId ?? null],
    );
    if (pool.length === 0) {
      throw new RuleViolation(args.paymentId
        ? 'that payment is already against an invoice, or belongs to another customer'
        : 'there is no money on their account to apply');
    }

    let applied = 0;
    const ids: string[] = [];
    for (const p of pool) {
      if (remaining <= 0) break;
      const have = num(p.amount_cents);
      const take = Math.min(have, remaining);
      if (take === have) {
        await t.query(`UPDATE payments SET invoice_id = $2 WHERE id = $1`, [p.id, args.invoiceId]);
        await audit(t, actor, 'adjust', 'Payment', p.id, p.reference ?? p.id, {
          applied: 'whole', invoiceId: args.invoiceId, invoiceNumber: inv.invoice_number,
          amountCents: take,
        });
        ids.push(p.id);
      } else {
        await t.query(`UPDATE payments SET amount_cents = amount_cents - $2 WHERE id = $1`, [p.id, take]);
        const part = await insertPayment(t, actor, {
          customerId: inv.customer_id,
          invoiceId: args.invoiceId,
          amountCents: take,
          method: p.method,
          paymentDate: p.payment_date,
          reference: p.reference,
          notes: `Part of an earlier payment${p.reference ? ` (${p.reference})` : ''}, applied to ${inv.invoice_number}`,
          deliverySheetId: p.delivery_sheet_id,
          deliveryStopId: p.delivery_stop_id,
          kind: p.kind,
          status: 'Confirmed',
        });
        await audit(t, actor, 'adjust', 'Payment', p.id, p.reference ?? p.id, {
          applied: 'split', invoiceId: args.invoiceId, invoiceNumber: inv.invoice_number,
          amountCents: take, leftUnattachedCents: have - take, newPaymentId: part.id,
        });
        ids.push(part.id);
      }
      applied += take;
      remaining -= take;
    }
    return { appliedCents: applied, paymentIds: ids };
  });
}

/* ------------------------------------------------------------------ */
/* Changing a posted payment (team feedback, 1 Oct 2026, point 11)     */
/* ------------------------------------------------------------------ */

export interface PaymentChange {
  amountCents?: Cents;
  paymentDate?: string | null;
  method?: PaymentMethod;
  reference?: string | null;
  /** Move it to another customer (it lands unattached on their account). */
  customerId?: string;
  /** Put it against another invoice of the (new) customer; null = on account. */
  invoiceId?: string | null;
}

/**
 * Ask to change a payment already posted: the amount, date, method or
 * reference, or which customer / invoice it belongs to.
 *
 * Everton's ruling: changes need approval. Office staff raise the request
 * and an administrator approves it in Approvals; an administrator's own
 * change is its own approval and applies at once (the same rule discounts
 * and stop corrections follow). A reason is always required.
 */
export async function requestPaymentChange(
  db: Db, actor: Actor, paymentId: string, changes: PaymentChange, reason: string,
): Promise<{ applied: boolean; approvalRequestId: string }> {
  requireRole(actor, 'admin', 'user');
  if (!reason?.trim()) throw new RuleViolation('say why the payment is being changed');

  return db.tx(async (t) => {
    const p = await t.maybeOne<{
      id: string; customer_id: string; amount_cents: number; is_reversal: boolean;
      status: string; receipt_number: string | null; reference: string | null;
    }>(
      `SELECT id, customer_id, amount_cents, is_reversal, status, receipt_number, reference
       FROM payments WHERE id = $1`, [paymentId],
    );
    if (!p) throw new RuleViolation('that payment no longer exists');
    if (p.is_reversal) throw new RuleViolation('a reversal cannot be changed');
    if (p.status !== 'Confirmed') throw new RuleViolation('only a confirmed payment can be changed');
    const reversed = await t.maybeOne(`SELECT 1 FROM payments WHERE reverses_payment_id = $1`, [paymentId]);
    if (reversed) throw new RuleViolation('this payment has been reversed, so it cannot be changed');
    const open = await t.maybeOne(
      `SELECT 1 FROM approval_requests
       WHERE request_type = 'PaymentChange' AND entity_id = $1 AND status = 'Pending'`, [paymentId],
    );
    if (open) throw new RuleViolation('a change to this payment is already waiting for approval');

    const clean = cleanChange(changes);
    if (Object.keys(clean).length === 0) throw new RuleViolation('nothing was changed');
    await checkChange(t, p.customer_id, clean);

    const label = p.receipt_number ?? p.reference ?? `payment of ${(num(p.amount_cents) / 100).toFixed(2)}`;
    const req = await t.one<{ id: string }>(
      `INSERT INTO approval_requests
         (request_type, status, entity_type, entity_id, entity_label, customer_id,
          amount_cents, reason, requested_by_id, payload,
          reviewed_by_id, reviewed_date)
       VALUES ('PaymentChange',$1,'Payment',$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
       RETURNING id`,
      [actor.role === 'admin' ? 'Approved' : 'Pending', paymentId, label, p.customer_id,
       num(p.amount_cents), reason.trim(), actor.id, JSON.stringify(clean),
       actor.role === 'admin' ? actor.id : null, actor.role === 'admin' ? new Date().toISOString() : null],
    );
    if (actor.role === 'admin') {
      await applyPaymentChange(t, actor, paymentId, clean, reason.trim());
      return { applied: true, approvalRequestId: req.id };
    }
    await audit(t, actor, 'create', 'ApprovalRequest', req.id, label, {
      requestType: 'PaymentChange', changes: clean, reason,
    });
    return { applied: false, approvalRequestId: req.id };
  });
}

function cleanChange(c: PaymentChange): PaymentChange {
  const out: PaymentChange = {};
  if (c.amountCents !== undefined && c.amountCents !== null) out.amountCents = Math.round(Number(c.amountCents));
  if (c.paymentDate) out.paymentDate = String(c.paymentDate).slice(0, 10);
  if (c.method) out.method = c.method;
  if (c.reference !== undefined) out.reference = c.reference?.trim() || null;
  if (c.customerId) out.customerId = c.customerId;
  if (c.invoiceId !== undefined) out.invoiceId = c.invoiceId || null;
  return out;
}

async function checkChange(t: Queryable, currentCustomer: string, c: PaymentChange): Promise<void> {
  if (c.amountCents !== undefined && !(c.amountCents > 0)) {
    throw new RuleViolation('a payment must be more than zero');
  }
  const customer = c.customerId ?? currentCustomer;
  if (c.customerId) {
    const ok = await t.maybeOne(`SELECT 1 FROM customers WHERE id = $1`, [c.customerId]);
    if (!ok) throw new RuleViolation('that customer no longer exists');
  }
  if (c.invoiceId) {
    const inv = await t.maybeOne<{ customer_id: string; invoice_number: string; is_credit_note: boolean }>(
      `SELECT customer_id, invoice_number, is_credit_note FROM invoices WHERE id = $1`, [c.invoiceId],
    );
    if (!inv) throw new RuleViolation('that invoice no longer exists');
    if (inv.is_credit_note) throw new RuleViolation('a payment cannot go against a credit note');
    if (inv.customer_id !== customer) {
      throw new RuleViolation(`${inv.invoice_number} belongs to a different customer`);
    }
  }
}

/**
 * Apply an approved change. Moving it (customer / invoice), its date, method
 * and reference are edited on the payment itself with the before and after in
 * the audit log - none of those changes what anybody owes. A different AMOUNT
 * is never an edit: the original is reversed and a new payment posted with
 * the right figure, so the ledger shows exactly what happened.
 */
export async function applyPaymentChange(
  t: Queryable, actor: Actor, paymentId: string, c: PaymentChange, reason: string,
): Promise<{ paymentId: string }> {
  const p = await t.one<{
    id: string; customer_id: string; invoice_id: string | null; amount_cents: number;
    payment_date: string; method: PaymentMethod; reference: string | null; notes: string | null;
    delivery_sheet_id: string | null; delivery_stop_id: string | null; kind: string | null;
  }>(
    `SELECT id, customer_id, invoice_id, amount_cents, payment_date::text AS payment_date, method,
            reference, notes, delivery_sheet_id, delivery_stop_id, kind,
            business_date(payment_date)::text AS payment_day
     FROM payments WHERE id = $1 FOR UPDATE`, [paymentId],
  );
  await checkChange(t, p.customer_id, c);

  const customerId = c.customerId ?? p.customer_id;
  // Moving customer clears the invoice unless a new one was named.
  const invoiceId = c.invoiceId !== undefined ? c.invoiceId
    : (c.customerId && c.customerId !== p.customer_id ? null : p.invoice_id);
  const before = {
    customerId: p.customer_id, invoiceId: p.invoice_id, amountCents: num(p.amount_cents),
    paymentDate: p.payment_date, method: p.method, reference: p.reference,
  };

  let resultId = paymentId;
  if (c.amountCents !== undefined && c.amountCents !== num(p.amount_cents)) {
    await t.query(
      `INSERT INTO payments
         (customer_id, invoice_id, amount_cents, payment_date, method, status,
          is_reversal, reverses_payment_id, notes, created_by_id)
       VALUES ($1,$2,$3,now(),$4,'Confirmed',true,$5,$6,$7)`,
      [p.customer_id, p.invoice_id, -num(p.amount_cents), p.method,
       paymentId, `Replaced by a corrected payment: ${reason}`, actor.id],
    );
    const fresh = await insertPayment(t, actor, {
      customerId, invoiceId,
      amountCents: c.amountCents,
      method: c.method ?? p.method,
      paymentDate: c.paymentDate ?? p.payment_date,
      // keeps the original instant when the date was not changed
      reference: c.reference !== undefined ? c.reference : p.reference,
      notes: `Corrected payment (was ${(num(p.amount_cents) / 100).toFixed(2)}): ${reason}`,
      deliverySheetId: p.delivery_sheet_id, deliveryStopId: p.delivery_stop_id, kind: p.kind,
      status: 'Confirmed',
    });
    resultId = fresh.id;
  } else {
    await t.query(
      `UPDATE payments
       SET customer_id = $2, invoice_id = $3,
           payment_date = COALESCE($4::timestamptz, payment_date),
           method = $5, reference = $6
       WHERE id = $1`,
      [paymentId, customerId, invoiceId, paymentInstant(c.paymentDate), c.method ?? p.method,
       c.reference !== undefined ? c.reference : p.reference],
    );
  }

  await audit(t, actor, 'adjust', 'Payment', resultId, p.reference ?? paymentId, {
    reason, before, changes: c, replacedPaymentId: resultId !== paymentId ? paymentId : null,
  });
  return { paymentId: resultId };
}
