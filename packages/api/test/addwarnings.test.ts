/**
 * Warnings before an order is added to a round by hand (Everton, 19 Nov 2026).
 * On 18 Nov next Tuesday's standing order for 360 Degrees went on Wednesday's
 * round to carry 2 cases left over from Tuesday, so the whole order was
 * delivered and invoiced twice and 24 Nov was left with no order.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { createOrder } from '../src/services/orders.ts';
import { addOrderToSheet, addOrderWarnings, markStop } from '../src/services/delivery.ts';
import { businessToday } from '../src/services/core.ts';
import { addDays } from '@alka/shared';

let f: Fixture;
before(async () => {
  f = await setupFixture();
  await f.db.query(`INSERT INTO finished_goods_stock (product_id, quantity_on_hand) VALUES ($1, 2400), ($2, 2400)
                    ON CONFLICT (product_id) DO UPDATE SET quantity_on_hand = 2400`, [f.casedProductId, f.fiveGalProductId]);
});
after(async () => { await f.close(); });

const sameLines = () => [{ productId: f.casedProductId, cases: 2 }, { productId: f.fiveGalProductId, looseBottles: 4 }];
const sheetOf = async (orderId: string) => (await f.db.one<{ s: string }>(
  `SELECT delivery_sheet_id AS s FROM delivery_stops WHERE order_id = $1`, [orderId])).s;
const order = (day: string, l = sameLines(), noRound = false) => createOrder(f.db, f.office, {
  customerId: f.customerId, deliveryMode: 'Delivery', requestedDeliveryDate: day, noRound, lines: l,
} as never);

describe('Adding an order to a round by hand', () => {
  test('the 360 Degrees case: next week\'s standing order on the next day\'s round, same items just delivered', async () => {
    const tue = addDays(businessToday(), 1);
    const wed = addDays(tue, 1);
    const nextTue = addDays(tue, 7);
    // Tuesday's order, delivered in full.
    const first = await order(tue);
    const stop = await f.db.one<{ id: string }>(`SELECT id FROM delivery_stops WHERE order_id = $1`, [first.id]);
    await markStop(f.db, f.driver, { stopId: stop.id, outcome: 'Delivered' } as never);
    // Wednesday's round, and next Tuesday's run of the standing order.
    const other = await order(wed, [{ productId: f.fiveGalProductId, looseBottles: 1 }]);
    const wedSheet = await sheetOf(other.id);
    const run = await order(nextTue, sameLines(), true);
    await f.db.query(`UPDATE customer_orders SET parent_recurring_id = $2 WHERE id = $1`, [run.id, first.id]);

    const w = await addOrderWarnings(f.db, wedSheet, run.id);
    assert.equal(w.length, 2);
    assert.match(w[0], /standing order due .* no order for/);
    assert.match(w[1], /already had the same items .* delivered on/);
    assert.match(w[1], new RegExp(first.orderNumber));

    await assert.rejects(addOrderToSheet(f.db, f.office, wedSheet, run.id), /confirm on the round page/);
    const none = await f.db.maybeOne(`SELECT 1 FROM delivery_stops WHERE order_id = $1`, [run.id]);
    assert.equal(none, null, 'not added without confirming');

    const r = await addOrderToSheet(f.db, f.office, wedSheet, run.id, { confirmed: true });
    assert.equal(r.warnings.length, 2);
    const a = await f.db.one<{ details: { warningsOverridden?: string[] } }>(
      `SELECT details FROM audit_log WHERE entity_id = $1 AND details->>'addedOrderId' = $2`, [wedSheet, run.id]);
    assert.equal(a.details.warningsOverridden?.length, 2, 'the override is on the audit log');
  });

  test('an order for the round\'s own day with different items adds with no warning', async () => {
    const day = addDays(businessToday(), 20);
    const other = await order(day, [{ productId: f.fiveGalProductId, looseBottles: 1 }]);
    const sheet = await sheetOf(other.id);
    const mine = await order(day, [{ productId: f.casedProductId, cases: 5 }], true);
    assert.deepEqual(await addOrderWarnings(f.db, sheet, mine.id), []);
    const r = await addOrderToSheet(f.db, f.office, sheet, mine.id);
    assert.ok(r.stopId);
  });

  test('an ordinary order booked later gets the lighter wording', async () => {
    const day = addDays(businessToday(), 30);
    const other = await order(day, [{ productId: f.fiveGalProductId, looseBottles: 1 }]);
    const sheet = await sheetOf(other.id);
    const later = await order(addDays(day, 3), [{ productId: f.casedProductId, cases: 7 }], true);
    const w = await addOrderWarnings(f.db, sheet, later.id);
    assert.equal(w.length, 1);
    assert.match(w[0], /booked for .* later than this round/);
  });

  test('the same items already waiting on a nearby round are flagged', async () => {
    const day = addDays(businessToday(), 40);
    const first = await order(day, [{ productId: f.casedProductId, cases: 3 }]);
    const sheet = await sheetOf(first.id);
    const twice = await order(day, [{ productId: f.casedProductId, cases: 3 }], true);
    const w = await addOrderWarnings(f.db, sheet, twice.id);
    assert.equal(w.length, 1);
    assert.match(w[0], /already has the same items .* on the round for/);
  });
});
