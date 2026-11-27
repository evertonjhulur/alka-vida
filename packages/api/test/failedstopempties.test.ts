/**
 * Failed stops and empties (Everton, 27 Nov 2026): "stops failed but empties
 * marked collected". The driver's empties box was pre-filled for a delivery
 * and sent with Not home / Refused / Another day. Bottles only change hands on
 * a delivery, so a stop that did not happen records none, the round's totals
 * count delivered stops only, and an old listing can be cleared without
 * moving any stock.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { createOrder } from '../src/services/orders.ts';
import { markStop } from '../src/services/delivery.ts';
import { getSettlementReview, correctStopRecord } from '../src/services/settlement.ts';
import { businessToday } from '../src/services/core.ts';
import { addDays } from '@alka/shared';

let f: Fixture;
before(async () => { f = await setupFixture(); });
after(async () => { await f.close(); });

const fiveGal = async (day: string, customerId = f.customerId) => {
  const o = await createOrder(f.db, f.office, { customerId, deliveryMode: 'Delivery', requestedDeliveryDate: day,
    lines: [{ productId: f.fiveGalProductId, looseBottles: 3 }] });
  return f.db.one<{ id: string; sheet: string }>(
    `SELECT id, delivery_sheet_id AS sheet FROM delivery_stops WHERE order_id = $1`, [o.id]);
};
const jugs = async () => Number((await f.db.one<{ q: number }>(
  `SELECT quantity_on_hand AS q FROM raw_materials WHERE id = $1`, [f.jugMaterialId])).q);

describe('Empties on a stop that did not happen', () => {
  test('not home, refused or another day record no empties, whatever was sent', async () => {
    const day = addDays(businessToday(), 5);
    const a = await fiveGal(day);
    const b = await fiveGal(day, f.otherCustomerId);
    await markStop(f.db, f.driver, { stopId: a.id, outcome: 'Customer Not Home',
      bottlesDeliveredFull: 3, bottlesEmptiesPickedUp: 3 } as never);
    await markStop(f.db, f.driver, { stopId: b.id, outcome: 'Delivered', bottlesDeliveredFull: 3, bottlesEmptiesPickedUp: 2 } as never);
    const row = await f.db.one<{ e: number; d: number }>(
      `SELECT bottles_empties_picked_up AS e, bottles_delivered_full AS d FROM delivery_stops WHERE id = $1`, [a.id]);
    assert.equal(Number(row.e), 0);
    assert.equal(Number(row.d), 0);
    assert.equal((await getSettlementReview(f.db, a.sheet)).bottles.emptiesFromStops, 0);
    assert.equal((await getSettlementReview(f.db, b.sheet)).bottles.emptiesFromStops, 2);
  });

  test('an old listing is left out of the totals and can be cleared without moving stock', async () => {
    const day = addDays(businessToday(), 6);
    const a = await fiveGal(day);
    await markStop(f.db, f.driver, { stopId: a.id, outcome: 'Refused' } as never);
    // As on live data before this fix.
    await f.db.query(`UPDATE delivery_stops SET bottles_empties_picked_up = 4 WHERE id = $1`, [a.id]);
    assert.equal((await getSettlementReview(f.db, a.sheet)).bottles.emptiesFromStops, 0);

    await assert.rejects(correctStopRecord(f.db, f.admin, a.id, { bottlesEmptiesPickedUp: 2 }, 'driver says 2'),
      /not delivered/);
    const before_ = await jugs();
    await correctStopRecord(f.db, f.admin, a.id, { bottlesEmptiesPickedUp: 0 }, 'pre-filled, nothing collected');
    assert.equal(await jugs(), before_, 'nothing came off the empties at the plant');
    const row = await f.db.one<{ e: number }>(`SELECT bottles_empties_picked_up AS e FROM delivery_stops WHERE id = $1`, [a.id]);
    assert.equal(Number(row.e), 0);
  });
});
