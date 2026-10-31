/**
 * Approximate pins from the typed address (31 Oct 2026). Google is never
 * called: fetch is replaced with a stand-in Geocoding API.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { createOrder } from '../src/services/orders.ts';
import { assignDriver } from '../src/services/routing.ts';
import { setCustomerPin, setPlantLocation, setStopPin, proposeSort } from '../src/services/locations.ts';
import { approximatePinsForAll, pinCounts, resetGeocodeCounter } from '../src/services/approxpins.ts';

let f: Fixture;
let sheetId: string;
const ids: Record<string, string> = {};
const realFetch = globalThis.fetch;
const asked: string[] = [];
/** What the stand-in Google says for each address. */
const ANSWERS: Record<string, unknown> = {
  '5 Paddington Terrace, Kingston 6, St Andrew': { status: 'OK', results: [{ types: ['route'], geometry: { location: { lat: 18.0281, lng: -76.7731 }, location_type: 'GEOMETRIC_CENTER' } }] },
  'Lot 22, Greendale, Spanish Town, St Catherine': { status: 'OK', results: [{ types: ['neighborhood'], geometry: { location: { lat: 18.0101, lng: -76.9702 }, location_type: 'APPROXIMATE' } }] },
  'Somewhere, St Mary': { status: 'OK', results: [{ types: ['administrative_area_level_1'], geometry: { location: { lat: 18.3, lng: -76.9 }, location_type: 'APPROXIMATE' } }] },
  'Nowhere Lane, Kingston': { status: 'ZERO_RESULTS', results: [] },
  '14 Hope Road, Kingston 10, St Andrew': { status: 'OK', results: [{ types: ['street_address'], geometry: { location: { lat: 18.0251, lng: -76.7952 }, location_type: 'ROOFTOP' } }] },
};

async function customer(name: string, line1: string, city: string, parish: string, seq: number) {
  const c = await f.db.one<{ id: string }>(
    `INSERT INTO customers (name, phone, email, address_line1, city, parish, delivery_zone, route_sequence)
     VALUES ($1, $6, '', $3, $4, $5, 'Kingston', $2) RETURNING id`, [name, seq, line1, city, parish, `8765551${seq}`]);
  ids[name] = c.id;
  const o = await createOrder(f.db, f.admin, {
    customerId: c.id, deliveryMode: 'Delivery', requestedDeliveryDate: '2026-11-09',
    lines: [{ productId: f.fiveGalProductId, looseBottles: 1 }],
  });
  sheetId = o.deliverySheetId!;
}

before(async () => {
  f = await setupFixture();
  delete process.env.ORS_API_KEY;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.hostname !== 'maps.googleapis.com') return realFetch(url, init);
    const address = u.searchParams.get('address') ?? '';
    asked.push(address);
    if (u.searchParams.get('key') === 'denied') return new Response(JSON.stringify({ status: 'REQUEST_DENIED', error_message: 'API not enabled' }));
    assert.equal(u.searchParams.get('components'), 'country:JM');
    return new Response(JSON.stringify(ANSWERS[address] ?? { status: 'ZERO_RESULTS', results: [] }));
  }) as typeof fetch;
  await setPlantLocation(f.db, f.admin, { lat: 18.0127, lng: -76.9572 });
  await customer('Andrea Brown', '5 Paddington Terrace', 'Kingston 6', 'St Andrew', 10);
  await customer('Devon Clarke', 'Lot 22, Greendale', 'Spanish Town', 'St Catherine', 20);
  await customer('Vague Person', 'Somewhere', '', 'St Mary', 30);
  await customer('Lost Person', 'Nowhere Lane', 'Kingston', '', 40);
  await customer('Pinned Already', '14 Hope Road', 'Kingston 10', 'St Andrew', 50);
  await setCustomerPin(f.db, f.office, ids['Pinned Already'], { lat: 18.03, lng: -76.80 });
  await assignDriver(f.db, f.admin, sheetId, f.driver.id);
});
after(async () => { globalThis.fetch = realFetch; delete process.env.GOOGLE_MAPS_API_KEY; await f.close(); });
beforeEach(() => { asked.length = 0; resetGeocodeCounter(); delete process.env.GEOCODE_DAILY_LIMIT; });

