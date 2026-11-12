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
 *     Money the driver did not split goes to the customer's OLDEST open
 *     invoice first (Everton, 15 Oct 2026). That is worked out here, before
 *     the plan, as more allocation inputs - so planPayments is still the one
 *     path, and still emits the whole list in one pass.
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
import { collectedEmpties, settleCollections } from './collections.ts';
import { unconfirmedAdditions } from './trucks.ts';
import { moveEmpties } from './bottles.ts';

export interface SettlementStopRow {
  stopId: string;
  customerName: string;
  outcome: string;
  orderRef: string | null;
  /** A payment the driver added after the stop was delivered (10 Oct 2026). */
  paymentAfterDelivery?: boolean;
  note?: string | null;
  deliveredSummary: string;
  paymentMethod: string | null;
  bottlesDeliveredFull: number;
  bottlesEmptiesPickedUp: number;
  bottlesLostDamaged: number;
  /** What the driver recorded collecting. */
  collectedCents: Cents;
  /**
   * Money already recorded at the office for this stop's order before it went
   * out (27 Oct 2026): if the driver ALSO recorded collecting, it is very
   * likely counted twice.
   */
  paidBeforeCents?: Cents;
  paidBeforeReceipts?: string[];
  /** Tax-inclusive amount that was owed for this stop. */
  expectedCents: Cents;
  /** expected - collected, per stop, so a discrepancy traces to one stop. */
  varianceCents: Cents;
  allocations: Array<{ invoiceId: string | null; invoiceNumber: string | null; amountCents: Cents }>;
  /**
   * Where the money the driver did NOT split will go at settlement: the
   * oldest open invoice first (15 Oct 2026). Anything left after every open
   * invoice is paid stays on the account (invoiceId null).
   */
  autoApplied: Array<{ invoiceId: string | null; invoiceNumber: string | null; amountCents: Cents }>;
  /** Everything this customer still owes, so the cash can be applied here. */
  openInvoices: Array<{
    invoiceId: string; invoiceNumber: string; balanceCents: Cents;
    grandTotalCents: Cents; invoiceDate: string; status: string;
  }>;
  settled: boolean;
  /**
   * What settling this stop actually put on the account (12 Nov 2026: a
   * settled round showed "—" and today's open invoices instead of what was
   * paid). One line per payment created, oldest first.
   */
  paidAtSettlement?: Array<{
    paymentId: string; invoiceId: string | null; invoiceNumber: string | null;
    amountCents: Cents; receiptNumber: string | null; reversed: boolean;
  }>;
}

/**
 * Money collected at a stop that the driver did not split (Everton, 15 Oct
 * 2026): it goes to the customer's oldest open invoice first, then the next,
 * and so on. When the only open invoice is this delivery's own, that is
 * where it goes. Anything left once every open invoice is covered is
 * returned as nothing - planPayments leaves it on the account, as before.
 *
 * `already` is what is going to each invoice in this same settlement
 * (the driver's own split, and earlier stops for the same customer), so an
 * invoice is never paid past its balance.
 */
