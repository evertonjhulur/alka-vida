/**
 * Route settlement (Section 3 Step 4, Section 7).
 *
 * This is the ONLY place delivery activity turns into real Payments.
 *
 * Two rules from the prior build's failures are structural here:
 *
 *  1. Payments are created by ONE uniform loop over planPayments(). There is
 *     no "if there is a remainder" branch, and no generic overpayment
 *     auto-split running in parallel. Adding either would reintroduce the
 *     duplicate phantom credit bug.
 *
 *  2. Cash variance is a DRIVER ACCOUNTABILITY CHECK ONLY. It compares
 *     physical cash handed in against what the driver recorded collecting.
 *     It never creates, adjusts or influences any Payment or Invoice, and it
 *     touches no customer's account.
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, requireRole, num } from './core.ts';
import type { Cents } from '@alka/shared';
import { planPayments, validateAllocation, RuleViolation } from '@alka/shared';
import { insertPayment } from './payments.ts';
import { amountOwedForStop } from './delivery.ts';
import { recomputeDelivered } from './orders.ts';
import { openInvoicesForCustomer } from './invoices.ts';

export interface SettlementStopRow {
  stopId: string;
  customerName: string;
  outcome: string;
  orderRef: string | null;
  deliveredSummary: string;
  paymentMethod: string | null;
  bottlesDeliveredFull: number;
  bottlesEmptiesPickedUp: number;
  bottlesLostDamaged: number;
  /** What the driver recorded collecting. */
  collectedCents: Cents;
  /** Tax-inclusive amount that was owed for this stop. */
  expectedCents: Cents;
  /** expected - collected, per stop, so a discrepancy traces to one stop. */
  varianceCents: Cents;
  allocations: Array<{ invoiceId: string | null; invoiceNumber: string | null; amountCents: Cents }>;
  /** Everything this customer still owes, so the cash can be applied here. */
  openInvoices: Array<{
    invoiceId: string; invoiceNumber: string; balanceCents: Cents;
    grandTotalCents: Cents; invoiceDate: string; status: string;
  }>;
  settled: boolean;
}

/**
 * The per-stop review table shown before a sheet can be Completed.
 * Deliberately per-stop rather than one route-wide number, so any
 * discrepancy traces to a specific stop.
 */
