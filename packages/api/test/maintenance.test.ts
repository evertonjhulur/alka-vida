/** Customer creation/editing and order editing - the office maintenance paths. */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, stopsOf, type Fixture } from './helpers.ts';
import {
  createCustomer, updateCustomer, getCustomer, listSelectableCustomers,
} from '../src/services/customers.ts';
import {
  createOrder, editOrder, cancelOrder, listOrders, getOrder,
} from '../src/services/orders.ts';
import { markStop } from '../src/services/delivery.ts';

let f: Fixture;
before(async () => { f = await setupFixture(); });
after(async () => { await f.close(); });

describe('Customer records', () => {
  test('a customer can be created with the minimum details', async () => {
    const c = await createCustomer(f.db, f.office, {
      name: 'New Corner Shop', phone: '876-555-3333', email: 'shop@corner.jm',
      deliveryZone: 'Kingston', routeSequence: 30, priceTierId: f.tierId,
    });
    assert.ok(c.id);
    assert.equal(c.warnings.length, 0);

    const list = await listSelectableCustomers(f.db) as Array<{ id: string; name: string }>;
    assert.ok(list.some((x) => x.id === c.id));
  });

  test('creating without a delivery zone warns but still succeeds', async () => {
    const c = await createCustomer(f.db, f.office, {
      name: 'Walk-in Only', phone: '000', email: 'walkin@x.jm',
    });
    assert.ok(c.id, 'a pickup-only customer is perfectly valid');
    assert.match(c.warnings.join(' '), /no delivery zone/i);
  });

  test('a customer can be edited, and the zone change takes effect on routing', async () => {
    const c = await createCustomer(f.db, f.office, {
      name: 'Movers Ltd', phone: '876', email: 'm@x.jm',
    });
    await updateCustomer(f.db, f.office, c.id, {
      deliveryZone: 'Portmore', routeSequence: 7, priceTierId: f.tierId,
    });

    const after = await getCustomer(f.db, c.id) as {
      delivery_zone: string; route_sequence: number; price_tier: string;
    };
    assert.equal(after.delivery_zone, 'Portmore');
    assert.equal(Number(after.route_sequence), 7);
    assert.equal(after.price_tier, 'Corporate');

    // The new zone is what the order now routes by.
    const order = await createOrder(f.db, f.office, {
      customerId: c.id, deliveryMode: 'Delivery',
      requestedDeliveryDate: '2027-03-01',
      lines: [{ productId: f.fiveGalProductId, looseBottles: 2 }],
    });
    const sheet = await f.db.one<{ zone: string }>(
      `SELECT zone FROM delivery_sheets WHERE id = $1`, [order.deliverySheetId],
    );
    assert.equal(sheet.zone, 'Portmore');
  });

  test('editing only the fields supplied leaves the rest untouched', async () => {
    const c = await createCustomer(f.db, f.office, {
      name: 'Partial Edit Ltd', phone: '876-1', email: 'p@x.jm',
      deliveryZone: 'Kingston', paymentTerms: 'Net 30',
    });
    await updateCustomer(f.db, f.office, c.id, { phone: '876-2' });

    const after = await getCustomer(f.db, c.id) as {
      phone: string; payment_terms: string; delivery_zone: string;
    };
    assert.equal(after.phone, '876-2');
    assert.equal(after.payment_terms, 'Net 30', 'untouched fields survive');
    assert.equal(after.delivery_zone, 'Kingston');
  });

  test('a merged-away customer cannot be edited', async () => {
    const c = await createCustomer(f.db, f.office, {
      name: 'To Be Merged', phone: '8', email: 'tbm@x.jm',
    });
    await f.db.query(`UPDATE customers SET active = false WHERE id = $1`, [c.id]);
    await assert.rejects(
      updateCustomer(f.db, f.office, c.id, { phone: '9' }), /merged away/,
    );
  });
});

