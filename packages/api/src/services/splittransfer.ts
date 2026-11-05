/**
 * One bank transfer that pays invoices of SEVERAL customers (Everton and
 * Luckie, 4 Nov 2026) - QuickBooks' "Find other matches" on a bank-feed line.
 *
 * His rulings:
 *   - Each customer gets their own payment and RCT number; all carry the
 *     transfer's bank reference, so they can be traced back to it.
 *   - Whatever is not put against an invoice stays as credit on ONE customer
 *     the office picks. Nothing is left unaccounted for.
 *   - Receipts: one per customer, emailed if asked (ticked by default).
 *   - Shown as separate rows on Payments received (no grouping).
 *   - QuickBooks stays the bank reconciliation for now.
 *
 * All of it is one transaction: if any part is refused, nothing is recorded.
 * The same insert every Confirmed payment goes through (insertPayment), so
 * invariants 1 and 2 hold: what is paid is derived from these rows, and each
 * customer's part is planned by planPayments.
 */
import type { Db } from '../db/index.ts';
import type { Actor } from './core.ts';
import { assertMethodAllowed, audit, requireRole, withIdempotency, num } from './core.ts';
import { insertPayment } from './payments.ts';
import { RuleViolation, planPayments, type Cents, type PaymentMethod } from '@alka/shared';

const cash = (c: number) =>
  `J$${(c / 100).toLocaleString('en-JM', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface SplitTransferInput {
  amountCents: Cents;
  method?: PaymentMethod;
  paymentDate?: string | null;
  reference?: string | null;
  notes?: string | null;
  allocations: ReadonlyArray<{ invoiceId: string; amountCents: Cents }>;
  /** Who keeps what is not put against an invoice, as credit. */
  leftoverCustomerId?: string | null;
  idempotencyKey?: string | null;
}

export interface SplitTransferPart {
  customerId: string; customerName: string; amountCents: Cents; paymentIds: string[]; receiptNumber: string | null;
}

export async function splitTransfer(db: Db, actor: Actor, input: SplitTransferInput): Promise<{
  parts: SplitTransferPart[]; allocatedCents: Cents; leftoverCents: Cents; replayed: boolean;
}> {
  requireRole(actor, 'admin', 'user');
  const amount = Math.round(Number(input.amountCents));
  if (!(amount > 0)) throw new RuleViolation('enter the amount of the transfer');
  const method = input.method ?? 'Bank Transfer';
  await assertMethodAllowed(db, method);
  const allocs = (input.allocations ?? []).map((a) => ({ invoiceId: a.invoiceId, amountCents: Math.round(Number(a.amountCents)) }));
  if (allocs.length === 0) throw new RuleViolation('choose at least one invoice');
  if (allocs.some((a) => !(a.amountCents > 0))) throw new RuleViolation('each invoice ticked needs an amount above zero');
  if (new Set(allocs.map((a) => a.invoiceId)).size !== allocs.length) throw new RuleViolation('an invoice is listed twice');
  const allocated = allocs.reduce((s, a) => s + a.amountCents, 0);
  if (allocated > amount) {
    throw new RuleViolation(`the invoices take ${cash(allocated)}, more than the ${cash(amount)} received`);
  }
  const leftover = amount - allocated;
  if (leftover > 0 && !input.leftoverCustomerId) {
    throw new RuleViolation(`${cash(leftover)} is not against an invoice: choose the customer it stays with as credit`);
  }

  return db.tx(async (t) => {
    // A second press of the same button: already recorded, do nothing (and
    // do not refuse it because the invoices are now paid).
    if (input.idempotencyKey && await t.maybeOne(`SELECT 1 FROM idempotency_keys WHERE key = $1`, [input.idempotencyKey])) {
      return { parts: [], allocatedCents: allocated, leftoverCents: leftover, replayed: true };
    }
    // Every invoice: still owed, not a credit note, and how much it can take.
    const byCustomer = new Map<string, { name: string; allocations: Array<{ invoiceId: string; amountCents: Cents }> }>();
    for (const a of allocs) {
      const inv = await t.maybeOne<{ customer_id: string; customer_name: string; invoice_number: string; balance_cents: string; is_credit_note: boolean; status: string }>(
        `SELECT customer_id, customer_name, invoice_number, balance_cents::text AS balance_cents, is_credit_note, status
         FROM invoice_ledger WHERE invoice_id = $1`, [a.invoiceId],
      );
      if (!inv) throw new RuleViolation('one of those invoices no longer exists');
      if (inv.is_credit_note) throw new RuleViolation(`${inv.invoice_number} is a credit note; a payment cannot go against it`);
      if (inv.status === 'Cancelled') throw new RuleViolation(`${inv.invoice_number} is cancelled`);
      await t.query(`SELECT id FROM invoices WHERE id = $1 FOR UPDATE`, [a.invoiceId]);
      const owed = num(inv.balance_cents);
      if (a.amountCents > owed) {
        throw new RuleViolation(owed <= 0 ? `${inv.invoice_number} is already paid`
          : `${inv.invoice_number} only has ${cash(owed)} still owed, not ${cash(a.amountCents)}`);
      }
      const c = byCustomer.get(inv.customer_id) ?? { name: inv.customer_name, allocations: [] };
      c.allocations.push(a);
      byCustomer.set(inv.customer_id, c);
    }
    if (leftover > 0) {
      const lc = await t.maybeOne<{ name: string; active: boolean }>(
        `SELECT name, active FROM customers WHERE id = $1`, [input.leftoverCustomerId],
      );
      if (!lc) throw new RuleViolation('the customer chosen for the credit no longer exists');
      if (!byCustomer.has(input.leftoverCustomerId!)) byCustomer.set(input.leftoverCustomerId!, { name: lc.name, allocations: [] });
    }

    const run = async () => {
      const parts: SplitTransferPart[] = [];
      const ref = (input.reference ?? '').trim() || null;
      const n = byCustomer.size;
      for (const [customerId, c] of byCustomer) {
        const own = c.allocations.reduce((s, a) => s + a.amountCents, 0)
          + (customerId === input.leftoverCustomerId ? leftover : 0);
        const note = [`Part of a ${cash(amount)} bank transfer paid for ${n} ${n === 1 ? 'customer' : 'customers'}${ref ? ` (ref ${ref})` : ''}`,
          (input.notes ?? '').trim()].filter(Boolean).join('. ');
        const ids: string[] = [];
        for (const plan of planPayments(own, c.allocations)) {
          const row = await insertPayment(t, actor, {
            customerId, invoiceId: plan.invoiceId, amountCents: plan.amountCents, method,
            paymentDate: input.paymentDate ?? null, reference: ref, notes: note, status: 'Confirmed',
          });
          ids.push(row.id);
        }
        await audit(t, actor, 'pay', 'Customer', customerId, c.name, {
          amountCents: own, method, reference: ref, allocations: c.allocations,
          splitTransfer: { totalCents: amount, customers: n },
        });
        const rn = await t.maybeOne<{ r: string | null }>(`SELECT receipt_number AS r FROM payments WHERE id = $1`, [ids[0]]);
        parts.push({ customerId, customerName: c.name, amountCents: own, paymentIds: ids, receiptNumber: rn?.r ?? null });
      }
      return { id: parts[0]?.paymentIds[0] ?? '', parts };
    };

    const outcome = await withIdempotency(t, input.idempotencyKey, 'splitTransfer', run);
    const result = outcome.result as { parts?: SplitTransferPart[] } | null;
    return { parts: result?.parts ?? [], allocatedCents: allocated, leftoverCents: leftover, replayed: outcome.replayed };
  });
}