export async function getSettlementReview(
  db: Db,
  sheetId: string,
): Promise<{
  sheetId: string;
  status: string;
  stops: SettlementStopRow[];
  totalCollectedCents: Cents;
  totalExpectedCents: Cents;
}> {
  const sheet = await db.one<{ status: string }>(
    `SELECT status FROM delivery_sheets WHERE id = $1`, [sheetId],
  );

  const stops = await db.query<{
    id: string; customer_id: string; customer_name: string; stop_outcome: string;
    order_ref: string | null; payment_method: string | null;
    payment_amount_cents: number; settled_at: string | null;
    bottles_delivered_full: number; bottles_empties_picked_up: number;
    bottles_lost_damaged: number;
  }>(
    `SELECT s.id, s.customer_id, c.name AS customer_name, s.stop_outcome, s.order_ref,
            s.payment_method, s.payment_amount_cents, s.settled_at,
            s.bottles_delivered_full, s.bottles_empties_picked_up, s.bottles_lost_damaged
     FROM delivery_stops s JOIN customers c ON c.id = s.customer_id
     WHERE s.delivery_sheet_id = $1
     ORDER BY s.sequence_no, c.name`,
    [sheetId],
  );

  const rows: SettlementStopRow[] = [];
  for (const s of stops) {
    const expected = await amountOwedForStop(db, s.id);
    const collected = num(s.payment_amount_cents);

    const allocations = await db.query<{
      invoice_id: string | null; amount_cents: number; invoice_number: string | null;
    }>(
      `SELECT a.invoice_id, a.amount_cents, i.invoice_number
       FROM delivery_stop_allocations a
       LEFT JOIN invoices i ON i.id = a.invoice_id
       WHERE a.stop_id = $1`,
      [s.id],
    );

    const lines = await db.query<{ product_name: string; cases: number; loose_bottles: number }>(
      `SELECT p.name AS product_name, l.cases, l.loose_bottles
       FROM delivery_stop_lines l JOIN products p ON p.id = l.product_id
       WHERE l.stop_id = $1`,
      [s.id],
    );

    rows.push({
      stopId: s.id,
      customerName: s.customer_name,
      outcome: s.stop_outcome,
      orderRef: s.order_ref,
      deliveredSummary: lines
        .map((l) => `${num(l.cases) > 0 ? `${l.cases} cs` : `${l.loose_bottles} btl`} ${l.product_name}`)
        .join(', '),
      paymentMethod: s.payment_method,
      collectedCents: collected,
      expectedCents: expected,
      varianceCents: expected - collected,
      allocations: allocations.map((a) => ({
        invoiceId: a.invoice_id,
        invoiceNumber: a.invoice_number,
        amountCents: num(a.amount_cents),
      })),
      openInvoices: (await openInvoicesForCustomer(db, s.customer_id)).map((i) => ({
        invoiceId: i.invoiceId,
        invoiceNumber: i.invoiceNumber,
        balanceCents: i.balanceCents,
        grandTotalCents: i.grandTotalCents,
        invoiceDate: String(i.invoiceDate).slice(0, 10),
        status: i.status,
      })),
      bottlesDeliveredFull: num(s.bottles_delivered_full),
      bottlesEmptiesPickedUp: num(s.bottles_empties_picked_up),
      bottlesLostDamaged: num(s.bottles_lost_damaged),
      settled: !!s.settled_at,
    });
  }

  return {
    sheetId,
    status: sheet.status,
    stops: rows,
    totalCollectedCents: rows.reduce((s, r) => s + r.collectedCents, 0),
    totalExpectedCents: rows.reduce((s, r) => s + r.expectedCents, 0),
  };
}

/**
 * A correction to what a stop recorded. Every field is optional; only what is
 * supplied is changed.
 */
export interface StopCorrection {
  paymentMethod?: string;
  paymentAmountCents?: Cents;
  bottlesDeliveredFull?: number;
  bottlesEmptiesPickedUp?: number;
  bottlesLostDamaged?: number;
  deliveredLines?: Array<{ orderLineId: string; cases: number; looseBottles: number }>;
}

/**
 * Apply a correction inside an existing transaction.
 *
 * Shared by an admin correcting directly and by an admin approving one an
 * office user raised, so an approved correction is applied by exactly the
 * same code as a direct one - never a re-derivation that could drift.
 */
