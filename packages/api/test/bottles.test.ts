/** The 5-gallon returnable bottle exchange pool, end to end. */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, stopsOf, type Fixture } from './helpers.ts';
import { createOrder } from '../src/services/orders.ts';
import { markStop } from '../src/services/delivery.ts';
import { getInvoiceLedger } from '../src/services/invoices.ts';
import {
  listPools, washBottles, adjustPool, customerHoldings, poolHistory,
} from '../src/services/bottles.ts';

let f: Fixture;
before(async () => { f = await setupFixture(); });
after(async () => { await f.close(); });

/** Deliver `full` bottles, collect `back` empties, report `lost` missing. */
async function deliver(
  date: string, full: number, back: number, lost = 0, customerId?: string,
) {
  const order = await createOrder(f.db, f.office, {
    customerId: customerId ?? f.customerId,
    deliveryMode: 'Delivery',
    requestedDeliveryDate: date,
    lines: [{ productId: f.fiveGalProductId, looseBottles: full }],
  });
  const [stop] = await stopsOf(f.db, order.deliverySheetId!);
  return markStop(f.db, f.driver, {
    stopId: stop.id, outcome: 'Delivered',
    bottlesDeliveredFull: full,
    bottlesEmptiesPickedUp: back,
    bottlesLostDamaged: lost,
  });
}

describe('The exchange cycle', () => {
  test('a delivery moves clean bottles out to the customer', async () => {
    const before = (await listPools(f.db))[0];
    await deliver('2027-01-04', 20, 0);
    const after = (await listPools(f.db))[0];

    assert.equal(after.cleanReady, before.cleanReady - 20);
    assert.equal(after.filledWithCustomer, before.filledWithCustomer + 20);
    assert.equal(after.inCirculation, before.inCirculation,
      'the bottles moved state but none left the pool');
  });

  test('collecting empties moves them to the awaiting-wash pile', async () => {
    const before = (await listPools(f.db))[0];
    await deliver('2027-01-11', 10, 15);
    const after = (await listPools(f.db))[0];

    assert.equal(after.returnedDirty, before.returnedDirty + 15);
    assert.equal(after.filledWithCustomer, before.filledWithCustomer + 10 - 15);
  });

  test('washing returns them to clean stock, closing the loop', async () => {
    const before = (await listPools(f.db))[0];
    assert.ok(before.returnedDirty >= 10, 'there are dirty bottles to wash');

    const after = await washBottles(f.db, f.office, { quantity: 10 });

    assert.equal(after.cleanReady, before.cleanReady + 10);
    assert.equal(after.returnedDirty, before.returnedDirty - 10);
    assert.equal(after.inCirculation, before.inCirculation,
      'washing does not create or destroy bottles');
  });

  test('bottles scrapped at washing leave the pool as a loss', async () => {
    const before = (await listPools(f.db))[0];
    const after = await washBottles(f.db, f.office, { quantity: 2, scrapped: 3 });

    assert.equal(after.cleanReady, before.cleanReady + 2);
    assert.equal(after.lostDamaged, before.lostDamaged + 3);
    assert.equal(after.returnedDirty, before.returnedDirty - 5);
    assert.equal(after.inCirculation, before.inCirculation - 3,
      'only the scrapped bottles leave circulation');
  });

  test('cannot wash more bottles than have been returned', async () => {
    const pool = (await listPools(f.db))[0];
    await assert.rejects(
      washBottles(f.db, f.office, { quantity: pool.returnedDirty + 1 }),
      /only \d+ bottles are waiting/,
    );
  });

  test('a wash of nothing is rejected rather than silently doing nothing', async () => {
    await assert.rejects(
      washBottles(f.db, f.office, { quantity: 0 }), /how many bottles/,
    );
  });
});

