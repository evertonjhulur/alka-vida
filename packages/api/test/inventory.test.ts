/** Supplier pricing, purchasing, production feasibility and stock counts. */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import {
  createSupplier, setSupplierMaterial, listSuppliers,
  createRawMaterial, listRawMaterials, setBom, getBom, materialBatches,
} from '../src/services/catalog.ts';
import {
  createPurchaseOrder, receivePurchaseOrder, completeProduction,
  productionFeasibility, listPurchaseOrders, getPurchaseOrder,
  finishedGoods, listInventoryTransactions, lookupSupplierPrice,
} from '../src/services/inventory.ts';
import { recordCount, reconcileCount, listAudits } from '../src/services/audits.ts';

let f: Fixture;
let supplierId: string;
let preformId: string;
let capId: string;
let productId: string;

before(async () => {
  f = await setupFixture();

  supplierId = (await createSupplier(f.db, f.office, {
    name: 'Caribbean Preforms Ltd', contactPerson: 'M. Chen', phone: '876-555-0100',
  })).id;

  preformId = (await createRawMaterial(f.db, f.office, {
    name: '500ml preform', category: 'Bottle', sizeSpec: '18g PET', reorderPoint: 5_000,
  })).id;
  capId = (await createRawMaterial(f.db, f.office, {
    name: '28mm cap', category: 'Cap', reorderPoint: 1_000,
  })).id;

  productId = f.casedProductId;
  await setBom(f.db, f.office, productId, [
    { rawMaterialId: preformId, componentType: 'Bottle', quantity: 1 },
    { rawMaterialId: capId, componentType: 'Cap', quantity: 1 },
  ]);
});
after(async () => { await f.close(); });

describe('Supplier pricing', () => {
  test('a material can be attached to a supplier with volume price breaks', async () => {
    await setSupplierMaterial(f.db, f.office, {
      supplierId, rawMaterialId: preformId, unitCostCents: 900,
      priceBreaks: [
        { minQty: 10_000, unitCostCents: 850 },
        { minQty: 50_000, unitCostCents: 780 },
      ],
    });
    await setSupplierMaterial(f.db, f.office, {
      supplierId, rawMaterialId: capId, unitCostCents: 400,
    });

    const suppliers = await listSuppliers(f.db);
    const s = suppliers.find((x) => x.id === supplierId)!;
    assert.equal(s.materials.length, 2);
    const preform = s.materials.find((m) => m.rawMaterialId === preformId)!;
    assert.equal(preform.unitCostCents, 900);
    assert.equal(preform.priceBreaks.length, 2);
  });

  test('the best matching tier is chosen for a quantity', async () => {
    assert.equal(await lookupSupplierPrice(f.db, supplierId, preformId, 500), 900);
    assert.equal(await lookupSupplierPrice(f.db, supplierId, preformId, 10_000), 850);
    assert.equal(await lookupSupplierPrice(f.db, supplierId, preformId, 60_000), 780);
  });

  test('re-saving replaces that supplier price breaks rather than stacking them', async () => {
    await setSupplierMaterial(f.db, f.office, {
      supplierId, rawMaterialId: preformId, unitCostCents: 900,
      priceBreaks: [{ minQty: 10_000, unitCostCents: 820 }],
    });
    const s = (await listSuppliers(f.db)).find((x) => x.id === supplierId)!;
    const preform = s.materials.find((m) => m.rawMaterialId === preformId)!;
    assert.equal(preform.priceBreaks.length, 1, 'the old breaks were replaced');
    assert.equal(await lookupSupplierPrice(f.db, supplierId, preformId, 60_000), 820);

    // Restore for later tests.
    await setSupplierMaterial(f.db, f.office, {
      supplierId, rawMaterialId: preformId, unitCostCents: 900,
      priceBreaks: [
        { minQty: 10_000, unitCostCents: 850 },
        { minQty: 50_000, unitCostCents: 780 },
      ],
    });
  });
});