export async function applyStopCorrection(
  t: Queryable,
  actor: Actor,
  stopId: string,
  changes: StopCorrection,
  reason: string,
): Promise<void> {
  const before = await t.one<Record<string, unknown>>(
    `SELECT s.payment_method, s.payment_amount_cents, s.bottles_delivered_full,
            s.bottles_empties_picked_up, s.bottles_lost_damaged, s.settled_at,
            d.status AS sheet_status
     FROM delivery_stops s JOIN delivery_sheets d ON d.id = s.delivery_sheet_id
     WHERE s.id = $1`,
    [stopId],
  );
  // Re-checked here as well as at the entry point: an approval can be granted
  // minutes after it was raised, and the route may have closed in between.
  if (before.sheet_status === 'Completed') {
    throw new RuleViolation(
      'this route is closed; corrections now go through payment reversal, ' +
      'reassignment or invoice editing',
    );
  }

  await t.query(
    `UPDATE delivery_stops
     SET payment_method = COALESCE($2, payment_method),
         payment_amount_cents = COALESCE($3, payment_amount_cents),
         bottles_delivered_full = COALESCE($4, bottles_delivered_full),
         bottles_empties_picked_up = COALESCE($5, bottles_empties_picked_up),
         bottles_lost_damaged = COALESCE($6, bottles_lost_damaged)
     WHERE id = $1`,
    [stopId, changes.paymentMethod ?? null, changes.paymentAmountCents ?? null,
     changes.bottlesDeliveredFull ?? null, changes.bottlesEmptiesPickedUp ?? null,
     changes.bottlesLostDamaged ?? null],
  );

  // What THIS stop handed over is corrected, and the order's delivered
  // figures recounted from all its stops (an order can go out in parts).
  for (const l of changes.deliveredLines ?? []) {
    await t.query(
      `INSERT INTO delivery_stop_lines (stop_id, order_line_id, product_id, cases, loose_bottles, total_bottles)
       SELECT $1, oli.id, oli.product_id, $3, $4, $3 * p.bottles_per_case + $4
       FROM order_line_items oli JOIN products p ON p.id = oli.product_id WHERE oli.id = $2
       ON CONFLICT (stop_id, order_line_id) DO UPDATE
         SET cases = EXCLUDED.cases, loose_bottles = EXCLUDED.loose_bottles,
             total_bottles = EXCLUDED.total_bottles`,
      [stopId, l.orderLineId, l.cases, l.looseBottles],
    );
  }
  if ((changes.deliveredLines ?? []).length > 0) {
    const o = await t.maybeOne<{ order_id: string | null }>(
      `SELECT order_id FROM delivery_stops WHERE id = $1`, [stopId],
    );
    if (o?.order_id) await recomputeDelivered(t, o.order_id);
  }

  await audit(t, actor, 'adjust', 'DeliveryStop', stopId, stopId, {
    reason, before, changes, correctedBy: actor.name,
  });
}

/**
 * Correct what a stop recorded, or ask an admin to.
 *
 * A correction rewrites what the driver recorded collecting, delivering and
 * picking up - precisely the record someone would alter to cover a shortfall.
 * So an admin applies it directly, while an office user, who is the one
 * holding the paperwork, may only RAISE it: the proposed change waits in the
 * approvals queue until an admin approves it.
 */
export async function requestStopCorrection(
  db: Db,
  actor: Actor,
  stopId: string,
  changes: StopCorrection,
  reason: string,
): Promise<{ applied: boolean; requestId: string | null }> {
  requireRole(actor, 'admin', 'user');
  if (!reason || !reason.trim()) {
    throw new RuleViolation('a reason is required when correcting a stop record');
  }

  return db.tx(async (t) => {
    const stop = await t.maybeOne<{
      order_ref: string | null; customer_id: string; settled_at: string | null;
      sheet_status: string;
    }>(
      `SELECT s.order_ref, s.customer_id, s.settled_at, d.status AS sheet_status
       FROM delivery_stops s JOIN delivery_sheets d ON d.id = s.delivery_sheet_id
       WHERE s.id = $1`,
      [stopId],
    );
    if (!stop) throw new RuleViolation('that stop no longer exists');
    if (stop.sheet_status === 'Completed') {
      throw new RuleViolation(
        'this route is closed; corrections now go through payment reversal, ' +
        'reassignment or invoice editing',
      );
    }

    if (actor.role === 'admin') {
      await applyStopCorrection(t, actor, stopId, changes, reason);
      return { applied: true, requestId: null };
    }

    const req = await t.one<{ id: string }>(
      `INSERT INTO approval_requests
         (request_type, entity_type, entity_id, entity_label, customer_id,
          amount_cents, reason, requested_by_id, payload)
       VALUES ('StopCorrection','DeliveryStop',$1,$2,$3,$4,$5,$6,$7::jsonb)
       RETURNING id`,
      [stopId, stop.order_ref ?? stopId, stop.customer_id,
       changes.paymentAmountCents ?? 0, reason, actor.id, JSON.stringify(changes)],
    );
    await audit(t, actor, 'update', 'ApprovalRequest', req.id, 'StopCorrection', {
      stopId, changes, reason, note: 'awaiting admin approval',
    });
    return { applied: false, requestId: req.id };
  });
}

