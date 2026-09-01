/** End-to-end HTTP tests: auth, role enforcement and portal scoping. */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPgliteDb, type Db } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { seed } from '../src/db/seed.ts';
import { buildServer } from '../src/server.ts';
import { signToken } from '../src/lib/auth.ts';
import { randomUUID } from 'node:crypto';

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

  /**
   * The bug this pins: "Reset Alka Vida data" wipes .data and reseeds the
   * users with fresh ids, but a browser tab open through the wipe still holds
   * its old token. Signed correctly, naming a user who no longer exists.
   *
   * Unchecked, the request sails past authentication and dies at the very END
   * of the write, on audit_log's foreign key - by which point the order number
   * has already been drawn from its sequence and is gone for good.
   */
  describe('a session whose user no longer exists', () => {
    const ghost = () => signToken({
      id: randomUUID(), name: 'System Administrator', role: 'admin', customerId: null,
    });

    test('cannot read', async () => {
      const res = await app.inject({
        method: 'GET', url: '/api/customers',
        headers: { authorization: `Bearer ${ghost()}` },
      });
      assert.equal(res.statusCode, 401);
    });

    test('is told to sign in again, not handed a database error', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/customers',
        headers: { authorization: `Bearer ${ghost()}` },
        payload: { name: 'Ghost Co', phone: '8765550000', email: 'ghost@example.com' },
      });
      assert.equal(res.statusCode, 401, 'rejected at the door, never reaching the write');
      assert.match(res.json().error, /sign in again/i);
      assert.doesNotMatch(res.body, /audit_log|foreign key/i,
        'the person reading this should never see a constraint name');
    });

    test('writes nothing and burns no document number', async () => {
      const before = await db.one<{ n: string }>(`SELECT count(*)::text n FROM customers`);
      const seqBefore = await db.one<{ n: string }>(
        `SELECT last_value::text n FROM order_number_seq`);

      await app.inject({
        method: 'POST', url: '/api/customers',
        headers: { authorization: `Bearer ${ghost()}` },
        payload: { name: 'Ghost Co', phone: '8765550000', email: 'ghost@example.com' },
      });

      const after = await db.one<{ n: string }>(`SELECT count(*)::text n FROM customers`);
      const seqAfter = await db.one<{ n: string }>(
        `SELECT last_value::text n FROM order_number_seq`);
      assert.equal(after.n, before.n, 'no customer was created');
      assert.equal(seqAfter.n, seqBefore.n, 'no sequence was advanced');
    });
  });

  test('tokens are signed with a per-install key, not a constant', async () => {
    const row = await db.one<{ value: string }>(
      `SELECT value FROM system_settings WHERE key = 'jwt_signing_key'`);
    assert.ok(row.value.length >= 32, 'a real key was generated and stored');
    assert.notEqual(row.value, 'dev-only-insecure-secret-change-me',
      'never the old hardcoded fallback - a token must not outlive its database');
  });

  test('a portal login is linked to its customer record', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth('portal') });
    const me = res.json();
    assert.equal(me.role, 'customer');
    assert.ok(me.customerId, 'the session carries the linked customer');
  });
});

