/**
 * Invoices (Section 3, Steps 2/5/6 and Section 5).
 *
 * Two hard rules hold everywhere in this file:
 *
 *  1. An invoice is created ONLY from actual delivered quantities, or from a
 *     counter/pickup sale. Never from requested quantities.
 *
 *  2. amount_paid is NEVER written. It does not exist as a column; it is the
 *     sum of Confirmed payments, exposed by the invoice_ledger view. Every
 *     read of "how much is paid / what is the status" goes through
 *     getInvoiceLedger below - there is no second derivation anywhere.
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, nextNumber, requireRole, num } from './core.ts';
import type { Cents, InvoiceStatus } from '@alka/shared';
import { computeTotals, computeLineTotal, RuleViolation } from '@alka/shared';

export interface InvoiceLineInput {
  productId: string;
  cases: number;
  looseBottles: number;
  pricePerCaseCents: Cents;
  pricePerBottleCents: Cents;
}

export interface InvoiceLedgerRow {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  grandTotalCents: Cents;
  amountPaidCents: Cents;
  balanceCents: Cents;
  status: InvoiceStatus;
  isCreditNote: boolean;
  invoiceDate: string;
  dueDate: string | null;
}

const LEDGER_COLUMNS = `
  invoice_id, invoice_number, customer_id, grand_total_cents,
  amount_paid_cents, balance_cents, status, is_credit_note, invoice_date, due_date`;

function toLedgerRow(r: Record<string, unknown>): InvoiceLedgerRow {
  return {
    invoiceId: r.invoice_id as string,
    invoiceNumber: r.invoice_number as string,
    customerId: r.customer_id as string,
    grandTotalCents: num(r.grand_total_cents),
    amountPaidCents: num(r.amount_paid_cents),
    balanceCents: num(r.balance_cents),
    status: r.status as InvoiceStatus,
    isCreditNote: r.is_credit_note as boolean,
    invoiceDate: String(r.invoice_date),
    dueDate: r.due_date ? String(r.due_date) : null,
  };
}

/** THE single way to read an invoice's paid amount and status. */
export async function getInvoiceLedger(
  t: Queryable,
  invoiceId: string,
): Promise<InvoiceLedgerRow | null> {
  const row = await t.maybeOne(
    `SELECT ${LEDGER_COLUMNS} FROM invoice_ledger WHERE invoice_id = $1`, [invoiceId],
  );
  return row ? toLedgerRow(row) : null;
}

/** Open invoices for a customer, oldest first - what a driver can allocate to. */
export async function openInvoicesForCustomer(
  t: Queryable,
  customerId: string,
): Promise<InvoiceLedgerRow[]> {
  const rows = await t.query(
    `SELECT ${LEDGER_COLUMNS} FROM invoice_ledger
     WHERE customer_id = $1 AND NOT is_credit_note
       AND status NOT IN ('Paid','Cancelled')
     ORDER BY invoice_date, invoice_number`,
    [customerId],
  );
  return rows.map(toLedgerRow);
}

/**
 * Create an invoice with the given lines. Shared by delivery invoicing and
 * counter/pickup sales so both use one calculation path.
 */
