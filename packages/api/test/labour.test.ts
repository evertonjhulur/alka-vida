/**
 * Employees and labour cost.
 *
 * The rules worth pinning are the ones that would go wrong quietly:
 *
 *   * The rate is LOCKED onto an entry, so a pay rise never restates what an
 *     earlier week cost. This is the same rule order lines follow, and the
 *     one most likely to be undone by a well-meaning "just read the current
 *     rate" refactor.
 *   * NOTHING here is wired into production costing. That is deliberate, and
 *     a test says so - if somebody connects it later, they should have to
 *     delete a test that explains why it was not connected, rather than
 *     silently move every margin in the system.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPgliteDb, type Db } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { seed } from '../src/db/seed.ts';
import {
  listEmployees, createEmployee, updateEmployee, setEmployeeActive,
  recordLabour, deleteLabourEntry, listLabourEntries, labourForPeriod, labourByMonth,
  importEmployeesFromLogins, getEmployee,
} from '../src/services/labour.ts';
import { SYSTEM_USER_EMAIL } from '../src/services/users.ts';
import type { Actor } from '../src/services/core.ts';

let db: Db;
let admin: Actor;
let office: Actor;
let driverActor: Actor;

const actorFor = async (email: string): Promise<Actor> => {
  const u = await db.one<{ id: string; name: string; role: Actor['role'] }>(
    `SELECT id, name, role FROM users WHERE email = $1`, [email]);
  return { id: u.id, name: u.name, role: u.role };
};

before(async () => {
  db = await createPgliteDb();
  await migrate(db, { quiet: true });
  await seed(db, { quiet: true });
  admin = await actorFor('admin@alkavida.jm');
  office = await actorFor('office@alkavida.jm');
  driverActor = await actorFor('driver@alkavida.jm');
});
after(async () => { await db.close(); });

describe('Employees', () => {
  test('hourly and per-trip are both first-class', async () => {
    const bottler = await createEmployee(db, admin, {
      name: 'Marcia Reid', jobTitle: 'Production', payBasis: 'Hourly',
      rateCents: 90000, startedOn: '2026-01-15',
    });
    const driver = await createEmployee(db, admin, {
      name: 'Devon Clarke', jobTitle: 'Driver', payBasis: 'PerTrip',
      rateCents: 250000, phone: '8765550101',
    });

    const all = await listEmployees(db, admin) as Array<Record<string, unknown>>;
    const byId = new Map(all.map((r) => [r.id, r]));
    assert.equal(byId.get(bottler.id)?.pay_basis, 'Hourly');
    assert.equal(byId.get(driver.id)?.pay_basis, 'PerTrip');
    assert.equal(Number(byId.get(driver.id)?.rate_cents), 250000);
  });

  test('a name is required and a rate cannot be negative', async () => {
    await assert.rejects(
      () => createEmployee(db, admin, { name: '  ', payBasis: 'Hourly', rateCents: 1000 }),
      /needs a name/,
    );
    await assert.rejects(
      () => createEmployee(db, admin, { name: 'X', payBasis: 'Hourly', rateCents: -1 }),
      /cannot be negative/,
    );
  });

  test('office staff may look but not hire', async () => {
    await assert.rejects(
      () => createEmployee(db, office, { name: 'X', payBasis: 'Hourly', rateCents: 1000 }),
      /requires role admin/,
    );
    // Reading is open to the office - they record the work.
    await listEmployees(db, office);
  });

  test('a driver cannot read the payroll', async () => {
    await assert.rejects(() => listEmployees(db, driverActor), /requires role/);
    await assert.rejects(() => labourForPeriod(db, driverActor), /requires role/);
  });
});

describe('Recording work', () => {
  test('hours times the hourly rate', async () => {
    const e = await createEmployee(db, admin, {
      name: 'Hourly Hand', payBasis: 'Hourly', rateCents: 85000,
    });
    const entry = await recordLabour(db, office, {
      employeeId: e.id, workDate: '2026-09-01', quantity: 8,
    });
    assert.equal(entry.amountCents, 680000);
  });

  test('trips times the per-trip rate', async () => {
    const e = await createEmployee(db, admin, {
      name: 'Trip Driver', payBasis: 'PerTrip', rateCents: 300000,
    });
    const entry = await recordLabour(db, office, {
      employeeId: e.id, workDate: '2026-09-01', quantity: 3, reference: 'Kingston round',
    });
    assert.equal(entry.amountCents, 900000);

    const rows = await listLabourEntries(db, admin, { employeeId: e.id }) as
      Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].basis, 'PerTrip');
    assert.equal(rows[0].reference, 'Kingston round');
    // Who typed it in, for the same reason every other write records it.
    assert.equal(rows[0].recorded_by_name, office.name);
  });

  test('a half hour is not rounded away', async () => {
    const e = await createEmployee(db, admin, {
      name: 'Half Hour', payBasis: 'Hourly', rateCents: 85000,
    });
    const entry = await recordLabour(db, office, {
      employeeId: e.id, workDate: '2026-09-02', quantity: 7.5,
    });
    assert.equal(entry.amountCents, 637500);
  });

  test('the amount lands on a whole cent, never a fraction', async () => {
    const e = await createEmployee(db, admin, {
      name: 'Odd Rate', payBasis: 'Hourly', rateCents: 83333,
    });
    const entry = await recordLabour(db, office, {
      employeeId: e.id, workDate: '2026-09-02', quantity: 1.5,
    });
    assert.equal(entry.amountCents, 125000);
    assert.equal(Number.isInteger(entry.amountCents), true);
  });

  test('nothing worked is not work', async () => {
    const e = await createEmployee(db, admin, {
      name: 'Zero', payBasis: 'Hourly', rateCents: 85000,
    });
    await assert.rejects(
      () => recordLabour(db, office, { employeeId: e.id, workDate: '2026-09-02', quantity: 0 }),
      /how many hours|trips run/,
    );
    await assert.rejects(
      () => recordLabour(db, office, { employeeId: e.id, workDate: '2026-09-02', quantity: -4 }),
      /how many hours|trips run/,
    );
  });
});

describe('A pay rise does not rewrite the past', () => {
  test('an entry keeps the rate it was costed at', async () => {
    const e = await createEmployee(db, admin, {
      name: 'Raise Me', payBasis: 'Hourly', rateCents: 80000,
    });
    const before = await recordLabour(db, admin, {
      employeeId: e.id, workDate: '2026-08-01', quantity: 10,
    });
    assert.equal(before.amountCents, 800000);

    await updateEmployee(db, admin, e.id, { rateCents: 100000 });

    const after = await recordLabour(db, admin, {
      employeeId: e.id, workDate: '2026-09-01', quantity: 10,
    });
    assert.equal(after.amountCents, 1000000, 'new work uses the new rate');

    const rows = await listLabourEntries(db, admin, { employeeId: e.id }) as
      Array<Record<string, unknown>>;
    const august = rows.find((r) => r.work_date === '2026-08-01');
    assert.equal(Number(august?.rate_cents), 80000, 'August still costs what August cost');
    assert.equal(Number(august?.amount_cents), 800000);
  });

  test('a one-off rate overrides for that entry only', async () => {
    const e = await createEmployee(db, admin, {
      name: 'Long Round', payBasis: 'PerTrip', rateCents: 200000,
    });
    const special = await recordLabour(db, admin, {
      employeeId: e.id, workDate: '2026-09-03', quantity: 1, rateCents: 350000,
      notes: 'St Elizabeth, agreed beforehand',
    });
    assert.equal(special.amountCents, 350000);

    const normal = await recordLabour(db, admin, {
      employeeId: e.id, workDate: '2026-09-04', quantity: 1,
    });
    assert.equal(normal.amountCents, 200000, 'the employee rate is unchanged');
  });
});

describe('Leaving and coming back', () => {
  test('somebody who has left cannot have new work recorded against them', async () => {
    const e = await createEmployee(db, admin, {
      name: 'Gone Fishing', payBasis: 'Hourly', rateCents: 85000,
    });
    await recordLabour(db, admin, {
      employeeId: e.id, workDate: '2026-07-01', quantity: 5,
    });
    await setEmployeeActive(db, admin, e.id, false, '2026-07-31');

    await assert.rejects(
      () => recordLabour(db, admin, {
        employeeId: e.id, workDate: '2026-09-01', quantity: 5,
      }),
      /has left/,
    );

    // The work they already did is untouched - it is part of what production cost.
    const rows = await listLabourEntries(db, admin, { employeeId: e.id }) as unknown[];
    assert.equal(rows.length, 1);

    await setEmployeeActive(db, admin, e.id, true);
    const back = await recordLabour(db, admin, {
      employeeId: e.id, workDate: '2026-09-01', quantity: 5,
    });
    assert.equal(back.amountCents, 425000);
  });
});

describe('What is owed for a period', () => {
  test('totals per person, and only the days asked for', async () => {
    const a = await createEmployee(db, admin, {
      name: 'Period A', payBasis: 'Hourly', rateCents: 100000,
    });
    const b = await createEmployee(db, admin, {
      name: 'Period B', payBasis: 'PerTrip', rateCents: 200000,
    });
    await recordLabour(db, admin, { employeeId: a.id, workDate: '2026-06-10', quantity: 4 });
    await recordLabour(db, admin, { employeeId: a.id, workDate: '2026-06-11', quantity: 6 });
    await recordLabour(db, admin, { employeeId: b.id, workDate: '2026-06-11', quantity: 2 });
    // Outside the window, and must not be counted.
    await recordLabour(db, admin, { employeeId: a.id, workDate: '2026-07-01', quantity: 8 });

    const p = await labourForPeriod(db, admin, { from: '2026-06-01', to: '2026-06-30' });
    const rows = p.byEmployee as Array<Record<string, unknown>>;
    const rowA = rows.find((r) => r.employee_id === a.id);
    const rowB = rows.find((r) => r.employee_id === b.id);

    assert.equal(Number(rowA?.quantity), 10);
    assert.equal(Number(rowA?.amount_cents), 1000000);
    assert.equal(Number(rowB?.quantity), 2);
    assert.equal(Number(rowB?.amount_cents), 400000);

    // The grand total is the sum of everybody's June, not everybody's ever.
    const summed = rows.reduce((s, r) => s + Number(r.amount_cents), 0);
    assert.equal(p.totalCents, summed);
  });

  test('somebody who did nothing this period still appears, at zero', async () => {
    const idle = await createEmployee(db, admin, {
      name: 'Idle Ivan', payBasis: 'Hourly', rateCents: 90000,
    });
    const p = await labourForPeriod(db, admin, { from: '2026-06-01', to: '2026-06-30' });
    const row = (p.byEmployee as Array<Record<string, unknown>>)
      .find((r) => r.employee_id === idle.id);
    assert.ok(row, 'an active employee is listed even with nothing recorded');
    assert.equal(Number(row?.amount_cents), 0);
  });

  test('by month, for the figure production costing will one day read', async () => {
    const months = await labourByMonth(db, admin) as Array<Record<string, unknown>>;
    const june = months.find((m) => m.month === '2026-06');
    assert.ok(june, 'June is a month with work in it');
    assert.ok(Number(june?.amount_cents) > 0);
  });
});

describe('Correcting a mistake', () => {
  test('an administrator can remove an entry; the office cannot', async () => {
    const e = await createEmployee(db, admin, {
      name: 'Typo Ted', payBasis: 'Hourly', rateCents: 85000,
    });
    const entry = await recordLabour(db, admin, {
      employeeId: e.id, workDate: '2026-09-05', quantity: 80,
    });

    await assert.rejects(() => deleteLabourEntry(db, office, entry.id), /requires role admin/);
    await deleteLabourEntry(db, admin, entry.id);

    const rows = await listLabourEntries(db, admin, { employeeId: e.id }) as unknown[];
    assert.equal(rows.length, 0);

    // Removing it left a trace, like every other write.
    const logged = await db.one<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit_log
       WHERE entity_type = 'LabourEntry' AND action = 'delete' AND entity_id = $1`,
      [entry.id],
    );
    assert.equal(Number(logged.n), 1);
  });
});

describe('Labour is NOT in the cost of a case yet', () => {
  /*
   * Deliberate, and Evert's instruction: build the module, connect it later.
   * If this test starts failing, somebody has connected labour to costing -
   * which is fine, but it must be a decision rather than a side effect,
   * because it moves every margin in the system.
   */
  test('nothing outside this module reads labour_entries', async () => {
    const readers = await db.query<{ name: string }>(
      `SELECT p.proname AS name FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosrc ILIKE '%labour_entries%'`,
    );
    assert.deepEqual(readers.map((r) => r.name), [],
      'no database function costs anything from labour yet');

    const views = await db.query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.views
       WHERE table_schema = 'public' AND view_definition ILIKE '%labour_entries%'`,
    );
    assert.deepEqual(views.map((v) => v.name), [],
      'no view - inventory valuation included - reads labour yet');
  });

  test('an employee is not a login, and does not need one', async () => {
    const e = await createEmployee(db, admin, {
      name: 'No Login Needed', payBasis: 'Hourly', rateCents: 85000,
    });
    const row = await db.one<{ user_id: string | null }>(
      `SELECT user_id FROM employees WHERE id = $1`, [e.id]);
    assert.equal(row.user_id, null);
  });
});

describe('Bringing the existing logins across', () => {
  /*
   * Evert's own classification: a `user` login is an employee, an `admin` is
   * a manager, a `driver` drives. The login role IS the workforce category,
   * so it is what the job title comes from.
   */
  test('every login becomes an employee, titled by its role', async () => {
    const fresh = await createPgliteDb();
    await migrate(fresh, { quiet: true });
    await seed(fresh, { quiet: true });
    const a = await fresh.one<{ id: string; name: string; role: Actor['role'] }>(
      `SELECT id, name, role FROM users WHERE email = 'admin@alkavida.jm'`);
    const actor: Actor = { id: a.id, name: a.name, role: a.role };

    const r = await importEmployeesFromLogins(fresh, actor);
    assert.ok(r.created.length > 0);

    const rows = await fresh.query<{
      name: string; job_title: string; pay_basis: string; rate_cents: string;
      user_id: string | null; role: string;
    }>(
      `SELECT e.name, e.job_title, e.pay_basis, e.rate_cents::text AS rate_cents,
              e.user_id, u.role
       FROM employees e JOIN users u ON u.id = e.user_id`);

    for (const row of rows) {
      if (row.role === 'driver') {
        assert.equal(row.job_title, 'Driver');
        assert.equal(row.pay_basis, 'PerTrip', 'a driver is paid by the trip');
      } else if (row.role === 'admin') {
        assert.equal(row.job_title, 'Manager');
        assert.equal(row.pay_basis, 'Hourly');
      } else {
        assert.equal(row.job_title, 'Employee');
        assert.equal(row.pay_basis, 'Hourly');
      }
      // What somebody is paid cannot be derived from anything in the system.
      // A blank is honest; an invented figure is not.
      assert.equal(Number(row.rate_cents), 0, 'the rate is left to be filled in');
      assert.ok(row.user_id, 'the employee is tied to their login');
    }

    await fresh.close();
  });

  test('pressing it twice does not produce two of anybody', async () => {
    const fresh = await createPgliteDb();
    await migrate(fresh, { quiet: true });
    await seed(fresh, { quiet: true });
    const a = await fresh.one<{ id: string; name: string; role: Actor['role'] }>(
      `SELECT id, name, role FROM users WHERE email = 'admin@alkavida.jm'`);
    const actor: Actor = { id: a.id, name: a.name, role: a.role };

    const first = await importEmployeesFromLogins(fresh, actor);
    const second = await importEmployeesFromLogins(fresh, actor);

    assert.equal(second.created.length, 0, 'nobody is added a second time');
    assert.deepEqual([...second.skipped].sort(), [...first.created].sort());

    const dupes = await fresh.query<{ name: string }>(
      `SELECT name FROM employees GROUP BY name HAVING COUNT(*) > 1`);
    assert.deepEqual(dupes, []);
    await fresh.close();
  });

  test('customers and the system account are never employees', async () => {
    const fresh = await createPgliteDb();
    await migrate(fresh, { quiet: true });
    await seed(fresh, { quiet: true });
    const a = await fresh.one<{ id: string; name: string; role: Actor['role'] }>(
      `SELECT id, name, role FROM users WHERE email = 'admin@alkavida.jm'`);
    await importEmployeesFromLogins(fresh, { id: a.id, name: a.name, role: a.role });

    const wrong = await fresh.query<{ email: string }>(
      `SELECT u.email FROM employees e JOIN users u ON u.id = e.user_id
       WHERE u.role = 'customer' OR u.email = $1`, [SYSTEM_USER_EMAIL]);
    assert.deepEqual(wrong, [],
      'the people who buy the water are not the people who make it');
    await fresh.close();
  });

  test('only an administrator may run it', async () => {
    await assert.rejects(() => importEmployeesFromLogins(db, office), /requires role admin/);
  });
});

describe('A blank rate is refused, not silently costed at nothing', () => {
  test('work cannot be recorded against an employee with no rate', async () => {
    const e = await createEmployee(db, admin, {
      name: 'Rate Unset', payBasis: 'Hourly', rateCents: 0,
    });
    await assert.rejects(
      () => recordLabour(db, admin, {
        employeeId: e.id, workDate: '2026-09-05', quantity: 8,
      }),
      /has no rate set/,
    );

    // Typing a rate for the one entry is the way through.
    const entry = await recordLabour(db, admin, {
      employeeId: e.id, workDate: '2026-09-05', quantity: 8, rateCents: 90000,
    });
    assert.equal(entry.amountCents, 720000);
  });
});

describe('One employee, on their own page', () => {
  test('their details and their own work, and no one else’s', async () => {
    const mine = await createEmployee(db, admin, {
      name: 'Own Page', jobTitle: 'Production', payBasis: 'Hourly', rateCents: 95000,
    });
    const other = await createEmployee(db, admin, {
      name: 'Someone Else', payBasis: 'Hourly', rateCents: 95000,
    });
    await recordLabour(db, admin, { employeeId: mine.id, workDate: '2026-05-01', quantity: 8 });
    await recordLabour(db, admin, { employeeId: mine.id, workDate: '2026-05-02', quantity: 4 });
    await recordLabour(db, admin, { employeeId: other.id, workDate: '2026-05-02', quantity: 9 });

    const r = await getEmployee(db, admin, mine.id) as {
      employee: Record<string, unknown>; entries: Array<Record<string, unknown>>;
    };
    assert.equal(r.employee.name, 'Own Page');
    assert.equal(r.employee.job_title, 'Production');
    assert.equal(r.entries.length, 2, "only this person's work");
    assert.equal(Number(r.employee.lifetime_cents), 95000 * 12);
    assert.equal(Number(r.employee.lifetime_quantity), 12);
    assert.equal(r.employee.entry_count, 2);
  });

  test('the office may open a record; a driver may not', async () => {
    const e = await createEmployee(db, admin, {
      name: 'Readable', payBasis: 'Hourly', rateCents: 90000,
    });
    await getEmployee(db, office, e.id);
    await assert.rejects(() => getEmployee(db, driverActor, e.id), /requires role/);
  });
});
