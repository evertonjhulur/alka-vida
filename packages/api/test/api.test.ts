/** End-to-end HTTP tests: auth, role enforcement and portal scoping. */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPgliteDb, type Db } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { seed } from '../src/db/seed.ts';
import { buildServer } from '../src/server.ts';

let db: Db;
let app: Awaited<ReturnType<typeof buildServer>>;
const tokens: Record<string, string> = {};

before(async () => {
  db = await createPgliteDb();
  await migrate(db, { quiet: true });
  await seed(db, { quiet: true });
  app = await buildServer(db);
  await app.ready();

  for (const [role, email, password] of [
    ['admin', 'admin@alkavida.jm', 'admin1234'],
    ['office', 'office@alkavida.jm', 'office1234'],
    ['driver', 'driver@alkavida.jm', 'driver1234'],
    ['portal', 'ap@bluemountain.jm', 'portal1234'],
  ] as const) {
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email, password },
    });
    assert.equal(res.statusCode, 200, `${role} login failed: ${res.body}`);
    tokens[role] = res.json().token;
  }
});

after(async () => { await app.close(); await db.close(); });

const auth = (role: string) => ({ authorization: `Bearer ${tokens[role]}` });

describe('Authentication', () => {
  test('rejects a wrong password', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: 'admin@alkavida.jm', password: 'wrong' },
    });
    assert.equal(res.statusCode, 401);
  });

  test('rejects an unauthenticated request', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/customers' });
    assert.equal(res.statusCode, 401);
  });

  test('rejects a tampered token', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/customers',
      headers: { authorization: `Bearer ${tokens.admin.slice(0, -3)}xxx` },
    });
    assert.equal(res.statusCode, 401);
  });

  test('a portal login is linked to its customer record', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth('portal') });
    const me = res.json();
    assert.equal(me.role, 'customer');
    assert.ok(me.customerId, 'the session carries the linked customer');
  });
});

describe('Role enforcement (Section 10)', () => {
  test('an office User cannot edit an issued invoice', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/invoices/00000000-0000-0000-0000-000000000000',
      headers: auth('office'), payload: { discountPercent: 10 },
    });
    assert.equal(res.statusCode, 403);
  });

  test('an office User cannot reverse a payment', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/payments/00000000-0000-0000-0000-000000000000/reverse',
      headers: auth('office'), payload: {},
    });
    assert.equal(res.statusCode, 403);
  });

  test('an office User cannot merge customers', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/customers/merge',
      headers: auth('office'), payload: { survivorId: 'a', mergedId: 'b' },
    });
    assert.equal(res.statusCode, 403);
  });

  test('a driver cannot open the settlement screen or approve anything', async () => {
    const settle = await app.inject({
      method: 'GET', url: '/api/delivery-sheets/x/settlement', headers: auth('driver'),
    });
    assert.equal(settle.statusCode, 403);
    const approvals = await app.inject({
      method: 'GET', url: '/api/approvals', headers: auth('driver'),
    });
    assert.equal(approvals.statusCode, 403);
  });

  test('an office User CAN adjust an allocation - deliberately less restrictive', async () => {
    // Reaches the service and fails on the unknown stop, not on permission.
    const res = await app.inject({
      method: 'POST', url: '/api/stops/00000000-0000-0000-0000-000000000000/adjust-allocation',
      headers: auth('office'), payload: { allocations: [] },
    });
    assert.notEqual(res.statusCode, 403);
  });

  test('but only an Admin may correct a stop recorded figure', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/stops/00000000-0000-0000-0000-000000000000/correct',
      headers: auth('office'), payload: { changes: {}, reason: 'x' },
    });
    assert.equal(res.statusCode, 403);
  });
});