export async function createInvoice(
  t: Queryable,
  actor: Actor | null,
  args: {
    customerId: string;
    lines: readonly InvoiceLineInput[];
    orderIds?: readonly string[];
    discountPercent?: number;
    discountStatus?: 'Approved' | 'Pending' | 'Rejected';
    dueDate?: string | null;
    notes?: string | null;
    invoiceDate?: string | null;
  },
): Promise<{ id: string; invoiceNumber: string; grandTotalCents: Cents }> {
  if (args.lines.length === 0) {
    throw new RuleViolation('cannot create an invoice with no lines');
  }

  const priced = await priceLines(t, args.lines);

  // A discount still pending approval must not reduce what is owed yet
  // (Section 5). The percent is recorded, but the money is calculated at 0%
  // until an Admin approves it.
  const discountStatus = args.discountStatus ?? 'Approved';
  const effectiveDiscount = discountStatus === 'Approved' ? (args.discountPercent ?? 0) : 0;
  const totals = computeTotals(priced, effectiveDiscount);

  const invoiceNumber = await nextNumber(t, 'invoice_number_seq', 'INV');
  const invoice = await t.one<{ id: string }>(
    `INSERT INTO invoices
       (invoice_number, customer_id, invoice_date, due_date, subtotal_cents,
        discount_percent, discount_amount_cents, discount_status,
        gct_cents, grand_total_cents, notes)
     VALUES ($1,$2,COALESCE($3::date,business_today()),$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [invoiceNumber, args.customerId, args.invoiceDate ?? null, args.dueDate ?? null,
     totals.subtotal, args.discountPercent ?? 0, totals.discountAmount, discountStatus,
     totals.gct, totals.grandTotal, args.notes ?? null],
  );

  for (const l of priced) {
    await t.query(
      `INSERT INTO invoice_line_items
         (invoice_id, product_id, cases, loose_bottles,
          price_per_case_cents, price_per_bottle_cents, line_total_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [invoice.id, l.productId, l.cases, l.looseBottles,
       l.pricePerCaseCents, l.pricePerBottleCents, l.lineTotal],
    );
  }
  for (const orderId of args.orderIds ?? []) {
    await t.query(
      `INSERT INTO invoice_orders (invoice_id, order_id) VALUES ($1,$2)
       ON CONFLICT DO NOTHING`,
      [invoice.id, orderId],
    );
  }

  await audit(t, actor, 'create', 'Invoice', invoice.id, invoiceNumber, {
    customerId: args.customerId,
    grandTotalCents: totals.grandTotal,
    discountPercent: args.discountPercent ?? 0,
    discountStatus,
  });

  return { id: invoice.id, invoiceNumber, grandTotalCents: totals.grandTotal };
}

interface PricedLine extends InvoiceLineInput { lineTotal: Cents }

async function priceLines(
  t: Queryable,
  lines: readonly InvoiceLineInput[],
): Promise<PricedLine[]> {
  const out: PricedLine[] = [];
  for (const l of lines) {
    const product = await t.one<{ bottles_per_case: number }>(
      `SELECT bottles_per_case FROM products WHERE id = $1`, [l.productId],
    );
    out.push({
      ...l,
      lineTotal: computeLineTotal({
        bottlesPerCase: num(product.bottles_per_case),
        cases: l.cases,
        looseBottles: l.looseBottles,
        pricePerCase: l.pricePerCaseCents,
        pricePerBottle: l.pricePerBottleCents,
      }),
    });
  }
  return out;
}

/**
 * Admin-only invoice editing (Section 5).
 *
 * Recalculates the totals. If the edit REDUCES the grand total below what has
 * already been paid, a Credit Note is generated and posted automatically -
 * with NO separate approval, because the Admin's edit is itself the
 * authorisation. If the edit INCREASES the total, the invoice simply carries
 * the new larger balance and no extra document is produced.
 *
 * Always logged with before/after values, whether or not a reason was given.
 */
