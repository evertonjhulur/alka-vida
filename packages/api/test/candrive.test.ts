/**
 * Office staff and administrators who also drive (Everton, 18 Nov 2026).
 *
 * "Can also drive" on an office or administrator login: they can be put on a
 * round, confirm its load and reconfirm additions. When the person who
 * confirms also logged or loaded it, that is allowed but flagged ("loaded and
 * confirmed by the same person") on the truck, the rounds/End of day report,
 * the loadings report and the audit log.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { createOrder } from '../src/services/orders.ts';
import { listDrivers, assignDriver } from '../src/services/routing.ts';
import { loadRound, confirmLoad, addToLoad, confirmAddition, truckPosition, loadingsReport } from '../src/services/trucks.ts';
import { roundsReport } from '../src/services/reports.ts';
import { describeAuditRows } from '../src/services/auditwords.ts';
import { createUser, listUsers, updateUser } from '../src/services/users.ts';
import { setAlertSettings, alertSettingsFor } from '../src/services/push.ts';
import { businessToday, canDrive, type Actor } from '../src/services/core.ts';
import { addDays } from '@alka/shared';

let f: Fixture;
const today = businessToday();
/** Office staff with "Can also drive" ticked. */
let jane: Actor;
/** Office staff without it. */
let paul: Actor;

before(async () => {
  f = await setupFixture();
  await f.db.query(`INSERT INTO finished_goods_stock (product_id, quantity_on_hand) VALUES ($1, 5000)
                    ON CONFLICT (product_id) DO UPDATE SET quantity_on_hand = 5000`, [f.casedProductId]);
  const j = await createUser(f.db, f.admin, {
    email: 'jane@alkavida.jm', name: 'Jane Office', role: 'user', password: 'password1', canDrive: true,
  });
  jane = { id: j.id, name: 'Jane Office', role: 'user', canDrive: true };
  const p = await createUser(f.db, f.admin, {
    email: 'paul@alkavida.jm', name: 'Paul Office', role: 'user', password: 'password1',
  });
  paul = { id: p.id, name: 'Paul Office', role: 'user', canDrive: false };
});
after(async () => { await f.close(); });

let dayOffset = 30;
async function round() {
  const day = addDays(today, dayOffset++);
  const o = await createOrder(f.db, f.office, {
    customerId: f.customerId, deliveryMode: 'Delivery', requestedDeliveryDate: day,
    lines: [{ productId: f.casedProductId, cases: 2 }],
  });
  const st = await f.db.one<{ delivery_sheet_id: string }>(
    `SELECT delivery_sheet_id FROM delivery_stops WHERE order_id = $1`, [o.id]);
  return st.delivery_sheet_id;
}

describe('the "Can also drive" tick', () => {
  test('only on office and administrator logins; listed on the Users screen', async () => {
    await assert.rejects(createUser(f.db, f.admin, {
      email: 'd2@alkavida.jm', name: 'D2', role: 'driver', password: 'password1', canDrive: true,
    }), /already drives/);
    const users = await listUsers(f.db, f.admin) as Array<{ id: string; can_drive: boolean }>;
    assert.equal(users.find((u) => u.id === jane.id)?.can_drive, true);
    assert.equal(users.find((u) => u.id === paul.id)?.can_drive, false);
    assert.equal(canDrive(jane), true);
    assert.equal(canDrive(paul), false);
    assert.equal(canDrive(f.driver), true);
    assert.equal(canDrive({ ...f.driver, role: 'customer', canDrive: true }), false);
  });

  test('ticked logins are in the driver drop-down, marked as office', async () => {
    const list = await listDrivers(f.db);
    assert.equal(list.find((d) => d.id === jane.id)?.office, true);
    assert.equal(list.find((d) => d.id === f.driver.id)?.office, false);
    assert.ok(!list.some((d) => d.id === paul.id));
  });

  test('the office can put a ticked login on a round, not an unticked one', async () => {
    const sheetId = await round();
    await assert.rejects(assignDriver(f.db, f.office, sheetId, paul.id), /not a driver.*Can also drive/);
    const out = await assignDriver(f.db, f.office, sheetId, jane.id);
    assert.equal(out.driverName, 'Jane Office');
  });

  test('unticking is refused while they hold an open round', async () => {
    const sheetId = await round();
    await assignDriver(f.db, f.office, sheetId, jane.id);
    await assert.rejects(updateUser(f.db, f.admin, jane.id, { canDrive: false }), /driver on the open/);
    await assignDriver(f.db, f.office, sheetId, null);
  });
});