export async function oldestFirst(
  t: Queryable,
  customerId: string,
  amountCents: Cents,
  already: ReadonlyMap<string, Cents> = new Map(),
): Promise<Array<{ invoiceId: string; invoiceNumber: string; amountCents: Cents }>> {
  if (!(amountCents > 0)) return [];
  const open = await openInvoicesForCustomer(t, customerId); // oldest first
  const out: Array<{ invoiceId: string; invoiceNumber: string; amountCents: Cents }> = [];
  let left = amountCents;
  for (const inv of open) {
    if (left <= 0) break;
    const room = num(inv.balanceCents) - (already.get(inv.invoiceId) ?? 0);
    if (room <= 0) continue;
    const take = Math.min(room, left);
    out.push({ invoiceId: inv.invoiceId, invoiceNumber: inv.invoiceNumber, amountCents: take });
    left -= take;
  }
  return out;
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
  /**
   * The round's bottles (Everton, 23 Oct 2026: the empties a driver listed at
   * a delivery were not showing on the settlement). Full bottles out and
   * empties picked up across the stops, plus empties from collection stops,
   * and - once settled - what was counted and the difference.
   */
  bottles: {
    fullOut: number;
    emptiesFromStops: number;
    emptiesFromCollections: number;
    emptiesRecorded: number;
    lostDamaged: number;
    counted: number | null;
    variance: number | null;
  };
  /** What the settlement recorded, for a round already closed. */
  settledCash: { handedInCents: Cents | null; varianceCents: Cents | null; notes: string | null } | null;
}> {
  const sheet = await db.one<{
    status: string; bottle_actual_returned: number | null; bottle_variance: number | null;
    actual_cash_cents: number | null; cash_variance_cents: number | null; settlement_notes: string | null;
  }>(
    `SELECT status, bottle_actual_returned, bottle_variance, actual_cash_cents, cash_variance_cents, settlement_notes
     FROM delivery_sheets WHERE id = $1`, [sheetId],
  );

  const stops = await db.query<{
    id: string; customer_id: string; order_id: string | null; customer_name: string; stop_outcome: string;
    order_ref: string | null; payment_method: string | null;
    payment_amount_cents: number; settled_at: string | null;
    bottles_delivered_full: number; bottles_empties_picked_up: number;
    bottles_lost_damaged: number; after_stop_id: string | null; line_items_summary: string | null;
  }>(
    `SELECT s.id, s.customer_id, s.order_id, c.name AS customer_name, s.stop_outcome, s.order_ref, s.after_stop_id,
            s.line_items_summary,
            s.payment_method, s.payment_amount_cents, s.settled_at,
            s.bottles_delivered_full, s.bottles_empties_picked_up, s.bottles_lost_damaged
     FROM delivery_stops s JOIN customers c ON c.id = s.customer_id
     WHERE s.delivery_sheet_id = $1
     ORDER BY s.sequence_no, c.name`,
    [sheetId],
  );

  const rows: SettlementStopRow[] = [];
  // What earlier unsettled stops on this round will already put against each
  // invoice, so two stops for one customer do not both claim the same balance.
  const going = new Map<string, Cents>();
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

    let autoApplied: SettlementStopRow['autoApplied'] = [];
    if (!s.settled_at) {
      const split = allocations.filter((a) => a.invoice_id)
        .reduce((sum, a) => sum + num(a.amount_cents), 0);
      for (const a of allocations) {
        if (a.invoice_id) going.set(a.invoice_id, (going.get(a.invoice_id) ?? 0) + num(a.amount_cents));
      }
      const unsplit = Math.max(collected - split, 0);
      const auto = await oldestFirst(db, s.customer_id, unsplit, going);
      for (const a of auto) going.set(a.invoiceId, (going.get(a.invoiceId) ?? 0) + a.amountCents);
      const placed = auto.reduce((sum, a) => sum + a.amountCents, 0);
      autoApplied = [
        ...auto,
        ...(unsplit - placed > 0 ? [{ invoiceId: null, invoiceNumber: null, amountCents: unsplit - placed }] : []),
      ];
    }

    const paidAtSettlement = s.settled_at ? (await db.query<{
      id: string; invoice_id: string | null; invoice_number: string | null; amount_cents: string;
      receipt_number: string | null; reversed: boolean;
    }>(
      `SELECT p.id, p.invoice_id, i.invoice_number, p.amount_cents::text AS amount_cents, p.receipt_number,
              EXISTS (SELECT 1 FROM payments r WHERE r.reverses_payment_id = p.id) AS reversed
       FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id
       WHERE p.delivery_stop_id = $1 AND NOT p.is_reversal
       ORDER BY p.created_at, p.id`, [s.id])).map((p) => ({
        paymentId: p.id, invoiceId: p.invoice_id, invoiceNumber: p.invoice_number,
        amountCents: num(p.amount_cents), receiptNumber: p.receipt_number, reversed: !!p.reversed,
      })) : [];

    const before = s.order_id && !s.after_stop_id ? await db.one<{ cents: string; receipts: string[] | null }>(
      // A payment since reversed no longer counts (28 Oct 2026: the doubles
      // reversed after the 26-28 Oct rounds still showed as "counted twice?").
      `SELECT COALESCE(SUM(p.amount_cents), 0)::text AS cents,
              array_agg(DISTINCT p.receipt_number) FILTER (WHERE p.receipt_number IS NOT NULL) AS receipts
       FROM payments p
       WHERE p.order_id = $1 AND p.delivery_stop_id IS NULL AND p.status = 'Confirmed'
         AND NOT p.is_reversal
         AND NOT EXISTS (SELECT 1 FROM payments r WHERE r.reverses_payment_id = p.id)`, [s.order_id]) : null;

    rows.push({
      stopId: s.id,
      paidBeforeCents: before ? num(before.cents) : 0,
      paidBeforeReceipts: before?.receipts ?? [],
      customerName: s.customer_name,
      outcome: s.stop_outcome,
      orderRef: s.order_ref,
      paymentAfterDelivery: !!s.after_stop_id,
      note: s.after_stop_id || s.stop_outcome === 'Payment Only' ? s.line_items_summary : null,
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
      autoApplied,
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
      paidAtSettlement,
    });
  }

  const emptiesFromStops = rows.reduce((s, r) => s + r.bottlesEmptiesPickedUp, 0);
  const emptiesFromCollections = await collectedEmpties(db, sheetId);
  return {
    sheetId,
    status: sheet.status,
    stops: rows,
    totalCollectedCents: rows.reduce((s, r) => s + r.collectedCents, 0),
    totalExpectedCents: rows.reduce((s, r) => s + r.expectedCents, 0),
    bottles: {
      fullOut: rows.reduce((s, r) => s + r.bottlesDeliveredFull, 0),
      emptiesFromStops,
      emptiesFromCollections,
      emptiesRecorded: emptiesFromStops + emptiesFromCollections,
      lostDamaged: rows.reduce((s, r) => s + r.bottlesLostDamaged, 0),
      counted: sheet.bottle_actual_returned === null ? null : num(sheet.bottle_actual_returned),
      variance: sheet.bottle_variance === null ? null : num(sheet.bottle_variance),
    },
    settledCash: sheet.status === 'Completed' ? {
      handedInCents: sheet.actual_cash_cents === null ? null : num(sheet.actual_cash_cents),
      varianceCents: sheet.cash_variance_cents === null ? null : num(sheet.cash_variance_cents),
      notes: sheet.settlement_notes,
    } : null,
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
  /** The driver's note on the stop. */
  notes?: string | null;
}

