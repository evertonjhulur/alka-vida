/**
 * Production and Purchasing reports (Everton, 13 Nov 2026).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { createSupplier, createRawMaterial } from '../src/services/catalog.ts';
import { createPurchaseOrder, receivePurchaseOrder, completeProduction, deleteProduction, editProduction, batchCodeSuggestion, listProductionBatches } from '../src/services/inventory.ts';
import { productionReport, purchasingReport, bucketOf } from '../src/services/opsreports.ts';
import { businessToday } from '../src/services/core.ts';
import { addDays } from '@alka/shared';

let f: Fixture;
before(async () => { f = await setupFixture(); });
after(async () => { await f.close(); });

describe('Production report', () => {
  test('runs by product and by day, with run numbers and who entered them; deleted runs left out', async () => {
    const today = businessToday();
    const a = await completeProduction(f.db, f.office, { productId: f.fiveGalProductId, looseBottles: 5, operator: 'Line 1' });
    const b = await completeProduction(f.db, f.admin, { productId: f.fiveGalProductId, looseBottles: 3 });
    const gone = await completeProduction(f.db, f.office, { productId: f.fiveGalProductId, looseBottles: 7 });
    await deleteProduction(f.db, f.admin, gone.batchId, 'entered twice', { evenIfShort: true });

    const r = await productionReport(f.db, today, today, 'day');
    assert.equal(r.totals.runs, 2);
    assert.equal(r.totals.bottles, 8);
    const p = r.products.find((x) => x.productId === f.fiveGalProductId)!;
    assert.equal(p.runs, 2); assert.equal(p.bottles, 8);
    assert.equal(r.periods.length, 1);
    assert.equal(r.periods[0].bottles[f.fiveGalProductId], 8);
    const runA = r.runs.find((x) => x.id === a.batchId)!;
    assert.match(runA.runNumber, /^PR-\d{4}$/);
    assert.equal(runA.enteredBy, f.office.name);
    assert.equal(runA.operator, 'Line 1');
    assert.equal(r.runs.find((x) => x.id === b.batchId)!.enteredBy, f.admin.name);
    assert.notEqual(runA.runNumber, r.runs.find((x) => x.id === b.batchId)!.runNumber, 'each run its own number');
    assert.ok(!r.runs.some((x) => x.id === gone.batchId), 'deleted run left out');

    const outside = await productionReport(f.db, addDays(today, 10), addDays(today, 20));
    assert.equal(outside.totals.runs, 0);
  });

  test('weeks run Monday to Sunday; months are calendar months', () => {
    assert.deepEqual(bucketOf('2026-11-13', 'week'), { key: '2026-11-09', label: 'Week of Mon 9 Nov', from: '2026-11-09', to: '2026-11-15' });
    assert.equal(bucketOf('2026-11-09', 'week').key, '2026-11-09');
    assert.equal(bucketOf('2026-11-15', 'week').key, '2026-11-09');
    assert.deepEqual(bucketOf('2026-02-10', 'month'), { key: '2026-02', label: 'Feb 2026', from: '2026-02-01', to: '2026-02-28' });
  });
});

describe('Batch numbers', () => {
  test('required for cased goods; the same brand that day suggests its batch; another brand has its own; edit and report carry it', async () => {
    const brand = await f.db.one<{ id: string }>(`SELECT brand_id AS id FROM products WHERE id = $1`, [f.casedProductId]);
    const other = await f.db.one<{ id: string }>(`INSERT INTO brands (name, type) VALUES ('Island Fresh', 'Third-Party Co-Pack') RETURNING id`);
    const p280 = await f.db.one<{ id: string }>(
      `INSERT INTO products (name, brand_id, size, bottles_per_case, price_per_case_cents, price_per_bottle_cents, is_returnable)
       VALUES ('Alka Vida 280ml', $1, '280ml', 24, 90000, 0, false) RETURNING id`, [brand.id]);
    const isl = await f.db.one<{ id: string }>(
      `INSERT INTO products (name, brand_id, size, bottles_per_case, price_per_case_cents, price_per_bottle_cents, is_returnable)
       VALUES ('Island Fresh 500ml', $1, '500ml', 24, 90000, 0, false) RETURNING id`, [other.id]);
    const day = addDays(businessToday(), -1);

    await assert.rejects(completeProduction(f.db, f.office, { productId: f.casedProductId, cases: 1, productionDate: day }), /batch number/);
    const first = await completeProduction(f.db, f.office, { productId: f.casedProductId, cases: 2, productionDate: day, batchCode: '  AV 1311  ' });
    // 5-gallon: no batch number needed.
    await completeProduction(f.db, f.office, { productId: f.fiveGalProductId, looseBottles: 2, productionDate: day });

    const s280 = await batchCodeSuggestion(f.db, p280.id, day);
    assert.equal(s280.suggested, 'AV 1311', 'Alka Vida 280ml the same day: the same batch');
    const sIsl = await batchCodeSuggestion(f.db, isl.id, day);
    assert.equal(sIsl.suggested, null, 'another brand: its own number');
    assert.equal(sIsl.sameDay.length, 1);
    assert.equal((await batchCodeSuggestion(f.db, p280.id, addDays(day, -1))).suggested, null, 'another day: nothing to suggest');

    await editProduction(f.db, f.admin, first.batchId, { batchCode: 'AV-1311' });
    const listed = (await listProductionBatches(f.db) as Array<{ id: string; batch_code: string }>).find((r) => r.id === first.batchId)!;
    assert.equal(listed.batch_code, 'AV-1311');
    await assert.rejects(editProduction(f.db, f.admin, first.batchId, { batchCode: ' ' }), /batch number/);

    const r = await productionReport(f.db, day, day);
    assert.equal(r.runs.find((x) => x.id === first.batchId)!.batchCode, 'AV-1311');
  });
});

describe('Purchasing report', () => {
  test('ordered, received and still to come, by supplier; an older open PO stays in; closed ones drop out; drafts count', async () => {
    const sup = (await createSupplier(f.db, f.office, { name: 'Polypet Test' })).id;
    const cap = (await createRawMaterial(f.db, f.office, { name: 'Test cap', category: 'Cap' })).id;
    const po = await createPurchaseOrder(f.db, f.office, {
      supplierId: sup, lines: [{ rawMaterialId: cap, quantityOrdered: 1_000, unitCostCents: 400 }],
    });
    // A PO counts once it has gone to the supplier.
    await f.db.query(`UPDATE purchase_orders SET status = 'Sent', expected_delivery_date = $2 WHERE id = $1 AND status = 'Draft'`,
      [po.id, addDays(businessToday(), -2)]);
    const line = await f.db.one<{ id: string; value: string }>(
      `SELECT id, (line_total_cents + gct_cents + env_tax_cents)::text AS value FROM po_line_items WHERE po_id = $1`, [po.id]);
    await receivePurchaseOrder(f.db, f.office, po.id, [{ poLineItemId: line.id, quantityReceived: 400 }]);

    const today = businessToday();
    const r = await purchasingReport(f.db, today, today);
    const s = r.suppliers.find((x) => x.supplierId === sup)!;
    assert.equal(s.orders.length, 1);
    const o = s.orders[0];
    const value = Number(line.value);
    assert.equal(o.orderedCents, value);
    assert.equal(o.receivedCents, Math.round(value * 0.4));
    assert.equal(o.toComeCents, Math.round(value * 0.6));
    assert.equal(o.lines[0].toCome, 600);
    assert.equal(o.overdue, true, 'expected two days ago, 600 still to come');
    assert.equal(s.overdue, 1);

    // A draft (printed or phoned, never emailed) is an order too.
    const draft = await createPurchaseOrder(f.db, f.office, {
      supplierId: sup, lines: [{ rawMaterialId: cap, quantityOrdered: 10, unitCostCents: 400 }],
    });
    const withDraft = await purchasingReport(f.db, today, today);
    const d = withDraft.suppliers.find((x) => x.supplierId === sup)!.orders.find((x) => x.poId === draft.id)!;
    assert.equal(d.status, 'Draft');
    assert.equal(d.lines[0].toCome, 10);
    await f.db.query(`UPDATE purchase_orders SET status = 'Cancelled' WHERE id = $1`, [draft.id]);

    // Next month: raised earlier, but still has something to come, so it stays.
    const later = await purchasingReport(f.db, addDays(today, 40), addDays(today, 60));
    const again = later.suppliers.find((x) => x.supplierId === sup)!.orders[0];
    assert.equal(again.poId, po.id);
    assert.equal(again.raisedInPeriod, false);

    // Closed short: nothing more to come, so it drops out of later periods.
    await f.db.query(`UPDATE purchase_orders SET status = 'Partially Received - Closed' WHERE id = $1`, [po.id]);
    const closed = await purchasingReport(f.db, today, today);
    const c = closed.suppliers.find((x) => x.supplierId === sup)!.orders[0];
    assert.equal(c.toComeCents, 0);
    assert.equal(c.lines[0].notComing, 600);
    assert.equal(c.overdue, false);
    const gone = await purchasingReport(f.db, addDays(today, 40), addDays(today, 60));
    assert.ok(!gone.suppliers.some((x) => x.supplierId === sup));
  });
});
