/**
 * Opening balances of our 5-gallon bottles with customers (Everton, 28 Oct
 * 2026): "I now need to update bottles owned by us on the customer accounts."
 * Uploaded from the bottle-ownership workbook, or set on a customer's
 * Bottles tab. They count towards what the customer holds of ours, are never
 * shown as deliveries, and do not move the pool's own totals.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, stopsOf, type Fixture } from './helpers.ts';
import { createOrder } from '../src/services/orders.ts';
import { markStop } from '../src/services/delivery.ts';
import {
  listPools, customerHoldings, bottleAccount, uploadOpeningBottles, setOpeningBottles,
} from '../src/services/bottles.ts';
import { describeAuditRows } from '../src/services/auditwords.ts';

let f: Fixture;
before(async () => { f = await setupFixture(); });
after(async () => { await f.close(); });

const AS_OF = '2026-10-23';

async function deliver(date: string, full: number, back: number, customerId?: string) {
  const order = await createOrder(f.db, f.office, {
    customerId: customerId ?? f.customerId, deliveryMode: 'Delivery', requestedDeliveryDate: date,
    lines: [{ productId: f.fiveGalProductId, looseBottles: full }],
  });
  const [stop] = await stopsOf(f.db, order.deliverySheetId!);
  return markStop(f.db, f.driver, {
    stopId: stop.id, outcome: 'Delivered', bottlesDeliveredFull: full, bottlesEmptiesPickedUp: back, bottlesLostDamaged: 0,
  });
}

const holdingOf = async (id: string) =>
  (await customerHoldings(f.db) as Array<Record<string, unknown>>).find((h) => h.customer_id === id);

describe('Uploading opening balances', () => {
  test('checked first: unknown names, bad counts and repeats are shown and nothing is written', async () => {
    const r = await uploadOpeningBottles(f.db, f.admin, {
      asOf: AS_OF, dryRun: true,
      rows: [
        { customer: '  blue mountain   OFFICES ', quantity: 5 },
        { customer: 'Nobody Ltd', quantity: 2 },
        { customer: 'Portmore Pharmacy', quantity: '1.5' },
        { customer: 'Blue Mountain Offices', quantity: 3 },
      ],
    });
    assert.equal(r.dryRun, true);
    assert.equal(r.rows[0].action, 'set');
    assert.equal(r.rows[0].matchedName, 'Blue Mountain Offices');
    assert.match(r.rows[1].errors.join(), /no customer with this name/);
    assert.match(r.rows[2].errors.join(), /whole number/);
    assert.match(r.rows[3].errors.join(), /in the file twice/);
    assert.equal(r.withErrors, 3);
    const moves = await f.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM customer_bottle_moves WHERE opening`);
    assert.equal(moves.n, 0);
    await assert.rejects(
      uploadOpeningBottles(f.db, f.admin, { asOf: AS_OF, dryRun: false, rows: [{ customer: 'Nobody Ltd', quantity: 2 }] }),
      /nothing was brought in/);
  });

  test('office staff cannot upload; a future date is refused', async () => {
    await assert.rejects(uploadOpeningBottles(f.db, f.office, { asOf: AS_OF, rows: [{ customer: 'Portmore Pharmacy', quantity: 1 }] }));
    await assert.rejects(uploadOpeningBottles(f.db, f.admin, { asOf: '2999-01-01', rows: [{ customer: 'Portmore Pharmacy', quantity: 1 }] }), /future/);
  });

  test('brought in: counts towards what they hold of ours, not as a delivery, and the pool is not moved', async () => {
    const poolBefore = (await listPools(f.db))[0];
    const r = await uploadOpeningBottles(f.db, f.admin, {
      asOf: AS_OF, dryRun: false,
      rows: [{ customer: 'Blue Mountain Offices', quantity: 5 }, { customer: 'Portmore Pharmacy', quantity: 2 }],
    });
    assert.equal(r.done, 2);
    assert.equal(r.bottles, 7);
    const h = await holdingOf(f.customerId);
    assert.equal(Number(h?.opening), 5);
    assert.equal(Number(h?.delivered), 0, 'the opening balance is not a delivery');
    assert.equal(Number(h?.holding), 5);
    const poolAfter = (await listPools(f.db))[0];
    assert.deepEqual(poolAfter, poolBefore, 'the pool totals do not move');
  });

  test('later deliveries add to it, empties come off it', async () => {
    await deliver('2027-01-04', 3, 4);
    const h = await holdingOf(f.customerId);
    assert.equal(Number(h?.holding), 5 + 3 - 4);
    assert.equal(Number(h?.delivered), 3);
  });

  test('the statement brings it forward as held at the start', async () => {
    const oct = await bottleAccount(f.db, f.customerId, { from: '2026-10-01', to: '2026-10-31' });
    assert.equal(oct.openingHolding, 5, 'dated inside the window: brought forward, not delivered');
    assert.equal(oct.delivered, 0);
    assert.equal(oct.closingHolding, 5);
    const jan = await bottleAccount(f.db, f.customerId, { from: '2027-01-01', to: '2027-01-31' });
    assert.equal(jan.openingHolding, 5);
    assert.equal(jan.delivered, 3);
    assert.equal(jan.closingHolding, 4);
    const sep = await bottleAccount(f.db, f.customerId, { from: '2026-09-01', to: '2026-09-30' });
    assert.equal(sep.openingHolding, 0, 'a period before the opening date does not see it');
    assert.equal(sep.closingHolding, 0);
    const all = await bottleAccount(f.db, f.customerId);
    assert.deepEqual(all.openingEntered, { quantity: 5, asOf: AS_OF });
    assert.equal(all.closingHolding, 4);
  });

  test('uploading again replaces it; 0 removes it; an unchanged row is left alone', async () => {
    const audits = async () => (await f.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE details ? 'openingBottlesNow'`)).n;
    const before = await audits();
    const check = await uploadOpeningBottles(f.db, f.admin, {
      asOf: AS_OF, dryRun: true,
      rows: [{ customer: 'Blue Mountain Offices', quantity: 6 }, { customer: 'Portmore Pharmacy', quantity: 2 }],
    });
    assert.deepEqual(check.rows.map((r) => r.action), ['change', 'same']);
    await uploadOpeningBottles(f.db, f.admin, {
      asOf: AS_OF, dryRun: false,
      rows: [{ customer: 'Blue Mountain Offices', quantity: 6 }, { customer: 'Portmore Pharmacy', quantity: 2 }],
    });
    assert.equal(await audits(), before + 1, 'only the change is logged');
    assert.equal(Number((await holdingOf(f.customerId))?.holding), 6 + 3 - 4);
    const n = await f.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM customer_bottle_moves WHERE opening AND customer_id = $1`, [f.customerId]);
    assert.equal(n.n, 1, 'still one opening row');
    await uploadOpeningBottles(f.db, f.admin, { asOf: AS_OF, dryRun: false, rows: [{ customer: 'Portmore Pharmacy', quantity: 0 }] });
    assert.equal(await holdingOf(f.otherCustomerId), undefined, 'nothing left for them');
  });
});

describe('Setting one customer\'s opening balance', () => {
  test('administrators only, with a reason and a whole number', async () => {
    await assert.rejects(setOpeningBottles(f.db, f.office, f.otherCustomerId, { quantity: 2, asOf: AS_OF, reason: 'x' }));
    await assert.rejects(setOpeningBottles(f.db, f.admin, f.otherCustomerId, { quantity: 2, asOf: AS_OF, reason: ' ' }), /reason/);
    await assert.rejects(setOpeningBottles(f.db, f.admin, f.otherCustomerId, { quantity: -1, asOf: AS_OF, reason: 'x' }), /whole number/);
  });

  test('sets it, and the audit log says so in words', async () => {
    const r = await setOpeningBottles(f.db, f.admin, f.otherCustomerId, { quantity: 3, asOf: AS_OF, reason: 'Counted with the driver' });
    assert.equal(r.was, 0);
    assert.equal(r.now, 3);
    assert.equal(Number((await holdingOf(f.otherCustomerId))?.holding), 3);
    const rows = await f.db.query<Record<string, unknown>>(
      `SELECT * FROM audit_log WHERE entity_id = $1 AND details ? 'openingBottlesNow' ORDER BY ts DESC LIMIT 1`, [f.otherCustomerId]);
    const [d] = await describeAuditRows(f.db, rows as never);
    assert.match(d.summary, /Opening 5-gallon balance for Portmore Pharmacy: 3 of our bottles as at/);
    assert.match(d.summary, /Counted with the driver/);
  });
});
