/** The 5-gallon jug cycle (3 Nov 2026), end to end. */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, stopsOf, type Fixture } from './helpers.ts';
import { createOrder } from '../src/services/orders.ts';
import { markStop } from '../src/services/delivery.ts';
import { getInvoiceLedger } from '../src/services/invoices.ts';
import {
  poolFigures, recordJugsBought, scrapJugs, customerHoldings, poolHistory,
} from '../src/services/bottles.ts';
import {
  completeProduction, productionFeasibility, createPurchaseOrder, receivePurchaseOrder,
} from '../src/services/inventory.ts';
import { recordCount } from '../src/services/audits.ts';

let f: Fixture;
before(async () => { f = await setupFixture(); });
after(async () => { await f.close(); });

const empties = async () => Number((await f.db.one<{ q: string }>(
  `SELECT quantity_on_hand q FROM raw_materials WHERE id = $1`, [f.jugMaterialId])).q);
const fullInStock = async () => Number((await f.db.maybeOne<{ q: number }>(
  `SELECT quantity_on_hand q FROM finished_goods_stock WHERE product_id = $1`, [f.fiveGalProductId]))?.q ?? 0);
/** Deliver `full` bottles, collect `back` empties, report `lost` missing. */
async function deliver(
  date: string, full: number, back: number, lost = 0, customerId?: string,
) {
  const order = await createOrder(f.db, f.office, {
    customerId: customerId ?? f.customerId,
    deliveryMode: 'Delivery',
    requestedDeliveryDate: date,
    lines: [{ productId: f.fiveGalProductId, looseBottles: full }],
  });
  const [stop] = await stopsOf(f.db, order.deliverySheetId!);
  return markStop(f.db, f.driver, {
    stopId: stop.id, outcome: 'Delivered',
    bottlesDeliveredFull: full,
    bottlesEmptiesPickedUp: back,
    bottlesLostDamaged: lost,
  });
}

describe('The cycle: empties -> production -> full -> customers -> empties', () => {
  test('a 5-gallon run fills jugs from the empties and puts them in stock', async () => {
    const e0 = await empties(); const full0 = await fullInStock();
    const r = await completeProduction(f.db, f.office, { productId: f.fiveGalProductId, looseBottles: 60 });
    assert.equal(await empties(), e0 - 60, 'one empty per jug filled');
    assert.equal(await fullInStock(), full0 + 60);
    assert.equal(r.empties?.drawn, 60);
    assert.equal(r.materialCostCents, 0, 'filling a jug adds no jug cost to the water');
  });

  test('jugs scrapped on a run come off the empties as well, and count as a loss', async () => {
    const e0 = await empties(); const fig0 = await poolFigures(f.db);
    const r = await completeProduction(f.db, f.office, { productId: f.fiveGalProductId, looseBottles: 10, jugsScrapped: 2 });
    assert.equal(await empties(), e0 - 12);
    assert.equal(r.empties?.scrapped, 2);
    assert.equal((await poolFigures(f.db)).scrapped, fig0.scrapped + 2);
  });

  test('scrapping only applies to a 5-gallon run', async () => {
    await assert.rejects(
      completeProduction(f.db, f.office, { productId: f.casedProductId, cases: 1, jugsScrapped: 1 }),
      /only apply to a 5-gallon run/);
  });

  test('a delivery takes full jugs off stock but does not touch the empties', async () => {
    const e0 = await empties(); const full0 = await fullInStock();
    await deliver('2027-01-04', 20, 0);
    assert.equal(await empties(), e0);
    assert.equal(await fullInStock(), full0 - 20);
  });

  test('empties the driver takes back go into the empties at the plant', async () => {
    const e0 = await empties();
    await deliver('2027-01-11', 10, 15);
    assert.equal(await empties(), e0 + 15);
  });

  test('a run may draw more than the empties on record: allowed, and flagged', async () => {
    const e0 = await empties();
    const want = e0 + 5;
    const feas = await productionFeasibility(f.db, f.fiveGalProductId, want);
    assert.equal(feas.empties?.short, 5, 'the screen is told how many short');
    const r = await completeProduction(f.db, f.office, { productId: f.fiveGalProductId, looseBottles: want });
    assert.equal(r.empties?.left, -5, 'below zero until the empties are recorded or counted');
    // back to a sensible figure for the tests that follow
    await recordJugsBought(f.db, f.office, { quantity: 50, unitCostCents: 83341 });
    assert.equal(await empties(), 45);
  });
});

describe('Bottle pool shows the same figures as Stock', () => {
  test('each figure is read from its one home', async () => {
    const fig = await poolFigures(f.db);
    assert.equal(fig.jug?.id, f.jugMaterialId);
    assert.equal(fig.empties, await empties(), 'empties = the jug raw material');
    assert.equal(fig.full, await fullInStock(), 'full = finished goods of the 5-gallon product');
    const holdings = await customerHoldings(f.db) as Array<{ holding: number }>;
    assert.equal(fig.withCustomers, holdings.reduce((a, h) => a + Number(h.holding), 0),
      'out with customers = the customer accounts');
    assert.equal(fig.inCycle, fig.empties + fig.full + fig.withCustomers);
  });
});

