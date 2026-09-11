/**
 * Employees and what their work costs.
 *
 * Built for two things that come later: payroll, and putting labour into the
 * cost of a case of water. Today a case costs what its materials cost, so the
 * margin reads better than it is.
 *
 * NOTHING HERE IS WIRED INTO COSTING YET, deliberately. Evert asked for the
 * structure now and the connection later. A half-connected labour cost that
 * quietly changes what a case appears to cost would be worse than no figure
 * at all - every margin in the system would move and nobody would know why.
 *
 * Two ways of being paid, because that is how the business pays: production
 * and office staff by the hour, drivers by the trip.
 */

import type { Db } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, num, requireRole } from './core.ts';
import { SYSTEM_USER_EMAIL } from './users.ts';
import type { Cents } from '@alka/shared';
import { RuleViolation } from '@alka/shared';

export type PayBasis = 'Hourly' | 'PerTrip';

export interface EmployeeInput {
  name: string;
  jobTitle?: string | null;
  payBasis: PayBasis;
  rateCents: Cents;
  phone?: string | null;
  email?: string | null;
  /** A driver usually also has a login; a production hand need not. */
  userId?: string | null;
  startedOn?: string | null;
  notes?: string | null;
}

const clean = (s: string | null | undefined) => s?.trim() || null;

function assertBasis(basis: string): asserts basis is PayBasis {
  if (basis !== 'Hourly' && basis !== 'PerTrip') {
    throw new RuleViolation('an employee is paid either by the hour or by the trip');
  }
}

export async function listEmployees(db: Db, actor: Actor) {
  requireRole(actor, 'admin', 'user');
  return db.query(
    `SELECT e.*, u.email AS login_email,
            (SELECT COALESCE(SUM(l.amount_cents), 0)::text
               FROM labour_entries l WHERE l.employee_id = e.id) AS lifetime_cents
     FROM employees e
     LEFT JOIN users u ON u.id = e.user_id
     ORDER BY e.active DESC, e.name`,
  );
}

/** One person, with what their recorded work comes to. For their own page. */
export async function getEmployee(db: Db, actor: Actor, employeeId: string) {
  requireRole(actor, 'admin', 'user');
  const employee = await db.one(
    `SELECT e.*, u.email AS login_email, u.role AS login_role,
            (SELECT COALESCE(SUM(l.amount_cents), 0)::text
               FROM labour_entries l WHERE l.employee_id = e.id) AS lifetime_cents,
            (SELECT COALESCE(SUM(l.quantity), 0)::text
               FROM labour_entries l WHERE l.employee_id = e.id) AS lifetime_quantity,
            (SELECT COUNT(*)::int
               FROM labour_entries l WHERE l.employee_id = e.id) AS entry_count
     FROM employees e
     LEFT JOIN users u ON u.id = e.user_id
     WHERE e.id = $1`,
    [employeeId],
  );
  const entries = await listLabourEntries(db, actor, { employeeId });
  return { employee, entries };
}

