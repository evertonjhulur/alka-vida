/**
 * The aged schedule behind the dashboard's Money owed (Everton, 27 Oct 2026),
 * and voided invoices kept out of every age.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { recordPastDelivery } from '../src/services/counter.ts';
import { recordPayment } from '../src/services/payments.ts';
import { voidInvoice } from '../src/services/invoices.ts';
import { agingSchedule, dashboard } from '../src/services/reports.ts';
import { businessToday } from '../src/services/core.ts';
import { addDays } from '@alka/shared';

let f: Fixture;
before(async () => {
  f = await setupFixture();
  await f.db.query(`INSERT INTO finished_goods_stock (product_id, quantity_on_hand) VALUES ($1, 1000)
                    ON CONFLICT (product_id) DO UPDATE SET quantity_on_hand = 1000`, [f.casedProductId]);
});
after(async () => { await f.close(); });

const sale = async (daysAgo: number, cases = 1) => (await recordPastDelivery(f.db, f.admin, {
  customerId: f.customerId, deliveredOn: addDays(businessToday(), -daysAgo), how: 'Delivered',
  lines: [{ productId: f.casedProductId, cases }],
} as never)).invoiceId as string;

describe('Aged receivables', () => {
  test('buckets by due date, voided invoices left out, credit and net per customer', async () => {
    await f.db.query(`UPDATE customers SET payment_terms = 'Due on receipt' WHERE id = $1`, [f.customerId]);
    const a = await sale(0);      // due today: not yet due
    const b = await sale(10);     // 10 days late
    const c = await sale(45);     // 45 days late
    const d = await sale(90);     // 90 days late
    const v = await sale(20);     // voided below
    await f.db.query(`UPDATE invoices SET due_date = invoice_date WHERE id = ANY($1::uuid[])`, [[a, b, c, d, v]]);
    await voidInvoice(f.db, f.admin, v, { reason: 'test' });
    await recordPayment(f.db, f.office, { customerId: f.customerId, amountCents: 10_000, method: 'Cash' } as never);

    const r = await agingSchedule(f.db);
    const one = 138_000; // 1 case x 1,200.00 + 15% GCT
    assert.equal(r.totals.currentCents, one);
    assert.equal(r.totals.d30Cents, one);
    assert.equal(r.totals.d60Cents, one);
    assert.equal(r.totals.d90Cents, one);
    assert.ok(!r.invoices.some((i) => i.invoiceId === v), 'the voided invoice is not owed');
    const me = r.customers.find((x) => x.customerId === f.customerId)!;
    assert.equal(me.openCents, 4 * one);
    assert.equal(me.creditCents, -10_000, 'money on account not yet applied');
    assert.equal(me.netCents, 4 * one - 10_000);
    assert.equal(r.invoices.find((i) => i.invoiceId === d)!.daysLate, 90);

    const dash = await dashboard(f.db);
    assert.equal(dash.aging.totalCents, 4 * one, 'the dashboard leaves the voided invoice out too');
    assert.equal(dash.aging.d90Cents, one);
  });
});
