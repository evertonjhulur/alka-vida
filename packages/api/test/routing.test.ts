/**
 * Composing a route and handing it to a driver.
 *
 * The rules pinned here all protect one thing: a round belongs to exactly
 * one driver, and everything on it is going out exactly once.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import * as routing from '../src/services/routing.ts';
import { addOrderToSheet, markStop } from '../src/services/delivery.ts';
import { createOrder } from '../src/services/orders.ts';
import type { Actor } from '../src/services/core.ts';

let f: Fixture;
let secondDriver: Actor;

before(async () => {
  f = await setupFixture();
  const row = await f.db.one<{ id: string }>(
    `INSERT INTO users (email, name, password_hash, role)
     VALUES ('driver2@alkavida.jm','Second Driver','x','driver') RETURNING id`,
  );
  secondDriver = { id: row.id, name: 'Second Driver', role: 'driver' };
});
after(async () => { await f.close(); });

/** A delivery order for the Kingston customer, and the sheet it lands on. */
async function orderOnSheet(dateStr = '2026-09-10') {
  const order = await createOrder(f.db, f.admin, {
    customerId: f.customerId,
    deliveryMode: 'Delivery',
    requestedDeliveryDate: dateStr,
    lines: [{ productId: f.casedProductId, cases: 4 }],
  });
  assert.ok(order.deliverySheetId, 'the order auto-routed onto a sheet');
  return order;
}

describe('Assigning a driver to a route', () => {
  let sheetId: string;
  beforeEach(async () => { sheetId = (await orderOnSheet()).deliverySheetId!; });

  test('the office can assign, and reassign, right up until settlement', async () => {
    const first = await routing.assignDriver(f.db, f.admin, sheetId, f.driver.id);
    assert.equal(first.driverName, 'Driver');

    const second = await routing.assignDriver(f.db, f.admin, sheetId, secondDriver.id);
    assert.equal(second.assignedDriverId, secondDriver.id,
      'a round can change hands mid-morning');
  });

  test('a route can be handed back by assigning nobody', async () => {
    await routing.assignDriver(f.db, f.admin, sheetId, f.driver.id);
    const out = await routing.assignDriver(f.db, f.admin, sheetId, null);
    assert.equal(out.assignedDriverId, null);
  });

  test('only a driver can be put on a route', async () => {
    await assert.rejects(
      () => routing.assignDriver(f.db, f.admin, sheetId, f.office.id),
      /is not a driver/,
    );
  });

  test('a driver can claim a route nobody holds', async () => {
    const out = await routing.assignDriver(f.db, f.driver, sheetId, f.driver.id);
    assert.equal(out.assignedDriverId, f.driver.id);
  });

  test('a driver cannot take a route already assigned to someone else', async () => {
    await routing.assignDriver(f.db, f.admin, sheetId, secondDriver.id);
    await assert.rejects(
      () => routing.assignDriver(f.db, f.driver, sheetId, f.driver.id),
      /already assigned to another driver/,
      'two drivers on one round means stops delivered twice and cash that never reconciles',
    );
  });

  test('a driver cannot assign the route to anybody but themselves', async () => {
    await assert.rejects(
      () => routing.assignDriver(f.db, f.driver, sheetId, secondDriver.id),
      /only take a route for themselves/,
    );
  });

  test('a settled route cannot be reassigned', async () => {
    await f.db.query(`UPDATE delivery_sheets SET status = 'Completed' WHERE id = $1`, [sheetId]);
    await assert.rejects(
      () => routing.assignDriver(f.db, f.admin, sheetId, f.driver.id),
      /settled route cannot be reassigned/,
    );
  });
});

describe('Starting a route', () => {
  test('starting claims an unheld route and stamps the time', async () => {
    const sheetId = (await orderOnSheet('2026-09-11')).deliverySheetId!;
    const out = await routing.startRoute(f.db, f.driver, sheetId);
    assert.ok(out.startedAt, 'the start time is recorded');
    assert.equal(out.driverName, 'Driver', 'starting put the route in the driver name');
  });

  test('starting twice keeps the first start time', async () => {
    const sheetId = (await orderOnSheet('2026-09-12')).deliverySheetId!;
    const first = await routing.startRoute(f.db, f.driver, sheetId);
    const again = await routing.startRoute(f.db, f.driver, sheetId);
    assert.equal(again.startedAt, first.startedAt,
      'reopening the app must not restart the day');
  });

  test('a driver cannot start somebody else route', async () => {
    const sheetId = (await orderOnSheet('2026-09-13')).deliverySheetId!;
    await routing.assignDriver(f.db, f.admin, sheetId, secondDriver.id);
    await assert.rejects(
      () => routing.startRoute(f.db, f.driver, sheetId),
      /already assigned to another driver/,
    );
  });
});

describe('What a driver is shown', () => {
  test('their own routes and unclaimed ones, never another driver round', async () => {
    const mine = (await orderOnSheet('2026-09-20')).deliverySheetId!;
    const theirs = (await orderOnSheet('2026-09-21')).deliverySheetId!;
    const free = (await orderOnSheet('2026-09-22')).deliverySheetId!;

    await routing.assignDriver(f.db, f.admin, mine, f.driver.id);
    await routing.assignDriver(f.db, f.admin, theirs, secondDriver.id);

    const seen = await routing.listSheets(f.db, f.driver, { status: 'Open' });
    const ids = seen.map((s) => (s as { id: string }).id);
    assert.ok(ids.includes(mine), 'their own route');
    assert.ok(ids.includes(free), 'a route nobody has taken');
    assert.ok(!ids.includes(theirs), 'never another driver round');

    const office = await routing.listSheets(f.db, f.admin, { status: 'Open' });
    assert.ok(office.map((s) => (s as { id: string }).id).includes(theirs),
      'the office still sees everything');
  });
});

