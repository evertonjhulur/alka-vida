/**
 * Recurrence date arithmetic for standing orders.
 *
 * Pure string-in, string-out on YYYY-MM-DD. Deliberately no Date-with-local-
 * timezone anywhere: this codebase has already been bitten twice by a
 * timestamp resolving to the previous day in local time (migrations 004 and
 * 008). Dates here are calendar dates, not moments, so they are computed in
 * UTC and never formatted through a local-time path.
 */

import type { RecurrencePattern } from './types.ts';
import { RuleViolation } from './types.ts';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertDateString(d: string, label = 'date'): string {
  if (!DATE_RE.test(d)) {
    throw new RuleViolation(`${label} must be a calendar date as YYYY-MM-DD, got "${d}"`);
  }
  return d;
}

/** Parse YYYY-MM-DD to its UTC parts. */
function parts(d: string): { y: number; m: number; day: number } {
  assertDateString(d);
  const [y, m, day] = d.split('-').map(Number);
  return { y, m, day };
}

function format(y: number, m: number, day: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Days in a given month, 1-indexed month. */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Add whole days to a calendar date. */
export function addDays(date: string, days: number): string {
  const { y, m, day } = parts(date);
  const t = Date.UTC(y, m - 1, day) + days * 86_400_000;
  const d = new Date(t);
  return format(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * Add whole months, clamping to the end of the target month.
 *
 * The 31st of January plus one month is the 28th (or 29th) of February, not
 * the 2nd/3rd of March. A customer on "the 31st" should not silently drift
 * into the following month.
 */
export function addMonths(date: string, months: number): string {
  const { y, m, day } = parts(date);
  const zero = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(zero / 12);
  const nm = (zero % 12) + 1;
  return format(ny, nm, Math.min(day, daysInMonth(ny, nm)));
}

/** The date one cycle after `date`. */
export function nextOccurrence(date: string, pattern: RecurrencePattern): string {
  switch (pattern) {
    case 'Weekly': return addDays(date, 7);
    case 'Biweekly': return addDays(date, 14);
    case 'Monthly': return addMonths(date, 1);
    default: {
      throw new RuleViolation(`unknown recurrence pattern "${pattern}"`);
    }
  }
}

/** Whole days from `a` to `b`; negative when `b` is earlier. */
export function daysBetween(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  return Math.round(
    (Date.UTC(pb.y, pb.m - 1, pb.day) - Date.UTC(pa.y, pa.m - 1, pa.day)) / 86_400_000,
  );
}

export interface SchedulePlan {
  /** Dates to create an order for, earliest first. */
  due: string[];
  /** Dates skipped as too far in the past to be worth raising now. */
  skipped: string[];
  /** Where the schedule points once this run is applied. */
  nextDate: string;
}

export interface PlanOptions {
  /** Raise an occurrence this many days before it is due. */
  leadDays: number;
  /**
   * How overdue an occurrence may be and still be raised. Anything older is
   * rolled past rather than back-dated, so an app left closed for months does
   * not produce a flood of orders nobody is going to deliver.
   */
  graceDays: number;
  /** Safety stop, so a corrupt date can never spin out thousands of rows. */
  maxPerRun: number;
}

export const DEFAULT_PLAN_OPTIONS: PlanOptions = {
  leadDays: 7,
  graceDays: 14,
  maxPerRun: 12,
};

/**
 * Work out which occurrences of a schedule are due as at `today`.
 *
 * Walks the schedule forward from `nextDate`, collecting every occurrence
 * that falls on or before today+leadDays. An occurrence more than graceDays
 * in the past is reported as skipped rather than created.
 *
 * Pure and deterministic: given the same inputs it always plans the same
 * work, which is what lets the caller run it as often as it likes.
 */
export function planSchedule(
  args: {
    nextDate: string;
    pattern: RecurrencePattern;
    today: string;
    endsOn?: string | null;
  },
  options: Partial<PlanOptions> = {},
): SchedulePlan {
  const { leadDays, graceDays, maxPerRun } = { ...DEFAULT_PLAN_OPTIONS, ...options };
  assertDateString(args.nextDate, 'nextDate');
  assertDateString(args.today, 'today');

  const horizon = addDays(args.today, leadDays);
  const earliest = addDays(args.today, -graceDays);

  const due: string[] = [];
  const skipped: string[] = [];
  let cursor = args.nextDate;

  for (let guard = 0; guard < maxPerRun; guard++) {
    if (args.endsOn && daysBetween(cursor, args.endsOn) < 0) break;
    if (daysBetween(cursor, horizon) < 0) break; // beyond the horizon

    if (daysBetween(earliest, cursor) < 0) skipped.push(cursor);
    else due.push(cursor);

    cursor = nextOccurrence(cursor, args.pattern);
  }

  return { due, skipped, nextDate: cursor };
}

/* ------------------------------------------------------------------ */
/* Weekdays, zone run days and invoice cycles (30 Sep 2026)            */
/* ------------------------------------------------------------------ */

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** 'Mon'..'Sun' for a calendar date. */
export function weekdayOf(date: string): string {
  const { y, m, day } = parts(date);
  return WEEKDAY_NAMES[new Date(Date.UTC(y, m - 1, day)).getUTCDay()];
}

/**
 * The first date on or after `from` that falls on one of `days`.
 * With no days given, `from` itself - a zone with no run days set runs any day.
 */
export function nextRunDate(from: string, days: readonly string[]): string {
  if (!days || days.length === 0) return from;
  let d = from;
  for (let i = 0; i < 7; i++) {
    if (days.includes(weekdayOf(d))) return d;
    d = addDays(d, 1);
  }
  return from;
}

export type InvoiceCycle = 'PerDelivery' | 'Weekly' | 'Monthly';

/**
 * The billing period a date belongs to. A week runs Monday to Sunday; a
 * month is the calendar month.
 */
export function cyclePeriod(date: string, cycle: 'Weekly' | 'Monthly'): { from: string; to: string } {
  if (cycle === 'Weekly') {
    const back = (['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const)
      .indexOf(weekdayOf(date) as 'Mon');
    const from = addDays(date, -back);
    return { from, to: addDays(from, 6) };
  }
  const { y, m } = parts(date);
  return { from: format(y, m, 1), to: format(y, m, daysInMonth(y, m)) };
}
