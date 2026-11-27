/**
 * Delivered short, nothing more to come (Everton, 27 Nov 2026): Imperial
 * Optical's order was delivered short on the round and, instead of being
 * closed and invoiced for what went, it asked for another round.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { createOrder, closeShort } from '../src/services/orders.ts';
import { markStop } from '../src/services/delivery.ts';
import { requestStopCorrection } from '../src/services/settlement.ts';
import { noRound } from '../src/services/noround.ts';
import { businessToday } from '../src/services/core.ts';
import { addDays } from '@alka/shared';

let f: Fixture;
before(async () => {
  f = await setupFixture();
  await f.db.query(`INSERT INTO finished_goods_stock (product_id, quantity_on_hand) VALUES ($1, 2400), ($2, 2400)
                    ON CONFLICT (product_id) DO UPDATE SET quantity_on_hand = 2400`, [f.casedProductId, f.fiveGalProductId]);
  await f.db.query(`UPDATE system_settings SET value = '2000-01-01' WHERE key = 'no_round_from'`);
});
after(async () => { await f.close(); });

async function order(day: string) {
  const o = await createOrder(f.db, f.office, {
    customerId: f.customerId, deliveryMode: 'Delivery', requestedDeliveryDate: day,
    lines: [{ productId: f.casedProductId, cases: 5 }],
  } as never);
  const stop = await f.db.one<{ id: string }>(`SELECT id FROM delivery_stops WHERE order_id = $1`, [o.id]);
  const line = await f.db.one<{ id: string }>(`SELECT id FROM order_line_items WHERE order_id = $1`, [o.id]);
  return { o, stopId: stop.id, lineId: line.id };
}
const status = async (id: string) => (await f.db.one<{ status: string; closed_short_at: string | null }>(
  `SELECT status, closed_short_at FROM customer_orders WHERE id = $1`, [id]));
const waitingStops = async (id: string) => Number((await f.db.one<{ n: number }>(
  `SELECT COUNT(*)::int AS n FROM delivery_stops WHERE order_id = $1 AND stop_outcome = 'Pending'`, [id])).n);

describe('Delivered short, nothing more to come', () => {
  test('the driver\'s "they took less" closes the order, invoiced for what went', async () => {
    const d = await order(addDays(businessToday(), 1));
    const r = await markStop(f.db, f.driver, { stopId: d.stopId, outcome: 'Delivered',
      deliveredLines: [{ orderLineId: d.lineId, cases: 3, looseBottles: 0 }] } as never);
    assert.equal(r.orderStatus, 'Delivered');
    const s = await status(d.o.id);
    assert.equal(s.status, 'Delivered');
    assert.ok(s.closed_short_at);
    const inv = await f.db.one<{ g: number }>(`SELECT grand_total_cents AS g FROM invoices WHERE id = $1`, [r.invoiceId]);
    assert.equal(Number(inv.g), 3 * 138000, 'three cases at their J$1,200 + GCT');
    assert.equal((await noRound(f.db)).orders.some((x) => x.id === d.o.id), false, 'no round wanted for the rest');
  });

  test('the rest sent to another day can still be closed from Orders, coming off its round', async () => {
    const day = addDays(businessToday(), 2);
    const d = await order(day);
    await markStop(f.db, f.driver, { stopId: d.stopId, outcome: 'Delivered', remainderTo: addDays(day, 1),
      deliveredLines: [{ orderLineId: d.lineId, cases: 2, looseBottles: 0 }] } as never);
    assert.equal((await status(d.o.id)).status, 'Partially Delivered');
    assert.equal(await waitingStops(d.o.id), 1);
    const r = await closeShort(f.db, f.office, d.o.id);
    assert.equal(r.status, 'Delivered');
    assert.equal(r.stopsRemoved, 1);
    assert.equal(await waitingStops(d.o.id), 0);
    await assert.rejects(closeShort(f.db, f.office, d.o.id), /delivered/);
  });

  test('or when the office corrects the stop at settlement', async () => {
    const d = await order(addDays(businessToday(), 4));
    await markStop(f.db, f.driver, { stopId: d.stopId, outcome: 'Delivered' } as never);
    await requestStopCorrection(f.db, f.office, d.stopId, {
      deliveredLines: [{ orderLineId: d.lineId, cases: 4, looseBottles: 0 }], closeShort: true,
    }, 'only 4 cases went; they do not want the fifth');
    assert.equal((await status(d.o.id)).status, 'Delivered');
    assert.equal(await waitingStops(d.o.id), 0);
  });
});