describe('Action endpoints that carry no body', () => {
  /**
   * "Start route", "delete a price tier", "mark an invoice sent" - all pure
   * actions with nothing to send. The stock JSON parser rejects an empty body
   * outright, so every one of these buttons died with a 500 that read like a
   * database fault.
   */
  test('a POST with a JSON content-type and no body is not a 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/delivery-sheets/00000000-0000-0000-0000-000000000000/start',
      headers: { ...auth('admin'), 'content-type': 'application/json' },
    });
    assert.notEqual(res.statusCode, 500, res.body);
    assert.doesNotMatch(res.body, /Body cannot be empty/);
  });

  test('a DELETE with a JSON content-type and no body is not a 500', async () => {
    const tiers = await app.inject({
      method: 'GET', url: '/api/price-tiers', headers: auth('admin'),
    });
    const tierId = tiers.json().at(-1).id;
    const res = await app.inject({
      method: 'DELETE', url: `/api/price-tiers/${tierId}`,
      headers: { ...auth('admin'), 'content-type': 'application/json' },
    });
    assert.notEqual(res.statusCode, 500, res.body);
  });

  test('malformed JSON is still a 400, not a 500', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/customers',
      headers: { ...auth('admin'), 'content-type': 'application/json' },
      payload: '{ not json',
    });
    assert.equal(res.statusCode, 400);
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

  /** The seed ships an empty route, so make a real stop to correct. */
  async function aStopOnAnOpenRoute() {
    const customers = await app.inject({
      method: 'GET', url: '/api/customers', headers: auth('admin') });
    const products = await app.inject({
      method: 'GET', url: '/api/products', headers: auth('admin') });
    const customer = customers.json().find((c) => c.delivery_zone);
    const product = products.json().find((p) => p.bottles_per_case > 0);

    const order = await app.inject({
      method: 'POST', url: '/api/orders', headers: auth('admin'),
      payload: {
        customerId: customer.id, deliveryMode: 'Delivery',
        lines: [{ productId: product.id, cases: 2 }],
      },
    });
    const stopId = order.json().deliveryStopId;
    await db.query(
      `UPDATE delivery_stops SET payment_amount_cents = 50000 WHERE id = $1`, [stopId]);
    return { id: stopId, payment_amount_cents: 50000 };
  }

  /**
   * An office User may RAISE a correction - they hold the paperwork - but a
   * correction rewrites what the driver recorded collecting, which is exactly
   * the record someone would alter to cover a shortfall. So it is parked for
   * an admin rather than applied.
   */
  test('an office User can raise a stop correction but not apply it', async () => {
    const stop = await aStopOnAnOpenRoute();

    const res = await app.inject({
      method: 'POST', url: `/api/stops/${stop.id}/correct`,
      headers: auth('office'),
      payload: { changes: { paymentAmountCents: 999_99 }, reason: 'miscounted at the gate' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().applied, false, 'an office correction waits for an admin');

    const after = await db.one<{ payment_amount_cents: number }>(
      `SELECT payment_amount_cents FROM delivery_stops WHERE id = $1`, [stop.id],
    );
    assert.equal(Number(after.payment_amount_cents), Number(stop.payment_amount_cents),
      'nothing changed until the admin decides');

    const queue = await app.inject({ method: 'GET', url: '/api/approvals', headers: auth('admin') });
    const pending = queue.json().find((r) => r.requestType === 'StopCorrection');
    assert.ok(pending, 'it is sitting in the approvals queue');

    const review = await app.inject({
      method: 'POST', url: `/api/approvals/${pending.id}/review`,
      headers: auth('admin'), payload: { decision: 'Approved' },
    });
    assert.equal(review.statusCode, 200);

    const applied = await db.one<{ payment_amount_cents: number }>(
      `SELECT payment_amount_cents FROM delivery_stops WHERE id = $1`, [stop.id],
    );
    assert.equal(Number(applied.payment_amount_cents), 999_99,
      'approving applies exactly what was requested');
  });

  test('a rejected correction leaves the stop exactly as the driver recorded it', async () => {
    const stop = await aStopOnAnOpenRoute();
    const raised = await app.inject({
      method: 'POST', url: `/api/stops/${stop.id}/correct`,
      headers: auth('office'),
      payload: { changes: { paymentAmountCents: 1 }, reason: 'test rejection' },
    });
    const requestId = raised.json().requestId;

    await app.inject({
      method: 'POST', url: `/api/approvals/${requestId}/review`,
      headers: auth('admin'), payload: { decision: 'Rejected' },
    });

    const after = await db.one<{ payment_amount_cents: number }>(
      `SELECT payment_amount_cents FROM delivery_stops WHERE id = $1`, [stop.id],
    );
    assert.equal(Number(after.payment_amount_cents), Number(stop.payment_amount_cents));
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
