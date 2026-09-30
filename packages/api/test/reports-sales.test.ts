/** The Reports screen's Sales and Margin tabs read real invoices. */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { counterSale } from '../src/services/counter.ts';
import { salesReport, marginReport, roundsReport } from '../src/services/reports.ts';
import { createOrder } from '../src/services/orders.ts';
import { markStop } from '../src/services/delivery.ts';
import { stopsOf } from './helpers.ts';

let f: Fixture;
before(async () => { f = await setupFixture(); });
after(async () => { await f.close(); });

describe('Sales report', () => {
  test('counts a sale by product, by where it went, and by customer, before GCT', async () => {
    const sale = await counterSale(f.db, f.office, {
      customerId: f.customerId, lines: [{ productId: f.casedProductId, cases: 2 }], amountPaidCents: 0,
    });
    const inv = await f.db.one<{ subtotal_cents: number; grand_total_cents: number }>(
      `SELECT subtotal_cents, grand_total_cents FROM invoices WHERE invoice_number = $1`, [sale.invoiceNumber]);

    const r = await salesReport(f.db, null, null);
    assert.ok(r.totals.netCents >= Number(inv.subtotal_cents));
    assert.ok(r.totals.grossCents > r.totals.netCents, 'with GCT is more than before GCT');
    const product = r.byProduct.find((p) => p.productId === f.casedProductId)!;
    assert.ok(product.cases >= 2);
    assert.ok(r.byZone.some((z) => z.zone === 'Collected or counter'));
    assert.ok(r.topCustomers.some((c) => c.customerId === f.customerId));
  });

  test('margin is sales less materials, and says when there is no bill of materials', async () => {
    const rows = await marginReport(f.db, null, null);
    const row = rows.find((p) => p.productId === f.casedProductId)!;
    assert.ok(row.salesCents > 0);
    if (row.materialCents === null) assert.equal(row.bomLines === 0 || row.materialPerBottleCents === null, true);
    else assert.equal(row.marginCents, row.salesCents - row.materialCents);
  });
});

describe('Rounds and cash report', () => {
  test('a round shows its stops, what was delivered and the cash the driver recorded', async () => {
    const order = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Delivery', requestedDeliveryDate: '2027-07-06',
      lines: [{ productId: f.fiveGalProductId, looseBottles: 2 }],
    });
    const [stop] = await stopsOf(f.db, order.deliverySheetId!);
    await markStop(f.db, f.driver, {
      stopId: stop.id, outcome: 'Delivered', paymentReceived: true, paymentMethod: 'Cash', paymentAmountCents: 1_000,
    });
    const r = await roundsReport(f.db, '2027-07-06', '2027-07-06');
    const round = r.rounds.find((x) => x.id === order.deliverySheetId)!;
    assert.equal(round.stops, 1);
    assert.equal(round.delivered, 1);
    assert.equal(round.recordedCents, 1_000);
    assert.equal(round.cashVarianceCents, null, 'not settled, so no difference yet');
    assert.ok(round.invoicedCents > 0);
  });
});
