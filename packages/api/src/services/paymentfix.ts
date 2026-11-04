/**
 * The payment ⋯ menu (Everton, 4 Nov 2026): View receipt, Edit payment,
 * Move to another customer, Reverse, Delete, on every payment row of the
 * Payments screen and the customer's Transactions tab.
 *
 * His rulings:
 *  - It acts on the WHOLE payment (one RCT number), even when it was spread
 *    over several invoices, from any of its lines.
 *  - Edit and Move are simply done: no note on either customer's account, no
 *    reversal line. The audit log is the only record (before and after).
 *  - Move keeps the RCT number. The money goes to the invoices picked, else
 *    to the customer's oldest open invoices first; anything beyond stays as
 *    credit on their account.
 *  - Delete removes the payment completely, for a true error nobody knows
 *    happened. Its RCT number is never reused. Only the audit log keeps it.
 *    The screen warns (does not block) when the receipt was emailed or the
 *    money is part of a settled round's cash.
 *  - Reverse stays as before: the original and its reversal both show.
 *  - Office staff may ask for any of these; an administrator approves it
 *    under Needs a decision. An administrator's own action applies at once.
 *
 * This supersedes, for these screens, the older "Change" path in
 * payments.ts (requestPaymentChange), which reversed and re-posted a payment
 * whose amount changed. That path is left in place for anything still using it.
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { assertMethodAllowed, audit, num, requireRole } from './core.ts';
import type { PaymentMethod } from '@alka/shared';
import { RuleViolation } from '@alka/shared';

export interface Allocation { invoiceId: string; amountCents?: number | null }

export type PaymentFix =
  | {
      action: 'edit';
      amountCents?: number;
      paymentDate?: string;
      method?: PaymentMethod;
      reference?: string | null;
      /** The invoices it pays and how much on each; what is left stays as credit. Left out = as it is now. */
      allocations?: Allocation[];
    }
  | {
      action: 'move';
      customerId: string;
      /** Picked invoices of the new customer. None picked = oldest open invoices first. */
      allocations?: Allocation[];
    }
  | { action: 'reverse' }
  | { action: 'delete' };

interface Row {
  id: string; customer_id: string; invoice_id: string | null; invoice_number: string | null;
  invoice_date: string | null; amount_cents: number; payment_date: string; payment_day: string;
  method: PaymentMethod; reference: string | null; notes: string | null; status: string;
  delivery_sheet_id: string | null; delivery_stop_id: string | null; kind: string | null;
  order_id: string | null; receipt_number: string | null; created_by_id: string | null;
  created_at: string; is_reversal: boolean; reversed: boolean;
}

const ROW_SQL = `
  SELECT p.id, p.customer_id, p.invoice_id, i.invoice_number, i.invoice_date::text AS invoice_date,
         p.amount_cents, p.payment_date::text AS payment_date,
         business_date(p.payment_date)::text AS payment_day, p.method, p.reference, p.notes,
         p.status, p.delivery_sheet_id, p.delivery_stop_id, p.kind, p.order_id, p.receipt_number,
         p.created_by_id, p.created_at::text AS created_at, p.is_reversal,
         EXISTS (SELECT 1 FROM payments r WHERE r.reverses_payment_id = p.id) AS reversed
  FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id`;