export async function editInvoice(
  db: Db,
  actor: Actor,
  invoiceId: string,
  changes: { lines?: readonly InvoiceLineInput[]; discountPercent?: number; reason?: string },
): Promise<{ invoice: InvoiceLedgerRow; creditNoteId: string | null }> {
  requireRole(actor, 'admin');

  return db.tx(async (t) => {
    const before = await getInvoiceLedger(t, invoiceId);
    if (!before) throw new RuleViolation(`invoice ${invoiceId} not found`);
    if (before.isCreditNote) throw new RuleViolation('a credit note cannot be edited');

    const existing = await t.one<{ discount_percent: number; customer_id: string }>(
      `SELECT discount_percent, customer_id FROM invoices WHERE id = $1`, [invoiceId],
    );

    const lines = changes.lines
      ? await priceLines(t, changes.lines)
      : (await t.query<Record<string, unknown>>(
          `SELECT product_id, cases, loose_bottles, price_per_case_cents,
                  price_per_bottle_cents, line_total_cents
           FROM invoice_line_items WHERE invoice_id = $1`, [invoiceId],
        )).map((r) => ({
          productId: r.product_id as string,
          cases: num(r.cases),
          looseBottles: num(r.loose_bottles),
          pricePerCaseCents: num(r.price_per_case_cents),
          pricePerBottleCents: num(r.price_per_bottle_cents),
          lineTotal: num(r.line_total_cents),
        }));

    const discountPercent = changes.discountPercent ?? num(existing.discount_percent);
    const totals = computeTotals(lines, discountPercent);

    if (changes.lines) {
      await t.query(`DELETE FROM invoice_line_items WHERE invoice_id = $1`, [invoiceId]);
      for (const l of lines) {
        await t.query(
          `INSERT INTO invoice_line_items
             (invoice_id, product_id, cases, loose_bottles,
              price_per_case_cents, price_per_bottle_cents, line_total_cents)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [invoiceId, l.productId, l.cases, l.looseBottles,
           l.pricePerCaseCents, l.pricePerBottleCents, l.lineTotal],
        );
      }
    }

    await t.query(
      `UPDATE invoices SET subtotal_cents = $2, discount_percent = $3,
         discount_amount_cents = $4, gct_cents = $5, grand_total_cents = $6,
         updated_at = now()
       WHERE id = $1`,
      [invoiceId, totals.subtotal, discountPercent, totals.discountAmount,
       totals.gct, totals.grandTotal],
    );

    let creditNoteId: string | null = null;
    const paid = before.amountPaidCents;

    // The edit reduced the bill below what the customer has already paid:
    // post a Credit Note for the difference, approved on the Admin's authority.
    if (totals.grandTotal < paid) {
      const difference = paid - totals.grandTotal;
      const creditNumber = await nextNumber(t, 'invoice_number_seq', 'CN');
      const cn = await t.one<{ id: string }>(
        `INSERT INTO invoices
           (invoice_number, customer_id, invoice_date, subtotal_cents,
            discount_amount_cents, gct_cents, grand_total_cents,
            is_credit_note, credit_status, linked_invoice_id, notes)
         VALUES ($1,$2,business_today(),$3,0,0,$4,true,'Approved',$5,$6)
         RETURNING id`,
        [creditNumber, existing.customer_id, -difference, -difference, invoiceId,
         `Automatic credit note from admin edit of ${before.invoiceNumber}`],
      );
      creditNoteId = cn.id;
      await audit(t, actor, 'create', 'Invoice', cn.id, creditNumber, {
        autoGenerated: true,
        reason: 'invoice edited below amount already paid',
        linkedInvoiceId: invoiceId,
        amountCents: -difference,
        approvalRequired: false,
      });
    }

    const after = await getInvoiceLedger(t, invoiceId);

    // Always logged with before/after, regardless of whether a reason exists.
    await audit(t, actor, 'update', 'Invoice', invoiceId, before.invoiceNumber, {
      reason: changes.reason ?? null,
      before: {
        grandTotalCents: before.grandTotalCents,
        status: before.status,
        amountPaidCents: before.amountPaidCents,
      },
      after: {
        grandTotalCents: after!.grandTotalCents,
        status: after!.status,
        amountPaidCents: after!.amountPaidCents,
      },
      creditNoteId,
    });

    return { invoice: after!, creditNoteId };
  });
}

/** Raise a credit note explicitly. A User's goes to the approval queue. */
export async function createCreditNote(
  db: Db,
  actor: Actor,
  args: { invoiceId: string; amountCents: Cents; reason: string },
): Promise<{ id: string; invoiceNumber: string; approvalRequestId: string | null }> {
  requireRole(actor, 'admin', 'user');
  if (args.amountCents <= 0) throw new RuleViolation('a credit note amount must be positive');

  return db.tx(async (t) => {
    const target = await t.one<{ customer_id: string; invoice_number: string }>(
      `SELECT customer_id, invoice_number FROM invoices WHERE id = $1`, [args.invoiceId],
    );

    // An Admin's credit note is approved on their own authority; a User's is
    // saved immediately but does not reduce what is owed until approved.
    const isAdmin = actor.role === 'admin';
    const creditStatus = isAdmin ? 'Approved' : 'Pending';
    const effective = isAdmin ? -args.amountCents : 0;

    const number = await nextNumber(t, 'invoice_number_seq', 'CN');
    const cn = await t.one<{ id: string }>(
      `INSERT INTO invoices
         (invoice_number, customer_id, invoice_date, subtotal_cents,
          gct_cents, grand_total_cents, is_credit_note, credit_status,
          linked_invoice_id, notes)
       VALUES ($1,$2,business_today(),$3,0,$4,true,$5,$6,$7)
       RETURNING id`,
      [number, target.customer_id, effective, effective, creditStatus,
       args.invoiceId, args.reason],
    );

    let approvalRequestId: string | null = null;
    if (!isAdmin) {
      const req = await t.one<{ id: string }>(
        `INSERT INTO approval_requests
           (request_type, entity_type, entity_id, entity_label, customer_id,
            amount_cents, reason, requested_by_id)
         VALUES ('CreditNote','Invoice',$1,$2,$3,$4,$5,$6)
         RETURNING id`,
        [cn.id, number, target.customer_id, -args.amountCents, args.reason, actor.id],
      );
      approvalRequestId = req.id;
      await t.query(`UPDATE invoices SET approval_request_id = $2 WHERE id = $1`,
        [cn.id, req.id]);
    }

    await audit(t, actor, 'create', 'Invoice', cn.id, number, {
      isCreditNote: true, creditStatus, linkedInvoiceId: args.invoiceId,
      amountCents: -args.amountCents, reason: args.reason,
    });

    return { id: cn.id, invoiceNumber: number, approvalRequestId };
  });
}

/** Mark an invoice as sent to the customer. */
export async function markInvoiceSent(db: Db, actor: Actor, invoiceId: string): Promise<void> {
  requireRole(actor, 'admin', 'user');
  await db.tx(async (t) => {
    await t.query(
      `UPDATE invoices SET lifecycle = 'Sent', sent_date = business_today()
       WHERE id = $1 AND lifecycle = 'Open'`, [invoiceId],
    );
    await audit(t, actor, 'update', 'Invoice', invoiceId, invoiceId, { lifecycle: 'Sent' });
  });
}

export async function getInvoiceDetail(db: Db, invoiceId: string) {
  const ledger = await getInvoiceLedger(db, invoiceId);
  if (!ledger) return null;
  const header = await db.one(`SELECT * FROM invoices WHERE id = $1`, [invoiceId]);
  const lines = await db.query(
    `SELECT ili.*, p.name AS product_name, p.bottles_per_case
     FROM invoice_line_items ili JOIN products p ON p.id = ili.product_id
     WHERE ili.invoice_id = $1`, [invoiceId],
  );
  const payments = await db.query(
    `SELECT id, amount_cents, business_date(payment_date)::text AS payment_date,
            method, status, is_reversal, reference, reverses_payment_id
     FROM payments WHERE invoice_id = $1 ORDER BY payment_date`, [invoiceId],
  );
  // Who it is for, and what it came from. Without these the screen showed a
  // number, some lines and no way to tell whose invoice it was.
  const customer = await db.one(
    `SELECT id, name, email, phone, delivery_address, payment_terms, delivery_zone,
            address_line1, address_line2, city, parish, contact_person
     FROM customers WHERE id = $1`, [ledger.customerId],
  );
  const orders = await db.query(
    `SELECT o.id, o.order_number, o.delivery_mode, o.order_date::text AS order_date,
            o.requested_delivery_date::text AS requested_delivery_date, o.status
     FROM invoice_orders io JOIN customer_orders o ON o.id = io.order_id
     WHERE io.invoice_id = $1 ORDER BY o.order_number`, [invoiceId],
  );
  // What the invoice page's "What has happened" and "on their account"
  // prompt need: the delivery that raised it, credit notes against it, its
  // own audit trail, and money the customer has paid that is not yet
  // against any invoice.
  const delivery = await db.maybeOne(
    `SELECT ds.zone, ds.delivery_date::text AS delivery_date, ds.driver_name,
            u.name AS driver_user_name,
            st.bottles_delivered_full, st.bottles_empties_picked_up, st.bottles_lost_damaged
     FROM delivery_stops st
     JOIN delivery_sheets ds ON ds.id = st.delivery_sheet_id
     LEFT JOIN users u ON u.id = ds.assigned_driver_id
     WHERE st.invoice_id = $1 LIMIT 1`, [invoiceId],
  );
  const creditNotes = await db.query(
    `SELECT id, invoice_number, grand_total_cents, credit_status, created_at
     FROM invoices WHERE linked_invoice_id = $1 AND is_credit_note ORDER BY created_at`,
    [invoiceId],
  );
  const history = await db.query(
    `SELECT ts, user_name, action, details FROM audit_log
     WHERE entity_type = 'Invoice' AND entity_id = $1 ORDER BY ts`, [invoiceId],
  );
  const onAccount = await db.one<{ cents: number }>(
    `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS cents FROM payments
     WHERE customer_id = $1 AND invoice_id IS NULL AND status = 'Confirmed'
       AND NOT is_reversal AND amount_cents > 0`, [ledger.customerId],
  );
  return {
    ...header, ...ledger, lines, payments, customer, orders,
    delivery, creditNotes, history, onAccountCents: Number(onAccount.cents),
  };
}