describe('New jugs', () => {
  test('bought without a PO: into the empties, cost recorded once and never layered', async () => {
    const e0 = await empties();
    await recordJugsBought(f.db, f.office, { quantity: 4, unitCostCents: 83341, notes: 'new customer' });
    assert.equal(await empties(), e0 + 4);
    const open = await f.db.one<{ n: number }>(
      `SELECT COUNT(*)::int n FROM material_batches WHERE raw_material_id = $1 AND status = 'Open'`, [f.jugMaterialId]);
    assert.equal(Number(open.n), 0, 'no open FIFO layer: the jug is never charged into a run');
    const cost = await f.db.one<{ c: number }>(
      `SELECT total_cost_cents c FROM inventory_transactions
       WHERE item_id = $1 AND reference_type = 'JugsBought' ORDER BY txn_date DESC LIMIT 1`, [f.jugMaterialId]);
    assert.equal(Number(cost.c), 4 * 83341);
  });

  test('bought on a PO: received into the empties, cost on the PO', async () => {
    const supplier = await f.db.one<{ id: string }>(`INSERT INTO suppliers (name) VALUES ('Polypet') RETURNING id`);
    const po = await createPurchaseOrder(f.db, f.admin, {
      supplierId: supplier.id, lines: [{ rawMaterialId: f.jugMaterialId, quantityOrdered: 50, unitCostCents: 83341 }],
    });
    const line = await f.db.one<{ id: string }>(`SELECT id FROM po_line_items WHERE po_id = $1`, [po.id]);
    const e0 = await empties();
    await receivePurchaseOrder(f.db, f.admin, po.id, [{ poLineItemId: line.id, quantityReceived: 50 }]);
    assert.equal(await empties(), e0 + 50);
    const open = await f.db.one<{ n: number }>(
      `SELECT COUNT(*)::int n FROM material_batches WHERE raw_material_id = $1 AND status = 'Open'`, [f.jugMaterialId]);
    assert.equal(Number(open.n), 0);
  });

  test('a purchase of nothing, or with no jug ticked, is refused', async () => {
    await assert.rejects(recordJugsBought(f.db, f.office, { quantity: 0 }), /how many new jugs/);
  });
});

describe('Scrapped and counted', () => {
  test('jugs scrapped at the plant need a reason and come off the empties', async () => {
    const e0 = await empties();
    await assert.rejects(scrapJugs(f.db, f.office, { quantity: 2, reason: ' ' }), /say why/);
    await scrapJugs(f.db, f.office, { quantity: 2, reason: 'cracked' });
    assert.equal(await empties(), e0 - 2);
  });

  test('a count of the empties resets that one line, with no cost layers', async () => {
    await recordCount(f.db, f.admin, {
      itemType: 'RawMaterial', itemId: f.jugMaterialId, countedQty: 69, apply: true, notes: 'recount of the empties',
    });
    // The 15 empties of the 2027-01-11 round are dated after the count, so
    // they are carried forward on top of it, like any movement after a count.
    assert.equal(await empties(), 69 + 15);
    assert.equal((await poolFigures(f.db)).empties, 69 + 15);
    const open = await f.db.one<{ n: number }>(
      `SELECT COUNT(*)::int n FROM material_batches WHERE raw_material_id = $1 AND status = 'Open'`, [f.jugMaterialId]);
    assert.equal(Number(open.n), 0);
  });
});

describe('Losses', () => {
  test('a jug reported lost comes off the customer and counts as a loss', async () => {
    const before = await poolFigures(f.db);
    await deliver('2027-02-01', 5, 0, 4);
    const after = await poolFigures(f.db);
    assert.equal(after.lostOnRoad, before.lostOnRoad + 4);
    assert.equal(after.withCustomers, before.withCustomers + 5 - 4);
  });

  test('a loss is a business loss and is never billed to the customer', async () => {
    const result = await deliver('2027-02-08', 6, 0, 6);
    // 6 bottles at the Corporate rate of 450.00 = 2,700.00 + 15% = 3,105.00.
    const invoice = await getInvoiceLedger(f.db, result.invoiceId!);
    assert.equal(invoice!.grandTotalCents, 310_500);
    const lines = await f.db.query(
      `SELECT id FROM invoice_line_items WHERE invoice_id = $1`, [result.invoiceId],
    );
    assert.equal(lines.length, 1, 'no extra charge line for the lost bottles');
  });
});

describe('Movement history', () => {
  test('the empties have a real history on the stock ledger', async () => {
    const history = await poolHistory(f.db) as Array<{ reference_type: string; txn_day: string }>;
    const kinds = new Set(history.map((h) => h.reference_type));
    for (const k of ['ProductionBatch', 'BottleReturn', 'JugsBought', 'JugsScrapped', 'PurchaseOrder', 'Adjustment']) {
      assert.ok(kinds.has(k), `${k} is recorded`);
    }
    for (const h of history) assert.match(String(h.txn_day), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('Who is holding bottles', () => {
  test('reports each customer net position from deliveries and returns', async () => {
    const holdings = await customerHoldings(f.db) as Array<{
      customer_id: string; delivered: number; returned: number;
      lost: number; holding: number;
    }>;
    const mine = holdings.find((h) => h.customer_id === f.customerId)!;
    assert.ok(mine, 'the delivered-to customer appears');

    // Delivered 20 + 10 + 5 + 6 = 41, returned 15, lost 4 + 6 = 10.
    assert.equal(Number(mine.delivered), 41);
    assert.equal(Number(mine.returned), 15);
    assert.equal(Number(mine.lost), 10);
    assert.equal(Number(mine.holding), 41 - 15 - 10, 'net bottles still with them');
  });

  test('a customer who was never delivered to is not listed', async () => {
    const holdings = await customerHoldings(f.db) as Array<{ customer_id: string }>;
    assert.ok(!holdings.some((h) => h.customer_id === f.otherCustomerId));
  });
});

