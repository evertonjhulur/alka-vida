/**
 * Standing orders (Section 2, CustomerOrder recurrence fields).
 *
 * A standing customer has a SCHEDULE - the first order of the series, holding
 * the pattern and the date of the next occurrence still to be raised. Every
 * later occurrence is an ordinary order pointing back at it.
 *
 * That shape is the whole design. Because an occurrence is just an order,
 * nothing downstream needs to know a series exists: it routes onto a delivery
 * sheet, is invoiced at the moment of delivery, and settles exactly like a
 * one-off. Section 3's "every individual delivery gets its own real Invoice,
 * there is no batching or cycle-close" stays true for standing customers with
 * no special case anywhere.
 *
 * Prices are NOT copied from the schedule. Each occurrence re-resolves the
 * customer's current tier rate, because an order locks its price when it is
 * created - so a price rise reaches standing customers on their next delivery
 * and never retrospectively.
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, num } from './core.ts';
import type { RecurrencePattern } from '@alka/shared';
import {
  planSchedule, nextOccurrence, DEFAULT_PLAN_OPTIONS, RuleViolation,
  type PlanOptions,
} from '@alka/shared';
import { createOrder } from './orders.ts';

/** A schedule as the office sees it. */
export interface Schedule {
  id: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  pattern: RecurrencePattern;
  nextDeliveryDate: string | null;
  paused: boolean;
  endsOn: string | null;
  deliveryZone: string | null;
  lastRunAt: string | null;
  lastNote: string | null;
  occurrencesRaised: number;
  lineSummary: string;
}

export interface GenerationResult {
  /** Orders actually created, oldest date first. */
  created: Array<{ orderId: string; orderNumber: string; scheduleId: string; date: string }>;
  /** Occurrences too old to raise; reported so they are never silent. */
  skipped: Array<{ scheduleId: string; customerName: string; date: string }>;
  /** Schedules that could not be advanced, with why. */
  problems: Array<{ scheduleId: string; customerName: string; reason: string }>;
  schedulesConsidered: number;
}

/** Today as a calendar date in the business timezone, from the database. */
async function businessToday(t: Queryable): Promise<string> {
  const row = await t.one<{ d: string }>(`SELECT business_today()::text AS d`);
  return row.d;
}

/**
 * Raise every occurrence that is due, across all active schedules.
 *
 * Safe to call as often as you like: the unique index on
 * (parent_recurring_id, requested_delivery_date) means a duplicate is
 * impossible even if two runs overlap, and a schedule only advances by what
 * it actually managed to create.
 */