describe('Customer portal is view-only, own records only', () => {
  test('a portal user cannot read another customer statement', async () => {
    const other = await db.one<{ id: string }>(
      `SELECT id FROM customers WHERE name = 'Portmore Pharmacy'`,
    );
    const res = await app.inject({
      method: 'GET', url: `/api/customers/${other.id}/statement`, headers: auth('portal'),
    });
    assert.equal(res.statusCode, 403);
  });

  test('a portal user CAN read their own statement', async () => {
    const me = (await app.inject({
      method: 'GET', url: '/api/auth/me', headers: auth('portal'),
    })).json();
    const res = await app.inject({
      method: 'GET', url: `/api/customers/${me.customerId}/statement`, headers: auth('portal'),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().customerId, me.customerId);
  });

  test('a portal invoice list is scoped to that customer regardless of query', async () => {
    const other = await db.one<{ id: string }>(
      `SELECT id FROM customers WHERE name = 'Portmore Pharmacy'`,
    );
    const res = await app.inject({
      method: 'GET', url: `/api/invoices?customerId=${other.id}`, headers: auth('portal'),
    });
    assert.equal(res.statusCode, 200);
    const me = (await app.inject({
      method: 'GET', url: '/api/auth/me', headers: auth('portal'),
    })).json();
    for (const inv of res.json()) {
      assert.equal(inv.customer_id, me.customerId, 'cannot widen scope via the query string');
    }
  });

  test('a portal order is forced onto the logged-in customer and marked Portal', async () => {
    const product = await db.one<{ id: string }>(
      `SELECT id FROM products WHERE bottles_per_case = 0 LIMIT 1`,
    );
    const other = await db.one<{ id: string }>(
      `SELECT id FROM customers WHERE name = 'Portmore Pharmacy'`,
    );
    const res = await app.inject({
      method: 'POST', url: '/api/orders', headers: auth('portal'),
      payload: {
        customerId: other.id, // attempts to order on someone else's account
        deliveryMode: 'Delivery', requestedDeliveryDate: '2026-11-02',
        lines: [{ productId: product.id, looseBottles: 3 }],
      },
    });
    assert.equal(res.statusCode, 200);
    const order = await db.one<{ customer_id: string; source: string }>(
      `SELECT customer_id, source FROM customer_orders WHERE id = $1`, [res.json().id],
    );
    const me = (await app.inject({
      method: 'GET', url: '/api/auth/me', headers: auth('portal'),
    })).json();
    assert.equal(order.customer_id, me.customerId, 'forced onto their own account');
    assert.equal(order.source, 'Portal');
  });
});

describe('Business rules surface as 400, not 500', () => {
  test('selling loose bottles of a cased product is rejected with a clear message', async () => {
    const cased = await db.one<{ id: string }>(
      `SELECT id FROM products WHERE bottles_per_case > 0 LIMIT 1`,
    );
    const customer = await db.one<{ id: string }>(
      `SELECT id FROM customers WHERE name = 'Portmore Pharmacy'`,
    );
    const res = await app.inject({
      method: 'POST', url: '/api/orders', headers: auth('office'),
      payload: {
        customerId: customer.id, deliveryMode: 'Pickup',
        lines: [{ productId: cased.id, cases: 0, looseBottles: 5 }],
      },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /loose bottles cannot be sold/);
  });
});

describe('A full delivery cycle over HTTP', () => {
  test('order, deliver, allocate, settle - ending Paid with correct GCT', async () => {
    const customer = await db.one<{ id: string }>(
      `SELECT id FROM customers WHERE name = 'Half Way Tree Clinic'`,
    );
    const product = await db.one<{ id: string }>(
      `SELECT id FROM products WHERE name = 'Alka Vida 500ml'`,
    );

    const order = (await app.inject({
      method: 'POST', url: '/api/orders', headers: auth('office'),
      payload: {
        customerId: customer.id, deliveryMode: 'Delivery',
        requestedDeliveryDate: '2026-11-09',
        lines: [{ productId: product.id, cases: 8 }],
      },
    })).json();

    // 8 x 1200.00 = 9,600.00 + 15% = 11,040.00
    assert.equal(order.grandTotalCents, 1_104_000);
    assert.ok(order.deliverySheetId);

    const sheet = (await app.inject({
      method: 'GET', url: `/api/delivery-sheets/${order.deliverySheetId}`,
      headers: auth('driver'),
    })).json();
    const stop = sheet.stops[0];

    // The driver sees a tax-inclusive figure.
    const forDriver = (await app.inject({
      method: 'GET', url: `/api/stops/${stop.id}`, headers: auth('driver'),
    })).json();
    assert.equal(forDriver.amountOwedCents, 1_104_000);

    const delivered = (await app.inject({
      method: 'POST', url: `/api/stops/${stop.id}/outcome`, headers: auth('driver'),
      payload: {
        outcome: 'Delivered', paymentReceived: true,
        paymentMethod: 'Cash', paymentAmountCents: 1_104_000,
      },
    })).json();
    assert.ok(delivered.invoiceId);

    await app.inject({
      method: 'POST', url: `/api/stops/${stop.id}/allocation`, headers: auth('driver'),
      payload: { allocations: [{ invoiceId: delivered.invoiceId, amountCents: 1_104_000 }] },
    });

    const review = (await app.inject({
      method: 'GET', url: `/api/delivery-sheets/${order.deliverySheetId}/settlement`,
      headers: auth('office'),
    })).json();
    assert.equal(review.stops[0].expectedCents, 1_104_000);
    assert.equal(review.stops[0].varianceCents, 0);

    const settled = (await app.inject({
      method: 'POST', url: `/api/delivery-sheets/${order.deliverySheetId}/settle`,
      headers: auth('admin'), payload: { actualCashCents: 1_104_000 },
    })).json();
    assert.equal(settled.cashVarianceCents, 0);

    const invoice = (await app.inject({
      method: 'GET', url: `/api/invoices/${delivered.invoiceId}`, headers: auth('office'),
    })).json();
    assert.equal(invoice.status, 'Paid');
    assert.equal(invoice.amountPaidCents, 1_104_000);
    assert.equal(invoice.gct_cents, 144_000, 'GCT on the post-discount subtotal');
  });
});
