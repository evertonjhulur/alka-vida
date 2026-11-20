/**
 * Discounts from office staff need an administrator (Everton, 19 Nov 2026).
 * Before this only a discount added to an invoice already raised went for
 * approval; one put on the order went straight onto its invoice - and on
 * 19 Nov three walk-in sales went through at 16.7% off that way.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { createOrder, editOrder } from '../src/services/orders.ts';
import { counterSale } from '../src/services/counter.ts';
import { markStop } from '../src/services/delivery.ts';
import { reviewApproval } from '../src/services/approvals.ts';
import { setSpecialPrice, createCustomer } from '../src/services/customers.ts';
import { createQuotation } from '../src/services/quotations.ts';
import { getInvoiceLedger } from '../src/services/invoices.ts';
import { generateDueOrders, startSchedule } from '../src/services/recurring.ts';
import { businessToday } from '../src/services/core.ts';
import { addDays } from '@alka/shared';

let f: Fixture;
before(async () => {
  f = await setupFixture();
  await f.db.query(`INSERT INTO finished_goods_stock (product_id, quantity_on_hand) VALUES ($1, 9000), ($2, 9000)
                    ON CONFLICT (product_id) DO UPDATE SET quantity_on_hand = 9000`, [f.casedProductId, f.fiveGalProductId]);
});
after(async () => { await f.close(); });

const pendingFor = (orderId: string) => f.db.maybeOne<{ id: string; discount_percent: number }>(
  `SELECT id, discount_percent FROM approval_requests
   WHERE request_type = 'Discount' AND entity_type = 'CustomerOrder' AND entity_id = $1 AND status = 'Pending'`, [orderId]);
const status = async (orderId: string) => (await f.db.one<{ s: string }>(
  `SELECT discount_status AS s FROM customer_orders WHERE id = $1`, [orderId])).s;

async function deliver(orderId: string) {
  const stop = await f.db.one<{ id: string }>(`SELECT id FROM delivery_stops WHERE order_id = $1`, [orderId]);
  const r = await markStop(f.db, f.driver, { stopId: stop.id, outcome: 'Delivered' } as never);
  return r.invoiceId!;
}

describe('Discounts on orders need an administrator', () => {
  test('office discount: the invoice is for the full amount until approved, then the discount counts', async () => {
    const o = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Delivery', requestedDeliveryDate: addDays(businessToday(), 1),
      lines: [{ productId: f.casedProductId, cases: 2 }], discountPercent: 10, discountReason: 'loyal customer',
    } as never);
    assert.equal(await status(o.id), 'Pending');
    assert.ok(o.warnings.some((w) => /waiting for an administrator/.test(w)));
    const req = await pendingFor(o.id);
    assert.ok(req, 'a request under Needs a decision');

    const inv = await deliver(o.id);
    const before = (await getInvoiceLedger(f.db, inv))!;
    assert.equal(before.grandTotalCents, 276_000, '2 x 1,200 + GCT, no discount yet');

    await reviewApproval(f.db, f.admin, req!.id, 'Approved');
    assert.equal(await status(o.id), 'Approved');
    assert.equal((await getInvoiceLedger(f.db, inv))!.grandTotalCents, 248_400, '2,400 - 10% = 2,160 + GCT');
  });

  test('turned down: the discount comes off the order and its invoice', async () => {
    const o = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Delivery', requestedDeliveryDate: addDays(businessToday(), 2),
      lines: [{ productId: f.casedProductId, cases: 1 }], discountFixedCents: 20_000,
    } as never);
    const inv = await deliver(o.id);
    await reviewApproval(f.db, f.admin, (await pendingFor(o.id))!.id, 'Rejected');
    const ord = await f.db.one<{ s: string; f: number; g: number }>(
      `SELECT discount_status AS s, discount_fixed_cents AS f, grand_total_cents AS g FROM customer_orders WHERE id = $1`, [o.id]);
    assert.deepEqual([ord.s, Number(ord.f), Number(ord.g)], ['Rejected', 0, 138_000]);
    const i = (await getInvoiceLedger(f.db, inv))!;
    assert.equal(i.grandTotalCents, 138_000);
  });

  test("an administrator's discount applies at once; no request", async () => {
    const o = await createOrder(f.db, f.admin, {
      customerId: f.customerId, deliveryMode: 'Delivery', requestedDeliveryDate: addDays(businessToday(), 3),
      lines: [{ productId: f.casedProductId, cases: 1 }], discountPercent: 100,
    } as never);
    assert.equal(await status(o.id), 'Approved');
    assert.equal(await pendingFor(o.id), null);
    const inv = await deliver(o.id);
    assert.equal((await getInvoiceLedger(f.db, inv))!.grandTotalCents, 0, 'FOC as before');
  });

  test('editing: an office change to the discount waits again; taking it off settles it', async () => {
    const o = await createOrder(f.db, f.admin, {
      customerId: f.customerId, deliveryMode: 'Delivery', requestedDeliveryDate: addDays(businessToday(), 4),
      lines: [{ productId: f.casedProductId, cases: 1 }], discountPercent: 5,
    } as never);
    await editOrder(f.db, f.office, o.id, { discountPercent: 15 });
    assert.equal(await status(o.id), 'Pending');
    const first = await pendingFor(o.id);
    await editOrder(f.db, f.office, o.id, { discountPercent: 20 });
    const second = await pendingFor(o.id);
    assert.notEqual(second!.id, first!.id, 'the latest change replaces the earlier request');
    await editOrder(f.db, f.office, o.id, { discountPercent: 0 });
    assert.equal(await status(o.id), 'Approved');
    assert.equal(await pendingFor(o.id), null);
  });

  test("a walk-in counter sale with an office discount: paid at the discounted amount, counted once approved", async () => {
    const sale = await counterSale(f.db, f.office, {
      customerId: f.customerId, lines: [{ productId: f.casedProductId, cases: 1 }], discountPercent: 50,
      amountPaidCents: 69_000, method: 'Cash',
    } as never);
    const i1 = (await getInvoiceLedger(f.db, sale.invoiceId))!;
    assert.equal(i1.grandTotalCents, 138_000, 'full until approved');
    await reviewApproval(f.db, f.admin, (await pendingFor(sale.orderId))!.id, 'Approved');
    const i2 = (await getInvoiceLedger(f.db, sale.invoiceId))!;
    assert.equal(i2.grandTotalCents, 69_000);
  });

  test("a standing order's runs carry its decision; approving the schedule covers runs already made", async () => {
    const start = addDays(businessToday(), 1);
    const o = await createOrder(f.db, f.office, {
      customerId: f.otherCustomerId, deliveryMode: 'Delivery', requestedDeliveryDate: start,
      lines: [{ productId: f.fiveGalProductId, looseBottles: 2 }], discountPercent: 10,
    } as never);
    await startSchedule(f.db, f.office, o.id, { pattern: 'Weekly' as never });
    await generateDueOrders(f.db, f.office, { options: { leadDays: 30 } as never });
    const runs = await f.db.query<{ id: string; s: string }>(
      `SELECT id, discount_status AS s FROM customer_orders WHERE parent_recurring_id = $1`, [o.id]);
    assert.ok(runs.length > 0);
    assert.ok(runs.every((r) => r.s === 'Pending'), 'runs wait with the schedule');
    const reqs = await f.db.one<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM approval_requests WHERE request_type = 'Discount' AND status = 'Pending'
       AND entity_id = ANY($1::uuid[])`, [runs.map((r) => r.id)]);
    assert.equal(reqs.n, 0, 'one request, on the schedule, not one per run');
    await reviewApproval(f.db, f.admin, (await pendingFor(o.id))!.id, 'Approved');
    for (const r of runs) assert.equal(await status(r.id), 'Approved');
  });
});

describe('Other ways to charge less need an administrator', () => {
  test('office staff cannot type a line price below the customer\'s own; an admin can', async () => {
    const base = {
      customerId: f.customerId, deliveryMode: 'Delivery', requestedDeliveryDate: addDays(businessToday(), 5),
    };
    await assert.rejects(createOrder(f.db, f.office, {
      ...base, lines: [{ productId: f.casedProductId, cases: 1, pricePerCaseCents: 100_000 }] } as never),
      /Only an administrator can charge less/);
    const higher = await createOrder(f.db, f.office, {
      ...base, lines: [{ productId: f.casedProductId, cases: 1, pricePerCaseCents: 130_000 }] } as never);
    assert.ok(higher.id, 'a higher price is fine');
    const byAdmin = await createOrder(f.db, f.admin, {
      ...base, lines: [{ productId: f.casedProductId, cases: 1, pricePerCaseCents: 100_000 }] } as never);
    assert.ok(byAdmin.id);
    await assert.rejects(createQuotation(f.db, f.office, {
      customerId: f.customerId, lines: [{ productId: f.casedProductId, cases: 1, pricePerCaseCents: 100_000 }] } as never),
      /Only an administrator can charge less/);
  });

  test('office staff cannot set a special price below the price list; above it, or an admin, is fine', async () => {
    await assert.rejects(setSpecialPrice(f.db, f.office, f.customerId, f.casedProductId, 110_000),
      /Only an administrator can set a special price below/);
    await setSpecialPrice(f.db, f.office, f.customerId, f.casedProductId, 125_000);
    await setSpecialPrice(f.db, f.admin, f.customerId, f.casedProductId, 110_000);
    await setSpecialPrice(f.db, f.office, f.customerId, f.casedProductId, null);
  });

  test('a walk-in put on file takes the Cash Walk-In record\'s price list', async () => {
    await f.db.query(
      `INSERT INTO customers (name, phone, email, is_walk_in, price_tier_id, delivery_address)
       VALUES ('Cash Walk-In', '000', '', true, $1, '')`, [f.tierId]);
    const c = await createCustomer(f.db, f.office, { name: 'Jane Counter', phone: '876-111-2222', email: '', isWalkIn: true } as never);
    const t = await f.db.one<{ t: string | null }>(`SELECT price_tier_id AS t FROM customers WHERE id = $1`, [c.id]);
    assert.equal(t.t, f.tierId);
  });
});
