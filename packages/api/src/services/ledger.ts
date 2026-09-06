/**
 * Customer ledger and statement (Section 4).
 *
 * ONE running balance per customer - not a balance plus a separate credit
 * balance. Whether a payment is attached to an invoice is bookkeeping detail
 * for which invoice reads as Paid on paper; it never gates the overall
 * balance, and no "credit" category exists in these filters or results.
 *
 * A customer's periodic bill IS this statement exported for a date range.
 * Nothing is "closed" or "batched" to produce one.
 */

import type { Db } from '../db/index.ts';
import type { Cents } from '@alka/shared';
import { BUSINESS_TIMEZONE, num } from './core.ts';

/**
 * The business operates in Jamaica. Statement periods are cut on Jamaican
 * calendar days, not UTC ones - otherwise an evening payment would fall into
 * the next day's period and land on the wrong monthly bill.
 */
export { BUSINESS_TIMEZONE };

export type EntryType = 'Invoice' | 'Credit Note' | 'Payment' | 'Reversal' | 'Reassignment';

/** The filters the statement screen offers. Deliberately no "Credits" filter:
 *  a credit note is a line detail within Invoices, not its own category. */
export type StatementFilter = 'All' | 'Invoices' | 'Payments';

export interface StatementEntry {
  date: string;
  type: EntryType;
  description: string;
  reference: string;
  /** Positive increases what the customer owes; negative reduces it. */
  amountCents: Cents;
  runningBalanceCents: Cents;
}

export interface Statement {
  customerId: string;
  customerName: string;
  from: string | null;
  to: string | null;
  openingBalanceCents: Cents;
  closingBalanceCents: Cents;
  entries: StatementEntry[];
}

export async function getStatement(
  db: Db,
  customerId: string,
  opts: { from?: string | null; to?: string | null; filter?: StatementFilter } = {},
): Promise<Statement> {
  const filter = opts.filter ?? 'All';
  const from = opts.from ?? null;
  const to = opts.to ?? null;

  const customer = await db.one<{ name: string }>(
    `SELECT name FROM customers WHERE id = $1`, [customerId],
  );

  // One chronological stream. Invoices, credit notes, payments, reversals and
  // reassignment markers are interleaved by date, never segregated.
  //
  // Every date is rendered to TEXT in the business timezone inside SQL. Two
  // reasons: a timestamptz would arrive as a JS Date whose toString is not
  // comparable to a YYYY-MM-DD bound, and a late-evening Jamaica payment would
  // otherwise land on the following UTC day and fall into the wrong statement
  // period.
  const rows = await db.query<{
    entry_date: string; type: EntryType; description: string;
    reference: string; amount_cents: number; sort_key: string;
  }>(
    `
    WITH entries AS (
      SELECT to_char(i.invoice_date, 'YYYY-MM-DD') AS entry_date,
             CASE WHEN i.is_credit_note THEN 'Credit Note' ELSE 'Invoice' END AS type,
             CASE WHEN i.is_credit_note
                  THEN COALESCE(i.notes, 'Credit note')
                  ELSE COALESCE(i.notes, 'Invoice') END AS description,
             i.invoice_number AS reference,
             i.grand_total_cents AS amount_cents,
             -- The separator must match the other branches exactly: a space
             -- sorts below a digit, so omitting it would order same-day
             -- payments ahead of the invoice they pay.
             to_char(i.invoice_date,'YYYY-MM-DD') || ' ' ||
               to_char(i.created_at AT TIME ZONE $2,'HH24:MI:SS.US') AS sort_key
      FROM invoices i
      WHERE i.customer_id = $1 AND i.lifecycle <> 'Cancelled'
        AND (NOT i.is_credit_note OR i.credit_status = 'Approved')

      UNION ALL

      -- Every Confirmed payment, attached or unattached, in one category.
      SELECT to_char(p.payment_date AT TIME ZONE $2, 'YYYY-MM-DD') AS entry_date,
             CASE WHEN p.is_reversal THEN 'Reversal' ELSE 'Payment' END AS type,
             CASE
               WHEN p.is_reversal THEN 'Payment reversed'
               -- Says WHY the reference is blank. A row reading "Payment
               -- received" next to an empty reference column looks like data
               -- has gone missing. It has not: the money simply is not against
               -- an invoice, and there is no separate credit concept in this
               -- system (invariant 6). This is how that reads on a statement.
               WHEN p.invoice_id IS NULL THEN 'Payment received, left on account'
               ELSE 'Payment received, applied to ' || COALESCE(inv.invoice_number,'')
             END AS description,
             -- The INVOICE it paid comes first. p.reference is whatever the
             -- office typed - a cheque number, a deposit slip - and showing
             -- that under a column headed Reference, beside an invoice row
             -- carrying an invoice number, invites exactly one question: why
             -- do these not match?
             COALESCE(inv.invoice_number, p.reference, '') AS reference,
             -p.amount_cents AS amount_cents,
             to_char(p.payment_date AT TIME ZONE $2,'YYYY-MM-DD HH24:MI:SS.US') AS sort_key
      FROM payments p
      LEFT JOIN invoices inv ON inv.id = p.invoice_id
      WHERE p.customer_id = $1 AND p.status = 'Confirmed'

      UNION ALL

      -- Reassignments are informational markers: the payment itself already
      -- appears above, under whichever customer now owns it.
      SELECT to_char(a.ts AT TIME ZONE $2, 'YYYY-MM-DD') AS entry_date,
             'Reassignment' AS type,
             'Payment reassigned' AS description,
             COALESCE(a.entity_label,'') AS reference,
             0 AS amount_cents,
             to_char(a.ts AT TIME ZONE $2,'YYYY-MM-DD HH24:MI:SS.US') AS sort_key
      FROM audit_log a
      WHERE a.action = 'adjust' AND a.entity_type = 'Payment'
        AND (a.details -> 'after' ->> 'customerId' = $1::text
             OR a.details -> 'before' ->> 'customerId' = $1::text)
        AND (a.details ? 'before')
    )
    SELECT * FROM entries ORDER BY sort_key
    `,
    [customerId, BUSINESS_TIMEZONE],
  );

  const inRange = (d: string) =>
    (!from || d.slice(0, 10) >= from) && (!to || d.slice(0, 10) <= to);
  const matchesFilter = (t: EntryType) =>
    filter === 'All' ? true
    : filter === 'Invoices' ? t === 'Invoice' || t === 'Credit Note'
    : t === 'Payment' || t === 'Reversal';

  // The opening balance is everything before the window, so the running
  // balance inside the window is still true rather than starting from zero.
  let running = 0;
  let opening = 0;
  const entries: StatementEntry[] = [];

  for (const r of rows) {
    const date = String(r.entry_date);
    const amount = num(r.amount_cents);
    if (!inRange(date)) {
      if (!from || date.slice(0, 10) < from) {
        running += amount;
        opening = running;
      }
      continue;
    }
    running += amount;
    if (!matchesFilter(r.type)) continue;
    entries.push({
      date: date.slice(0, 10),
      type: r.type,
      description: r.description,
      reference: r.reference,
      amountCents: amount,
      runningBalanceCents: running,
    });
  }

  return {
    customerId,
    customerName: customer.name,
    from, to,
    openingBalanceCents: opening,
    closingBalanceCents: running,
    entries,
  };
}