interface StopNow {
  payment_method: string | null; payment_amount_cents: string;
  bottles_delivered_full: number; bottles_empties_picked_up: number; bottles_lost_damaged: number;
  driver_notes: string | null; settled_at: string | null; stop_outcome: string;
  sheet_status: string; sheet_id: string; sheet_date: string | null; customer_name: string;
}

async function stopNow(t: Queryable, stopId: string, lock = false): Promise<StopNow | null> {
  return t.maybeOne<StopNow>(
    `SELECT s.payment_method, s.payment_amount_cents::text AS payment_amount_cents,
            s.bottles_delivered_full, s.bottles_empties_picked_up, s.bottles_lost_damaged,
            s.driver_notes, s.settled_at, s.stop_outcome,
            d.status AS sheet_status, d.id AS sheet_id, d.delivery_date::text AS sheet_date,
            c.name AS customer_name
     FROM delivery_stops s JOIN delivery_sheets d ON d.id = s.delivery_sheet_id
     JOIN customers c ON c.id = s.customer_id
     WHERE s.id = $1${lock ? ' FOR UPDATE OF s' : ''}`,
    [stopId],
  );
}

/**
 * Which parts of a correction can still be made (Everton, 12 Nov 2026: an
 * admin could not fix a delivered stop - Lightfire Partners handed back 12
 * bottles on Monday and it was recorded wrong).
 *
 *  - Bottles (full out, empties back, lost) and the note: always. A bottle is
 *    not money, so a settled round does not lock them.
 *  - The money (cash taken, how, the split by line): only until the stop is
 *    settled. After that the payments are real and are put right on
 *    Payments received (reverse, or edit the payment), never here.
 *
 * Only a field that actually CHANGES counts, so a form that sends the money
 * back unchanged alongside a bottle fix is not refused.
 */