/** Kept for direct admin use and for the tests that pin admin-only behaviour. */
export async function correctStopRecord(
  db: Db,
  actor: Actor,
  stopId: string,
  changes: StopCorrection,
  reason: string,
): Promise<void> {
  requireRole(actor, 'admin');
  await requestStopCorrection(db, actor, stopId, changes, reason);
}

/** Adjust a driver's suggested allocation. Admin AND office User may do this. */
export async function adjustAllocation(
  db: Db,
  actor: Actor,
  stopId: string,
  allocations: ReadonlyArray<{ invoiceId: string; amountCents: Cents }>,
): Promise<void> {
  requireRole(actor, 'admin', 'user');

  await db.tx(async (t) => {
    const stop = await t.one<{ payment_amount_cents: number; settled_at: string | null }>(
      `SELECT payment_amount_cents, settled_at FROM delivery_stops WHERE id = $1`, [stopId],
    );
    if (stop.settled_at) throw new RuleViolation('this stop has already been settled');

    const check = validateAllocation(num(stop.payment_amount_cents), allocations);
    if (!check.ok) throw new RuleViolation(check.error);

    await t.query(`DELETE FROM delivery_stop_allocations WHERE stop_id = $1`, [stopId]);
    for (const a of allocations) {
      await t.query(
        `INSERT INTO delivery_stop_allocations (stop_id, invoice_id, amount_cents)
         VALUES ($1,$2,$3)`, [stopId, a.invoiceId, a.amountCents],
      );
    }
    await audit(t, actor, 'update', 'DeliveryStop', stopId, stopId,
      { adjustedAllocation: allocations, by: actor.role });
  });
}

/**
 * Confirm one stop: create the real Payments.
 *
 * Idempotent by settled_at, so a slow response plus a repeated click cannot
 * create two sets of Payments for one stop.
 */
export async function settleStop(
  t: Queryable,
  actor: Actor,
  stopId: string,
): Promise<{ paymentIds: string[]; skipped: boolean }> {
  const stop = await t.one<{
    id: string; customer_id: string; payment_amount_cents: number;
    payment_method: string | null; settled_at: string | null; delivery_sheet_id: string;
  }>(
    `SELECT id, customer_id, payment_amount_cents, payment_method,
            settled_at, delivery_sheet_id
     FROM delivery_stops WHERE id = $1
     FOR UPDATE`,
    [stopId],
  );
  if (stop.settled_at) return { paymentIds: [], skipped: true };

  const allocations = await t.query<{ invoice_id: string; amount_cents: number }>(
    `SELECT invoice_id, amount_cents FROM delivery_stop_allocations
     WHERE stop_id = $1 AND invoice_id IS NOT NULL`,
    [stopId],
  );

  // ONE uniform plan covering attached and unattached portions alike.
  const plan = planPayments(
    num(stop.payment_amount_cents),
    allocations.map((a) => ({ invoiceId: a.invoice_id, amountCents: num(a.amount_cents) })),
  );

  const paymentIds: string[] = [];
  // ONE uniform creation loop. No branch distinguishes a remainder entry, and
  // nothing downstream is permitted to re-inspect or re-split these totals.
  for (const p of plan) {
    const created = await insertPayment(t, actor, {
      customerId: stop.customer_id,
      invoiceId: p.invoiceId,
      amountCents: p.amountCents,
      method: (stop.payment_method ?? 'Cash') as never,
      status: 'Confirmed',
      deliverySheetId: stop.delivery_sheet_id,
      deliveryStopId: stop.id,
      notes: 'Route settlement',
    });
    paymentIds.push(created.id);
  }

  await t.query(`UPDATE delivery_stops SET settled_at = now() WHERE id = $1`, [stopId]);
  return { paymentIds, skipped: false };
}

