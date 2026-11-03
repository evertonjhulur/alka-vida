/** Sell jugs outright from the customer's Bottles tab (3 Nov 2026). */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, stopsOf, type Fixture } from './helpers.ts';
import { createOrder } from '../src/services/orders.ts';
import { markStop } from '../src/services/delivery.ts';
import { bottleAccount, poolFigures } from '../src/services/bottles.ts';
import { sellJugs } from '../src/services/jugsales.ts';
import { getInvoiceLedger } from '../src/services/invoices.ts';
import { undoDelivery } from '../src/services/undodelivery.ts';
import { businessToday } from '../src/services/core.ts';

let f: Fixture;
before(async () => {
  f = await setupFixture();
  // Price the bottle as the live app does: J$1,304.35 + GCT.
  await f.db.query(`INSERT INTO products (name, size, bottles_per_case, price_per_case_cents,
                      price_per_bottle_cents, is_returnable, is_bottle_charge)
                    VALUES ('5-gallon bottle', '5gal', 0, 0, 130435, false, true)`);
  await f.db.query(`INSERT INTO finished_goods_stock (product_id, quantity_on_hand) VALUES ($1, 100)`, [f.fiveGalProductId]);
});
after(async () => { await f.close(); });

const empties = async () => Number((await f.db.one<{ q: string }>(
  `SELECT quantity_on_hand q FROM raw_materials WHERE id = $1`, [f.jugMaterialId])).q);

describe('Sell jugs', () => {
  test('a customer keeping 2 of our jugs buys them: invoiced, theirs, nothing from the plant', async () => {
    // Two full out, no empties back: 2 of ours with them.
    const o = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Delivery', requestedDeliveryDate: '2026-11-02',
      lines: [{ productId: f.fiveGalProductId, looseBottles: 2 }],
    });
    const [stop] = await stopsOf(f.db, o.deliverySheetId!);
    await markStop(f.db, f.driver, { stopId: stop.id, outcome: 'Delivered', bottlesDeliveredFull: 2, bottlesEmptiesPickedUp: 0 });
    assert.equal((await bottleAccount(f.db, f.customerId)).closingHolding, 2);

    const e0 = await empties();
    const r = await sellJugs(f.db, f.office, f.customerId, { quantity: 2 });
    assert.equal(r.fromHolding, 2);
    assert.equal(r.fromPlant, 0);
    assert.ok(r.invoiceId, 'invoiced now');
    const inv = await getInvoiceLedger(f.db, r.invoiceId!);
    assert.equal(inv!.grandTotalCents, Math.round(2 * 130435 * 1.15));
    const acc = await bottleAccount(f.db, f.customerId);
    assert.equal(acc.closingHolding, 0, 'none of ours with them now');
    assert.equal(acc.sold, 2, 'shown as bought (theirs)');
    assert.equal(await empties(), e0, 'the empties do not move');
    const order = await f.db.one<{ recorded_late: boolean }>(`SELECT recorded_late FROM customer_orders WHERE id = $1`, [r.orderId]);
    assert.equal(order.recorded_late, false, 'a sale for today is not recorded late');
  });

  test('extra jugs beyond what they hold come off the empties; ours with them never goes below zero', async () => {
    const e0 = await empties();
    const r = await sellJugs(f.db, f.office, f.otherCustomerId, { quantity: 3, amountPaidCents: Math.round(3 * 130435 * 1.15), method: 'Cash' });
    assert.equal(r.fromHolding, 0);
    assert.equal(r.fromPlant, 3);
    assert.equal(await empties(), e0 - 3);
    const acc = await bottleAccount(f.db, f.otherCustomerId);
    assert.equal(acc.closingHolding, 0);
    assert.equal(acc.sold, 3);
    assert.equal(r.balanceCents, 0, 'paid in full');
    const fig = await poolFigures(f.db);
    assert.ok(fig.withCustomers >= 0);
  });

  test('undo puts the jugs from the plant back into the empties', async () => {
    const e0 = await empties();
    const r = await sellJugs(f.db, f.office, f.otherCustomerId, { quantity: 2 });
    assert.equal(await empties(), e0 - 2);
    await undoDelivery(f.db, f.admin, r.orderId, { reason: 'sold in error' });
    assert.equal(await empties(), e0);
    assert.equal((await bottleAccount(f.db, f.otherCustomerId)).sold, 3, 'only the earlier sale stands');
  });

  test('an earlier day follows the New sale rule; nothing, or the future, is refused', async () => {
    await assert.rejects(sellJugs(f.db, f.office, f.customerId, { quantity: 0 }), /how many jugs/);
    await assert.rejects(sellJugs(f.db, f.office, f.customerId, { quantity: 1, soldOn: '2999-01-01' }), /not happened yet/);
    await assert.rejects(sellJugs(f.db, f.office, f.customerId, { quantity: 1, soldOn: '2026-01-05' }), /up to \d+ day/);
    const r = await sellJugs(f.db, f.admin, f.customerId, { quantity: 1, soldOn: '2026-11-02' });
    assert.equal(r.soldOn, '2026-11-02');
    const moved = await f.db.one<{ d: string }>(`SELECT moved_on::text d FROM customer_bottle_moves WHERE order_id = $1 LIMIT 1`, [r.orderId]);
    assert.equal(moved.d, '2026-11-02', 'the jugs changed hands that day');
    assert.ok(businessToday() >= '2026-11-02');
  });
});