const cash = (c: number) => `$${(c / 100).toLocaleString('en-JM', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Every line of the payment the clicked row belongs to: same customer, same
 * RCT number, confirmed, not a reversal and not reversed. Locked for the
 * rest of the transaction when `lock` is set.
 */
async function loadGroup(t: Queryable, paymentId: string, lock: boolean): Promise<Row[]> {
  const p = await t.maybeOne<Row>(`${ROW_SQL} WHERE p.id = $1`, [paymentId]);
  if (!p) throw new RuleViolation('that payment no longer exists (it may have been changed or deleted already)');
  if (p.is_reversal) throw new RuleViolation('this line is a reversal; it cannot be changed');
  if (p.reversed) throw new RuleViolation('this payment has been reversed, so it cannot be changed');
  if (p.status !== 'Confirmed') {
    throw new RuleViolation('this payment is still waiting for its round to be settled; settle the round first');
  }
  if (!p.receipt_number) {
    if (lock) await t.query(`SELECT id FROM payments WHERE id = $1 FOR UPDATE`, [p.id]);
    return [p];
  }
  const rows = await t.query<Row>(
    `${ROW_SQL}
     WHERE p.customer_id = $1 AND p.receipt_number = $2 AND p.status = 'Confirmed'
       AND NOT p.is_reversal
       AND NOT EXISTS (SELECT 1 FROM payments r WHERE r.reverses_payment_id = p.id)
     ORDER BY p.created_at, p.id`,
    [p.customer_id, p.receipt_number],
  );
  if (lock) {
    await t.query(`SELECT id FROM payments WHERE id = ANY($1::uuid[]) FOR UPDATE`, [rows.map((r) => r.id)]);
  }
  return rows;
}

async function customerName(t: Queryable, id: string): Promise<string> {
  const c = await t.maybeOne<{ name: string }>(`SELECT name FROM customers WHERE id = $1`, [id]);
  if (!c) throw new RuleViolation('that customer no longer exists');
  return c.name;
}

/* ------------------------------------------------------------------ */
/* What the ⋯ menu needs to know before it opens a panel               */
/* ------------------------------------------------------------------ */

export interface PaymentFixInfo {
  paymentId: string;
  receiptNumber: string | null;
  customerId: string;
  customerName: string;
  paymentDate: string;
  method: PaymentMethod;
  reference: string | null;
  totalCents: number;
  lines: Array<{ id: string; invoiceId: string | null; invoiceNumber: string | null; amountCents: number }>;
  /** The money is part of a settled round's cash: deleting it makes the round look short. */
  settledRound: string | null;
  /** The receipt was emailed to someone. */
  receiptEmailedTo: string | null;
  /** A change to it is already waiting for an administrator. */
  waiting: boolean;
}

export async function paymentFixInfo(db: Db, actor: Actor, paymentId: string): Promise<PaymentFixInfo> {
  requireRole(actor, 'admin', 'user');
  const rows = await loadGroup(db, paymentId, false);
  const a = rows[0];
  const round = await db.maybeOne<{ zone: string; d: string }>(
    `SELECT s.zone, s.delivery_date::text AS d FROM delivery_sheets s
     WHERE s.id = ANY($1::uuid[]) AND s.status = 'Completed' LIMIT 1`,
    [rows.map((r) => r.delivery_sheet_id).filter(Boolean)],
  );
  const emailed = a.receipt_number ? await db.maybeOne<{ to: string }>(
    `SELECT details->>'receiptEmailedTo' AS to FROM audit_log
     WHERE entity_type = 'Payment' AND details ? 'receiptEmailedTo'
       AND (entity_label = $1 OR entity_id = ANY($2::uuid[]))
     ORDER BY ts DESC LIMIT 1`, [a.receipt_number, rows.map((r) => r.id)],
  ) : null;
  const waiting = await db.maybeOne(
    `SELECT 1 FROM approval_requests
     WHERE request_type = 'PaymentChange' AND status = 'Pending' AND entity_id = ANY($1::uuid[])`,
    [rows.map((r) => r.id)],
  );
  return {
    paymentId: a.id,
    receiptNumber: a.receipt_number,
    customerId: a.customer_id,
    customerName: await customerName(db, a.customer_id),
    paymentDate: a.payment_day,
    method: a.method,
    reference: a.reference,
    totalCents: rows.reduce((n, r) => n + num(r.amount_cents), 0),
    lines: rows.map((r) => ({
      id: r.id, invoiceId: r.invoice_id, invoiceNumber: r.invoice_number, amountCents: num(r.amount_cents),
    })),
    settledRound: round ? `${round.zone} round of ${round.d}` : null,
    receiptEmailedTo: emailed?.to ?? null,
    waiting: !!waiting,
  };
}

/* ------------------------------------------------------------------ */
/* Asking (office) or doing (admin)                                    */
/* ------------------------------------------------------------------ */

export async function requestPaymentFix(
  db: Db, actor: Actor, paymentId: string, fix: PaymentFix, reason?: string | null,
): Promise<{ applied: boolean; approvalRequestId: string | null; paymentId: string | null }> {
  requireRole(actor, 'admin', 'user');
  const why = (reason ?? '').trim() || null;
  const clean = cleanFix(fix);
  if ((clean.action === 'reverse' || clean.action === 'delete') && !why) {
    throw new RuleViolation(`say why the payment is being ${clean.action === 'reverse' ? 'reversed' : 'deleted'}`);
  }

  return db.tx(async (t) => {
    const rows = await loadGroup(t, paymentId, true);
    const waiting = await t.maybeOne(
      `SELECT 1 FROM approval_requests
       WHERE request_type = 'PaymentChange' AND status = 'Pending' AND entity_id = ANY($1::uuid[])`,
      [rows.map((r) => r.id)],
    );
    if (waiting) throw new RuleViolation('a change to this payment is already waiting for an administrator');

    // Check it now, so the office hears of a problem before an admin does.
    const plan = clean.action === 'edit' || clean.action === 'move' ? await planFix(t, rows, clean) : null;

    if (actor.role === 'admin') {
      const r = await applyGroupFix(t, actor, rows, clean, why);
      return { applied: true, approvalRequestId: null, paymentId: r.paymentId };
    }

    const total = rows.reduce((n, r) => n + num(r.amount_cents), 0);
    const label = rows[0].receipt_number ?? rows[0].reference ?? `payment of ${cash(total)}`;
    const payload = {
      fix: clean,
      // For the approval screen: what will happen, in words.
      summary: describeFix(clean, rows, plan, plan ? await customerName(t, plan.customerId) : null),
    };
    const req = await t.one<{ id: string }>(
      `INSERT INTO approval_requests
         (request_type, status, entity_type, entity_id, entity_label, customer_id,
          amount_cents, reason, requested_by_id, payload)
       VALUES ('PaymentChange','Pending','Payment',$1,$2,$3,$4,$5,$6,$7::jsonb)
       RETURNING id`,
      [rows[0].id, label, rows[0].customer_id, total, why, actor.id, JSON.stringify(payload)],
    );
    await audit(t, actor, 'create', 'ApprovalRequest', req.id, label, {
      requestType: 'PaymentChange', fix: clean, reason: why,
    });
    return { applied: false, approvalRequestId: req.id, paymentId: null };
  });
}

/** Called by approvals.ts when an administrator approves an office request. */
export async function applyApprovedPaymentFix(
  t: Queryable, actor: Actor, paymentId: string, fix: PaymentFix, reason: string | null,
): Promise<void> {
  const rows = await loadGroup(t, paymentId, true);
  await applyGroupFix(t, actor, rows, cleanFix(fix), reason);
}

function cleanFix(f: PaymentFix): PaymentFix {
  const allocs = (a: Allocation[] | undefined) => (a === undefined ? undefined : (a ?? [])
    .filter((x) => x && x.invoiceId)
    .map((x) => ({
      invoiceId: String(x.invoiceId),
      amountCents: x.amountCents === undefined || x.amountCents === null ? null : Math.round(Number(x.amountCents)),
    })));
  switch (f?.action) {
    case 'edit': {
      const out: PaymentFix = { action: 'edit' };
      if (f.amountCents !== undefined && f.amountCents !== null) out.amountCents = Math.round(Number(f.amountCents));
      if (f.paymentDate) out.paymentDate = String(f.paymentDate).slice(0, 10);
      if (f.method) out.method = f.method;
      if (f.reference !== undefined) out.reference = f.reference?.trim() || null;
      const a = allocs(f.allocations);
      if (a !== undefined) out.allocations = a;
      return out;
    }
    case 'move': {
      if (!f.customerId) throw new RuleViolation('choose the customer to move it to');
      const out: PaymentFix = { action: 'move', customerId: String(f.customerId) };
      const a = allocs(f.allocations);
      if (a !== undefined) out.allocations = a;
      return out;
    }
    case 'reverse': return { action: 'reverse' };
    case 'delete': return { action: 'delete' };
    default: throw new RuleViolation('what should happen to the payment?');
  }
}

/* ------------------------------------------------------------------ */
/* Working out where the money goes                                    */
/* ------------------------------------------------------------------ */

interface Plan {
  customerId: string;
  totalCents: number;
  paymentInstant: string;
  /** The payment's day in Jamaica. */
  day: string;
  method: PaymentMethod;
  reference: string | null;
  /** invoiceId null = left on the account as credit. */
  parts: Array<{ invoiceId: string | null; invoiceNumber: string | null; amountCents: number }>;
  /** Only the date, method or reference change: the lines stay where they are. */
  inPlace: boolean;
}

async function planFix(t: Queryable, rows: Row[], f: PaymentFix & { action: 'edit' | 'move' }): Promise<Plan> {
  const a = rows[0];
  const current = rows.reduce((n, r) => n + num(r.amount_cents), 0);
  const customerId = f.action === 'move' ? f.customerId : a.customer_id;
  const moving = customerId !== a.customer_id;
  if (f.action === 'move' && !moving) throw new RuleViolation('it is already on that customer');
  if (moving) await customerName(t, customerId);

  const total = f.action === 'edit' && f.amountCents !== undefined ? f.amountCents : current;
  if (!(total > 0)) throw new RuleViolation('a payment must be more than zero');

  const method = f.action === 'edit' && f.method ? f.method : a.method;
  if (method !== a.method) await assertMethodAllowed(t, method);
  const reference = f.action === 'edit' && f.reference !== undefined ? f.reference ?? null : a.reference;

  let instant = a.payment_date;
  let day = a.payment_day;
  if (f.action === 'edit' && f.paymentDate && f.paymentDate !== a.payment_day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.paymentDate)) throw new RuleViolation('that date is not a date');
    const today = (await t.one<{ d: string }>(`SELECT business_today()::text AS d`)).d;
    if (f.paymentDate > today) throw new RuleViolation('a payment cannot be dated in the future');
    instant = `${f.paymentDate}T12:00:00-05:00`;
    day = f.paymentDate;
  }

  const allocations = f.allocations;
  const inPlace = !moving && total === current && allocations === undefined;
  if (inPlace) {
    return {
      customerId, totalCents: total, paymentInstant: instant, day, method, reference, inPlace,
      parts: rows.map((r) => ({ invoiceId: r.invoice_id, invoiceNumber: r.invoice_number, amountCents: num(r.amount_cents) })),
    };
  }

  // What each open invoice of the customer still owes, as if this payment
  // were not there (it is about to be rewritten).
  const own = new Map<string, number>();
  for (const r of rows) if (r.invoice_id && !moving) own.set(r.invoice_id, (own.get(r.invoice_id) ?? 0) + num(r.amount_cents));
  const open = await t.query<{
    invoice_id: string; invoice_number: string; invoice_date: string; balance_cents: number;
    is_credit_note: boolean; status: string;
  }>(
    `SELECT invoice_id, invoice_number, invoice_date::text AS invoice_date, balance_cents, is_credit_note, status
     FROM invoice_ledger WHERE customer_id = $1
     ORDER BY invoice_date, invoice_number`, [customerId],
  );
  const owes = (id: string) => {
    const i = open.find((x) => x.invoice_id === id);
    return i ? num(i.balance_cents) + (own.get(id) ?? 0) : 0;
  };

  const parts: Plan['parts'] = [];
  let left = total;

  // Picked invoices (or, for an edit with nothing said, the ones it pays now),
  // oldest first, so a smaller amount comes off the newest.
  const picked = allocations ?? (f.action === 'edit'
    ? rows.filter((r) => r.invoice_id).map((r) => ({ invoiceId: r.invoice_id!, amountCents: num(r.amount_cents) }))
    : []);
  const merged = new Map<string, number | null>();
  for (const p of picked) {
    const prev = merged.get(p.invoiceId);
    merged.set(p.invoiceId, p.amountCents === null || p.amountCents === undefined ? null
      : (prev ?? 0) + p.amountCents);
  }
  const pickedRows = [...merged.entries()].map(([invoiceId, amt]) => {
    const inv = open.find((x) => x.invoice_id === invoiceId);
    if (!inv) throw new RuleViolation('one of those invoices belongs to a different customer, or no longer exists');
    if (inv.is_credit_note) throw new RuleViolation(`${inv.invoice_number} is a credit note; a payment cannot go against it`);
    if (inv.status === 'Cancelled') throw new RuleViolation(`${inv.invoice_number} is cancelled or void`);
    const owed = owes(invoiceId);
    const want = amt === null ? owed : amt;
    if (want < 0) throw new RuleViolation('an amount on an invoice cannot be below zero');
    if (amt !== null && want > owed) {
      throw new RuleViolation(`${inv.invoice_number} only owes ${cash(owed)}`);
    }
    return { inv, want };
  }).sort((x, y) => (x.inv.invoice_date + x.inv.invoice_number).localeCompare(y.inv.invoice_date + y.inv.invoice_number));

  if (allocations && allocations.length) {
    const asked = pickedRows.reduce((n, p) => n + p.want, 0);
    const explicit = [...merged.values()].every((v) => v !== null);
    if (explicit && asked > total) {
      throw new RuleViolation(`the invoices picked add up to ${cash(asked)}, more than the payment of ${cash(total)}`);
    }
  }
  for (const p of pickedRows) {
    const take = Math.min(p.want, left);
    if (take > 0) { parts.push({ invoiceId: p.inv.invoice_id, invoiceNumber: p.inv.invoice_number, amountCents: take }); left -= take; }
  }

  // Moved with nothing picked: oldest open invoices first.
  if (f.action === 'move' && (!allocations || allocations.length === 0)) {
    for (const inv of open) {
      if (left <= 0) break;
      if (inv.is_credit_note || inv.status === 'Cancelled') continue;
      const owed = owes(inv.invoice_id);
      if (owed <= 0) continue;
      const take = Math.min(owed, left);
      parts.push({ invoiceId: inv.invoice_id, invoiceNumber: inv.invoice_number, amountCents: take });
      left -= take;
    }
  }
  if (left > 0) parts.push({ invoiceId: null, invoiceNumber: null, amountCents: left });

  return { customerId, totalCents: total, paymentInstant: instant, day, method, reference, parts, inPlace };
}

/* ------------------------------------------------------------------ */
/* Doing it                                                            */
/* ------------------------------------------------------------------ */

async function applyGroupFix(
  t: Queryable, actor: Actor, rows: Row[], f: PaymentFix, reason: string | null,
): Promise<{ paymentId: string | null }> {
  const a = rows[0];
  const total = rows.reduce((n, r) => n + num(r.amount_cents), 0);
  const fromName = await customerName(t, a.customer_id);
  const label = a.receipt_number ?? a.reference ?? 'payment';
  const linesWords = (parts: Array<{ invoiceNumber: string | null; amountCents: number }>) =>
    parts.map((p) => `${cash(p.amountCents)} ${p.invoiceNumber ? `on ${p.invoiceNumber}` : 'as credit'}`).join(', ');
  const before = {
    customerId: a.customer_id, customerName: fromName, totalCents: total, date: a.payment_day,
    method: a.method, reference: a.reference,
    lines: rows.map((r) => ({ invoiceId: r.invoice_id, invoiceNumber: r.invoice_number, amountCents: num(r.amount_cents) })),
  };

  if (f.action === 'delete') {
    const round = await t.maybeOne<{ zone: string; d: string }>(
      `SELECT zone, delivery_date::text AS d FROM delivery_sheets
       WHERE id = ANY($1::uuid[]) AND status = 'Completed' LIMIT 1`,
      [rows.map((r) => r.delivery_sheet_id).filter(Boolean)],
    );
    await t.query(`DELETE FROM payments WHERE id = ANY($1::uuid[])`, [rows.map((r) => r.id)]);
    await audit(t, actor, 'delete', 'Payment', a.id, label, {
      paymentFix: 'delete', reason, before,
      settledRound: round ? `${round.zone} round of ${round.d}` : null,
      summary: `Payment ${label} (${cash(total)} ${a.method.toLowerCase()}, ${a.payment_day}) from ${fromName} deleted. `
        + `It was ${linesWords(before.lines)}.`
        + (round ? ` It was part of the settled ${round.zone} round of ${round.d}.` : ''),
    });
    return { paymentId: null };
  }

  if (f.action === 'reverse') {
    for (const r of rows) {
      const rev = await t.one<{ id: string }>(
        `INSERT INTO payments
           (customer_id, invoice_id, amount_cents, method, status,
            is_reversal, reverses_payment_id, notes, created_by_id, receipt_number)
         VALUES ($1,$2,$3,$4,'Confirmed',true,$5,$6,$7,$8)
         RETURNING id`,
        [r.customer_id, r.invoice_id, -num(r.amount_cents), r.method, r.id,
         reason ?? 'Payment reversed', actor.id, r.receipt_number],
      );
      await audit(t, actor, 'adjust', 'Payment', rev.id, label, {
        reversesPaymentId: r.id, amountCents: -num(r.amount_cents), reason, originalPreserved: true,
      });
    }
    return { paymentId: null };
  }

  const plan = await planFix(t, rows, f);
  const toName = plan.customerId === a.customer_id ? fromName : await customerName(t, plan.customerId);

  if (plan.inPlace) {
    await t.query(
      `UPDATE payments SET payment_date = $2::timestamptz, method = $3, reference = $4
       WHERE id = ANY($1::uuid[])`,
      [rows.map((r) => r.id), plan.paymentInstant, plan.method, plan.reference],
    );
  } else {
    const moving = plan.customerId !== a.customer_id;
    // Re-use the existing lines in order, then add or remove lines as needed.
    // Every line keeps the RCT number and how and when the money came in.
    for (let i = 0; i < plan.parts.length; i++) {
      const part = plan.parts[i];
      // Money taken with an order stays kept for it, on the same customer only.
      const orderId = !moving && !part.invoiceId ? a.order_id : null;
      if (i < rows.length) {
        await t.query(
          `UPDATE payments
           SET customer_id = $2, invoice_id = $3, amount_cents = $4, payment_date = $5::timestamptz,
               method = $6, reference = $7, order_id = $8
           WHERE id = $1`,
          [rows[i].id, plan.customerId, part.invoiceId, part.amountCents, plan.paymentInstant,
           plan.method, plan.reference, orderId],
        );
      } else {
        await t.query(
          `INSERT INTO payments
             (customer_id, invoice_id, amount_cents, payment_date, method, reference, notes, status,
              delivery_sheet_id, delivery_stop_id, kind, created_by_id, order_id, receipt_number, created_at)
           VALUES ($1,$2,$3,$4::timestamptz,$5,$6,$7,'Confirmed',$8,$9,$10,$11,$12,$13,$14::timestamptz)`,
          [plan.customerId, part.invoiceId, part.amountCents, plan.paymentInstant, plan.method,
           plan.reference, a.notes, a.delivery_sheet_id, a.delivery_stop_id, a.kind, a.created_by_id,
           orderId, a.receipt_number, a.created_at],
        );
      }
    }
    if (rows.length > plan.parts.length) {
      await t.query(`DELETE FROM payments WHERE id = ANY($1::uuid[])`,
        [rows.slice(plan.parts.length).map((r) => r.id)]);
    }
  }

  const after = {
    customerId: plan.customerId, customerName: toName, totalCents: plan.totalCents,
    date: plan.day, method: plan.method, reference: plan.reference,
    lines: plan.parts,
  };
  const summary = f.action === 'move'
    ? `Payment ${label} (${cash(plan.totalCents)} ${plan.method.toLowerCase()}) moved from ${fromName} to ${toName}: ${linesWords(plan.parts)}. `
      + `On ${fromName} it was ${linesWords(before.lines)}.`
    : `Payment ${label} for ${fromName} edited: ${editWords(before, after)}.`;
  await audit(t, actor, 'adjust', 'Payment', a.id, label, {
    paymentFix: f.action, reason, before, after, summary,
  });
  return { paymentId: a.id };
}

function editWords(
  b: { totalCents: number; date: string; method: string; reference: string | null; lines: Array<{ invoiceNumber: string | null; amountCents: number }> },
  a: { totalCents: number; date: string; method: string; reference: string | null; lines: Array<{ invoiceNumber: string | null; amountCents: number }> },
): string {
  const bits: string[] = [];
  if (a.totalCents !== b.totalCents) bits.push(`amount ${cash(b.totalCents)} → ${cash(a.totalCents)}`);
  if (a.date !== b.date) bits.push(`date ${b.date} → ${a.date}`);
  if (a.method !== b.method) bits.push(`method ${b.method} → ${a.method}`);
  if ((a.reference ?? '') !== (b.reference ?? '')) bits.push(`reference "${b.reference ?? ''}" → "${a.reference ?? ''}"`);
  const w = (l: typeof a.lines) => l.map((p) => `${cash(p.amountCents)} ${p.invoiceNumber ? `on ${p.invoiceNumber}` : 'as credit'}`).join(', ');
  if (w(a.lines) !== w(b.lines)) bits.push(`now ${w(a.lines)} (was ${w(b.lines)})`);
  return bits.join('; ') || 'nothing changed';
}

/** Words for the approval screen. */
function describeFix(f: PaymentFix, rows: Row[], plan: Plan | null, toName: string | null): string {
  const total = rows.reduce((n, r) => n + num(r.amount_cents), 0);
  const where = (parts: Array<{ invoiceNumber: string | null; amountCents: number }>) =>
    parts.map((p) => `${cash(p.amountCents)} ${p.invoiceNumber ? `on ${p.invoiceNumber}` : 'as credit'}`).join(', ');
  switch (f.action) {
    case 'delete': return `Delete it (${cash(total)}). It disappears from the account; only the audit log keeps it.`;
    case 'reverse': return `Reverse it (${cash(total)}). The original and its reversal both stay on the account.`;
    case 'move': return `Move it to ${toName ?? 'another customer'}: ${plan ? where(plan.parts) : ''}.`;
    case 'edit': {
      if (!plan) return 'Edit it.';
      const a = rows[0];
      return `Edit it: ${editWords(
        { totalCents: total, date: a.payment_day, method: a.method, reference: a.reference,
          lines: rows.map((r) => ({ invoiceNumber: r.invoice_number, amountCents: num(r.amount_cents) })) },
        { totalCents: plan.totalCents, date: plan.day, method: plan.method,
          reference: plan.reference, lines: plan.parts },
      )}.`;
    }
  }
}