describe('the driver part of a round', () => {
  test('office staff without the tick cannot confirm a load', async () => {
    const sheetId = await round();
    await loadRound(f.db, f.office, sheetId, {});
    await assert.rejects(confirmLoad(f.db, paul, sheetId), /only the driver/);
  });

  test('a ticked login cannot confirm a load on somebody else\'s round', async () => {
    const sheetId = await round();
    await assignDriver(f.db, f.office, sheetId, f.driver.id);
    await loadRound(f.db, f.office, sheetId, {});
    await assert.rejects(confirmLoad(f.db, jane, sheetId), /already assigned to another driver/);
    const s = await f.db.one<{ assigned_driver_id: string }>(
      `SELECT assigned_driver_id FROM delivery_sheets WHERE id = $1`, [sheetId]);
    assert.equal(s.assigned_driver_id, f.driver.id, 'the round stays with its driver');
  });

  test('loaded by someone else and confirmed by the ticked login: no flag', async () => {
    const sheetId = await round();
    await assignDriver(f.db, f.office, sheetId, jane.id);
    await loadRound(f.db, f.office, sheetId, {});
    await confirmLoad(f.db, jane, sheetId);
    const t = await truckPosition(f.db, sheetId);
    assert.equal(t?.driverConfirmedName, 'Jane Office');
    assert.equal(t?.samePerson, null);
  });

  test('logged and confirmed by the same person: allowed, and flagged everywhere', async () => {
    const sheetId = await round();
    // Claims an unassigned round by confirming, like a driver.
    await loadRound(f.db, jane, sheetId, {});
    const out = await confirmLoad(f.db, jane, sheetId);
    assert.ok(out.startedAt);

    const t = await truckPosition(f.db, sheetId);
    assert.equal(t?.samePerson, 'Jane Office');

    const day = (await f.db.one<{ d: string }>(`SELECT delivery_date::text AS d FROM delivery_sheets WHERE id = $1`, [sheetId])).d;
    const rep = await roundsReport(f.db, day, day);
    assert.equal(rep.rounds.find((r) => r.id === sheetId)?.samePerson, 'Jane Office');

    const loads = await loadingsReport(f.db, '2000-01-01', '2100-01-01');
    assert.equal(loads.find((l) => l.sheetId === sheetId)?.samePerson, 'Jane Office');

    const rows = await f.db.query<Record<string, unknown>>(
      `SELECT * FROM audit_log WHERE entity_id = $1 AND details->>'samePerson' = 'true'`, [sheetId]);
    assert.equal(rows.length, 1, 'the audit log records the flag');
    const [said] = await describeAuditRows(f.db, rows as never);
    assert.match(said.summary, /confirmed the load.*same person/);
  });

  test('an administrator named as the loader, then confirming: flagged', async () => {
    const admin: Actor = { ...f.admin, canDrive: true };
    await f.db.query(`UPDATE users SET can_drive = true WHERE id = $1`, [f.admin.id]);
    const sheetId = await round();
    await loadRound(f.db, admin, sheetId, {});
    await confirmLoad(f.db, admin, sheetId);
    assert.equal((await truckPosition(f.db, sheetId))?.samePerson, f.admin.name);
    await f.db.query(`UPDATE users SET can_drive = false WHERE id = $1`, [f.admin.id]);
  });

  test('an addition logged and reconfirmed by the same person is flagged', async () => {
    const sheetId = await round();
    await assignDriver(f.db, f.office, sheetId, jane.id);
    await loadRound(f.db, f.office, sheetId, {});
    await confirmLoad(f.db, jane, sheetId);
    assert.equal((await truckPosition(f.db, sheetId))?.samePerson, null);

    const add = await addToLoad(f.db, jane, sheetId, { extras: [{ productId: f.casedProductId, extraUnits: 1 }] });
    await assert.rejects(confirmAddition(f.db, paul, add.id), /only the driver/);
    await confirmAddition(f.db, jane, add.id);
    const t = await truckPosition(f.db, sheetId);
    assert.equal(t?.additions.find((x) => x.id === add.id)?.samePerson, true);
    assert.equal(t?.samePerson, 'Jane Office');
  });

  test('a driver login confirming as before is never flagged', async () => {
    const sheetId = await round();
    await loadRound(f.db, f.office, sheetId, {});
    await confirmLoad(f.db, f.driver, sheetId);
    assert.equal((await truckPosition(f.db, sheetId))?.samePerson, null);
  });
});

describe('alerts and wording', () => {
  test('a ticked login can have "changes to my load" alerts', async () => {
    await setAlertSettings(f.db, jane, jane.id, { load: false });
    assert.equal((await alertSettingsFor(f.db, jane.id)).load, false);
    await setAlertSettings(f.db, jane, jane.id, { load: true });
    const s = await alertSettingsFor(f.db, jane.id);
    assert.equal(s.load, true);
    assert.equal(s.canDrive, true);
    // Unticked office staff: the setting is not theirs to change.
    await f.db.query(`UPDATE users SET notify_load = true WHERE id = $1`, [paul.id]);
    await setAlertSettings(f.db, paul, paul.id, { load: false });
    assert.equal((await alertSettingsFor(f.db, paul.id)).load, true);
  });
});