export async function generateDueOrders(
  db: Db,
  actor: Actor,
  opts: { today?: string; options?: Partial<PlanOptions> } = {},
): Promise<GenerationResult> {
  const result: GenerationResult = {
    created: [], skipped: [], problems: [], schedulesConsidered: 0,
  };

  const today = opts.today ?? await businessToday(db);
  const planOptions = { ...DEFAULT_PLAN_OPTIONS, ...opts.options };

  const schedules = await db.query<{
    id: string; customer_id: string; customer_name: string;
    recurrence_pattern: RecurrencePattern; next_delivery_date: string | null;
    recurrence_ends_on: string | null; delivery_mode: string; discount_percent: number;
  }>(
    `SELECT o.id, o.customer_id, c.name AS customer_name, o.recurrence_pattern,
            o.next_delivery_date::text AS next_delivery_date,
            o.recurrence_ends_on::text AS recurrence_ends_on,
            o.delivery_mode, o.discount_percent
     FROM customer_orders o
     JOIN customers c ON c.id = o.customer_id
     WHERE o.is_recurring
       AND o.parent_recurring_id IS NULL
       AND NOT o.recurrence_paused
       AND o.status <> 'Cancelled'
       AND c.active
     ORDER BY o.next_delivery_date NULLS LAST`,
  );

  result.schedulesConsidered = schedules.length;

  for (const s of schedules) {
    if (!s.next_delivery_date) {
      result.problems.push({
        scheduleId: s.id, customerName: s.customer_name,
        reason: 'no next delivery date set on the schedule',
      });
      continue;
    }
    if (!s.recurrence_pattern) {
      result.problems.push({
        scheduleId: s.id, customerName: s.customer_name,
        reason: 'no recurrence pattern set on the schedule',
      });
      continue;
    }

    const plan = planSchedule({
      nextDate: s.next_delivery_date,
      pattern: s.recurrence_pattern,
      today,
      endsOn: s.recurrence_ends_on,
    }, planOptions);

    for (const d of plan.skipped) {
      result.skipped.push({ scheduleId: s.id, customerName: s.customer_name, date: d });
    }

    // Nothing to do, but still record that the schedule was looked at.
    if (plan.due.length === 0 && plan.skipped.length === 0) {
      await noteRun(db, s.id, plan.nextDate, 'nothing due');
      continue;
    }

    const lines = await scheduleLines(db, s.id);
    if (lines.length === 0) {
      result.problems.push({
        scheduleId: s.id, customerName: s.customer_name,
        reason: 'the schedule has no product lines to copy',
      });
      continue;
    }

    for (const date of plan.due) {
      try {
        const created = await createOrder(db, actor, {
          customerId: s.customer_id,
          deliveryMode: s.delivery_mode as never,
          requestedDeliveryDate: date,
          discountPercent: num(s.discount_percent),
          parentRecurringId: s.id,
          notes: `Standing order for ${date}`,
          // Quantities carry over; prices re-resolve at today's tier rate.
          lines: lines.map((l) => ({
            productId: l.product_id,
            cases: num(l.cases),
            looseBottles: num(l.loose_bottles),
          })),
        });
        result.created.push({
          orderId: created.id, orderNumber: created.orderNumber,
          scheduleId: s.id, date,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A duplicate means another run beat us to this date. That is the
        // guard working, not a failure - carry on and advance as normal.
        if (/duplicate key|unique constraint/i.test(message)) continue;
        result.problems.push({
          scheduleId: s.id, customerName: s.customer_name,
          reason: message,
        });
      }
    }

    const note = [
      plan.due.length ? `raised ${plan.due.length}` : null,
      plan.skipped.length ? `skipped ${plan.skipped.length} too old` : null,
    ].filter(Boolean).join(', ') || 'nothing due';

    await noteRun(db, s.id, plan.nextDate, note);
  }

  if (result.created.length || result.skipped.length || result.problems.length) {
    await db.tx(async (t) => {
      await audit(t, actor, 'create', 'RecurringRun', null, `standing orders ${today}`, {
        created: result.created.length,
        skipped: result.skipped.length,
        problems: result.problems.length,
        schedulesConsidered: result.schedulesConsidered,
      });
    });
  }

  return result;
}

/** Move the schedule on and record what happened, in one statement. */
async function noteRun(
  db: Db, scheduleId: string, nextDate: string, note: string,
): Promise<void> {
  await db.query(
    `UPDATE customer_orders
     SET next_delivery_date = $2::date,
         recurrence_last_run_at = now(),
         recurrence_last_note = $3
     WHERE id = $1`,
    [scheduleId, nextDate, note],
  );
}

/** The product lines of a schedule, used as the template for each occurrence. */
async function scheduleLines(db: Queryable, scheduleId: string) {
  return db.query<{ product_id: string; cases: number; loose_bottles: number }>(
    `SELECT oli.product_id, oli.cases, oli.loose_bottles
     FROM order_line_items oli
     JOIN products p ON p.id = oli.product_id
     WHERE oli.order_id = $1 AND p.active`,
    [scheduleId],
  );
}

/* ------------------------------------------------------------------ */
/* Managing schedules                                                  */
/* ------------------------------------------------------------------ */

/**
 * Turn an existing order into a standing order.
 *
 * The order stays exactly as it is - it is the first delivery of the series -
 * and gains the pattern plus the date of the second one.
 */
export async function startSchedule(
  db: Db,
  actor: Actor,
  orderId: string,
  args: { pattern: RecurrencePattern; endsOn?: string | null; firstNextDate?: string },
): Promise<{ nextDeliveryDate: string }> {
  return db.tx(async (t) => {
    const order = await t.one<{
      requested_delivery_date: string | null; order_number: string;
      parent_recurring_id: string | null; is_recurring: boolean;
    }>(
      `SELECT requested_delivery_date::text AS requested_delivery_date, order_number,
              parent_recurring_id, is_recurring
       FROM customer_orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    if (order.parent_recurring_id) {
      throw new RuleViolation(
        'this order is already one occurrence of a standing order; change the schedule instead',
      );
    }
    if (order.is_recurring) throw new RuleViolation('this order is already a standing order');
    if (!order.requested_delivery_date && !args.firstNextDate) {
      throw new RuleViolation(
        'give the order a delivery date first - the schedule counts forward from it',
      );
    }

    const next = args.firstNextDate
      ?? nextOccurrence(order.requested_delivery_date!, args.pattern);

    await t.query(
      `UPDATE customer_orders
       SET is_recurring = true, recurrence_pattern = $2,
           next_delivery_date = $3::date, recurrence_ends_on = $4::date,
           recurrence_paused = false
       WHERE id = $1`,
      [orderId, args.pattern, next, args.endsOn ?? null],
    );

    await audit(t, actor, 'update', 'CustomerOrder', orderId, order.order_number, {
      startedSchedule: true, pattern: args.pattern,
      nextDeliveryDate: next, endsOn: args.endsOn ?? null,
    });

    return { nextDeliveryDate: next };
  });
}

/**
 * Pause or resume a schedule.
 *
 * Pausing keeps the arrangement and its history but stops it producing work -
 * for a customer closed over Christmas, say. Resuming does NOT back-fill the
 * silent period: the schedule is rolled forward to the next occurrence at or
 * after today, so coming back from a pause never dumps a month of orders.
 */
export async function setSchedulePaused(
  db: Db, actor: Actor, scheduleId: string, paused: boolean,
): Promise<{ nextDeliveryDate: string | null }> {
  return db.tx(async (t) => {
    const s = await t.one<{
      order_number: string; recurrence_pattern: RecurrencePattern;
      next_delivery_date: string | null; is_recurring: boolean;
    }>(
      `SELECT order_number, recurrence_pattern,
              next_delivery_date::text AS next_delivery_date, is_recurring
       FROM customer_orders WHERE id = $1 FOR UPDATE`,
      [scheduleId],
    );
    if (!s.is_recurring) throw new RuleViolation('that order is not a standing order');

    let next = s.next_delivery_date;
    if (!paused && next && s.recurrence_pattern) {
      const today = await businessToday(t);
      // Roll forward past the pause rather than back-filling it.
      let guard = 0;
      while (next < today && guard++ < 500) {
        next = nextOccurrence(next, s.recurrence_pattern);
      }
    }

    await t.query(
      `UPDATE customer_orders
       SET recurrence_paused = $2, next_delivery_date = COALESCE($3::date, next_delivery_date),
           recurrence_last_note = $4
       WHERE id = $1`,
      [scheduleId, paused, next, paused ? 'paused' : 'resumed'],
    );

    await audit(t, actor, 'update', 'CustomerOrder', scheduleId, s.order_number, {
      recurrencePaused: paused, nextDeliveryDate: next,
    });

    return { nextDeliveryDate: next };
  });
}

/** End a schedule for good. Occurrences already raised are untouched. */
export async function endSchedule(
  db: Db, actor: Actor, scheduleId: string, reason?: string,
): Promise<void> {
  await db.tx(async (t) => {
    const s = await t.one<{ order_number: string }>(
      `SELECT order_number FROM customer_orders WHERE id = $1`, [scheduleId],
    );
    await t.query(
      `UPDATE customer_orders
       SET is_recurring = false, recurrence_paused = true,
           recurrence_last_note = $2
       WHERE id = $1`,
      [scheduleId, reason ? `ended: ${reason}` : 'ended'],
    );
    await audit(t, actor, 'update', 'CustomerOrder', scheduleId, s.order_number, {
      endedSchedule: true, reason: reason ?? null,
    });
  });
}

/** Change the pattern, next date or end date of a running schedule. */
export async function updateSchedule(
  db: Db,
  actor: Actor,
  scheduleId: string,
  changes: {
    pattern?: RecurrencePattern;
    nextDeliveryDate?: string;
    endsOn?: string | null;
  },
): Promise<void> {
  await db.tx(async (t) => {
    const s = await t.one<{ order_number: string; is_recurring: boolean }>(
      `SELECT order_number, is_recurring FROM customer_orders WHERE id = $1 FOR UPDATE`,
      [scheduleId],
    );
    if (!s.is_recurring) throw new RuleViolation('that order is not a standing order');

    await t.query(
      `UPDATE customer_orders
       SET recurrence_pattern = COALESCE($2, recurrence_pattern),
           next_delivery_date = COALESCE($3::date, next_delivery_date),
           recurrence_ends_on = CASE WHEN $5 THEN $4::date ELSE recurrence_ends_on END
       WHERE id = $1`,
      [scheduleId, changes.pattern ?? null, changes.nextDeliveryDate ?? null,
       changes.endsOn ?? null, changes.endsOn !== undefined],
    );

    await audit(t, actor, 'update', 'CustomerOrder', scheduleId, s.order_number, changes);
  });
}

/** Every schedule, for the standing-orders screen. */
export async function listSchedules(db: Db): Promise<Schedule[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT o.id, o.order_number, o.customer_id, c.name AS customer_name,
            o.recurrence_pattern, o.next_delivery_date::text AS next_delivery_date,
            o.recurrence_paused, o.recurrence_ends_on::text AS recurrence_ends_on,
            o.recurrence_last_run_at, o.recurrence_last_note,
            c.delivery_zone,
            (SELECT COUNT(*)::int FROM customer_orders k
             WHERE k.parent_recurring_id = o.id) AS occurrences_raised,
            (SELECT string_agg(
                      CASE WHEN p.bottles_per_case > 0
                           THEN oli.cases || ' cs ' || p.name
                           ELSE oli.loose_bottles || ' x ' || p.name END, ', ')
             FROM order_line_items oli JOIN products p ON p.id = oli.product_id
             WHERE oli.order_id = o.id) AS line_summary
     FROM customer_orders o
     JOIN customers c ON c.id = o.customer_id
     WHERE o.is_recurring AND o.parent_recurring_id IS NULL
     ORDER BY o.recurrence_paused, o.next_delivery_date NULLS LAST, c.name`,
  );

  return rows.map((r) => ({
    id: r.id as string,
    orderNumber: r.order_number as string,
    customerId: r.customer_id as string,
    customerName: r.customer_name as string,
    pattern: r.recurrence_pattern as RecurrencePattern,
    nextDeliveryDate: (r.next_delivery_date as string) ?? null,
    paused: r.recurrence_paused as boolean,
    endsOn: (r.recurrence_ends_on as string) ?? null,
    deliveryZone: (r.delivery_zone as string) ?? null,
    lastRunAt: r.recurrence_last_run_at ? String(r.recurrence_last_run_at) : null,
    lastNote: (r.recurrence_last_note as string) ?? null,
    occurrencesRaised: num(r.occurrences_raised),
    lineSummary: (r.line_summary as string) ?? '',
  }));
}
