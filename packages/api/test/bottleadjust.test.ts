/**
 * A customer's 5-gallon bottle movement history and balance adjustments
 * (Everton, 20 Nov 2026): "Can I see the bottle movement per client under
 * their bottle details? also ability to edit their bottle balance if needs be?"
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, stopsOf, type Fixture } from './helpers.ts';
import { createOrder } from '../src/services/orders.ts';
import { markStop } from '../src/services/delivery.ts';
import {
  poolFigures, customerHoldings, bottleAccount, bottleMoves, setOpeningBottles,
  adjustBottleBalance, removeBottleAdjustment,
} from '../src/services/bottles.ts';
import { businessToday } from '../src/services/core.ts';

let f: Fixture;
before(async () => { f = await setupFixture(); });
after(async () => { await f.close(); });

async function deliver(date: string, full: number, back: number) {
  const order = await createOrder(f.db, f.office, {
    customerId: f.customerId, deliveryMode: 'Delivery', requestedDeliveryDate: date,
    lines: [{ productId: f.fiveGalProductId, looseBottles: full }],
  });
  const [stop] = await stopsOf(f.db, order.deliverySheetId!);
  return markStop(f.db, f.driver, {
    stopId: stop.id, outcome: 'Delivered', bottlesDeliveredFull: full, bottlesEmptiesPickedUp: back, bottlesLostDamaged: 0,
  });
}

describe('Bottle movement history and adjustments', () => {
  const today = businessToday();

  test('history lists every line, oldest first, with a running balance', async () => {
    await setOpeningBottles(f.db, f.admin, f.customerId, { quantity: 4, asOf: '2026-10-23', reason: 'delivery sheet' });
    await deliver(today, 3, 2);
    const moves = await bottleMoves(f.db, f.customerId);
    assert.equal(moves.length, 2);
    assert.equal(moves[0].kind, 'Opening');
    assert.equal(moves[0].balance, 4);
    assert.equal(moves[1].kind, 'Delivery');
    assert.equal(moves[1].delivered, 3);
    assert.equal(moves[1].returned, 2);
    assert.equal(moves[1].change, 1);
    assert.equal(moves[1].balance, 5);
    assert.equal((await bottleAccount(f.db, f.customerId)).closingHolding, 5);
  });

  test('office staff cannot adjust; a reason and a whole number are needed', async () => {
    await assert.rejects(adjustBottleBalance(f.db, f.office, f.customerId, { holding: 2, reason: 'count' }));
    await assert.rejects(adjustBottleBalance(f.db, f.admin, f.customerId, { holding: 2 }), /reason/);
    await assert.rejects(adjustBottleBalance(f.db, f.admin, f.customerId, { holding: '1.5', reason: 'x' }), /whole number/);
    await assert.rejects(adjustBottleBalance(f.db, f.admin, f.customerId, { holding: 2, reason: 'x', asOf: '2999-01-01' }), /future/);
  });

  test('an adjustment sets the balance everywhere, without moving the empties or the delivery figures', async () => {
    const poolBefore = await poolFigures(f.db);
    const r = await adjustBottleBalance(f.db, f.admin, f.customerId, { holding: 2, reason: 'Counted at their office' });
    assert.deepEqual([r.was, r.now, r.change], [5, 2, -3]);
    const acc = await bottleAccount(f.db, f.customerId);
    assert.equal(acc.closingHolding, 2);
    assert.equal(acc.adjusted, -3);
    assert.equal(acc.delivered, 3, 'deliveries are untouched');
    const h = (await customerHoldings(f.db) as Array<Record<string, unknown>>).find((x) => x.customer_id === f.customerId);
    assert.equal(Number(h?.holding), 2);
    const poolAfter = await poolFigures(f.db);
    assert.equal(poolAfter.empties, poolBefore.empties, 'empties at the plant do not move');
    assert.equal(poolAfter.withCustomers, poolBefore.withCustomers - 3);
    const moves = await bottleMoves(f.db, f.customerId);
    const last = moves[moves.length - 1];
    assert.equal(last.kind, 'Adjustment');
    assert.equal(last.change, -3);
    assert.equal(last.balance, 2);
    assert.equal(last.detail, 'Counted at their office');
    assert.ok(last.by);
    // Same figure again: nothing recorded.
    const again = await adjustBottleBalance(f.db, f.admin, f.customerId, { holding: 2, reason: 'again' });
    assert.equal(again.change, 0);
    assert.equal((await bottleMoves(f.db, f.customerId)).length, moves.length);
  });

  test('an adjustment entered in error can be removed by an administrator', async () => {
    const adj = (await bottleMoves(f.db, f.customerId)).find((m) => m.kind === 'Adjustment')!;
    await assert.rejects(removeBottleAdjustment(f.db, f.office, f.customerId, adj.id));
    const opening = (await bottleMoves(f.db, f.customerId)).find((m) => m.kind === 'Opening')!;
    await assert.rejects(removeBottleAdjustment(f.db, f.admin, f.customerId, opening.id), /not a balance adjustment/);
    const r = await removeBottleAdjustment(f.db, f.admin, f.customerId, adj.id, { reason: 'wrong customer' });
    assert.equal(r.removed, -3);
    assert.equal((await bottleAccount(f.db, f.customerId)).closingHolding, 5);
    const logged = await f.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = 'delete'`, [f.customerId]);
    assert.ok(logged.n >= 1);
  });
});
