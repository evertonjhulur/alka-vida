/**
 * The public website (21 Oct 2026): what it shows from the system, and
 * website orders from people without an account.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import {
  siteInfo, submitWebsiteOrder, listWebsiteOrders, bookWebsiteOrder, declineWebsiteOrder,
} from '../src/services/website.ts';
import { updateProduct } from '../src/services/pricing.ts';

let f: Fixture;
let coPackProductId: string;

const guest = (over: Record<string, unknown> = {}) => ({
  firstName: 'Grace', lastName: 'Brown', phone: '876-555-0101', email: 'grace@example.com',
  fulfilment: 'Deliver' as const, addressLine1: '4 Lady Musgrave Road', city: 'Kingston 10',
  parish: 'St Andrew', preferredDay: 'Thu', payMethod: 'Cash' as const,
  lines: [{ productId: f.fiveGalProductId, qty: 4 }, { productId: f.casedProductId, qty: 2 }],
  ...over,
});

before(async () => {
  f = await setupFixture();
  const brand = (await f.db.one<{ id: string }>(
    `INSERT INTO brands (name, type, label_source) VALUES ('Cool Cool','Third-Party Co-Pack','Customer-supplied') RETURNING id`)).id;
  coPackProductId = (await f.db.one<{ id: string }>(
    `INSERT INTO products (name, brand_id, size, bottles_per_case, price_per_case_cents)
     VALUES ('Cool Cool 500ml', $1, '500ml', 24, 99000) RETURNING id`, [brand])).id;
  await f.db.query(`INSERT INTO delivery_zones (name, run_days) VALUES ('Red Hills', '{Tue,Thu}')`);
});
after(async () => f.close());

describe('what the website shows', () => {
  test('own products at their list price, smallest first; never a co-pack brand', async () => {
    const s = await siteInfo(f.db);
    const ids = s.products.map((p) => p.id);
    assert.deepEqual(ids, [f.casedProductId, f.fiveGalProductId]);
    assert.ok(!ids.includes(coPackProductId));
    // List price, not the Corporate tier's.
    assert.equal(s.products[0].priceCents, 130000);
    assert.equal(s.products[0].unit, 'case');
    assert.equal(s.products[1].priceCents, 50000);
    assert.equal(s.products[1].unit, 'bottle');
  });

  test('a price changed in the system shows on the website at once', async () => {
    await updateProduct(f.db, f.admin, f.fiveGalProductId, { pricePerBottleCents: 52000 });
    const s = await siteInfo(f.db);
    assert.equal(s.products.find((p) => p.id === f.fiveGalProductId)?.priceCents, 52000);
    await updateProduct(f.db, f.admin, f.fiveGalProductId, { pricePerBottleCents: 50000 });
  });

  test('zones with their days, and the business number', async () => {
    const s = await siteInfo(f.db);
    assert.deepEqual(s.zones.find((z) => z.name === 'Red Hills')?.days, ['Tue', 'Thu']);
    assert.equal(s.phone, '876-528-6112');
  });
});

describe('website orders', () => {
  test('needs a name, a phone, an item, and an address to deliver to', async () => {
    await assert.rejects(submitWebsiteOrder(f.db, guest({ phone: '' })), /phone/);
    await assert.rejects(submitWebsiteOrder(f.db, guest({ lines: [] })), /at least one item/);
    await assert.rejects(submitWebsiteOrder(f.db, guest({ addressLine1: '' })), /street address/);
    // Collecting needs no address.
    const r = await submitWebsiteOrder(f.db, guest({ fulfilment: 'Collect', addressLine1: '', city: '', parish: '' }));
    assert.match(r.reference, /^WEB-\d{6}$/);
  });

  test('a co-pack product cannot be ordered from the website', async () => {
    await assert.rejects(submitWebsiteOrder(f.db, guest({ lines: [{ productId: coPackProductId, qty: 1 }] })),
      /no longer on sale/);
  });

  test('an account needs an email', async () => {
    await assert.rejects(submitWebsiteOrder(f.db, guest({ email: '', wantsAccount: true })), /email address is needed/);
  });

  test('the hidden field: looks accepted, stores nothing', async () => {
    const before = (await f.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM website_orders`)).n;
    await submitWebsiteOrder(f.db, guest({ website: 'http://spam' }));
    const after = (await f.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM website_orders`)).n;
    assert.equal(after, before);
  });

  test('booking makes the customer, the order and the login, at list price', async () => {
    const { reference } = await submitWebsiteOrder(f.db, guest({ wantsAccount: true, noEmpties: true }));
    const list = await listWebsiteOrders(f.db, f.office, 'Pending') as Array<{ id: string; reference: string }>;
    const w = list.find((x) => x.reference === reference)!;
    await assert.rejects(bookWebsiteOrder(f.db, f.office, w.id), /requires role admin/);

    const r = await bookWebsiteOrder(f.db, f.admin, w.id, { deliveryDate: '2026-10-29' });
    const c = await f.db.one<{ name: string; account_type: string; price_tier_id: string | null; user_id: string | null }>(
      `SELECT name, account_type, price_tier_id, user_id FROM customers WHERE id = $1`, [r.customerId]);
    assert.equal(c.name, 'Grace Brown');
    assert.equal(c.account_type, 'Individual');
    assert.equal(c.price_tier_id, null);
    assert.ok(c.user_id, 'a login was made');
    assert.ok(r.invitation?.link);

    const lines = await f.db.query<{ product_id: string; cases: number; loose_bottles: number }>(
      `SELECT product_id, cases, loose_bottles FROM order_line_items WHERE order_id = $1`, [r.orderId]);
    assert.ok(lines.some((l) => l.product_id === f.fiveGalProductId && Number(l.loose_bottles) === 4));
    assert.ok(lines.some((l) => l.product_id === f.casedProductId && Number(l.cases) === 2));
    // No empties to swap: the bottle charge line is added the usual way, if a
    // bottle-charge product exists; either way the order stands.
    const o = await f.db.one<{ requested_delivery_date: string }>(
      `SELECT requested_delivery_date::text FROM customer_orders WHERE id = $1`, [r.orderId]);
    assert.equal(o.requested_delivery_date, '2026-10-29');

    await assert.rejects(bookWebsiteOrder(f.db, f.admin, w.id), /already been booked/);
  });

  test('booked for a customer already on file: no new customer', async () => {
    const { reference } = await submitWebsiteOrder(f.db, guest({ email: 'ap@bluemountain.jm', phone: '8765551234' }));
    const list = await listWebsiteOrders(f.db, f.admin, 'Pending') as Array<{ id: string; reference: string; possible_matches: Array<{ id: string }> | null }>;
    const w = list.find((x) => x.reference === reference)!;
    assert.ok(w.possible_matches?.some((m) => m.id === f.customerId), 'spots the customer by email or phone');
    const n0 = (await f.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM customers`)).n;
    const r = await bookWebsiteOrder(f.db, f.admin, w.id, { existingCustomerId: f.customerId });
    assert.equal(r.customerId, f.customerId);
    assert.equal((await f.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM customers`)).n, n0);
  });

  test('declined with a reason', async () => {
    const { reference } = await submitWebsiteOrder(f.db, guest({ email: null }));
    const w = (await listWebsiteOrders(f.db, f.admin, 'Pending') as Array<{ id: string; reference: string }>)
      .find((x) => x.reference === reference)!;
    await declineWebsiteOrder(f.db, f.admin, w.id, 'Could not reach them');
    const row = await f.db.one<{ status: string; decline_reason: string }>(
      `SELECT status, decline_reason FROM website_orders WHERE id = $1`, [w.id]);
    assert.equal(row.status, 'Declined');
    assert.equal(row.decline_reason, 'Could not reach them');
  });
});