function checkCorrection(now: StopNow, changes: StopCorrection): void {
  const moneyLocked = !!now.settled_at || now.sheet_status === 'Completed';
  if (moneyLocked) {
    const cashChanged = changes.paymentAmountCents !== undefined
      && Math.round(Number(changes.paymentAmountCents)) !== num(now.payment_amount_cents);
    const howChanged = changes.paymentMethod !== undefined && (changes.paymentMethod || null) !== (now.payment_method || null)
      && num(now.payment_amount_cents) > 0;
    if (cashChanged || howChanged || (changes.deliveredLines ?? []).length > 0) {
      throw new RuleViolation(
        'this stop is settled, so its money is on the account already: put the cash right on ' +
        'Payments received (reverse or edit the payment). Bottles and the note can still be corrected here.',
      );
    }
  }
  for (const [k, v] of [['full bottles out', changes.bottlesDeliveredFull], ['empties back', changes.bottlesEmptiesPickedUp],
    ['lost or damaged', changes.bottlesLostDamaged]] as const) {
    if (v !== undefined && v !== null && (!Number.isFinite(Number(v)) || Number(v) < 0)) {
      throw new RuleViolation(`${k} cannot be below zero`);
    }
  }
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
  const before = await stopNow(t, stopId, true);
  if (!before) throw new RuleViolation('that stop no longer exists');
  // Re-checked here as well as at the entry point: an approval can be granted
  // minutes after it was raised, and the round may have been settled since.
  checkCorrectionAllowed(before, changes);

  const int = (v: number | undefined) => (v === undefined || v === null ? null : Math.round(Number(v)));
  await t.query(
    `UPDATE delivery_stops
     SET payment_method = COALESCE($2, payment_method),
         payment_amount_cents = COALESCE($3, payment_amount_cents),
         bottles_delivered_full = COALESCE($4, bottles_delivered_full),
         bottles_empties_picked_up = COALESCE($5, bottles_empties_picked_up),
         bottles_lost_damaged = COALESCE($6, bottles_lost_damaged),
         driver_notes = CASE WHEN $7::boolean THEN NULLIF(btrim($8), '') ELSE driver_notes END
     WHERE id = $1`,
    [stopId, changes.paymentMethod ?? null,
     changes.paymentAmountCents === undefined ? null : Math.round(Number(changes.paymentAmountCents)),
     int(changes.bottlesDeliveredFull), int(changes.bottlesEmptiesPickedUp), int(changes.bottlesLostDamaged),
     changes.notes !== undefined, changes.notes ?? ''],
  );

  // The empties back went into the empties at the plant when the stop was
  // recorded, so a correction moves them by the difference, dated the
  // round's day like the original. Without this the customer's account and
  // the stock of empties drift apart.
  if (changes.bottlesEmptiesPickedUp !== undefined && changes.bottlesEmptiesPickedUp !== null) {
    const delta = Math.round(Number(changes.bottlesEmptiesPickedUp)) - num(before.bottles_empties_picked_up);
    if (delta !== 0) {
      const n = Math.abs(delta);
      await moveEmpties(t, delta, delta > 0 ? 'BottleReturn' : 'Adjustment', `Correction ${stopId}`,
        delta > 0
          ? `${n} more empt${n === 1 ? 'y' : 'ies'} back from ${before.customer_name} (stop corrected)`
          : `${n} empt${n === 1 ? 'y' : 'ies'} fewer back from ${before.customer_name} (stop corrected)`,
        { day: before.sheet_date });
    }
    // A settled round keeps its empties count; the difference is worked out
    // again against the corrected stops.
    const sheet = await t.one<{ counted: number | null }>(
      `SELECT bottle_actual_returned AS counted FROM delivery_sheets WHERE id = $1`, [before.sheet_id]);
    if (sheet.counted !== null) {
      const rec = await t.one<{ n: string }>(
        `SELECT COALESCE(SUM(bottles_empties_picked_up), 0)::text AS n FROM delivery_stops WHERE delivery_sheet_id = $1`,
        [before.sheet_id]);
      await t.query(`UPDATE delivery_sheets SET bottle_variance = $2 WHERE id = $1`,
        [before.sheet_id, num(sheet.counted) - num(rec.n) - await collectedEmpties(t, before.sheet_id)]);
    }
  }

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

  await audit(t, actor, 'adjust', 'DeliveryStop', stopId, before.customer_name, {
    reason, before, changes, correctedBy: actor.name, afterSettlement: !!before.settled_at,
  });
}