describe('Adding an order to a route', () => {
  test('the added stop tells the driver what to load', async () => {
    const target = (await orderOnSheet('2026-10-01')).deliverySheetId!;
    // An order with no sheet of its own: the customer has no delivery zone.
    const walkIn = (await f.db.one<{ id: string }>(
      `INSERT INTO customers (name, phone, email) VALUES ('No Zone Ltd','876','nz@x.jm')
       RETURNING id`,
    )).id;
    const loose = await createOrder(f.db, f.admin, {
      customerId: walkIn, deliveryMode: 'Delivery',
      lines: [{ productId: f.casedProductId, cases: 7 }],
    });
    assert.equal(loose.deliverySheetId, null, 'no zone, so nothing auto-routed');

    const { stopId } = await addOrderToSheet(f.db, f.admin, target, loose.id);
    const stop = await f.db.one<{ line_items_summary: string | null }>(
      `SELECT line_items_summary FROM delivery_stops WHERE id = $1`, [stopId],
    );
    assert.match(stop.line_items_summary ?? '', /7 cs/,
      'a stop with no summary leaves the driver guessing what to put on the van');
  });

  test('one order cannot sit on two open routes at once', async () => {
    const first = await orderOnSheet('2026-10-02');
    const other = (await orderOnSheet('2026-10-03')).deliverySheetId!;
    await assert.rejects(
      () => addOrderToSheet(f.db, f.admin, other, first.id),
      /already on the/,
      'otherwise it is delivered twice and invoiced twice',
    );
  });

  test('a cancelled order cannot be routed', async () => {
    const order = await orderOnSheet('2026-10-04');
    const sheet = (await orderOnSheet('2026-10-05')).deliverySheetId!;
    await f.db.query(
      `UPDATE customer_orders SET status = 'Cancelled' WHERE id = $1`, [order.id]);
    await f.db.query(`DELETE FROM delivery_stops WHERE order_id = $1`, [order.id]);
    await assert.rejects(
      () => addOrderToSheet(f.db, f.admin, sheet, order.id), /cancelled/,
    );
  });
});

describe('Orders waiting for delivery', () => {
  test('an order already on an open route is not offered again', async () => {
    const routed = await orderOnSheet('2026-11-01');
    const sheetId = routed.deliverySheetId!;
    const offered = await routing.deliveryCandidates(f.db, sheetId);
    assert.ok(!offered.some((c) => c.id === routed.id),
      'it is already going out - offering it again invites a double delivery');
  });

  test('an unrouted order is offered', async () => {
    const zoneless = (await f.db.one<{ id: string }>(
      `INSERT INTO customers (name, phone, email) VALUES ('Waiting Ltd','876','w@x.jm')
       RETURNING id`,
    )).id;
    const waiting = await createOrder(f.db, f.admin, {
      customerId: zoneless, deliveryMode: 'Delivery',
      lines: [{ productId: f.casedProductId, cases: 2 }],
    });
    const sheetId = (await orderOnSheet('2026-11-02')).deliverySheetId!;
    const offered = await routing.deliveryCandidates(f.db, sheetId);
    const row = offered.find((c) => c.id === waiting.id);
    assert.ok(row, 'an order with nowhere to go is exactly what this list is for');
    assert.match(row!.summary ?? '', /2 cs/);
  });
});

describe('Taking a stop off a route', () => {
  test('a pending stop comes off and the order waits for delivery again', async () => {
    const order = await orderOnSheet('2026-12-01');
    const sheetId = order.deliverySheetId!;

    await routing.removeStop(f.db, f.admin, order.deliveryStopId!);

    const left = await f.db.query(
      `SELECT id FROM delivery_stops WHERE delivery_sheet_id = $1`, [sheetId]);
    assert.equal(left.length, 0, 'the stop is gone');

    const offered = await routing.deliveryCandidates(f.db, sheetId);
    assert.ok(offered.some((c) => c.id === order.id),
      'and the order is available to put on another day');
  });

  test('a delivered stop cannot be removed - that is a correction, not a deletion', async () => {
    const order = await orderOnSheet('2026-12-02');
    const line = await f.db.one<{ id: string }>(
      `SELECT id FROM order_line_items WHERE order_id = $1`, [order.id]);
    await markStop(f.db, f.driver, {
      stopId: order.deliveryStopId!,
      outcome: 'Delivered',
      deliveredLines: [{ orderLineId: line.id, cases: 4 }],
    });

    await assert.rejects(
      () => routing.removeStop(f.db, f.admin, order.deliveryStopId!),
      /already marked Delivered/,
      'there is an invoice against it; deleting the evidence is never the fix',
    );
  });

  test('a driver cannot take a stop off the route', async () => {
    const order = await orderOnSheet('2026-12-03');
    await assert.rejects(
      () => routing.removeStop(f.db, f.driver, order.deliveryStopId!),
      /not permitted|role/i,
    );
  });
});