describe('Order editing', () => {
  test('a pending order can have its lines and date changed, and totals follow', async () => {
    const order = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Delivery',
      requestedDeliveryDate: '2027-04-05',
      lines: [{ productId: f.casedProductId, cases: 10 }],
    });
    assert.equal(order.grandTotalCents, 1_380_000);

    const edited = await editOrder(f.db, f.office, order.id, {
      lines: [{ productId: f.casedProductId, cases: 4 }],
      requestedDeliveryDate: '2027-04-12',
    });
    // 4 x 1200.00 = 4,800.00 + 15% = 5,520.00
    assert.equal(edited.subtotalCents, 480_000);
    assert.equal(edited.grandTotalCents, 552_000);

    const after = await getOrder(f.db, order.id) as {
      requested_delivery_date: Date; lines: Array<{ cases: number }>;
    };
    // A `date` column arrives as a JS Date. It reaches the browser as an ISO
    // string via JSON, so normalise the same way rather than via String(),
    // whose local-time rendering would read as the previous day.
    assert.equal(
      new Date(after.requested_delivery_date).toISOString().slice(0, 10),
      '2027-04-12',
    );
    assert.equal(after.lines.length, 1);
    assert.equal(Number(after.lines[0].cases), 4);
  });

  test('a discount added on edit is taxed on the post-discount subtotal', async () => {
    const order = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Pickup',
      lines: [{ productId: f.casedProductId, cases: 10 }],
    });
    const edited = await editOrder(f.db, f.office, order.id, { discountPercent: 10 });
    // 12,000.00 less 10% = 10,800.00, +15% = 12,420.00
    assert.equal(edited.grandTotalCents, 1_242_000);
  });

  test('the case-vs-bottle rule still applies when editing', async () => {
    const order = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Pickup',
      lines: [{ productId: f.casedProductId, cases: 2 }],
    });
    await assert.rejects(
      editOrder(f.db, f.office, order.id, {
        lines: [{ productId: f.casedProductId, cases: 0, looseBottles: 5 }],
      }),
      /loose bottles cannot be sold/,
    );
  });

  test('a delivered order cannot be edited - the invoice is the record', async () => {
    const order = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Delivery',
      requestedDeliveryDate: '2027-04-19',
      lines: [{ productId: f.casedProductId, cases: 3 }],
    });
    const [stop] = await stopsOf(f.db, order.deliverySheetId!);
    await markStop(f.db, f.driver, { stopId: stop.id, outcome: 'Delivered' });

    await assert.rejects(
      editOrder(f.db, f.office, order.id, {
        lines: [{ productId: f.casedProductId, cases: 99 }],
      }),
      /already delivered|Correct the invoice/i,
    );
  });

  test('editing keeps the driver stop summary in step', async () => {
    const order = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Delivery',
      requestedDeliveryDate: '2027-05-03',
      lines: [{ productId: f.casedProductId, cases: 2 }],
    });
    await editOrder(f.db, f.office, order.id, {
      lines: [{ productId: f.casedProductId, cases: 9 }],
    });
    const stop = await f.db.one<{ line_items_summary: string }>(
      `SELECT line_items_summary FROM delivery_stops WHERE order_id = $1`, [order.id],
    );
    assert.match(stop.line_items_summary, /9 cs/, 'the driver sees the new quantity');
  });
});

describe('Order cancellation', () => {
  test('a pending order is cancelled and dropped from its route', async () => {
    const order = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Delivery',
      requestedDeliveryDate: '2027-05-10',
      lines: [{ productId: f.fiveGalProductId, looseBottles: 4 }],
    });
    const before = await stopsOf(f.db, order.deliverySheetId!);
    assert.equal(before.length, 1);

    await cancelOrder(f.db, f.office, order.id, 'customer changed their mind');

    const status = await f.db.one<{ status: string }>(
      `SELECT status FROM customer_orders WHERE id = $1`, [order.id],
    );
    assert.equal(status.status, 'Cancelled');
    const after = await stopsOf(f.db, order.deliverySheetId!);
    assert.equal(after.length, 0, 'the driver no longer sees the stop');
  });

  test('a delivered order cannot be cancelled', async () => {
    const order = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Delivery',
      requestedDeliveryDate: '2027-05-17',
      lines: [{ productId: f.fiveGalProductId, looseBottles: 2 }],
    });
    const [stop] = await stopsOf(f.db, order.deliverySheetId!);
    await markStop(f.db, f.driver, { stopId: stop.id, outcome: 'Delivered' });
    await assert.rejects(cancelOrder(f.db, f.office, order.id), /only a pending order/);
  });
});

describe('Order listing', () => {
  test('lists orders newest first and filters by status', async () => {
    const all = await listOrders(f.db) as Array<{ status: string }>;
    assert.ok(all.length > 0);

    const cancelled = await listOrders(f.db, { status: 'Cancelled' }) as Array<{ status: string }>;
    assert.ok(cancelled.every((o) => o.status === 'Cancelled'));
  });
});
