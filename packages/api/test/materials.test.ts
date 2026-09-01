/**
 * Raw materials, supplier pricing and bills of material.
 *
 * These run against the seeded catalogue rather than the bare fixture,
 * because the catalogue itself is part of what must be right: a wrong BOM
 * costs every run made against it.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPgliteDb, type Db } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { seed } from '../src/db/seed.ts';
import { setSupplierMaterial } from '../src/services/catalog.ts';
import {
  createPurchaseOrder, receivePurchaseOrder, issueMaterial, lookupSupplierPrice,
} from '../src/services/inventory.ts';
import { businessToday } from '../src/services/core.ts';
import { createOrder } from '../src/services/orders.ts';
import type { Actor } from '../src/services/core.ts';

let db: Db;
let admin: Actor;

before(async () => {
  db = await createPgliteDb();
  await migrate(db, { quiet: true });
  await seed(db, { quiet: true });
  const u = await db.one<{ id: string; name: string }>(
    `SELECT id, name FROM users WHERE role = 'admin'`);
  admin = { id: u.id, name: u.name, role: 'admin' };
});
after(async () => { await db.close(); });

const materialId = async (name: string) =>
  (await db.one<{ id: string }>(`SELECT id FROM raw_materials WHERE name = $1`, [name])).id;
const productId = async (name: string) =>
  (await db.one<{ id: string }>(`SELECT id FROM products WHERE name = $1`, [name])).id;

describe('The seeded catalogue matches the real product line', () => {
  test('every product has a bill of materials', async () => {
    const missing = await db.query<{ name: string }>(
      `SELECT p.name FROM products p
       WHERE NOT EXISTS (SELECT 1 FROM bom_line_items b WHERE b.product_id = p.id)
         AND p.name LIKE 'Alka Vida%'`,
    );
    assert.deepEqual(missing.map((m) => m.name), [],
      'a product with no BOM cannot be costed or produced');
  });

  test('the handle is on the 5L and NOWHERE else', async () => {
    const withHandle = await db.query<{ name: string }>(
      `SELECT p.name FROM bom_line_items b
       JOIN products p ON p.id = b.product_id
       WHERE b.component_type = 'Handle' ORDER BY p.name`,
    );
    assert.deepEqual(withHandle.map((r) => r.name), ['Alka Vida 5L'],
      'the 5-gallon carried a handle it never uses, and was costed for it');
  });

  test('the 5-gallon carries no label line - bottles are rotated', async () => {
    const p5gal = await productId('Alka Vida 5 Gallon');
    const labels = await db.query(
      `SELECT id FROM bom_line_items WHERE product_id = $1 AND component_type = 'Label'`,
      [p5gal],
    );
    assert.equal(labels.length, 0,
      'a returning bottle is relabelled as needed, not once per bottle filled');
  });

  test('each cap size is on the products it actually fits', async () => {
    const capped = await db.query<{ product: string; cap: string }>(
      `SELECT p.name AS product, rm.name AS cap
       FROM bom_line_items b
       JOIN products p ON p.id = b.product_id
       JOIN raw_materials rm ON rm.id = b.raw_material_id
       WHERE b.component_type = 'Cap' ORDER BY p.name`,
    );
    const capOf = (product: string) => capped.find((c) => c.product === product)?.cap;
    assert.equal(capOf('Alka Vida 280ml'), '28mm cap');
    assert.equal(capOf('Alka Vida 500ml'), '28mm cap');
    assert.equal(capOf('Alka Vida 1.5L'), '28mm cap');
    assert.equal(capOf('Alka Vida 5L'), '48mm cap');
    assert.equal(capOf('Alka Vida 5 Gallon'), '55mm cap');
  });
});

describe('Supplier pricing drives the purchase order', () => {
  test('a price list entered against a supplier resolves at the right break', async () => {
    const supplier = (await db.one<{ id: string }>(
      `INSERT INTO suppliers (name) VALUES ('New Supplier Ltd') RETURNING id`)).id;
    const cap55 = await materialId('55mm cap');

    // Exactly what the Suppliers screen sends: a standard cost and breaks.
    await setSupplierMaterial(db, admin, {
      supplierId: supplier, rawMaterialId: cap55, unitCostCents: 1_000,
      priceBreaks: [{ minQty: 500, unitCostCents: 900 }, { minQty: 2_000, unitCostCents: 800 }],
    });

    assert.equal(await lookupSupplierPrice(db, supplier, cap55, 100), 1_000, 'below every break');
    assert.equal(await lookupSupplierPrice(db, supplier, cap55, 500), 900, 'exactly on a break');
    assert.equal(await lookupSupplierPrice(db, supplier, cap55, 5_000), 800, 'the best break');

    const po = await createPurchaseOrder(db, admin, {
      supplierId: supplier,
      lines: [{ rawMaterialId: cap55, quantityOrdered: 3_000 }],
    });
    assert.equal(po.subtotalCents, 3_000 * 800, 'the PO took the volume price');

    // Re-saving replaces that supplier's pricing rather than stacking breaks.
    await setSupplierMaterial(db, admin, {
      supplierId: supplier, rawMaterialId: cap55, unitCostCents: 1_100,
      priceBreaks: [{ minQty: 500, unitCostCents: 1_050 }],
    });
    assert.equal(await lookupSupplierPrice(db, supplier, cap55, 5_000), 1_050,
      'the old 2,000+ break is gone, not still winning');

    const line = await db.one<{ unit_cost_cents: number }>(
      `SELECT unit_cost_cents FROM po_line_items WHERE po_id = $1`, [po.id]);
    assert.equal(Number(line.unit_cost_cents), 800,
      'a price change never rewrites an order already raised');
  });

  test('what is received at is what the stock costs', async () => {
    const supplier = (await db.one<{ id: string }>(
      `INSERT INTO suppliers (name) VALUES ('Receipt Test Ltd') RETURNING id`)).id;
    const cap48 = await materialId('48mm cap');
    await setSupplierMaterial(db, admin, {
      supplierId: supplier, rawMaterialId: cap48, unitCostCents: 950,
      priceBreaks: [{ minQty: 1_000, unitCostCents: 880 }],
    });

    const po = await createPurchaseOrder(db, admin, {
      supplierId: supplier,
      lines: [{ rawMaterialId: cap48, quantityOrdered: 2_000 }],
    });
    const line = await db.one<{ id: string }>(
      `SELECT id FROM po_line_items WHERE po_id = $1`, [po.id]);

    // A short delivery: half now, and the order stays open for the rest.
    const partial = await receivePurchaseOrder(db, admin, po.id, [
      { poLineItemId: line.id, quantityReceived: 1_200 },
    ]);
    assert.equal(partial.status, 'Partially Received');

    const batch = await db.one<{ unit_cost_cents: number; quantity_remaining: number }>(
      `SELECT unit_cost_cents, quantity_remaining FROM material_batches
       WHERE po_line_item_id = $1`, [line.id]);
    assert.equal(Number(batch.unit_cost_cents), 880, 'costed at what was actually paid');
    assert.equal(Number(batch.quantity_remaining), 1_200);

    const rest = await receivePurchaseOrder(db, admin, po.id, [
      { poLineItemId: line.id, quantityReceived: 800 },
    ]);
    assert.equal(rest.status, 'Received', 'complete once every line has met its quantity');
  });
});

describe('Material used outside production', () => {
  test('a 5gal label issue draws FIFO and is costed at what was paid', async () => {
    const label5gal = await materialId('5 gallon label');
    const before = await db.one<{ q: number }>(
      `SELECT quantity_on_hand q FROM raw_materials WHERE id = $1`, [label5gal]);

    const out = await issueMaterial(db, admin, {
      rawMaterialId: label5gal, quantity: 40, reason: 'relabelled returned bottles',
    });

    assert.equal(out.quantity, 40);
    assert.ok(out.totalCostCents > 0, 'the labels cost something real');

    const after = await db.one<{ q: number }>(
      `SELECT quantity_on_hand q FROM raw_materials WHERE id = $1`, [label5gal]);
    assert.equal(Number(after.q), Number(before.q) - 40, 'stock fell by what was used');

    const txn = await db.one<{ direction: string; reference: string; total_cost_cents: number }>(
      `SELECT direction, reference, total_cost_cents FROM inventory_transactions
       WHERE item_id = $1 AND reference_type = 'Manual' AND direction = 'out'
       ORDER BY txn_date DESC LIMIT 1`, [label5gal]);
    assert.equal(txn.direction, 'out');
    assert.match(txn.reference, /relabelled/);
    assert.equal(Number(txn.total_cost_cents), out.totalCostCents);
  });

  test('an issue of nothing, or of a material that is gone, is refused', async () => {
    const label5gal = await materialId('5 gallon label');
    await assert.rejects(
      () => issueMaterial(db, admin, { rawMaterialId: label5gal, quantity: 0 }),
      /more than zero/,
    );
    await assert.rejects(
      () => issueMaterial(db, admin, {
        rawMaterialId: '00000000-0000-0000-0000-000000000000', quantity: 1,
      }),
      /no longer exists/,
    );
  });

  test('a driver cannot issue material', async () => {
    const label5gal = await materialId('5 gallon label');
    await assert.rejects(
      () => issueMaterial(db, { id: admin.id, name: 'D', role: 'driver' },
        { rawMaterialId: label5gal, quantity: 1 }),
      /not permitted|role/i,
    );
  });
});

describe('Business dates are Jamaican dates, not UTC ones', () => {
  /**
   * Jamaica is UTC-5 all year. From 7pm local until midnight, current_date
   * is already tomorrow - so for five hours every evening, exactly when a
   * route settles and the counter cashes up, every document was dated a day
   * into the future and the customer statement sorted wrongly.
   */
  test('business_today() is today in Jamaica', async () => {
    const row = await db.one<{ d: string }>(`SELECT business_today()::text AS d`);
    assert.equal(row.d, businessToday(),
      'the database and the application must agree on what day it is');
  });

  test('an invoice raised now carries the Jamaican date', async () => {
    const customer = (await db.one<{ id: string }>(
      `INSERT INTO customers (name, phone, email) VALUES ('Date Test Ltd','8','d@x.jm')
       RETURNING id`)).id;
    const inv = (await db.one<{ invoice_date: string }>(
      `INSERT INTO invoices (invoice_number, customer_id, subtotal_cents, gct_cents,
         grand_total_cents)
       VALUES ('INV-DATE-TEST', $1, 100, 15, 115)
       RETURNING invoice_date::text AS invoice_date`, [customer]));
    assert.equal(inv.invoice_date, businessToday());
  });

  test('an order with no requested date lands on today Jamaican round', async () => {
    const customer = await db.one<{ id: string }>(
      `SELECT id FROM customers WHERE delivery_zone IS NOT NULL LIMIT 1`);
    const product = await db.one<{ id: string }>(
      `SELECT id FROM products WHERE bottles_per_case > 0 LIMIT 1`);

    const order = await createOrder(db, admin, {
      customerId: customer.id, deliveryMode: 'Delivery',
      lines: [{ productId: product.id, cases: 1 }],
    });
    const sheet = await db.one<{ d: string }>(
      `SELECT ds.delivery_date::text AS d
       FROM delivery_stops st JOIN delivery_sheets ds ON ds.id = st.delivery_sheet_id
       WHERE st.order_id = $1`, [order.id]);

    assert.equal(sheet.d, businessToday(),
      'an order taken at half past seven in the evening belongs on TODAY round');
  });
});
