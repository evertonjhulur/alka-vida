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
import {
  setSupplierMaterial, createRawMaterial, updateRawMaterial, deleteRawMaterial,
  restoreRawMaterial, listRawMaterials, createMaterialCategory,
  updateMaterialCategory, deleteMaterialCategory, listMaterialCategories,
} from '../src/services/catalog.ts';
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

/* ------------------------------------------------------------------ */

describe('An admin can correct the material catalogue', () => {
  // A real user id with a different role: the audit trail is a foreign key,
  // so an invented id fails on the write rather than on the role check.
  const driver = (): Actor => ({ id: admin.id, name: 'Driver', role: 'driver' });
  const office = (): Actor => ({ id: admin.id, name: 'Office', role: 'user' });

  test('a reorder point can be changed, and a size can be CLEARED', async () => {
    const { id } = await createRawMaterial(db, admin, {
      name: 'Trial cap', category: 'Cap', sizeSpec: '28mm', reorderPoint: 100,
    });

    await updateRawMaterial(db, admin, id, { reorderPoint: 250 });
    let row = await db.one<{ reorder_point: string; size_spec: string | null }>(
      `SELECT reorder_point::text, size_spec FROM raw_materials WHERE id = $1`, [id]);
    assert.equal(Number(row.reorder_point), 250);
    assert.equal(row.size_spec, '28mm', 'a field nobody touched must not move');

    // The COALESCE version of this update could change a size but never
    // remove one - an empty box read as "leave it alone".
    await updateRawMaterial(db, admin, id, { sizeSpec: '' });
    row = await db.one(`SELECT reorder_point::text, size_spec FROM raw_materials WHERE id = $1`,
      [id]);
    assert.equal(row.size_spec, null, 'an emptied size must actually clear');
    assert.equal(Number(row.reorder_point), 250, 'and must not disturb anything else');

    await deleteRawMaterial(db, admin, id);
  });

  test('a material nothing ever used is deleted outright', async () => {
    const { id } = await createRawMaterial(db, admin, { name: 'Typo material', category: 'Cap' });
    const out = await deleteRawMaterial(db, admin, id);

    assert.equal(out.deleted, true);
    assert.equal(out.retired, false);
    const left = await db.query(`SELECT id FROM raw_materials WHERE id = $1`, [id]);
    assert.equal(left.length, 0, 'a material nobody ever touched leaves nothing behind');
  });

  /**
   * The invariant behind the whole delete design: a material that has been
   * bought carries the cost of work already done. Removing it would either be
   * refused by the database or would tear that record out from under past
   * production, so it is withdrawn from use instead.
   */
  test('a material with history is withdrawn from use, never deleted', async () => {
    const capId = await materialId('28mm cap');
    const before = await db.one<{ qty: string }>(
      `SELECT quantity_on_hand::text AS qty FROM raw_materials WHERE id = $1`, [capId]);

    const out = await deleteRawMaterial(db, admin, capId);

    assert.equal(out.deleted, false);
    assert.equal(out.retired, true);
    assert.ok(out.reasons.length > 0, 'it must say WHY it could not be deleted');
    assert.ok(out.reasons.some((r) => /recipe/.test(r)),
      `a cap on a product recipe should say so - got ${JSON.stringify(out.reasons)}`);

    const after = await db.one<{ qty: string; retired_at: string | null }>(
      `SELECT quantity_on_hand::text AS qty, retired_at FROM raw_materials WHERE id = $1`, [capId]);
    assert.ok(after.retired_at, 'it is withdrawn');
    assert.equal(after.qty, before.qty, 'its stock, and so its value, is untouched');

    const batches = await db.one<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM material_batches WHERE raw_material_id = $1`, [capId]);
    assert.ok(Number(batches.n) > 0, 'and its FIFO cost history survives');
  });

  test('a withdrawn material never asks to be reordered', async () => {
    const capId = await materialId('28mm cap');
    // Put it below its reorder point while withdrawn.
    await db.query(
      `UPDATE raw_materials SET reorder_point = quantity_on_hand + 1 WHERE id = $1`, [capId]);

    const listed = await listRawMaterials(db);
    const cap = listed.find((m) => (m as { id: string }).id === capId) as
      { needs_reorder: boolean; retired_at: string | null };
    assert.ok(cap.retired_at, 'still withdrawn');
    assert.equal(cap.needs_reorder, false,
      'buying more of something you have stopped using is exactly the wrong prompt');

    await restoreRawMaterial(db, admin, capId);
    const back = (await listRawMaterials(db)).find((m) => (m as { id: string }).id === capId) as
      { needs_reorder: boolean; retired_at: string | null };
    assert.equal(back.retired_at, null, 'brought back');
    assert.equal(back.needs_reorder, true, 'and it asks to be reordered again');

    await db.query(`UPDATE raw_materials SET reorder_point = 0 WHERE id = $1`, [capId]);
  });

  /**
   * Withdrawing a material must leave every product still made from it
   * exactly as it was. The first cut of the raw-materials screen filtered
   * withdrawn materials out of the list the BOM editor ALSO used to look up
   * each line's cost and component type, so a withdrawn component silently
   * showed a cost of zero and would have been relabelled 'Water' on the next
   * save. The recipe is the record of how the product is made; retiring the
   * purchase of a material says nothing about that.
   */
  test('withdrawing a material leaves the recipes made from it untouched', async () => {
    const labelId = await materialId('280ml label');
    const before = await db.query<{ product_id: string; component_type: string; quantity: string }>(
      `SELECT product_id, component_type, quantity::text FROM bom_line_items
       WHERE raw_material_id = $1 ORDER BY product_id`, [labelId]);
    assert.ok(before.length > 0, 'the fixture needs this label on at least one recipe');

    await deleteRawMaterial(db, admin, labelId);

    const after = await db.query<{ product_id: string; component_type: string; quantity: string }>(
      `SELECT product_id, component_type, quantity::text FROM bom_line_items
       WHERE raw_material_id = $1 ORDER BY product_id`, [labelId]);
    assert.deepEqual(after, before, 'the recipe is how the product is made, not how it is bought');

    // And the line still finds its material, so it can still be costed.
    const product = before[0].product_id;
    const bom = await db.query<{ raw_material_id: string; raw_material_name: string }>(
      `SELECT b.raw_material_id, rm.name AS raw_material_name
       FROM bom_line_items b JOIN raw_materials rm ON rm.id = b.raw_material_id
       WHERE b.product_id = $1 AND b.raw_material_id = $2`, [product, labelId]);
    assert.equal(bom.length, 1, 'a withdrawn component must not vanish from its recipe');
    assert.equal(bom[0].raw_material_name, '280ml label');

    await restoreRawMaterial(db, admin, labelId);
  });

  test('only an admin removes a material', async () => {
    const { id } = await createRawMaterial(db, office(), { name: 'Office cap', category: 'Cap' });
    await assert.rejects(() => deleteRawMaterial(db, office(), id), /role|permitted/i);
    await assert.rejects(() => deleteRawMaterial(db, driver(), id), /role|permitted/i);
    await deleteRawMaterial(db, admin, id);
  });
});

describe('Categories and sizes are the office\'s to change', () => {
  test('a brand new category takes materials and recipes', async () => {
    await createMaterialCategory(db, admin, { name: 'Carton', sizes: ['12s', '24s'] });

    const cats = await listMaterialCategories(db);
    const carton = cats.find((c) => (c as { name: string }).name === 'Carton') as
      { id: string; sizes: string[] };
    assert.deepEqual(carton.sizes, ['12s', '24s'], 'sizes come back in the order given');

    // The real proof that the closed list is gone: a material files under it.
    const { id } = await createRawMaterial(db, admin, {
      name: 'Shipping carton', category: 'Carton', sizeSpec: '24s',
    });
    const row = await db.one<{ category: string }>(
      `SELECT category FROM raw_materials WHERE id = $1`, [id]);
    assert.equal(row.category, 'Carton');

    // And onto a product recipe, which carried the same closed list.
    const product = await productId('Alka Vida 500ml');
    await db.query(
      `INSERT INTO bom_line_items (product_id, raw_material_id, component_type, quantity)
       VALUES ($1,$2,'Carton',0.05)`, [product, id]);

    // Renaming has to carry BOTH across, or the material answers to a name
    // that no longer exists and drops off the screen.
    await updateMaterialCategory(db, admin, carton.id, { name: 'Cartons' });
    const renamed = await db.one<{ category: string }>(
      `SELECT category FROM raw_materials WHERE id = $1`, [id]);
    assert.equal(renamed.category, 'Cartons', 'the material followed the rename');
    const line = await db.one<{ component_type: string }>(
      `SELECT component_type FROM bom_line_items WHERE raw_material_id = $1`, [id]);
    assert.equal(line.component_type, 'Cartons', 'and so did its recipe line');

    await db.query(`DELETE FROM bom_line_items WHERE raw_material_id = $1`, [id]);
    await db.query(`DELETE FROM raw_materials WHERE id = $1`, [id]);
    await deleteMaterialCategory(db, admin, carton.id);
  });

  test('a category with materials under it is withdrawn, not deleted', async () => {
    const bottles = (await listMaterialCategories(db))
      .find((c) => (c as { name: string }).name === 'Bottle') as { id: string };

    const out = await deleteMaterialCategory(db, admin, bottles.id);
    assert.equal(out.deleted, false);
    assert.equal(out.retired, true);
    assert.ok(out.materialCount > 0, 'it says how many are filed under it');

    const still = await db.one<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM raw_materials WHERE category = 'Bottle'`);
    assert.ok(Number(still.n) > 0, 'nothing filed under it was orphaned');

    // A withdrawn category takes nothing new.
    await assert.rejects(
      () => createRawMaterial(db, admin, { name: 'Late bottle', category: 'Bottle' }),
      /retired|withdrawn/i,
    );

    await db.query(`UPDATE material_categories SET retired_at = NULL WHERE id = $1`, [bottles.id]);
  });

  test('a category nobody uses is deleted outright, and only by an admin', async () => {
    await assert.rejects(
      () => createMaterialCategory(db, { id: admin.id, name: 'Office', role: 'user' },
        { name: 'Sundries' }),
      /role|permitted/i,
    );

    const { id } = await createMaterialCategory(db, admin, { name: 'Sundries' });
    const out = await deleteMaterialCategory(db, admin, id);
    assert.equal(out.deleted, true);
    const left = await db.query(`SELECT id FROM material_categories WHERE id = $1`, [id]);
    assert.equal(left.length, 0);
  });

  test('a material cannot be filed under a category that does not exist', async () => {
    await assert.rejects(
      () => createRawMaterial(db, admin, { name: 'Mystery', category: 'Nonsense' }),
      /no category/i,
    );
  });
});