describe('Purchase orders', () => {
  test('lines auto-price from the supplier tier for the quantity ordered', async () => {
    const po = await createPurchaseOrder(f.db, f.office, {
      supplierId,
      lines: [
        { rawMaterialId: preformId, quantityOrdered: 20_000 }, // hits the 850 tier
        { rawMaterialId: capId, quantityOrdered: 20_000 },     // standard 400
      ],
    });
    const detail = await getPurchaseOrder(f.db, po.id) as { lines: Array<Record<string, unknown>> };
    const preformLine = detail.lines.find((l) => l.raw_material_id === preformId)!;
    assert.equal(Number(preformLine.unit_cost_cents), 850);

    // 20,000 x 8.50 + 20,000 x 4.00 = 170,000.00 + 80,000.00
    assert.equal(po.subtotalCents, 20_000 * 850 + 20_000 * 400);
    assert.equal(po.grandTotalCents, po.subtotalCents + Math.round(po.subtotalCents * 0.15));
  });

  test('receiving creates a FIFO batch and raises stock', async () => {
    const po = await createPurchaseOrder(f.db, f.office, {
      supplierId, lines: [{ rawMaterialId: capId, quantityOrdered: 1_000, unitCostCents: 400 }],
    });
    const line = await f.db.one<{ id: string }>(
      `SELECT id FROM po_line_items WHERE po_id = $1`, [po.id],
    );
    const before = await f.db.one<{ q: number }>(
      `SELECT quantity_on_hand q FROM raw_materials WHERE id = $1`, [capId],
    );

    const result = await receivePurchaseOrder(f.db, f.office, po.id, [
      { poLineItemId: line.id, quantityReceived: 1_000 },
    ]);
    assert.equal(result.status, 'Received');
    assert.equal(result.batchIds.length, 1);

    const after = await f.db.one<{ q: number }>(
      `SELECT quantity_on_hand q FROM raw_materials WHERE id = $1`, [capId],
    );
    assert.equal(Number(after.q) - Number(before.q), 1_000);

    const batches = await materialBatches(f.db, capId) as Array<Record<string, unknown>>;
    assert.ok(batches.length >= 1);
  });

  test('a partial receipt leaves the order Partially Received', async () => {
    const po = await createPurchaseOrder(f.db, f.office, {
      supplierId, lines: [{ rawMaterialId: capId, quantityOrdered: 500, unitCostCents: 400 }],
    });
    const line = await f.db.one<{ id: string }>(
      `SELECT id FROM po_line_items WHERE po_id = $1`, [po.id],
    );
    const r = await receivePurchaseOrder(f.db, f.office, po.id, [
      { poLineItemId: line.id, quantityReceived: 200 },
    ]);
    assert.equal(r.status, 'Partially Received');

    const list = await listPurchaseOrders(f.db, 'Partially Received') as Array<{ id: string }>;
    assert.ok(list.some((p) => p.id === po.id));
  });
});

describe('Production feasibility', () => {
  test('reports a shortfall before anything is consumed', async () => {
    // Only caps and a little preform stock exist so far.
    const check = await productionFeasibility(f.db, productId, 100_000);
    assert.equal(check.canProduce, false);
    const short = check.components.filter((c) => c.shortfall > 0);
    assert.ok(short.length > 0, 'the shortage is named before committing');

    const stock = await f.db.query(`SELECT id FROM production_batches`);
    assert.equal(stock.length, 0, 'nothing was produced by merely checking');
  });

  test('confirms a run that stock can cover, and prices it from real batches', async () => {
    // Receive enough preforms to build 500 bottles.
    const po = await createPurchaseOrder(f.db, f.office, {
      supplierId, lines: [{ rawMaterialId: preformId, quantityOrdered: 600, unitCostCents: 900 }],
    });
    const line = await f.db.one<{ id: string }>(
      `SELECT id FROM po_line_items WHERE po_id = $1`, [po.id],
    );
    await receivePurchaseOrder(f.db, f.office, po.id, [
      { poLineItemId: line.id, quantityReceived: 600 },
    ]);

    const check = await productionFeasibility(f.db, productId, 500);
    assert.equal(check.canProduce, true);
    // 500 preforms @ 9.00 + 500 caps @ 4.00
    assert.equal(check.estimatedCostCents, 500 * 900 + 500 * 400);
  });
});

describe('Production runs', () => {
  test('consume materials FIFO and add finished goods', async () => {
    // 500ml is 24 per case: 20 cases plus 4 loose = 484 bottles.
    const run = await completeProduction(f.db, f.office, {
      productId, cases: 20, looseBottles: 4, operator: 'Line 1',
    });
    assert.equal(run.bottlesProduced, 484);
    assert.ok(run.materialCostCents > 0);

    const fg = await finishedGoods(f.db) as Array<Record<string, unknown>>;
    const row = fg.find((p) => p.product_id === productId)!;
    assert.equal(Number(row.bottles_on_hand), 484);
    assert.equal(Number(row.full_cases), 20, '484 bottles is 20 whole cases');

    const txns = await listInventoryTransactions(f.db, { itemType: 'RawMaterial' }) as Array<Record<string, unknown>>;
    assert.ok(txns.some((tx) => tx.direction === 'out'), 'materials were drawn');
  });

  test('refuse a run that stock cannot cover, leaving stock untouched', async () => {
    const before = await f.db.one<{ q: number }>(
      `SELECT quantity_on_hand q FROM raw_materials WHERE id = $1`, [preformId],
    );
    await assert.rejects(
      completeProduction(f.db, f.office, { productId, cases: 10_000 }),
      /insufficient stock/,
    );
    const after = await f.db.one<{ q: number }>(
      `SELECT quantity_on_hand q FROM raw_materials WHERE id = $1`, [preformId],
    );
    assert.equal(Number(after.q), Number(before.q), 'the failed run rolled back completely');
  });
});