describe('Losses', () => {
  test('a bottle reported lost leaves circulation permanently', async () => {
    const before = (await listPools(f.db))[0];
    await deliver('2027-02-01', 5, 0, 4);
    const after = (await listPools(f.db))[0];

    assert.equal(after.lostDamaged, before.lostDamaged + 4);
    assert.equal(after.inCirculation, before.inCirculation - 4);
  });

  test('a loss is a business loss and is never billed to the customer', async () => {
    const result = await deliver('2027-02-08', 6, 0, 6);
    // 6 bottles at the Corporate rate of 450.00 = 2,700.00 + 15% = 3,105.00.
    // The 6 lost bottles must add nothing on top of that.
    const invoice = await getInvoiceLedger(f.db, result.invoiceId!);
    assert.equal(invoice!.grandTotalCents, 310_500);

    const lines = await f.db.query(
      `SELECT id FROM invoice_line_items WHERE invoice_id = $1`, [result.invoiceId],
    );
    assert.equal(lines.length, 1, 'no extra charge line for the lost bottles');
  });
});

describe('Movement history', () => {
  test('every movement is written to the stock ledger, not just the totals', async () => {
    const history = await poolHistory(f.db) as Array<{
      reference_type: string; quantity: string; notes: string;
    }>;
    assert.ok(history.length > 0, 'the pool has a real history');

    const kinds = new Set(history.map((h) => h.reference_type));
    assert.ok(kinds.has('CustomerOrder'), 'deliveries are recorded');
    assert.ok(kinds.has('BottleReturn'), 'collections are recorded');
    assert.ok(kinds.has('BottleWash'), 'washes are recorded');
  });

  test('a loss entry says plainly that it is not charged to the customer', async () => {
    const history = await poolHistory(f.db) as Array<{ notes: string }>;
    const loss = history.find((h) => h.notes?.includes('lost or damaged'));
    assert.ok(loss, 'losses appear in the history');
    assert.match(loss!.notes, /not charged to the customer/);
  });
});

describe('Who is holding bottles', () => {
  test('reports each customer net position from deliveries and returns', async () => {
    const holdings = await customerHoldings(f.db) as Array<{
      customer_id: string; delivered: number; returned: number;
      lost: number; holding: number;
    }>;
    const mine = holdings.find((h) => h.customer_id === f.customerId)!;
    assert.ok(mine, 'the delivered-to customer appears');

    // Delivered 20 + 10 + 5 + 6 = 41, returned 15, lost 4 + 6 = 10.
    assert.equal(Number(mine.delivered), 41);
    assert.equal(Number(mine.returned), 15);
    assert.equal(Number(mine.lost), 10);
    assert.equal(Number(mine.holding), 41 - 15 - 10, 'net bottles still with them');
  });

  test('a customer who was never delivered to is not listed', async () => {
    const holdings = await customerHoldings(f.db) as Array<{ customer_id: string }>;
    assert.ok(!holdings.some((h) => h.customer_id === f.otherCustomerId));
  });
});

describe('Corrections', () => {
  test('an admin can correct the counts, with a reason recorded', async () => {
    const after = await adjustPool(f.db, f.admin, {
      cleanReady: 500, reason: 'annual bottle count in the yard',
    });
    assert.equal(after.cleanReady, 500);

    const log = await f.db.one<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log
       WHERE entity_type = 'BottlePool' AND action = 'adjust'
       ORDER BY ts DESC LIMIT 1`,
    );
    assert.equal((log.details as { reason: string }).reason, 'annual bottle count in the yard');
  });

  test('a reason is required, and office staff cannot correct the pool', async () => {
    await assert.rejects(
      adjustPool(f.db, f.admin, { cleanReady: 10, reason: '  ' }), /reason is required/,
    );
    await assert.rejects(
      adjustPool(f.db, f.office, { cleanReady: 10, reason: 'x' }), /requires role admin/,
    );
  });

  test('negative counts are rejected', async () => {
    await assert.rejects(
      adjustPool(f.db, f.admin, { cleanReady: -5, reason: 'typo' }), /cannot be negative/,
    );
  });
});