export async function createEmployee(
  db: Db, actor: Actor, input: EmployeeInput,
): Promise<{ id: string }> {
  requireRole(actor, 'admin');
  const name = clean(input.name);
  if (!name) throw new RuleViolation('an employee needs a name');
  assertBasis(input.payBasis);
  if (!Number.isFinite(input.rateCents) || input.rateCents < 0) {
    throw new RuleViolation('a rate cannot be negative');
  }

  return db.tx(async (t) => {
    const row = await t.one<{ id: string }>(
      `INSERT INTO employees
         (name, job_title, pay_basis, rate_cents, phone, email, user_id,
          started_on, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [name, clean(input.jobTitle), input.payBasis, input.rateCents,
       clean(input.phone), clean(input.email), input.userId ?? null,
       clean(input.startedOn), clean(input.notes)],
    );
    await audit(t, actor, 'create', 'Employee', row.id, name,
      { payBasis: input.payBasis, rateCents: input.rateCents });
    return { id: row.id };
  });
}

/**
 * Change an employee's details or rate.
 *
 * A new rate applies to work recorded AFTER it. Entries already made keep the
 * rate they were costed at, so a rise never restates what an earlier week
 * cost - the same rule order lines follow.
 */
export async function updateEmployee(
  db: Db, actor: Actor, employeeId: string, input: Partial<EmployeeInput>,
): Promise<void> {
  requireRole(actor, 'admin');

  const sets: string[] = [];
  const args: unknown[] = [employeeId];
  const set = (col: string, value: unknown) => {
    args.push(value);
    sets.push(`${col} = $${args.length}`);
  };

  if ('name' in input) {
    if (!clean(input.name)) throw new RuleViolation('an employee needs a name');
    set('name', clean(input.name));
  }
  if ('payBasis' in input && input.payBasis) {
    assertBasis(input.payBasis);
    set('pay_basis', input.payBasis);
  }
  if ('rateCents' in input && input.rateCents != null) {
    if (input.rateCents < 0) throw new RuleViolation('a rate cannot be negative');
    set('rate_cents', input.rateCents);
  }
  if ('jobTitle' in input) set('job_title', clean(input.jobTitle));
  if ('phone' in input) set('phone', clean(input.phone));
  if ('email' in input) set('email', clean(input.email));
  if ('userId' in input) set('user_id', input.userId ?? null);
  if ('startedOn' in input) set('started_on', clean(input.startedOn));
  if ('notes' in input) set('notes', clean(input.notes));

  if (sets.length === 0) return;

  await db.tx(async (t) => {
    const before = await t.one<{ name: string }>(
      `SELECT name FROM employees WHERE id = $1`, [employeeId]);
    await t.query(`UPDATE employees SET ${sets.join(', ')} WHERE id = $1`, args);
    await audit(t, actor, 'update', 'Employee', employeeId,
      clean(input.name) ?? before.name, input);
  });
}

/**
 * Somebody leaving, or coming back.
 *
 * Never a delete: their past work is part of what production cost, and
 * payroll history has to stay readable.
 */
export async function setEmployeeActive(
  db: Db, actor: Actor, employeeId: string, active: boolean, endedOn?: string | null,
): Promise<void> {
  requireRole(actor, 'admin');
  await db.tx(async (t) => {
    const e = await t.one<{ name: string }>(
      `SELECT name FROM employees WHERE id = $1`, [employeeId]);
    await t.query(
      `UPDATE employees SET active = $2, ended_on = $3 WHERE id = $1`,
      [employeeId, active, active ? null : (clean(endedOn) ?? null)],
    );
    await audit(t, actor, 'update', 'Employee', employeeId, e.name, { active });
  });
}

export interface LabourEntryInput {
  employeeId: string;
  workDate: string;
  /** Hours worked, or trips run - the employee's basis decides which. */
  quantity: number;
  reference?: string | null;
  notes?: string | null;
  /** Overrides the employee's current rate for this entry only. */
  rateCents?: Cents;
}

/**
 * Record work done.
 *
 * The rate is taken from the employee and LOCKED onto the entry. Passing a
 * rate overrides it for this entry only - an agreed one-off for a long
 * awkward round, say - and is recorded as the override it is.
 */
export async function recordLabour(
  db: Db, actor: Actor, input: LabourEntryInput,
): Promise<{ id: string; amountCents: Cents }> {
  requireRole(actor, 'admin', 'user');

  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    throw new RuleViolation('record how many hours were worked, or trips run');
  }
  if (!input.workDate) throw new RuleViolation('a labour entry needs the date the work was done');

  return db.tx(async (t) => {
    const e = await t.one<{
      name: string; pay_basis: PayBasis; rate_cents: number; active: boolean;
    }>(
      `SELECT name, pay_basis, rate_cents, active FROM employees WHERE id = $1`,
      [input.employeeId],
    );
    if (!e.active) {
      throw new RuleViolation(
        `${e.name} has left. Bring them back before recording work against them.`,
      );
    }

    const rate = input.rateCents ?? num(e.rate_cents);
    if (rate < 0) throw new RuleViolation('a rate cannot be negative');
    // A rate of zero is almost always a rate nobody has filled in yet -
    // employees brought across from the logins start blank. Recording work
    // against one would cost nothing and look like it had worked.
    if (rate === 0) {
      throw new RuleViolation(
        `${e.name} has no rate set. Set it on the employee, or type a rate for `
        + 'this entry.',
      );
    }
    // Rounded to the cent here rather than anywhere downstream: money is
    // integer cents everywhere in this system (invariant 7).
    const amount = Math.round(input.quantity * rate);

    const row = await t.one<{ id: string }>(
      `INSERT INTO labour_entries
         (employee_id, work_date, basis, quantity, rate_cents, amount_cents,
          reference, notes, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [input.employeeId, input.workDate, e.pay_basis, input.quantity, rate, amount,
       clean(input.reference), clean(input.notes), actor.id],
    );
    await audit(t, actor, 'create', 'LabourEntry', row.id, e.name, {
      basis: e.pay_basis, quantity: input.quantity, rateCents: rate,
      amountCents: amount,
      rateOverridden: input.rateCents != null && input.rateCents !== num(e.rate_cents),
    });
    return { id: row.id, amountCents: amount };
  });
}

export async function deleteLabourEntry(
  db: Db, actor: Actor, entryId: string,
): Promise<void> {
  requireRole(actor, 'admin');
  await db.tx(async (t) => {
    const row = await t.one<{ employee_id: string; amount_cents: number }>(
      `SELECT employee_id, amount_cents FROM labour_entries WHERE id = $1`, [entryId]);
    await t.query(`DELETE FROM labour_entries WHERE id = $1`, [entryId]);
    await audit(t, actor, 'delete', 'LabourEntry', entryId, entryId,
      { amountCents: num(row.amount_cents) });
  });
}

/**
 * What the business owes for a period, per person.
 *
 * A date range rather than a fixed pay cycle: weekly, fortnightly and monthly
 * are all just a range, and picking one now would be guessing at how Evert
 * actually runs payroll.
 */
export async function labourForPeriod(
  db: Db, actor: Actor, opts: { from?: string | null; to?: string | null } = {},
) {
  requireRole(actor, 'admin', 'user');
  const from = opts.from ?? null;
  const to = opts.to ?? null;

  const byEmployee = await db.query(
    `SELECT e.id AS employee_id, e.name, e.job_title, e.pay_basis,
            e.rate_cents::text AS rate_cents,
            COALESCE(SUM(l.quantity), 0)::text AS quantity,
            COALESCE(SUM(l.amount_cents), 0)::text AS amount_cents,
            COUNT(l.id)::int AS entries
     FROM employees e
     LEFT JOIN labour_entries l ON l.employee_id = e.id
       AND ($1::date IS NULL OR l.work_date >= $1::date)
       AND ($2::date IS NULL OR l.work_date <= $2::date)
     GROUP BY e.id, e.name, e.job_title, e.pay_basis, e.rate_cents
     HAVING COUNT(l.id) > 0 OR e.active
     ORDER BY e.active DESC, e.name`,
    [from, to],
  );

  const total = await db.one<{ amount_cents: string }>(
    `SELECT COALESCE(SUM(amount_cents), 0)::text AS amount_cents
     FROM labour_entries
     WHERE ($1::date IS NULL OR work_date >= $1::date)
       AND ($2::date IS NULL OR work_date <= $2::date)`,
    [from, to],
  );

  return { from, to, byEmployee, totalCents: num(total.amount_cents) };
}

/** Recent entries, for checking what was put in. */
export async function listLabourEntries(
  db: Db, actor: Actor,
  opts: { employeeId?: string | null; from?: string | null; to?: string | null } = {},
) {
  requireRole(actor, 'admin', 'user');
  return db.query(
    `SELECT l.id, l.work_date::text AS work_date, l.basis,
            l.quantity::text AS quantity, l.rate_cents::text AS rate_cents,
            l.amount_cents::text AS amount_cents, l.reference, l.notes,
            e.name AS employee_name, u.name AS recorded_by_name
     FROM labour_entries l
     JOIN employees e ON e.id = l.employee_id
     LEFT JOIN users u ON u.id = l.recorded_by
     WHERE ($1::uuid IS NULL OR l.employee_id = $1::uuid)
       AND ($2::date IS NULL OR l.work_date >= $2::date)
       AND ($3::date IS NULL OR l.work_date <= $3::date)
     ORDER BY l.work_date DESC, e.name
     LIMIT 200`,
    [opts.employeeId ?? null, opts.from ?? null, opts.to ?? null],
  );
}

/**
 * Labour by calendar month.
 *
 * This is the figure true production costing will eventually read - the
 * shape AlkaFlow held as a single typed-in `LabourCost` per month, except
 * derived from what was actually recorded rather than remembered.
 *
 * Nothing reads it yet.
 */
export async function labourByMonth(db: Db, actor: Actor) {
  requireRole(actor, 'admin', 'user');
  return db.query(
    `SELECT to_char(work_date, 'YYYY-MM') AS month,
            COALESCE(SUM(amount_cents), 0)::text AS amount_cents,
            COALESCE(SUM(quantity) FILTER (WHERE basis = 'Hourly'), 0)::text AS hours,
            COALESCE(SUM(quantity) FILTER (WHERE basis = 'PerTrip'), 0)::text AS trips
     FROM labour_entries
     GROUP BY to_char(work_date, 'YYYY-MM')
     ORDER BY month DESC
     LIMIT 24`,
  );
}

/**
 * How Evert classifies his people, in his words: a `user` login is an
 * employee, an `admin` is a manager, a `driver` drives. The login role is
 * already the workforce category, so it is what the job title is taken from.
 *
 * Every one of these is editable afterwards - it is a starting point, not a
 * ruling.
 */
const TITLE_FOR_ROLE: Record<string, string> = {
  admin: 'Manager',
  user: 'Employee',
  driver: 'Driver',
};

/**
 * Create employee records from the logins that do not have one.
 *
 * Saves retyping people the system already knows. It fills in the name, the
 * email, the job title and how they are most likely paid, links the employee
 * to their login, and LEAVES THE RATE AT ZERO - what somebody is paid is not
 * derivable from anything in the system, and inventing a figure would be
 * worse than an obvious blank.
 *
 * Safe to run again. Anybody already on the payroll is skipped, matched
 * either by their login or by their name, so pressing the button twice does
 * not produce two Devon Clarkes.
 *
 * Customer portal logins are never candidates: they are the people who buy
 * the water, not the people who make it.
 */
export async function importEmployeesFromLogins(
  db: Db, actor: Actor,
): Promise<{ created: string[]; skipped: string[] }> {
  requireRole(actor, 'admin');

  const candidates = await db.query<{
    id: string; name: string; email: string; role: string;
  }>(
    `SELECT u.id, u.name, u.email, u.role
     FROM users u
     WHERE u.active
       AND u.role IN ('admin', 'user', 'driver')
       AND u.email <> $1
       AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.user_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM employees e WHERE lower(e.name) = lower(u.name))
     ORDER BY u.role, u.name`,
    [SYSTEM_USER_EMAIL],
  );

  const all = await db.query<{ name: string }>(
    `SELECT u.name FROM users u
     WHERE u.active AND u.role IN ('admin', 'user', 'driver') AND u.email <> $1`,
    [SYSTEM_USER_EMAIL],
  );

  const created: string[] = [];
  await db.tx(async (t) => {
    for (const u of candidates) {
      const row = await t.one<{ id: string }>(
        `INSERT INTO employees
           (name, job_title, pay_basis, rate_cents, email, user_id)
         VALUES ($1,$2,$3,0,$4,$5) RETURNING id`,
        [u.name, TITLE_FOR_ROLE[u.role] ?? null,
         u.role === 'driver' ? 'PerTrip' : 'Hourly', u.email, u.id],
      );
      await audit(t, actor, 'create', 'Employee', row.id, u.name,
        { fromLogin: u.email, role: u.role, rateCents: 0 });
      created.push(u.name);
    }
  });

  const createdSet = new Set(created);
  const skipped = all.map((u) => u.name).filter((n) => !createdSet.has(n));
  return { created, skipped };
}
