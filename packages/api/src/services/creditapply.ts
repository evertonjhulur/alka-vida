/**
 * Applying credit notes to invoices (Everton, 4 Nov 2026; migration 039).
 *
 * A credit note lowers what the customer owes as soon as it is approved -
 * that has not changed. Applying it says which invoice it settles, so that
 * invoice reads Paid (or Partial) and drops off overdue, reminders and Money
 * owed, instead of sitting there "overdue" while the account is square.
 *
 * Not money: no payment is created, the customer balance and the statement
 * do not move. A credit note raised AGAINST an invoice is applied to it
 * automatically when it is approved (at once for an admin's). Other unused
 * credit is applied from the invoice page ("Apply") or the credit note's row.
 */
import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, requireRole, num } from './core.ts';
import { RuleViolation, type Cents } from '@alka/shared';

const money = (c: number) =>
  `J$${(c / 100).toLocaleString('en-JM', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface UnusedCredit {
  id: string; invoice_number: string; invoice_date: string; unused_cents: number; notes: string | null;
}

/** The customer's approved credit notes with credit still unused, oldest first. */
export async function unusedCredit(t: Queryable, customerId: string): Promise<UnusedCredit[]> {
  const rows = await t.query<{ id: string; invoice_number: string; invoice_date: string; unused: string; notes: string | null }>(
    `SELECT l.invoice_id AS id, l.invoice_number, l.invoice_date::text AS invoice_date,
            (-l.balance_cents)::text AS unused, i.notes
     FROM invoice_ledger l JOIN invoices i ON i.id = l.invoice_id
     WHERE l.customer_id = $1 AND l.is_credit_note AND l.status <> 'Cancelled'
       AND i.credit_status = 'Approved' AND l.balance_cents < 0
     ORDER BY l.invoice_date, i.created_at`, [customerId],
  );
  return rows.map((r) => ({ id: r.id, invoice_number: r.invoice_number, invoice_date: r.invoice_date, unused_cents: num(r.unused), notes: r.notes }));
}

/** Credit applied to an invoice, for its page. */
export async function creditAppliedTo(t: Queryable, invoiceId: string) {
  return t.query<{ id: string; credit_note_id: string; invoice_number: string; amount_cents: string; created_at: string }>(
    `SELECT a.id, a.credit_note_id, cn.invoice_number, a.amount_cents::text AS amount_cents, a.created_at::text AS created_at
     FROM credit_applications a JOIN invoices cn ON cn.id = a.credit_note_id
     WHERE a.invoice_id = $1 AND cn.lifecycle <> 'Cancelled' ORDER BY a.created_at`, [invoiceId],
  );
}

/** Where a credit note's credit has gone, for its row and page. */
export async function creditAppliedFrom(t: Queryable, creditNoteId: string) {
  return t.query<{ id: string; invoice_id: string; invoice_number: string; amount_cents: string }>(
    `SELECT a.id, a.invoice_id, inv.invoice_number, a.amount_cents::text AS amount_cents
     FROM credit_applications a JOIN invoices inv ON inv.id = a.invoice_id
     WHERE a.credit_note_id = $1 AND inv.lifecycle <> 'Cancelled' ORDER BY a.created_at`, [creditNoteId],
  );
}

/**
 * Put unused credit against an invoice, inside the caller's transaction.
 * `creditNoteId` picks one credit note; without it, the oldest first. Never
 * more than the invoice still owes, or than the credit has left. Returns
 * what was applied (0 when there is nothing to do - never an error, so the
 * automatic call can never stop a credit note being raised or approved).
 */
export async function applyCreditTx(
  t: Queryable, actor: Actor,
  args: { invoiceId: string; creditNoteId?: string | null; amountCents?: Cents | null; automatic?: boolean },
): Promise<{ appliedCents: Cents; creditNotes: string[] }> {
  const inv = await t.maybeOne<{ customer_id: string; invoice_number: string; balance_cents: string; is_credit_note: boolean; status: string }>(
    `SELECT customer_id, invoice_number, balance_cents::text AS balance_cents, is_credit_note, status
     FROM invoice_ledger WHERE invoice_id = $1`, [args.invoiceId],
  );
  if (!inv || inv.is_credit_note || inv.status === 'Cancelled') return { appliedCents: 0, creditNotes: [] };
  // Lock the invoice so two people applying at once cannot over-settle it.
  await t.query(`SELECT id FROM invoices WHERE id = $1 FOR UPDATE`, [args.invoiceId]);
  let left = num(inv.balance_cents);
  if (args.amountCents && args.amountCents > 0) left = Math.min(left, Math.round(args.amountCents));
  if (left <= 0) return { appliedCents: 0, creditNotes: [] };

  let pool = await unusedCredit(t, inv.customer_id);
  if (args.creditNoteId) pool = pool.filter((c) => c.id === args.creditNoteId);
  if (pool.length) await t.query(`SELECT id FROM invoices WHERE id = ANY($1::uuid[]) FOR UPDATE`, [pool.map((c) => c.id)]);

  let applied = 0;
  const used: string[] = [];
  for (const c of pool) {
    if (left <= 0) break;
    const take = Math.min(left, c.unused_cents);
    if (take <= 0) continue;
    await t.query(
      `INSERT INTO credit_applications (credit_note_id, invoice_id, amount_cents, created_by_id)
       VALUES ($1, $2, $3, $4)`, [c.id, args.invoiceId, take, actor.id],
    );
    await audit(t, actor, 'update', 'Invoice', args.invoiceId, inv.invoice_number, {
      creditApplied: { creditNoteId: c.id, creditNote: c.invoice_number, amountCents: take },
      automatic: !!args.automatic,
      summary: `${money(take)} of credit note ${c.invoice_number} applied to ${inv.invoice_number}${args.automatic ? ' (raised against it)' : ''}.`,
    });
    applied += take; left -= take; used.push(c.invoice_number);
  }
  return { appliedCents: applied, creditNotes: used };
}

/** "Apply" on the invoice page or a credit note's row. Office or admin. */
export async function applyCredit(
  db: Db, actor: Actor, args: { invoiceId: string; creditNoteId?: string | null; amountCents?: Cents | null },
): Promise<{ appliedCents: Cents; creditNotes: string[] }> {
  requireRole(actor, 'admin', 'user');
  return db.tx(async (t) => {
    const inv = await t.maybeOne<{ customer_id: string; invoice_number: string; balance_cents: string; is_credit_note: boolean; status: string }>(
      `SELECT customer_id, invoice_number, balance_cents::text AS balance_cents, is_credit_note, status
       FROM invoice_ledger WHERE invoice_id = $1`, [args.invoiceId],
    );
    if (!inv) throw new RuleViolation('that invoice no longer exists');
    if (inv.is_credit_note) throw new RuleViolation('choose an invoice to apply the credit to, not a credit note');
    if (inv.status === 'Cancelled') throw new RuleViolation('that invoice is cancelled');
    if (num(inv.balance_cents) <= 0) throw new RuleViolation(`${inv.invoice_number} is already paid`);
    if (args.creditNoteId) {
      const cn = await t.maybeOne<{ customer_id: string; invoice_number: string; credit_status: string; lifecycle: string; is_credit_note: boolean }>(
        `SELECT customer_id, invoice_number, credit_status, lifecycle, is_credit_note FROM invoices WHERE id = $1`, [args.creditNoteId],
      );
      if (!cn || !cn.is_credit_note) throw new RuleViolation('that credit note no longer exists');
      if (cn.customer_id !== inv.customer_id) throw new RuleViolation(`${cn.invoice_number} belongs to a different customer`);
      if (cn.lifecycle === 'Cancelled') throw new RuleViolation(`${cn.invoice_number} is cancelled`);
      if (cn.credit_status !== 'Approved') throw new RuleViolation(`${cn.invoice_number} is still waiting for approval`);
    }
    const r = await applyCreditTx(t, actor, args);
    if (r.appliedCents <= 0) {
      throw new RuleViolation(args.creditNoteId ? 'that credit note has no credit left to apply' : 'they have no unused credit to apply');
    }
    return r;
  });
}

/**
 * Unused credit over SEVERAL invoices at once (Everton, 9 Nov 2026: "one by
 * one" was too slow - Treasure Isle had J$530 of credit and two invoices).
 * The invoices named, or all the customer's open invoices, oldest first,
 * until the credit (one credit note, or all of it) runs out. One transaction.
 */
export async function applyCreditAcross(
  db: Db, actor: Actor, args: { customerId: string; creditNoteId?: string | null; invoiceIds?: readonly string[] | null },
): Promise<{ appliedCents: Cents; invoices: string[]; creditNotes: string[] }> {
  requireRole(actor, 'admin', 'user');
  return db.tx((t) => applyCreditAcrossTx(t, actor, args));
}

/** applyCreditAcross inside the caller's transaction (credit note raised or approved). */
export async function applyCreditAcrossTx(
  t: Queryable, actor: Actor, args: { customerId: string; creditNoteId?: string | null; invoiceIds?: readonly string[] | null; quiet?: boolean },
): Promise<{ appliedCents: Cents; invoices: string[]; creditNotes: string[] }> {
  {
    if (args.creditNoteId) {
      const cn = await t.maybeOne<{ customer_id: string; invoice_number: string; credit_status: string; lifecycle: string; is_credit_note: boolean }>(
        `SELECT customer_id, invoice_number, credit_status, lifecycle, is_credit_note FROM invoices WHERE id = $1`, [args.creditNoteId],
      );
      if (!cn || !cn.is_credit_note) throw new RuleViolation('that credit note no longer exists');
      if (cn.customer_id !== args.customerId) throw new RuleViolation(`${cn.invoice_number} belongs to a different customer`);
      if (cn.lifecycle === 'Cancelled') throw new RuleViolation(`${cn.invoice_number} is cancelled`);
      if (cn.credit_status !== 'Approved') throw new RuleViolation(`${cn.invoice_number} is still waiting for approval`);
    }
    const wanted = args.invoiceIds?.length ? new Set(args.invoiceIds) : null;
    const open = await t.query<{ invoice_id: string; customer_id: string; invoice_number: string }>(
      `SELECT l.invoice_id, l.customer_id, l.invoice_number
       FROM invoice_ledger l JOIN invoices i ON i.id = l.invoice_id
       WHERE l.customer_id = $1 AND NOT l.is_credit_note AND l.status <> 'Cancelled' AND l.balance_cents > 0
       ORDER BY COALESCE(l.due_date, l.invoice_date), l.invoice_date, i.created_at`, [args.customerId],
    );
    if (wanted) {
      for (const id of wanted) {
        if (!open.some((o) => o.invoice_id === id)) {
          const x = await t.maybeOne<{ invoice_number: string; customer_id: string }>(`SELECT invoice_number, customer_id FROM invoices WHERE id = $1`, [id]);
          if (!x) throw new RuleViolation('one of those invoices no longer exists');
          if (x.customer_id !== args.customerId) throw new RuleViolation(`${x.invoice_number} belongs to a different customer`);
          throw new RuleViolation(`${x.invoice_number} has nothing owed on it`);
        }
      }
    }
    const targets = open.filter((o) => !wanted || wanted.has(o.invoice_id));
    if (targets.length === 0) {
      if (args.quiet) return { appliedCents: 0, invoices: [], creditNotes: [] };
      throw new RuleViolation('they have no open invoices to apply credit to');
    }
    let applied = 0;
    const invoices: string[] = []; const used = new Set<string>();
    for (const inv of targets) {
      const r = await applyCreditTx(t, actor, { invoiceId: inv.invoice_id, creditNoteId: args.creditNoteId ?? null });
      if (r.appliedCents <= 0) break; // the credit has run out
      applied += r.appliedCents; invoices.push(inv.invoice_number);
      r.creditNotes.forEach((c) => used.add(c));
    }
    if (applied <= 0 && !args.quiet) {
      throw new RuleViolation(args.creditNoteId ? 'that credit note has no credit left to apply' : 'they have no unused credit to apply');
    }
    return { appliedCents: applied, invoices, creditNotes: [...used] };
  }
}

/** Take credit back off an invoice (an admin, when it went on the wrong one). */
export async function unapplyCredit(db: Db, actor: Actor, applicationId: string): Promise<void> {
  requireRole(actor, 'admin');
  await db.tx(async (t) => {
    const a = await t.maybeOne<{ invoice_id: string; amount_cents: string; cn: string; inv: string }>(
      `SELECT a.invoice_id, a.amount_cents::text AS amount_cents, cn.invoice_number AS cn, inv.invoice_number AS inv
       FROM credit_applications a JOIN invoices cn ON cn.id = a.credit_note_id JOIN invoices inv ON inv.id = a.invoice_id
       WHERE a.id = $1`, [applicationId],
    );
    if (!a) throw new RuleViolation('that credit is no longer applied');
    await t.query(`DELETE FROM credit_applications WHERE id = $1`, [applicationId]);
    await audit(t, actor, 'update', 'Invoice', a.invoice_id, a.inv, {
      creditUnapplied: { creditNote: a.cn, amountCents: num(a.amount_cents) },
      summary: `${money(num(a.amount_cents))} of credit note ${a.cn} taken back off ${a.inv}.`,
    });
  });
}

/**
 * A credit note just approved: if it was raised against an invoice, apply it
 * there; if "apply to their open invoices now" was ticked (11 Nov 2026), the
 * rest goes on their other open invoices, oldest first. Never refuses: the
 * credit note is raised or approved whatever is left unused.
 */
export async function autoApplyLinked(
  t: Queryable, actor: Actor, creditNoteId: string, opts: { toOpenInvoices?: boolean } = {},
): Promise<void> {
  const cn = await t.maybeOne<{ linked_invoice_id: string | null; credit_status: string; customer_id: string }>(
    `SELECT linked_invoice_id, credit_status, customer_id FROM invoices WHERE id = $1 AND is_credit_note`, [creditNoteId],
  );
  if (!cn || cn.credit_status !== 'Approved') return;
  if (cn.linked_invoice_id) await applyCreditTx(t, actor, { invoiceId: cn.linked_invoice_id, creditNoteId, automatic: true });
  if (opts.toOpenInvoices) await applyCreditAcrossTx(t, actor, { customerId: cn.customer_id, creditNoteId, quiet: true });
}