/**
 * Settle and close the whole route.
 *
 * `actualCashCents` is the physical cash the driver handed in. The resulting
 * variance is recorded against the SHEET as a driver-accountability figure.
 * It is never absorbed into a customer's account and creates no Payment.
 */
export async function settleRoute(
  db: Db,
  actor: Actor,
  sheetId: string,
  args: {
    actualCashCents: Cents;
    bottleActualReturned?: number;
    settlementNotes?: string | null;
    bottleSettleNotes?: string | null;
    complete?: boolean;
  },
): Promise<{
  paymentIds: string[];
  expectedCashCents: Cents;
  actualCashCents: Cents;
  cashVarianceCents: Cents;
  bottleVariance: number | null;
  status: string;
}> {
  requireRole(actor, 'admin', 'user');

  return db.tx(async (t) => {
    const sheet = await t.one<{ status: string; bottle_expected_out: number }>(
      `SELECT status, bottle_expected_out FROM delivery_sheets WHERE id = $1 FOR UPDATE`,
      [sheetId],
    );
    if (sheet.status === 'Completed') {
      throw new RuleViolation('this route is already settled and locked');
    }

    const stops = await t.query<{ id: string }>(
      `SELECT id FROM delivery_stops
       WHERE delivery_sheet_id = $1 AND settled_at IS NULL`,
      [sheetId],
    );

    const paymentIds: string[] = [];
    for (const s of stops) {
      const r = await settleStop(t, actor, s.id);
      paymentIds.push(...r.paymentIds);
    }

    // Expected cash = the sum of what the driver RECORDED collecting across
    // their stops. Comparing it to the physical cash handed in is purely a
    // check on the driver; it has nothing to do with any customer's account.
    const totals = await t.one<{ recorded: number; bottles_out: number }>(
      `SELECT COALESCE(SUM(payment_amount_cents),0)::bigint AS recorded,
              COALESCE(SUM(bottles_empties_picked_up),0)::int AS bottles_out
       FROM delivery_stops WHERE delivery_sheet_id = $1`,
      [sheetId],
    );
    const expectedCash = num(totals.recorded);
    const cashVariance = num(args.actualCashCents) - expectedCash;

    const bottleActual = args.bottleActualReturned ?? null;
    const bottleVariance = bottleActual === null
      ? null
      : bottleActual - num(totals.bottles_out);

    const status = args.complete === false ? sheet.status : 'Completed';

    await t.query(
      `UPDATE delivery_sheets
       SET expected_cash_cents = $2, actual_cash_cents = $3, cash_variance_cents = $4,
           cash_settled = true, reconciled_by = $5, reconciled_date = now(),
           settlement_notes = $6, bottle_actual_returned = $7::int, bottle_variance = $8,
           bottle_settled = ($7::int IS NOT NULL), bottle_settle_notes = $9, status = $10
       WHERE id = $1`,
      [sheetId, expectedCash, args.actualCashCents, cashVariance, actor.id,
       args.settlementNotes ?? null, bottleActual, bottleVariance,
       args.bottleSettleNotes ?? null, status],
    );

    await audit(t, actor, 'finalize', 'DeliverySheet', sheetId, sheetId, {
      paymentsCreated: paymentIds.length,
      expectedCashCents: expectedCash,
      actualCashCents: args.actualCashCents,
      // Flagged for follow-up with the driver. Never posted to any ledger.
      cashVarianceCents: cashVariance,
      cashVarianceIsDriverAccountabilityOnly: true,
      bottleVariance,
      status,
    });

    return {
      paymentIds,
      expectedCashCents: expectedCash,
      actualCashCents: num(args.actualCashCents),
      cashVarianceCents: cashVariance,
      bottleVariance,
      status,
    };
  });
}