describe('Raw material management view', () => {
  test('shows stock, reorder flag, batch position and who supplies it', async () => {
    const materials = await listRawMaterials(f.db) as Array<Record<string, unknown>>;
    const preform = materials.find((m) => m.id === preformId)!;

    assert.equal(preform.name, '500ml preform');
    assert.ok(Number(preform.open_batches) >= 0);
    assert.equal(preform.needs_reorder, true, 'below its 5,000 reorder point');
    assert.equal((preform.suppliers as unknown[]).length, 1);
    assert.equal((preform.suppliers as Array<{ name: string }>)[0].name, 'Caribbean Preforms Ltd');
  });

  test('a bill of material reads back with its material names', async () => {
    const bom = await getBom(f.db, productId) as Array<Record<string, unknown>>;
    assert.equal(bom.length, 2);
    assert.ok(bom.some((b) => b.raw_material_name === '500ml preform'));
  });
});

describe('Stock counts (InventoryAudit)', () => {
  test('recording a count changes NO stock until it is reconciled', async () => {
    const before = await f.db.one<{ q: number }>(
      `SELECT quantity_on_hand q FROM raw_materials WHERE id = $1`, [capId],
    );
    const count = await recordCount(f.db, f.office, {
      itemType: 'RawMaterial', itemId: capId,
      countedQty: Number(before.q) - 50, notes: 'monthly count',
    });
    assert.equal(count.discrepancy, -50);

    const after = await f.db.one<{ q: number }>(
      `SELECT quantity_on_hand q FROM raw_materials WHERE id = $1`, [capId],
    );
    assert.equal(Number(after.q), Number(before.q), 'stock untouched while the count is Open');

    const open = await listAudits(f.db, 'Open') as Array<{ id: string }>;
    assert.ok(open.some((a) => a.id === count.id));
  });

  test('reconciling a shortage writes it off FIFO at real batch cost', async () => {
    const before = await f.db.one<{ q: number }>(
      `SELECT quantity_on_hand q FROM raw_materials WHERE id = $1`, [capId],
    );
    const count = await recordCount(f.db, f.office, {
      itemType: 'RawMaterial', itemId: capId, countedQty: Number(before.q) - 100,
    });
    const result = await reconcileCount(f.db, f.admin, count.id, 'breakage in store room');

    assert.equal(result.adjusted, -100);
    assert.equal(result.valueCents, 100 * 400, 'valued at the real 4.00 batch cost');

    const after = await f.db.one<{ q: number }>(
      `SELECT quantity_on_hand q FROM raw_materials WHERE id = $1`, [capId],
    );
    assert.equal(Number(after.q), Number(before.q) - 100);

    const txn = await f.db.one<{ direction: string; total_cost_cents: number; notes: string }>(
      `SELECT direction, total_cost_cents, notes FROM inventory_transactions
       WHERE item_id = $1 AND reference_type = 'Adjustment'
       ORDER BY txn_date DESC LIMIT 1`, [capId],
    );
    assert.equal(txn.direction, 'out');
    assert.match(txn.notes, /FIFO/);
  });

  test('damaged units are written off along with the shortfall', async () => {
    const before = await f.db.one<{ q: number }>(
      `SELECT quantity_on_hand q FROM raw_materials WHERE id = $1`, [capId],
    );
    // All stock physically present, but 25 of it is unusable.
    const count = await recordCount(f.db, f.office, {
      itemType: 'RawMaterial', itemId: capId,
      countedQty: Number(before.q), damagedQty: 25,
    });
    assert.equal(count.discrepancy, -25, 'damaged units do not count as usable stock');

    await reconcileCount(f.db, f.admin, count.id);
    const after = await f.db.one<{ q: number }>(
      `SELECT quantity_on_hand q FROM raw_materials WHERE id = $1`, [capId],
    );
    assert.equal(Number(after.q), Number(before.q) - 25);
  });

  test('an overage is added and valued at the blended average', async () => {
    const before = await f.db.one<{ q: number }>(
      `SELECT quantity_on_hand q FROM raw_materials WHERE id = $1`, [capId],
    );
    const count = await recordCount(f.db, f.office, {
      itemType: 'RawMaterial', itemId: capId, countedQty: Number(before.q) + 40,
    });
    const result = await reconcileCount(f.db, f.admin, count.id);

    assert.equal(result.adjusted, 40);
    const txn = await f.db.one<{ direction: string; notes: string }>(
      `SELECT direction, notes FROM inventory_transactions
       WHERE item_id = $1 AND reference_type = 'Adjustment'
       ORDER BY txn_date DESC LIMIT 1`, [capId],
    );
    assert.equal(txn.direction, 'in');
    assert.match(txn.notes, /estimate/, 'an overage is priced as an estimate, and says so');
  });

  test('finished goods can be counted too', async () => {
    const count = await recordCount(f.db, f.office, {
      itemType: 'FinishedGoods', itemId: productId, countedQty: 480,
    });
    assert.equal(count.systemQty, 484);
    assert.equal(count.discrepancy, -4);

    await reconcileCount(f.db, f.admin, count.id);
    const fg = await finishedGoods(f.db) as Array<Record<string, unknown>>;
    assert.equal(Number(fg.find((p) => p.product_id === productId)!.bottles_on_hand), 480);
  });

  test('only an admin may reconcile, and never twice', async () => {
    const count = await recordCount(f.db, f.office, {
      itemType: 'FinishedGoods', itemId: productId, countedQty: 470,
    });
    await assert.rejects(reconcileCount(f.db, f.office, count.id), /requires role admin/);
    await reconcileCount(f.db, f.admin, count.id);
    await assert.rejects(reconcileCount(f.db, f.admin, count.id), /already been reconciled/);
  });

  test('a material headline quantity always equals the sum of its FIFO layers', async () => {
    // The valuation on the raw-material screen is the sum of the batch layers,
    // while the "on hand" figure is its own column. If those two ever drift
    // apart, every cost figure derived from them is wrong - so assert across
    // every material after all the receiving, production and adjusting above.
    const rows = await f.db.query<{ name: string; drift: string }>(
      `SELECT rm.name,
              rm.quantity_on_hand - COALESCE(SUM(mb.quantity_remaining),0) AS drift
       FROM raw_materials rm
       LEFT JOIN material_batches mb
         ON mb.raw_material_id = rm.id AND mb.status = 'Open' AND mb.quantity_remaining > 0
       GROUP BY rm.id, rm.name, rm.quantity_on_hand`,
    );
    for (const r of rows) {
      assert.equal(Number(r.drift), 0, `${r.name} drifted from its batch layers`);
    }
  });

  test('a shortage larger than the batches hold cannot desynchronise the two', async () => {
    // Contrived: a material whose headline quantity exceeds its batch layers.
    const orphan = (await createRawMaterial(f.db, f.office, {
      name: 'Orphan stock item', category: 'Label',
    })).id;
    await f.db.query(
      `UPDATE raw_materials SET quantity_on_hand = 100 WHERE id = $1`, [orphan],
    );

    // Count zero: the system thinks 100 exist but no batch backs any of them.
    const count = await recordCount(f.db, f.office, {
      itemType: 'RawMaterial', itemId: orphan, countedQty: 0,
    });
    await reconcileCount(f.db, f.admin, count.id);

    const after = await f.db.one<{ on_hand: string; batch_qty: string }>(
      `SELECT rm.quantity_on_hand AS on_hand,
              COALESCE(SUM(mb.quantity_remaining),0) AS batch_qty
       FROM raw_materials rm
       LEFT JOIN material_batches mb
         ON mb.raw_material_id = rm.id AND mb.status = 'Open' AND mb.quantity_remaining > 0
       WHERE rm.id = $1 GROUP BY rm.quantity_on_hand`,
      [orphan],
    );
    assert.equal(Number(after.on_hand), Number(after.batch_qty),
      'the write-off is limited to what the layers actually hold');
  });

  test('rejects impossible counts', async () => {
    await assert.rejects(
      recordCount(f.db, f.office, {
        itemType: 'RawMaterial', itemId: capId, countedQty: 10, damagedQty: 20,
      }),
      /cannot exceed/,
    );
    await assert.rejects(
      recordCount(f.db, f.office, {
        itemType: 'RawMaterial', itemId: capId, countedQty: -5,
      }),
      /cannot be negative/,
    );
  });
});