const pin = (id: string) => f.db.one<{ lat: number | null; lng: number | null; location_source: string | null; location_accuracy_m: number | null }>(
  `SELECT lat, lng, location_source, location_accuracy_m FROM customers WHERE id = $1`, [id]);

describe('approximate pins', () => {
  test('nothing is looked up without the Google key', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    const p = await proposeSort(f.db, f.office, sheetId, 'Straight');
    assert.equal(p.approxPlaced, 0);
    assert.equal(asked.length, 0);
    assert.ok(p.missing >= 4);
  });

  test('sorting a round gives rough pins to stops with none, then sorts them in', async () => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-key';
    const p = await proposeSort(f.db, f.office, sheetId, 'Straight');
    assert.equal(p.approxPlaced, 2);
    const a = await pin(ids['Andrea Brown']);
    assert.deepEqual([a.lat, a.lng, a.location_source, a.location_accuracy_m], [18.0281, -76.7731, 'Approximate', 600]);
    assert.equal((await pin(ids['Devon Clarke'])).location_source, 'Approximate');
    // Parish-wide or not found: no pin, still last.
    assert.equal((await pin(ids['Vague Person'])).lat, null);
    assert.equal((await pin(ids['Lost Person'])).lat, null);
    // A pin someone placed is never looked up or replaced.
    assert.ok(!asked.some((x) => x.startsWith('14 Hope Road')));
    assert.equal((await pin(ids['Pinned Already'])).location_source, 'Office');
    const andrea = p.stops.find((s) => s.name === 'Andrea Brown')!;
    assert.equal(andrea.approximate, true);
    assert.ok(p.approximate >= 2);
    const lastTwo = p.stops.filter((s) => s.lat == null).map((s) => s.name).sort();
    assert.deepEqual(lastTwo.filter((n) => n === 'Vague Person' || n === 'Lost Person'), ['Lost Person', 'Vague Person']);
  });

  test('each address is asked about once, found or not', async () => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-key';
    await proposeSort(f.db, f.office, sheetId, 'Straight');
    assert.deepEqual(asked, []);
  });

  test('editing the address works the approximate pin out again', async () => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-key';
    await f.db.query(`UPDATE customers SET address_line1 = '14 Hope Road', city = 'Kingston 10' WHERE id = $1`, [ids['Andrea Brown']]);
    await proposeSort(f.db, f.office, sheetId, 'Straight');
    assert.deepEqual(asked, ['14 Hope Road, Kingston 10, St Andrew']);
    const a = await pin(ids['Andrea Brown']);
    assert.deepEqual([a.lat, a.location_accuracy_m], [18.0251, 30]);
  });

  test('the driver\'s pin at the gate replaces an approximate one', async () => {
    const stop = await f.db.one<{ id: string }>(`SELECT id FROM delivery_stops WHERE customer_id = $1`, [ids['Devon Clarke']]);
    await setStopPin(f.db, f.driver, stop.id, { lat: 18.0105, lng: -76.9711, accuracyM: 6 });
    assert.equal((await pin(ids['Devon Clarke'])).location_source, 'Driver');
  });

  test('everyone at once from Settings, within the daily ceiling', async () => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-key';
    for (let i = 0; i < 3; i++) {
      await f.db.query(`INSERT INTO customers (name, phone, email, address_line1, city, parish) VALUES ($1, $2, '', $3, 'Kingston', '')`,
        [`Extra ${i}`, `87655520${i}`, `${i} Nowhere Lane`]);
    }
    const before = await pinCounts(f.db);
    assert.equal(before.enabled, true);
    await assert.rejects(approximatePinsForAll(f.db, f.office), /requires role admin/);
    process.env.GEOCODE_DAILY_LIMIT = '2';
    const r = await approximatePinsForAll(f.db, f.admin);
    assert.equal(r.placed + r.notFound, 2);
    assert.match(r.stopped ?? '', /allowance/);
    assert.ok(r.left >= 1);
  });

  test('a key without the Geocoding API says so', async () => {
    process.env.GOOGLE_MAPS_API_KEY = 'denied';
    const r = await approximatePinsForAll(f.db, f.admin);
    assert.match(r.stopped ?? '', /Geocoding API/);
    assert.equal(r.placed, 0);
  });
});
