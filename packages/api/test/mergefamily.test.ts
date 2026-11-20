/**
 * Merging one person's account under the account of whoever pays (Everton,
 * 20 Nov 2026): "merge Rose Green under Maureen Williams/Rose Green. Rose
 * Green is the mother of Maureen but Maureen pays the bill. the two addresses
 * will be listed on the account and delivery sent separately".
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { createOrder, deliveryDaysFor } from '../src/services/orders.ts';
import { mergeCustomers } from '../src/services/customers.ts';
import { bottleAccount, setOpeningBottles } from '../src/services/bottles.ts';

let f: Fixture;
let maureen: string; let rose: string;

before(async () => {
  f = await setupFixture();
  await f.db.query(`INSERT INTO delivery_zones (name, run_days) VALUES ('Kingston', '{Tue}'), ('Portmore', '{Thu}')
                    ON CONFLICT (name) DO UPDATE SET run_days = EXCLUDED.run_days`);
  maureen = (await f.db.one<{ id: string }>(
    `INSERT INTO customers (name, email, phone, delivery_address, delivery_zone, route_sequence, price_tier_id)
     VALUES ('Maureen Williams/Rose Green', 'maureen@example.jm', '8765550001', '4 Oak Lane, Kingston 8', 'Kingston', 5, $1)
     RETURNING id`, [f.tierId])).id;
  rose = (await f.db.one<{ id: string }>(
    `INSERT INTO customers (name, email, phone, address_line1, city, parish, delivery_address, delivery_zone,
                            route_sequence, delivery_instructions, lat, lng, location_source, price_tier_id)
     VALUES ('Rose Green', 'rose@example.jm', '8765550002', '9 Palm Drive', 'Portmore', 'St. Catherine',
             '9 Palm Drive, Portmore, St. Catherine', 'Portmore', 12, 'Blue gate', 17.95, -76.88, 'Driver', $1)
     RETURNING id`, [f.tierId])).id;
  await setOpeningBottles(f.db, f.admin, maureen, { quantity: 2, asOf: '2026-10-23', reason: 'sheet' });
  await setOpeningBottles(f.db, f.admin, rose, { quantity: 3, asOf: '2026-10-23', reason: 'sheet' });
});
after(async () => { await f.close(); });

describe('Merging Rose Green into Maureen Williams/Rose Green', () => {
  let roseOrder: string;

  test('office staff cannot merge', async () => {
    await assert.rejects(mergeCustomers(f.db, f.office, { survivorId: maureen, mergedId: rose }));
  });

  test("Rose's address, bottles and orders come across; her deliveries keep her own door and round", async () => {
    roseOrder = (await createOrder(f.db, f.office, {
      customerId: rose, deliveryMode: 'Delivery',
      lines: [{ productId: f.fiveGalProductId, looseBottles: 2 }],
    })).id;

    const r = await mergeCustomers(f.db, f.admin, { survivorId: maureen, mergedId: rose, reason: 'Maureen pays' });
    assert.ok(r.addressId);
    assert.equal(r.moved.orders_to_their_address, 1);
    assert.equal(r.moved.opening_bottles_added, 3);

    const addr = await f.db.one<Record<string, unknown>>(
      `SELECT * FROM customer_addresses WHERE id = $1`, [r.addressId]);
    assert.equal(addr.customer_id, maureen);
    assert.equal(addr.label, 'Rose Green');
    assert.equal(addr.address_line1, '9 Palm Drive');
    assert.equal(addr.city, 'Portmore');
    assert.equal(addr.delivery_zone, 'Portmore');
    assert.equal(addr.phone, '8765550002');
    assert.equal(addr.delivery_instructions, 'Blue gate');
    assert.equal(addr.is_delivery, true);
    assert.equal(addr.is_billing, false);
    assert.equal(Number(addr.lat), 17.95);

    const o = await f.db.one<{ customer_id: string; address_id: string }>(
      `SELECT customer_id, address_id FROM customer_orders WHERE id = $1`, [roseOrder]);
    assert.equal(o.customer_id, maureen);
    assert.equal(o.address_id, r.addressId);
    const stops = await f.db.query<{ customer_id: string }>(
      `SELECT customer_id FROM delivery_stops WHERE order_id = $1`, [roseOrder]);
    for (const s of stops) assert.equal(s.customer_id, maureen);

    // Rose's address follows the Portmore round's days; Maureen's own stays Kingston's.
    assert.deepEqual(await deliveryDaysFor(f.db, maureen, r.addressId), ['Thu']);
    assert.deepEqual(await deliveryDaysFor(f.db, maureen, null), ['Tue']);

    // One opening balance holding both: 2 + 3.
    const openings = await f.db.query(`SELECT id FROM customer_bottle_moves WHERE customer_id = $1 AND opening`, [maureen]);
    assert.equal(openings.length, 1);
    assert.equal((await bottleAccount(f.db, maureen)).closingHolding, 5);
    assert.equal((await bottleAccount(f.db, rose)).closingHolding, 0);

    const gone = await f.db.one<{ active: boolean; merged_into_id: string }>(
      `SELECT active, merged_into_id FROM customers WHERE id = $1`, [rose]);
    assert.equal(gone.active, false);
    assert.equal(gone.merged_into_id, maureen);
  });

  test('a customer already merged cannot be merged again', async () => {
    await assert.rejects(mergeCustomers(f.db, f.admin, { survivorId: f.customerId, mergedId: rose }), /already been merged/);
  });

  test('a true duplicate can be merged without keeping its address', async () => {
    const dupe = (await f.db.one<{ id: string }>(
      `INSERT INTO customers (name, email, phone, delivery_address, delivery_zone) VALUES ('Maureen W', 'mw@example.jm', '8765550003', '4 Oak Lane', 'Kingston')
       RETURNING id`)).id;
    const r = await mergeCustomers(f.db, f.admin, { survivorId: maureen, mergedId: dupe, keepAddress: false });
    assert.equal(r.addressId, null);
    const n = await f.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM customer_addresses WHERE customer_id = $1`, [maureen]);
    assert.equal(n.n, 1, 'only Rose Green\'s address');
  });
});
