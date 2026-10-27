/**
 * Sales counts deliveries not invoiced yet, and the end-of-day report
 * (Everton, 27 Oct 2026).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { recordPastDelivery } from '../src/services/counter.ts';
import { createOrder } from '../src/services/orders.ts';
import { salesReport } from '../src/services/reports.ts';
import { endOfDay, renderEndOfDayPdf } from '../src/services/endofday.ts';
import { businessToday } from '../src/services/core.ts';
import { addDays } from '@alka/shared';

let f: Fixture;
before(async () => {
  f = await setupFixture();
  await f.db.query(`INSERT INTO finished_goods_stock (product_id, quantity_on_hand) VALUES ($1, 1000), ($2, 1000)
                    ON CONFLICT (product_id) DO UPDATE SET quantity_on_hand = 1000`, [f.casedProductId, f.fiveGalProductId]);
  await f.db.query(`UPDATE customers SET invoice_cycle = 'Monthly' WHERE id = $1`, [f.otherCustomerId]);
});
after(async () => { await f.close(); });

describe('Sales and the end of the day', () => {
  test('a monthly customer\'s delivery is in sales the day it went out, as not invoiced yet', async () => {
    const y = addDays(businessToday(), -1);
    const paid = await recordPastDelivery(f.db, f.office, {
      customerId: f.customerId, deliveredOn: y, how: 'Delivered',
      lines: [{ productId: f.casedProductId, cases: 2 }], amountPaidCents: 100_000, method: 'Cash',
    } as never);
    assert.ok(paid.invoiceId);
    const monthly = await recordPastDelivery(f.db, f.office, {
      customerId: f.otherCustomerId, deliveredOn: y, how: 'Delivered',
      lines: [{ productId: f.casedProductId, cases: 1 }],
    } as never);
    assert.equal(monthly.invoiceId ?? null, null, 'monthly: no invoice yet');

    const s = await salesReport(f.db, y, y);
    assert.equal(s.totals.invoices, 1);
    assert.equal(s.notInvoiced.deliveries, 1);
    assert.equal(s.notInvoiced.netCents, 120_000);
    assert.equal(s.totals.totalSalesNetCents, s.totals.netAfterCreditsCents + 120_000);

    const eod = await endOfDay(f.db, y);
    assert.equal(eod.sales.invoices.length, 1);
    assert.equal(eod.sales.totals.invoicedNetCents, 240_000);
    assert.equal(eod.sales.totals.totalSalesNetCents, 360_000);
    assert.equal(eod.sales.notInvoiced.items[0].customer.length > 0, true);
    assert.equal(eod.money.confirmedCents, 100_000);
    assert.equal(eod.money.byMethod[0].label, 'Cash');
    assert.equal(eod.sales.totals.stillOwedOnTheseCents, 276_000 - 100_000);
  });

  test('orders taken today, and what is booked for the next day', async () => {
    const today = businessToday();
    const o = await createOrder(f.db, f.office, { customerId: f.customerId, deliveryMode: 'Delivery',
      requestedDeliveryDate: addDays(today, 3), lines: [{ productId: f.fiveGalProductId, looseBottles: 4 }] });
    const eod = await endOfDay(f.db, today);
    const mine = eod.orders.taken.find((x) => x.orderId === o.id);
    assert.ok(mine, 'taken today');
    assert.match(mine!.items, /4/);
    assert.ok(!eod.orders.taken.some((x) => x.forDay === addDays(today, -1)),
      'sales recorded for an earlier day are not "orders taken"');
    const before = await endOfDay(f.db, addDays(today, 2));
    assert.ok(before.orders.booked.some((x) => x.orderId === o.id), 'booked for the next day');
  });

  test('the PDF', async () => {
    const r = await renderEndOfDayPdf(f.db, addDays(businessToday(), -1));
    assert.equal(r.pdf.subarray(0, 4).toString(), '%PDF');
    await assert.rejects(endOfDay(f.db, 'yesterday'), /choose a day/);
  });
});
