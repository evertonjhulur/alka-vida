/**
 * The customer portal.
 *
 * Most of this file is about what a customer must NOT be able to do. Order
 * entry is built for the office and accepts things only the office may
 * decide - above all a price for a line, which by design outranks the
 * customer's own tier rate. The portal route used to hand the request body
 * straight to it, so these tests exist to keep that door shut.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { createPortalOrder, createOrder, listOrders, getOrder } from '../src/services/orders.ts';
import type { Actor } from '../src/services/core.ts';
import { businessToday } from '../src/services/core.ts';

let f: Fixture;
let portal: Actor;
let otherCustomerId: string;

before(async () => {
  f = await setupFixture();
  // A portal login acts as itself; the customer it belongs to comes from the
  // session, never from the request body.
  portal = { id: f.admin.id, name: 'Blue Mountain AP', role: 'customer' };
  otherCustomerId = (await f.db.one<{ id: string }>(
    `INSERT INTO customers (name, phone, email)
     VALUES ('Somebody Else','876-555-0000','else@example.jm') RETURNING id`,
  )).id;
});
after(async () => { await f.db.close(); });

const linesFor = (productId: string, cases = 2) => [{ productId, cases }];

describe('A customer can place an order for themselves', () => {
  test('it is charged at their tier rate and marked as coming from the portal', async () => {
    const officeQuote = await createOrder(f.db, f.office, {
      customerId: f.customerId, lines: linesFor(f.casedProductId), deliveryMode: 'Delivery',
    });

    const mine = await createPortalOrder(f.db, portal, f.customerId, {
      lines: linesFor(f.casedProductId),
    });

    assert.equal(mine.grandTotalCents, officeQuote.grandTotalCents,
      'the portal must quote exactly what the office would charge');

    const row = await f.db.one<{ source: string; delivery_mode: string; discount_percent: number }>(
      `SELECT source, delivery_mode, discount_percent FROM customer_orders WHERE id = $1`,
      [mine.id],
    );
    assert.equal(row.source, 'Portal');
    assert.equal(row.delivery_mode, 'Delivery');
  });

  test('a delivery order is put on a round like any other', async () => {
    const r = await createPortalOrder(f.db, portal, f.customerId, {
      lines: linesFor(f.casedProductId),
    });
    assert.notEqual(r.deliverySheetId, null,
      'a portal order is an ordinary order - nothing downstream should know it came from a customer');
  });

  test('pickup is allowed and never reaches a delivery round', async () => {
    const r = await createPortalOrder(f.db, portal, f.customerId, {
      lines: linesFor(f.casedProductId), deliveryMode: 'Pickup',
    });
    assert.equal(r.deliverySheetId, null);
  });

  test('a note survives to the order', async () => {
    const r = await createPortalOrder(f.db, portal, f.customerId, {
      lines: linesFor(f.casedProductId), notes: '  leave at the back gate  ',
    });
    const row = await f.db.one<{ notes: string }>(
      `SELECT notes FROM customer_orders WHERE id = $1`, [r.id]);
    assert.equal(row.notes, 'leave at the back gate');
  });
});

describe('What a customer must not be able to do', () => {
  test('a price on a line is IGNORED, not honoured', async () => {
    const honest = await createPortalOrder(f.db, portal, f.customerId, {
      lines: linesFor(f.casedProductId),
    });

    const cheeky = await createPortalOrder(f.db, portal, f.customerId, {
      // A line price outranks the tier rate in resolveLines. This is the
      // whole reason the portal has its own entry point.
      lines: [{ productId: f.casedProductId, cases: 2, pricePerCaseCents: 1 }],
    } as never);

    assert.equal(cheeky.grandTotalCents, honest.grandTotalCents,
      'naming your own price must change nothing');
    assert.ok(cheeky.grandTotalCents > 100, 'and certainly must not be a penny a case');
  });

  test('a discount is IGNORED', async () => {
    const honest = await createPortalOrder(f.db, portal, f.customerId, {
      lines: linesFor(f.casedProductId),
    });
    const cheeky = await createPortalOrder(f.db, portal, f.customerId, {
      lines: linesFor(f.casedProductId), discountPercent: 100,
    } as never);

    assert.equal(cheeky.grandTotalCents, honest.grandTotalCents,
      'a discount is the office\'s to give');
    const row = await f.db.one<{ discount_percent: number }>(
      `SELECT discount_percent FROM customer_orders WHERE id = $1`, [cheeky.id]);
    assert.equal(Number(row.discount_percent), 0);
  });

  test('a customer cannot set themselves up a standing order', async () => {
    const r = await createPortalOrder(f.db, portal, f.customerId, {
      lines: linesFor(f.casedProductId),
      isRecurring: true, recurrencePattern: 'Weekly',
    } as never);
    const row = await f.db.one<{ is_recurring: boolean; recurrence_pattern: string | null }>(
      `SELECT is_recurring, recurrence_pattern FROM customer_orders WHERE id = $1`, [r.id]);
    assert.equal(row.is_recurring, false, 'a standing order is an arrangement, not an order');
    assert.equal(row.recurrence_pattern, null);
  });

  test('a counter sale cannot be raised from the portal', async () => {
    const r = await createPortalOrder(f.db, portal, f.customerId, {
      lines: linesFor(f.casedProductId), deliveryMode: 'Counter',
    } as never);
    const row = await f.db.one<{ delivery_mode: string }>(
      `SELECT delivery_mode FROM customer_orders WHERE id = $1`, [r.id]);
    assert.equal(row.delivery_mode, 'Delivery',
      'paying at the counter is an office action, so it falls back to a delivery');
  });

  test('the order cannot be back-dated', async () => {
    const r = await createPortalOrder(f.db, portal, f.customerId, {
      lines: linesFor(f.casedProductId), orderDate: '2020-01-01',
    } as never);
    const row = await f.db.one<{ order_date: string }>(
      `SELECT order_date::text FROM customer_orders WHERE id = $1`, [r.id]);
    assert.equal(row.order_date, businessToday());
  });

  test('a delivery cannot be requested for a day that has gone', async () => {
    await assert.rejects(
      () => createPortalOrder(f.db, portal, f.customerId, {
        lines: linesFor(f.casedProductId), requestedDeliveryDate: '2020-01-01',
      }),
      /date that has passed/,
    );
  });

  test('an order for somebody else is impossible - the customer comes from the session',
    async () => {
      const r = await createPortalOrder(f.db, portal, f.customerId, {
        lines: linesFor(f.casedProductId), customerId: otherCustomerId,
      } as never);
      const row = await f.db.one<{ customer_id: string }>(
        `SELECT customer_id FROM customer_orders WHERE id = $1`, [r.id]);
      assert.equal(row.customer_id, f.customerId,
        'the id in the body is not read at all - it is the session that decides');
    });

  test('an empty order is refused', async () => {
    await assert.rejects(
      () => createPortalOrder(f.db, portal, f.customerId, { lines: [] }),
      /at least one line/,
    );
  });
});

describe('A customer sees their own records and no others', () => {
  test('their order list is only theirs', async () => {
    await createOrder(f.db, f.office, {
      customerId: otherCustomerId, lines: linesFor(f.casedProductId), deliveryMode: 'Pickup',
    });

    const mine = await listOrders(f.db, { customerId: f.customerId });
    assert.ok(mine.length > 0);
    assert.equal(
      mine.every((o) => (o as { customer_id: string }).customer_id === f.customerId), true,
      'somebody else\'s order must never appear in a customer\'s list',
    );
  });

  test('an order carries the customer it belongs to, so the route can check ownership',
    async () => {
      const theirs = await createOrder(f.db, f.office, {
        customerId: otherCustomerId, lines: linesFor(f.casedProductId), deliveryMode: 'Pickup',
      });
      const fetched = await getOrder(f.db, theirs.id) as { customer_id: string };
      assert.equal(fetched.customer_id, otherCustomerId,
        'assertOwnCustomer in the route depends on this field being present');
    });
});
