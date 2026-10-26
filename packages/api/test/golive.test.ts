/**
 * Go-live (Everton, 25 Oct 2026): start fresh, then customers, then products
 * and prices.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { createOrder } from '../src/services/orders.ts';
import { markStop } from '../src/services/delivery.ts';
import { recordPayment } from '../src/services/payments.ts';
import { createEmployee } from '../src/services/labour.ts';
import { cleanupPreview, startFresh } from '../src/services/cleanup.ts';
import { importCustomers } from '../src/services/imports.ts';
import { importProducts } from '../src/services/productimport.ts';
import { customerPrices } from '../src/services/customers.ts';
import { businessToday } from '../src/services/core.ts';
import { addDays } from '@alka/shared';

let f: Fixture;
const count = async (table: string) => Number((await f.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table}`)).n);

before(async () => {
  f = await setupFixture();
  // A bit of everything, as the test site has.
  const day = addDays(businessToday(), 2);
  const o = await createOrder(f.db, f.office, { customerId: f.customerId, deliveryMode: 'Delivery', requestedDeliveryDate: day,
    lines: [{ productId: f.fiveGalProductId, looseBottles: 2 }] });
  const st = await f.db.one<{ id: string }>(`SELECT id FROM delivery_stops WHERE order_id = $1`, [o.id]);
  await markStop(f.db, f.driver, { stopId: st.id, outcome: 'Delivered', bottlesDeliveredFull: 2, bottlesEmptiesPickedUp: 1 } as never);
  await recordPayment(f.db, f.office, { customerId: f.otherCustomerId, amountCents: 50000, method: 'Cash' } as never);
  await createEmployee(f.db, f.admin, { name: 'Loader One', payBasis: 'Hourly', rateCents: 50000 });
  await f.db.query(`INSERT INTO delivery_zones (name, sort_order) VALUES ('Kingston', 10)`);
  await f.db.query(`INSERT INTO price_tiers (name) VALUES ('Retail'), ('Wholesale'), ('Distributor')`);
  await f.db.query(`INSERT INTO brands (name, type, label_source) VALUES ('Island Fresh','Third-Party Co-Pack','Customer-supplied')`);
});
after(async () => { await f.close(); });

describe('Start fresh', () => {
  test('the preview counts what goes and lists customers and logins', async () => {
    await assert.rejects(cleanupPreview(f.db, f.office), /requires role admin/);
    const p = await cleanupPreview(f.db, f.admin);
    assert.ok(p.counts.find((c) => c.label.startsWith('Orders'))!.count >= 1);
    assert.ok(p.counts.find((c) => c.label === 'Payments')!.count >= 1);
    assert.ok(p.customers.some((c) => c.name === 'Blue Mountain Offices'));
    assert.ok(p.logins.find((u) => u.you)!.role === 'admin');
    assert.deepEqual(p.clientBrands, ['Island Fresh']);
  });

  test('refused without CLEAR or a sensible invoice number, and for office staff', async () => {
    await assert.rejects(startFresh(f.db, f.admin, { confirm: 'yes', nextInvoiceNumber: 16393 }), /type CLEAR/);
    await assert.rejects(startFresh(f.db, f.admin, { confirm: 'CLEAR', nextInvoiceNumber: 0 }), /first new invoice/);
    await assert.rejects(startFresh(f.db, f.office, { confirm: 'CLEAR', nextInvoiceNumber: 16393 }), /requires role admin/);
  });

  test('removes every transaction; keeps settings, tiers, the own brand, ticked customers and logins', async () => {
    await f.db.query(`INSERT INTO system_settings (key, value) VALUES ('whatsapp_number', '8765286112')
                      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    const r = await startFresh(f.db, f.admin, {
      confirm: 'clear', nextInvoiceNumber: 16393,
      keepCustomerIds: [f.customerId], keepUserIds: [f.office.id],
    });
    assert.equal(r.nextInvoiceNumber, 'INV-016393');
    for (const t of ['customer_orders', 'invoices', 'payments', 'delivery_sheets', 'delivery_stops', 'products',
      'price_lists', 'customer_prices', 'employees', 'delivery_zones', 'customer_bottle_moves', 'inventory_transactions',
      'finished_goods_stock', 'approval_requests']) {
      assert.equal(await count(t), 0, `${t} is empty`);
    }
    // One entry: the clean-up itself.
    assert.equal(await count('audit_log'), 1);
    const names = (await f.db.query<{ name: string }>(`SELECT name FROM customers ORDER BY name`)).map((c) => c.name);
    assert.deepEqual(names, ['Blue Mountain Offices']);
    const kept = await f.db.one<{ delivery_zone: string | null; phone: string }>(
      `SELECT delivery_zone, phone FROM customers WHERE id = $1`, [f.customerId]);
    assert.equal(kept.delivery_zone, null, 'the zone list is gone, so the zone is blanked');
    assert.equal(kept.phone, '8765551234', 'customer information stays');
    const users = (await f.db.query<{ name: string }>(`SELECT name FROM users ORDER BY name`)).map((u) => u.name);
    assert.deepEqual(users, ['Admin', 'Office'], 'the administrator doing it and the ticked login');
    assert.equal(await count('price_tiers'), 4, 'tier names stay');
    assert.deepEqual((await f.db.query<{ name: string }>(`SELECT name FROM brands`)).map((b) => b.name), ['Alka Vida']);
    assert.equal((await f.db.one<{ value: string }>(`SELECT value FROM system_settings WHERE key = 'whatsapp_number'`)).value, '8765286112');
    const pool = await f.db.one<{ clean_ready: number }>(`SELECT clean_ready FROM five_gal_bottle_pool LIMIT 1`);
    assert.equal(Number(pool.clean_ready), 0);
  });
});

describe('Customers after the clean-up', () => {
  test('price tier and status columns; a kept customer gets their balance, keeping their details', async () => {
    const rows = [
      { name: 'Blue Mountain Offices', customerType: 'Corporate', priceTier: 'Corporate', phone: '000',
        deliveryZone: 'Boulevard', deliveryDays: 'Tue', openingBalanceCents: 150000,
        openItems: [{ reference: '16001', type: 'Invoice', date: '2026-10-01', dueDate: '2026-10-31', openCents: 150000 }] },
      { name: 'Tropical Catering LTD.', customerType: 'Corporate', priceTier: 'Wholesale', email: 't@example.com' },
      { name: 'Alka Lyfe Distribution ALD', customerType: 'Distributor', priceTier: 'Distributor', email: 'a@example.com',
        bottledBrands: 'Alka Lyfe; Sky Drops', canOrderOwnBrand: 'Yes' },
      { name: 'Ava Nash', customerType: 'Individual', priceTier: 'Retail', status: 'Inactive', phone: '1',
        openingBalanceCents: 150000, openItems: [{ reference: '15500', type: 'Invoice', date: '2026-08-01', openCents: 150000 }] },
    ];
    const dry = await importCustomers(f.db, f.office, { rows, asOf: '2026-10-25', dryRun: true });
    assert.equal(dry.withErrors, 0, JSON.stringify(dry.rows.filter((r) => r.errors.length)));
    assert.equal(dry.toUpdate, 1);
    assert.equal(dry.toCreate, 3);
    assert.equal(dry.totalBalanceCents, 300000);
    const bad = await importCustomers(f.db, f.office, { rows: [{ name: 'X', priceTier: 'Gold' }], asOf: '2026-10-25', dryRun: true });
    assert.match(bad.rows[0].errors[0], /not one of the price tiers/);

    await importCustomers(f.db, f.office, { rows, asOf: '2026-10-25', holdAutoEmails: false });
    const blue = await f.db.one<{ phone: string; delivery_zone: string; tier: string; bal: number }>(
      `SELECT c.phone, c.delivery_zone, t.name AS tier, b.balance_cents AS bal FROM customers c
       JOIN price_tiers t ON t.id = c.price_tier_id JOIN customer_balances b ON b.customer_id = c.id
       WHERE c.id = $1`, [f.customerId]);
    assert.equal(blue.phone, '8765551234', 'details kept, not overwritten by the file');
    assert.equal(blue.delivery_zone, 'Boulevard');
    assert.equal(blue.tier, 'Corporate');
    assert.equal(Number(blue.bal), 150000);
    const ava = await f.db.one<{ active: boolean; auto_statements: boolean; bal: number }>(
      `SELECT c.active, c.auto_statements, b.balance_cents AS bal FROM customers c
       JOIN customer_balances b ON b.customer_id = c.id WHERE c.name = 'Ava Nash'`);
    assert.equal(ava.active, false);
    assert.equal(ava.auto_statements, false, 'inactive customers are never emailed automatically');
    assert.equal(Number(ava.bal), 150000, 'kept with her balance');
    const trop = await f.db.one<{ tier: string }>(
      `SELECT t.name AS tier FROM customers c JOIN price_tiers t ON t.id = c.price_tier_id WHERE c.name = 'Tropical Catering LTD.'`);
    assert.equal(trop.tier, 'Wholesale');
  });
});

describe('Products and prices', () => {
  const products = () => [
    { name: 'Alka Vida 1.5 L', brand: 'Alka Vida', size: '1.5L', bottlesPerCase: 12, listPriceCents: 208000,
      tierPrices: { Retail: 208000, Corporate: 208000, Wholesale: 127456, Distributor: 89130 } },
    { name: 'Alka Vida 5 Gallon', brand: 'Alka Vida', size: '5gal', bottlesPerCase: 0, returnable: 'Yes', listPriceCents: 50000,
      tierPrices: { Retail: 50000, Corporate: 60000, Wholesale: 60000, Distributor: 60000 } },
    { name: '5 Gallon Bottle', bottleCharge: 'Yes', listPriceCents: 130435 },
    { name: 'Sky Drops 1.5 L', brand: 'Sky Drops', bottledFor: 'Alka Lyfe Distribution ALD', size: '1.5L', bottlesPerCase: 12, listPriceCents: 67913 },
    { name: 'Cool Cool 500 ml', brand: 'Cool Cool', bottledFor: 'Melkleen Distributors Ltd', size: '500ml', bottlesPerCase: 24, listPriceCents: 71306 },
  ];
  const specials = () => [{ customer: 'Alka Lyfe Distribution ALD', product: 'Alka Vida 1.5 L', priceCents: 96342 }];

  test('checked first; a client not yet in the app or an unknown tier stops it', async () => {
    const r = await importProducts(f.db, f.admin, { products: products(), specials: specials(), dryRun: true });
    const cool = r.products.find((p) => p.name === 'Cool Cool 500 ml')!;
    assert.equal(cool.action, 'error');
    assert.match(cool.errors[0], /not a customer in the app/);
    const odd = await importProducts(f.db, f.admin, { products: [{ name: 'X', bottlesPerCase: 12, listPriceCents: 1, tierPrices: { Gold: 5 } }], dryRun: true });
    assert.match(odd.products[0].errors[0], /no "Gold" price tier/);
    await assert.rejects(importProducts(f.db, f.office, { products: products(), dryRun: true }), /requires role admin/);
    await assert.rejects(importProducts(f.db, f.admin, { products: products(), specials: specials() }), /nothing was brought in/);
    assert.equal(await count('products'), 0);
  });

  test('brings in products, tier prices, client brands, special prices and the bottle charge', async () => {
    const rows = products().filter((p) => p.name !== 'Cool Cool 500 ml');
    const r = await importProducts(f.db, f.admin, { products: rows, specials: specials() });
    assert.equal(r.withErrors, 0);
    assert.equal(r.toCreate, 4);
    assert.deepEqual(r.newBrands, [], 'the customer upload already added the client brands');

    const ald = await f.db.one<{ id: string }>(`SELECT id FROM customers WHERE name = 'Alka Lyfe Distribution ALD'`);
    const trop = await f.db.one<{ id: string }>(`SELECT id FROM customers WHERE name = 'Tropical Catering LTD.'`);
    const price = async (customerId: string, product: string) => {
      const list = await customerPrices(f.db, customerId) as Array<{ name: string; price_per_case_cents: number; price_per_bottle_cents: number; bottles_per_case: number }>;
      const p = list.find((x) => x.name === product);
      return p ? Number(Number(p.bottles_per_case) > 0 ? p.price_per_case_cents : p.price_per_bottle_cents) : null;
    };
    assert.equal(await price(ald.id, 'Alka Vida 1.5 L'), 96342, 'ALD special price');
    assert.equal(await price(trop.id, 'Alka Vida 1.5 L'), 127456, 'Wholesale tier');
    assert.equal(await price(trop.id, 'Alka Vida 5 Gallon'), 60000, '5 gallon at the Corporate rate on Wholesale');
    assert.equal(await price(f.customerId, 'Alka Vida 1.5 L'), 208000, 'Corporate pays Retail for cases');
    assert.equal(await price(ald.id, 'Sky Drops 1.5 L'), 67913, 'ALD sees its own brand');
    assert.equal(await price(trop.id, 'Sky Drops 1.5 L'), null, 'nobody else sees it');
    const bottle = await f.db.query<{ name: string; price_per_bottle_cents: number }>(
      `SELECT name, price_per_bottle_cents FROM products WHERE is_bottle_charge`);
    assert.equal(bottle.length, 1);
    assert.equal(Number(bottle[0].price_per_bottle_cents), 130435);
  });

  test('uploading again updates rather than duplicating', async () => {
    const rows = products().filter((p) => p.name !== 'Cool Cool 500 ml');
    rows[0].listPriceCents = 210000;
    const r = await importProducts(f.db, f.admin, { products: rows, specials: specials() });
    assert.equal(r.toUpdate, 4);
    assert.equal(await count('products'), 4);
    const p = await f.db.one<{ price_per_case_cents: number }>(`SELECT price_per_case_cents FROM products WHERE name = 'Alka Vida 1.5 L'`);
    assert.equal(Number(p.price_per_case_cents), 210000);
  });

  test('the first new invoice carries on from QuickBooks', async () => {
    const day = addDays(businessToday(), 3);
    const prod = await f.db.one<{ id: string }>(`SELECT id FROM products WHERE name = 'Alka Vida 5 Gallon'`);
    const o = await createOrder(f.db, f.office, { customerId: f.customerId, deliveryMode: 'Delivery', requestedDeliveryDate: day,
      lines: [{ productId: prod.id, looseBottles: 1 }] });
    const st = await f.db.one<{ id: string }>(`SELECT id FROM delivery_stops WHERE order_id = $1`, [o.id]);
    const r = await markStop(f.db, f.office, { stopId: st.id, outcome: 'Delivered' } as never);
    const inv = await f.db.one<{ invoice_number: string }>(`SELECT invoice_number FROM invoices WHERE id = $1`, [r.invoiceId]);
    assert.equal(inv.invoice_number, 'INV-016393');
    assert.equal(o.orderNumber, 'SO-001000');
  });
});
