/**
 * Map pins and sorting a round's stops (23 Oct 2026).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { createOrder } from '../src/services/orders.ts';
import { assignDriver, startRoute } from '../src/services/routing.ts';
import {
  setCustomerPin, setStopPin, customerPins, setPlantLocation, proposeSort, applySort, pointFromText,
} from '../src/services/locations.ts';
import type { Actor } from '../src/services/core.ts';

let f: Fixture;
let sheetId: string;
const ids: string[] = [];
const PLANT = { lat: 18.0, lng: -76.95 };

before(async () => {
  f = await setupFixture();
  delete process.env.ORS_API_KEY;
  // Five customers on one Kingston round, strung out east of the plant but
  // put on the round in a zig-zag.
  const east = [0.20, 0.05, 0.15, 0.10, 0.25];
  for (const [i, d] of east.entries()) {
    const c = await f.db.one<{ id: string }>(
      `INSERT INTO customers (name, phone, email, delivery_zone, route_sequence)
       VALUES ($1, '876555000' || $2, '', 'Kingston', $3) RETURNING id`, [`Stop ${String.fromCharCode(65 + i)}`, i, (i + 1) * 10]);
    ids.push(c.id);
    if (i < 4) await setCustomerPin(f.db, f.office, c.id, { lat: 18.0, lng: -76.95 + d });
    const o = await createOrder(f.db, f.admin, {
      customerId: c.id, deliveryMode: 'Delivery', requestedDeliveryDate: '2026-11-05',
      lines: [{ productId: f.fiveGalProductId, looseBottles: 1 }],
    });
    sheetId = o.deliverySheetId!;
  }
});
after(async () => f.close());

describe('pins', () => {
  test('pasted links and coordinates; never outside Jamaica', async () => {
    assert.deepEqual(await pointFromText('18.0123, -76.9456'), { lat: 18.0123, lng: -76.9456 });
    await assert.rejects(pointFromText('25.76, -80.19'), /not in Jamaica/);
    await assert.rejects(pointFromText('Papine Square'), /no map position/);
  });

  test('the customer page lists the main address with its pin', async () => {
    const pins = await customerPins(f.db, ids[0]) as Array<{ label: string; lat: number | null; location_source: string }>;
    assert.equal(pins[0].label, 'Main address');
    assert.equal(pins[0].lat, 18.0);
    assert.equal(pins[0].location_source, 'Office');
  });

  test('a driver pins only stops on their own round; a vague fix is refused', async () => {
    const stop = await f.db.one<{ id: string }>(`SELECT id FROM delivery_stops WHERE customer_id = $1`, [ids[4]]);
    const other: Actor = { ...f.driver, id: (await f.db.one<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role) VALUES ('d9@x.jm','Other','x','driver') RETURNING id`)).id };
    await assignDriver(f.db, f.admin, sheetId, f.driver.id);
    await assert.rejects(setStopPin(f.db, other, stop.id, { lat: 18.0, lng: -76.70, accuracyM: 8 }), /another driver/);
    await assert.rejects(setStopPin(f.db, f.driver, stop.id, { lat: 18.0, lng: -76.70, accuracyM: 900 }), /within 900 m/);
    await setStopPin(f.db, f.driver, stop.id, { lat: 18.0, lng: -76.70, accuracyM: 8 });
    const c = await f.db.one<{ lat: number; location_source: string; location_accuracy_m: number }>(
      `SELECT lat, location_source, location_accuracy_m FROM customers WHERE id = $1`, [ids[4]]);
    assert.equal(c.location_source, 'Driver');
    assert.equal(c.location_accuracy_m, 8);
  });
});

describe('sorting a round', () => {
  test('needs the plant first', async () => {
    await assert.rejects(proposeSort(f.db, f.office, sheetId), /plant's location/);
    await assert.rejects(setPlantLocation(f.db, f.office, PLANT), /requires role admin/);
    await setPlantLocation(f.db, f.admin, PLANT);
  });

  test('straight line when the road map is off; out from the plant in order, never longer', async () => {
    const p = await proposeSort(f.db, f.office, sheetId, 'Road');
    assert.equal(p.method, 'Straight');
    assert.match(p.note ?? '', /not switched on/);
    const names = p.stops.map((s) => s.name);
    // Fixture's own customer is on this round too only if it is in Kingston on that day; ours are A-E.
    const ours = names.filter((n) => n.startsWith('Stop '));
    // A loop out and back: B, D, C, A, E going east (or the reverse) - D,C,A,E all eastward of B.
    assert.ok(['Stop B,Stop D,Stop C,Stop A,Stop E', 'Stop E,Stop A,Stop C,Stop D,Stop B'].includes(ours.join(',')), ours.join(','));
    assert.ok(p.sortedKm <= p.currentKm);
    assert.equal(p.missing, 0);
  });

  test('apply, and save as the usual order', async () => {
    const p = await proposeSort(f.db, f.office, sheetId, 'Straight');
    await assert.rejects(applySort(f.db, f.office, sheetId, { order: p.order.slice(1) }), /changed while you were sorting/);
    await applySort(f.db, f.office, sheetId, { order: p.order, saveAsUsual: true });
    const seq = await f.db.query<{ id: string }>(
      `SELECT id FROM delivery_stops WHERE delivery_sheet_id = $1 ORDER BY sequence_no`, [sheetId]);
    assert.deepEqual(seq.map((s) => s.id), p.order);
    const first = await f.db.one<{ route_sequence: number }>(
      `SELECT c.route_sequence FROM delivery_stops s JOIN customers c ON c.id = s.customer_id WHERE s.id = $1`, [p.order[0]]);
    assert.equal(first.route_sequence, 10);
  });

  test('locked once the round starts', async () => {
    await startRoute(f.db, f.driver, sheetId).catch(() => {});
    const started = await f.db.one<{ started_at: string | null }>(`SELECT started_at FROM delivery_sheets WHERE id = $1`, [sheetId]);
    if (!started.started_at) await f.db.query(`UPDATE delivery_sheets SET started_at = now() WHERE id = $1`, [sheetId]);
    await assert.rejects(proposeSort(f.db, f.driver, sheetId), /locked/);
  });
});

describe('customers drop their own pin when they sign up (23 Oct 2026)', () => {
  test('an account request carries its pin to the new customer', async () => {
    const { submitApplication, approveApplication } = await import('../src/services/registration.ts');
    await assert.rejects(submitApplication(f.db, {
      accountType: 'Individual', firstName: 'Far', lastName: 'Away', email: 'far@example.com', phone: '8765550199',
      addressLine1: '1 Road', city: 'Kingston', parish: 'St Andrew', lat: 25.76, lng: -80.19,
    }), /not in Jamaica/);
    const a = await submitApplication(f.db, {
      accountType: 'Individual', firstName: 'Pinned', lastName: 'Person', email: 'pinned@example.com', phone: '8765550198',
      addressLine1: '2 Road', city: 'Kingston', parish: 'St Andrew', lat: 18.02, lng: -76.78, accuracyM: 12,
    });
    const r = await approveApplication(f.db, f.admin, a.id, { createLogin: false });
    const c = await f.db.one<{ lat: number; location_source: string; location_accuracy_m: number }>(
      `SELECT lat, location_source, location_accuracy_m FROM customers WHERE id = $1`, [r.customerId]);
    assert.equal(c.lat, 18.02);
    assert.equal(c.location_source, 'Customer');
    assert.equal(c.location_accuracy_m, 12);
  });

  test('a website order carries its pin to the booked customer', async () => {
    const { submitWebsiteOrder, listWebsiteOrders, bookWebsiteOrder } = await import('../src/services/website.ts');
    const { reference } = await submitWebsiteOrder(f.db, {
      firstName: 'Web', lastName: 'Pin', phone: '876-555-0177', email: '', fulfilment: 'Deliver',
      addressLine1: '3 Road', city: 'Kingston', parish: 'St Andrew', payMethod: 'Cash',
      lines: [{ productId: f.fiveGalProductId, qty: 2 }], lat: 18.03, lng: -76.77, accuracyM: 9,
    });
    const w = (await listWebsiteOrders(f.db, f.admin, 'Pending') as Array<{ id: string; reference: string }>)
      .find((x) => x.reference === reference)!;
    const r = await bookWebsiteOrder(f.db, f.admin, w.id, { deliveryDate: '2026-11-06' });
    const c = await f.db.one<{ lng: number; location_source: string }>(
      `SELECT lng, location_source FROM customers WHERE id = $1`, [r.customerId]);
    assert.equal(c.lng, -76.77);
    assert.equal(c.location_source, 'Customer');
  });
});
