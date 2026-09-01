/**
 * Counter sales, pickup collection, and money received outside a delivery.
 *
 * The rule that shapes all three: nothing is billed until the goods actually
 * leave, and every payment lands somewhere real - against an invoice, or on
 * the account as a payment. There is no "credit balance" concept.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { createOrder } from '../src/services/orders.ts';
import { counterSale, collectOrder } from '../src/services/counter.ts';
import { receivePayment, unappliedPayments } from '../src/services/payments.ts';
import { getCustomerBalance } from '../src/services/payments.ts';

let f: Fixture;
before(async () => { f = await setupFixture(); });
after(async () => { await f.close(); });

const pickup = () => createOrder(f.db, f.office, {
  customerId: f.customerId,
  deliveryMode: 'Pickup',
  lines: [{ productId: f.casedProductId, cases: 2 }],
});

describe('A counter sale is not a pickup', () => {
  test('a counter sale is recorded as one, and bills on the spot', async () => {
    const sale = await counterSale(f.db, f.office, {
      customerId: f.customerId,
      lines: [{ productId: f.casedProductId, cases: 1 }],
      amountPaidCents: 100_000,
    });
    const order = await f.db.one<{ delivery_mode: string; status: string }>(
      `SELECT delivery_mode, status FROM customer_orders WHERE id = $1`, [sale.orderId]);
    assert.equal(order.delivery_mode, 'Counter');
    assert.equal(order.status, 'Delivered', 'it left the counter, so it is fulfilled');
    assert.ok(sale.invoiceNumber, 'and it was billed immediately');
  });

  test('a pickup order is NOT billed when it is taken', async () => {
    const order = await pickup();
    const invoices = await f.db.query(
      `SELECT invoice_id FROM invoice_orders WHERE order_id = $1`, [order.id]);
    assert.equal(invoices.length, 0,
      'a customer collecting on Friday must not be billed on Monday');
    const row = await f.db.one<{ status: string; delivery_mode: string }>(
      `SELECT status, delivery_mode FROM customer_orders WHERE id = $1`, [order.id]);
    assert.equal(row.delivery_mode, 'Pickup');
    assert.equal(row.status, 'Pending');
  });

  test('a pickup never lands on a delivery sheet', async () => {
    const order = await pickup();
    assert.equal(order.deliverySheetId, null);
  });
});

describe('Collecting a pickup order', () => {
  test('collection is what raises the invoice', async () => {
    const order = await pickup();
    const out = await collectOrder(f.db, f.office, {
      orderId: order.id, amountPaidCents: 0,
    });
    assert.ok(out.invoiceNumber);
    assert.equal(out.grandTotalCents, order.grandTotalCents,
      'billed for exactly what was ordered and handed over');
    assert.equal(out.balanceCents, out.grandTotalCents, 'nothing paid, so it is all owing');

    const row = await f.db.one<{ status: string }>(
      `SELECT status FROM customer_orders WHERE id = $1`, [order.id]);
    assert.equal(row.status, 'Delivered');
  });

  test('paying at collection settles the invoice there and then', async () => {
    const order = await pickup();
    const out = await collectOrder(f.db, f.office, {
      orderId: order.id, amountPaidCents: order.grandTotalCents, method: 'Card',
    });
    assert.equal(out.balanceCents, 0);
    assert.equal(out.status, 'Paid');
  });

  test('the same order cannot be collected twice', async () => {
    const order = await pickup();
    await collectOrder(f.db, f.office, { orderId: order.id });
    await assert.rejects(
      () => collectOrder(f.db, f.office, { orderId: order.id }),
      /already been collected/,
    );
  });

  test('a delivery order cannot be collected at the counter', async () => {
    const order = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Delivery',
      requestedDeliveryDate: '2027-01-05',
      lines: [{ productId: f.casedProductId, cases: 1 }],
    });
    await assert.rejects(
      () => collectOrder(f.db, f.office, { orderId: order.id }), /not a pickup/,
    );
  });
});

describe('Money received outside a delivery', () => {
  test('one transfer settles several invoices and leaves the rest on account', async () => {
    // Two invoices to pay off, via two collected pickups.
    const a = await pickup();
    const b = await pickup();
    const invA = await collectOrder(f.db, f.office, { orderId: a.id });
    const invB = await collectOrder(f.db, f.office, { orderId: b.id });

    const before = await getCustomerBalance(f.db, f.customerId);
    const transfer = invA.grandTotalCents + invB.grandTotalCents + 50_000;

    const out = await receivePayment(f.db, f.office, {
      customerId: f.customerId,
      amountCents: transfer,
      method: 'Bank Transfer',
      reference: 'NCB 88213',
      allocations: [
        { invoiceId: invA.invoiceId, amountCents: invA.grandTotalCents },
        { invoiceId: invB.invoiceId, amountCents: invB.grandTotalCents },
      ],
    });

    assert.equal(out.paymentIds.length, 3, 'one per invoice, plus the remainder');
    assert.equal(out.unappliedCents, 50_000);

    const after = await getCustomerBalance(f.db, f.customerId);
    assert.equal(after.balanceCents, before.balanceCents - transfer,
      'the whole transfer reduces what they owe, remainder included');
  });

  test('a payment with no invoice named simply sits on the account', async () => {
    const out = await receivePayment(f.db, f.office, {
      customerId: f.otherCustomerId, amountCents: 25_000, method: 'Cheque',
    });
    assert.equal(out.allocatedCents, 0);
    assert.equal(out.unappliedCents, 25_000);

    const waiting = await unappliedPayments(f.db, f.otherCustomerId);
    assert.ok(waiting.some((p) => Number(p.amount_cents) === 25_000),
      'and it is listed as still to be applied');
  });

  test('money cannot be applied to another customer invoice', async () => {
    const order = await pickup();
    const inv = await collectOrder(f.db, f.office, { orderId: order.id });
    await assert.rejects(
      () => receivePayment(f.db, f.office, {
        customerId: f.otherCustomerId, amountCents: 1_000, method: 'Cash',
        allocations: [{ invoiceId: inv.invoiceId, amountCents: 1_000 }],
      }),
      /belongs to a different customer/,
    );
  });

  test('more cannot be applied than was received', async () => {
    const order = await pickup();
    const inv = await collectOrder(f.db, f.office, { orderId: order.id });
    await assert.rejects(
      () => receivePayment(f.db, f.office, {
        customerId: f.customerId, amountCents: 1_000, method: 'Cash',
        allocations: [{ invoiceId: inv.invoiceId, amountCents: 500_000 }],
      }),
      /exceeds/,
    );
  });

  test('a driver cannot record a payment', async () => {
    await assert.rejects(
      () => receivePayment(f.db, f.driver, {
        customerId: f.customerId, amountCents: 1_000, method: 'Cash',
      }),
      /not permitted|role/i,
    );
  });
});
