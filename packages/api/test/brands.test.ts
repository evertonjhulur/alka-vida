/**
 * Bottled brands and the customer upload (Everton, 16 Oct 2026).
 *
 *   - A product bottled for one customer is never offered or sold to another;
 *     a customer can have several bottled brands; one who buys only their
 *     own brands is not offered or sold ours.
 *   - Walk-ins are only ever sold our own products.
 *   - The upload: a dry run writes nothing; the real run brings customers in
 *     with zones, days, brands and opening balances (per open QuickBooks
 *     item when they add up, else one line), skips names already on file,
 *     and refuses the whole file if any row is wrong.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { createOrder, editOrder } from '../src/services/orders.ts';
import { counterSale } from '../src/services/counter.ts';
import { customerPrices } from '../src/services/customers.ts';
import { createBrand, setCustomerBrands, listBrands, customerBrands, updateBrand } from '../src/services/brands.ts';
import { importCustomers, parseDays } from '../src/services/imports.ts';
import { createQuotation } from '../src/services/quotations.ts';

let f: Fixture;
let skyDrops: string; let alkaLyfeBrand: string; let coolCool: string;
let skyProduct: string; let lyfeProduct: string; let coolProduct: string;
let alkaLyfe: string; let melkleen: string;

const product = async (name: string, brandId: string) => (await f.db.one<{ id: string }>(
  `INSERT INTO products (name, brand_id, size, bottles_per_case, price_per_case_cents, price_per_bottle_cents)
   VALUES ($1,$2,'500ml',24,90000,0) RETURNING id`, [name, brandId])).id;
const customer = async (name: string) => (await f.db.one<{ id: string }>(
  `INSERT INTO customers (name, phone, email, delivery_address, delivery_zone)
   VALUES ($1,'876-555-0101','','1 Test Rd','Kingston') RETURNING id`, [name])).id;
const offered = async (customerId: string) =>
  (await customerPrices(f.db, customerId)).map((p) => (p as { name: string }).name).sort();

before(async () => {
  f = await setupFixture();
  skyDrops = (await createBrand(f.db, f.office, { name: 'Sky Drops', type: 'Third-Party Co-Pack' })).id;
  alkaLyfeBrand = (await createBrand(f.db, f.office, { name: 'Alka Lyfe', type: 'Third-Party Co-Pack' })).id;
  coolCool = (await createBrand(f.db, f.office, { name: 'Cool Cool', type: 'Third-Party Co-Pack' })).id;
  skyProduct = await product('Sky Drops 500ml', skyDrops);
  lyfeProduct = await product('Alka Lyfe 500ml', alkaLyfeBrand);
  coolProduct = await product('Cool Cool 500ml', coolCool);
  alkaLyfe = await customer('Alka Lyfe Distribution ALD');
  melkleen = await customer('Melkleen Distributors Ltd');
  await setCustomerBrands(f.db, f.office, alkaLyfe, { brandIds: [skyDrops, alkaLyfeBrand] });
  await setCustomerBrands(f.db, f.office, melkleen, { brandIds: [coolCool], buysOwnBrand: false });
});
after(async () => { await f.close(); });

const order = (customerId: string, productId: string) => createOrder(f.db, f.office, {
  customerId, deliveryMode: 'Pickup', requestedDeliveryDate: '2026-10-20',
  lines: [{ productId, cases: 1 }],
} as never);

describe('Bottled brands', () => {
  test('each customer is offered only what they may buy', async () => {
    assert.deepEqual(await offered(alkaLyfe),
      ['Alka Lyfe 500ml', 'Alka Vida 5 Gallon', 'Alka Vida 500ml', 'Sky Drops 500ml']);
    assert.deepEqual(await offered(melkleen), ['Cool Cool 500ml']);
    // Everyone else: our own products only.
    assert.deepEqual(await offered(f.customerId), ['Alka Vida 5 Gallon', 'Alka Vida 500ml']);
  });

  test('a bottled product cannot be put on anybody else\'s order, quote or counter sale', async () => {
    await assert.rejects(order(f.customerId, coolProduct), /Cool Cool 500ml is Cool Cool bottled for another customer/);
    await assert.rejects(order(alkaLyfe, coolProduct), /bottled for another customer/);
    await assert.rejects(createQuotation(f.db, f.office, {
      customerId: f.customerId, lines: [{ productId: skyProduct, cases: 1 }],
    } as never), /bottled for another customer/);
    await assert.rejects(counterSale(f.db, f.office, {
      lines: [{ productId: lyfeProduct, cases: 1 }],
    }), /bottled for another customer/);
    // Their own are fine.
    await order(alkaLyfe, skyProduct);
    await order(melkleen, coolProduct);
  });

  test('a customer who buys only their own brands is not sold ours', async () => {
    await assert.rejects(order(melkleen, f.casedProductId), /buys only their own bottled brands/);
    await order(alkaLyfe, f.casedProductId);
  });

  test('a line already on an order survives the brand being unlinked; a new one does not', async () => {
    const o = await order(alkaLyfe, lyfeProduct);
    await setCustomerBrands(f.db, f.office, alkaLyfe, { brandIds: [skyDrops] });
    await editOrder(f.db, f.office, o.id, { lines: [{ productId: lyfeProduct, cases: 2 }] } as never);
    await assert.rejects(order(alkaLyfe, lyfeProduct), /bottled for another customer/);
    await setCustomerBrands(f.db, f.office, alkaLyfe, { brandIds: [skyDrops, alkaLyfeBrand] });
  });

  test('a retired brand is no longer offered', async () => {
    await updateBrand(f.db, f.office, skyDrops, { active: false });
    assert.ok(!(await offered(alkaLyfe)).includes('Sky Drops 500ml'));
    await updateBrand(f.db, f.office, skyDrops, { active: true });
    assert.ok((await offered(alkaLyfe)).includes('Sky Drops 500ml'));
  });

  test('our own brand is never linked to one customer, and names are unique', async () => {
    await assert.rejects(setCustomerBrands(f.db, f.office, alkaLyfe, { brandIds: [f.brandId] }), /our own brand/);
    await assert.rejects(createBrand(f.db, f.office, { name: 'sky drops' }), /already a brand/);
    const list = await listBrands(f.db);
    const sky = list.find((b) => b.name === 'Sky Drops')!;
    assert.deepEqual(sky.customers.map((c) => c.name), ['Alka Lyfe Distribution ALD']);
    assert.equal(sky.product_count, 1);
    assert.deepEqual((await customerBrands(f.db, melkleen)), {
      buysOwnBrand: false, brands: [{ id: coolCool, name: 'Cool Cool', active: true }],
    });
  });
});

describe('Customer upload', () => {
  const rows = () => [
    { name: 'Treasure Isle Distributors', customerType: 'Distributor', email: 'treasure@example.com',
      deliveryAddress: 'Seawings Freight Forwarders, Ballater Ave', deliveryZone: 'Kingston', deliveryDays: 'Mon, Thu',
      openingBalanceCents: 43053000,
      openItems: [
        { reference: '15100', type: 'Invoice', date: '2026-04-16', dueDate: '2026-05-16', amountCents: 21526500, openCents: 21526500 },
        { reference: '15101', type: 'Invoice', date: '2026-05-01', dueDate: '2026-05-31', amountCents: 21526500, openCents: 21526500 },
      ] },
    { name: 'Living Hope', customerType: 'Corporate', phone: '876-555-0111', deliveryAddress: '248 Silver Sun Estate',
      billingAddress: 'PO Box 1, Spanish Town', parish: 'St. Catherine', deliveryZone: 'Spanish Town',
      bottledBrands: 'Living Water', canOrderOwnBrand: 'No', openingBalanceCents: 416350 },
    { name: 'Andrew Clarke', customerType: 'Individual', phone: '876-269-9507', deliveryAddress: '8A Ashenheim Road',
      openingBalanceCents: -450000 },
    { name: 'Adrianna', customerType: '', deliveryAddress: 'Calabar Mews' },
  ];

  test('delivery days read the way people write them', () => {
    assert.deepEqual(parseDays('Mon, Thu'), { days: ['Mon', 'Thu'], bad: [] });
    assert.deepEqual(parseDays('Thursday and monday'), { days: ['Mon', 'Thu'], bad: [] });
    assert.deepEqual(parseDays('Mon/Fri'), { days: ['Mon', 'Fri'], bad: [] });
    assert.deepEqual(parseDays('Someday').bad, ['Someday']);
  });

  test('a dry run explains every row and writes nothing', async () => {
    await f.db.query(`INSERT INTO delivery_zones (name, sort_order) VALUES ('Kingston', 10) ON CONFLICT DO NOTHING`);
    const before = await f.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM customers`);
    const r = await importCustomers(f.db, f.office, { rows: rows(), asOf: '2026-10-15', dryRun: true });
    assert.equal(r.toCreate, 4);
    assert.equal(r.withErrors, 0);
    assert.deepEqual(r.newZones, ['Spanish Town']);
    assert.deepEqual(r.newBrands, ['Living Water']);
    assert.equal(r.totalBalanceCents, 43053000 + 416350 - 450000);
    const ti = r.rows[0];
    assert.equal(ti.balanceAs, 'items'); assert.equal(ti.itemCount, 2);
    assert.match(ti.warnings.join(' '), /no "Distributor" price list/);
    assert.equal(r.rows[1].buysOwnBrand, false);
    assert.match(r.rows[3].warnings.join(' '), /brought in as Individual/);
    const after = await f.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM customers`);
    assert.equal(after.n, before.n);
  });

  test('a row with a mistake stops the whole file', async () => {
    const bad = rows(); bad[2].customerType = 'Wholesaler';
    await assert.rejects(importCustomers(f.db, f.office, { rows: bad, asOf: '2026-10-15' }), /nothing was brought in/);
    const n = await f.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM customers WHERE name = 'Living Hope'`);
    assert.equal(n.n, 0);
  });

  test('the real run brings them in with their balances', async () => {
    await f.db.query(`INSERT INTO price_tiers (name) VALUES ('Distributor')`);
    const r = await importCustomers(f.db, f.office, { rows: rows(), asOf: '2026-10-15', holdAutoEmails: true });
    assert.equal(r.created, 4);

    const ti = await f.db.one<Record<string, unknown>>(
      `SELECT c.*, pt.name AS tier, b.balance_cents FROM customers c
       LEFT JOIN price_tiers pt ON pt.id = c.price_tier_id
       LEFT JOIN customer_balances b ON b.customer_id = c.id WHERE c.name = 'Treasure Isle Distributors'`);
    assert.equal(ti.account_type, 'Corporate');
    assert.equal(ti.tier, 'Distributor');
    assert.deepEqual(ti.delivery_days, ['Mon', 'Thu']);
    assert.equal(Number(ti.balance_cents), 43053000);
    assert.equal(ti.auto_reminders, false);
    const invs = await f.db.query<{ invoice_number: string; status: string; due_date: string }>(
      `SELECT invoice_number, status, due_date::text FROM invoice_ledger WHERE customer_id = $1 ORDER BY invoice_number`, [ti.id]);
    assert.deepEqual(invs.map((i) => [i.invoice_number, i.status]), [['OB-15100', 'Overdue'], ['OB-15101', 'Overdue']]);

    const lh = await f.db.one<Record<string, unknown>>(
      `SELECT c.*, b.balance_cents FROM customers c LEFT JOIN customer_balances b ON b.customer_id = c.id
       WHERE c.name = 'Living Hope'`);
    assert.equal(lh.buys_own_brand, false);
    assert.equal(lh.parish, 'St Catherine');
    assert.equal(Number(lh.balance_cents), 416350);
    assert.deepEqual(await offered(lh.id as string), []);
    const billing = await f.db.query(`SELECT address_line1 FROM customer_addresses WHERE customer_id = $1 AND is_billing`, [lh.id]);
    assert.equal(billing.length, 1);
    const zone = await f.db.maybeOne(`SELECT 1 FROM delivery_zones WHERE name = 'Spanish Town'`);
    assert.ok(zone);

    const ac = await f.db.one<{ id: string; balance_cents: number }>(
      `SELECT c.id, b.balance_cents FROM customers c JOIN customer_balances b ON b.customer_id = c.id
       WHERE c.name = 'Andrew Clarke'`);
    assert.equal(Number(ac.balance_cents), -450000);
    const pay = await f.db.one<{ invoice_id: string | null; method: string; receipt_number: string }>(
      `SELECT invoice_id, method, receipt_number FROM payments WHERE customer_id = $1`, [ac.id]);
    assert.equal(pay.invoice_id, null); assert.equal(pay.method, 'Other'); assert.match(pay.receipt_number, /^RCT-/);

    const ad = await f.db.one<{ balance_cents: number }>(
      `SELECT b.balance_cents FROM customers c JOIN customer_balances b ON b.customer_id = c.id WHERE c.name = 'Adrianna'`);
    assert.equal(Number(ad.balance_cents), 0);
  });

  test('uploading the same file again skips everyone already in', async () => {
    const r = await importCustomers(f.db, f.office, { rows: rows(), asOf: '2026-10-15' });
    assert.equal(r.created, 0);
    assert.equal(r.toSkip, 4);
  });

  test('Open Items that do not add up come in as one balance line', async () => {
    const r = await importCustomers(f.db, f.office, { asOf: '2026-10-15', rows: [{
      name: 'Odd Sums Ltd', customerType: 'Corporate', openingBalanceCents: 100000,
      openItems: [{ reference: '9', openCents: 50000 }],
    }] });
    assert.equal(r.rows[0].balanceAs, 'single');
    const inv = await f.db.one<{ invoice_number: string; grand_total_cents: number }>(
      `SELECT i.invoice_number, i.grand_total_cents FROM invoices i JOIN customers c ON c.id = i.customer_id
       WHERE c.name = 'Odd Sums Ltd'`);
    assert.match(inv.invoice_number, /^OB-\d{6}$/);
    assert.equal(Number(inv.grand_total_cents), 100000);
  });
});