const checkCorrectionAllowed = checkCorrection;

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
    const stop = await t.maybeOne<{ order_ref: string | null; customer_id: string }>(
      `SELECT order_ref, customer_id FROM delivery_stops WHERE id = $1`, [stopId],
    );
    if (!stop) throw new RuleViolation('that stop no longer exists');
    checkCorrectionAllowed((await stopNow(t, stopId))!, changes);

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

  // Whatever the driver did not split goes to the oldest open invoice first
  // (15 Oct 2026). It joins the driver's split as more allocation inputs, so
  // the plan below is still the one place payments come from.
  const collected = num(stop.payment_amount_cents);
  const split = new Map<string, Cents>();
  for (const a of allocations) split.set(a.invoice_id, (split.get(a.invoice_id) ?? 0) + num(a.amount_cents));
  const splitTotal = [...split.values()].reduce((sum, v) => sum + v, 0);
  const inputs = new Map(split);
  for (const a of await oldestFirst(t, stop.customer_id, Math.max(collected - splitTotal, 0), split)) {
    inputs.set(a.invoiceId, (inputs.get(a.invoiceId) ?? 0) + a.amountCents);
  }

  // ONE uniform plan covering attached and unattached portions alike.
  const plan = planPayments(
    collected,
    [...inputs].map(([invoiceId, amountCents]) => ({ invoiceId, amountCents })),
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
    // A loaded truck has to be counted back first (10 Oct 2026, point 4):
    // otherwise its goods would sit "on the truck" for ever.
    if (args.complete !== false) {
      const load = await t.maybeOne<{ returned_at: string | null }>(
        `SELECT returned_at FROM round_loads WHERE delivery_sheet_id = $1`, [sheetId],
      );
      if (load && !load.returned_at) {
        throw new RuleViolation('confirm what came back on the truck before closing the round');
      }
      // Something added to the load after the driver confirmed it has to be
      // reconfirmed by the driver (or cancelled by the office) first.
      if (load && await unconfirmedAdditions(t, sheetId) > 0) {
        throw new RuleViolation('the driver has not confirmed what was added to the load. '
          + 'Ask them to confirm it on My route, or cancel the addition on the round page.');
      }
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
    // Collection stops: empties into the pool, returned goods per the office's
    // decision (refuses if one is still undecided), unvisited ones closed.
    if (args.complete !== false) await settleCollections(t, actor, sheetId);
    const bottlesOut = num(totals.bottles_out) + await collectedEmpties(t, sheetId);
    const expectedCash = num(totals.recorded);
    const cashVariance = num(args.actualCashCents) - expectedCash;

    const bottleActual = args.bottleActualReturned ?? null;
    const bottleVariance = bottleActual === null
      ? null
      : bottleActual - bottlesOut;

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
      notes: args.settlementNotes?.trim() || null,
      bottleNotes: args.bottleSettleNotes?.trim() || null,
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
