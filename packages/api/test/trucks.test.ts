/**
 * Everton's round of 10 Oct 2026 - his rulings final. One describe per point.
 * (Point 1, the Delivery rounds status filter, is screen-only.)
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { setupFixture, paymentsOf, type Fixture } from './helpers.ts';
import { createOrder } from '../src/services/orders.ts';
import { markStop, addPaymentToDeliveredStop, addPaymentStop, getStopForDriver, getSheet } from '../src/services/delivery.ts';
import { settleRoute, getSettlementReview } from '../src/services/settlement.ts';
import { startRoute } from '../src/services/routing.ts';
import { recordPayment } from '../src/services/payments.ts';
import { counterSale } from '../src/services/counter.ts';
import { bottleAccount, listPools } from '../src/services/bottles.ts';
import { loadRound, confirmLoad, addToLoad, confirmAddition, cancelAddition, confirmReturns, truckPosition, loadingsReport, loadingSummary, goodsOnTrucks } from '../src/services/trucks.ts';
import { stockSnapshot } from '../src/services/audits.ts';
import { bottleChargeProduct } from '../src/services/orders.ts';
import { getStatement } from '../src/services/ledger.ts';
import {
  addCollection, recordCollection, decideReturn, listCollections, pickupsForPo, stopOptions,
} from '../src/services/collections.ts';
import { createPurchaseOrder, receivePurchaseOrder } from '../src/services/inventory.ts';
import { renderInvoicePdf, renderStatementPdf, setMailSinkForTests, type MailMessage } from '../src/services/documents.ts';
import { sendOrderPlacedEmail } from '../src/services/messaging.ts';
import { businessToday, DEFAULT_DOCUMENT_FOOTER } from '../src/services/core.ts';
import { addDays } from '@alka/shared';

let f: Fixture;
const today = businessToday();
const sent: MailMessage[] = [];
let loaderA: string;
let loaderB: string;

before(async () => {
  f = await setupFixture();
  setMailSinkForTests((m) => { sent.push(m); });
  // Loaders are office logins since 23 Oct 2026 (they used to be employees).
  const mkOffice = async (email: string, name: string) => (await f.db.one<{ id: string }>(
    `INSERT INTO users (email, name, password_hash, role) VALUES ($1,$2,'x','user') RETURNING id`, [email, name])).id;
  loaderA = await mkOffice('andre@alkavida.jm', 'Andre Loader');
  loaderB = await mkOffice('brian@alkavida.jm', 'Brian Loader');
});
after(async () => { setMailSinkForTests(null); await f.close(); });

let dayOffset = 20;
/** A fresh round of its own for each test: an order a day further out. */
async function roundWith(lines: Array<{ productId: string; cases?: number; looseBottles?: number }>, customerId = f.customerId) {
  const day = addDays(today, dayOffset++);
  const o = await createOrder(f.db, f.office, { customerId, deliveryMode: 'Delivery', requestedDeliveryDate: day, lines });
  const st = await f.db.one<{ id: string; delivery_sheet_id: string }>(
    `SELECT id, delivery_sheet_id FROM delivery_stops WHERE order_id = $1`, [o.id]);
  return { order: o, stopId: st.id, sheetId: st.delivery_sheet_id, day };
}
const stock = async (productId: string) => Number((await f.db.maybeOne<{ q: number }>(
  `SELECT quantity_on_hand AS q FROM finished_goods_stock WHERE product_id = $1`, [productId]))?.q ?? 0);
const setSetting = (key: string, value: string) => f.db.query(
  `INSERT INTO system_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);

/** The text pdfkit drew: its content streams are deflated, strings hex-encoded. */
function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  let out = '';
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    let body: string;
    try { body = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { continue; }
    for (const h of body.matchAll(/<([0-9a-fA-F]+)>/g)) out += Buffer.from(h[1], 'hex').toString('latin1');
    out += '\n';
  }
  return out;
}

describe('Point 2: a payment on a stop already delivered', () => {
  test('goes on the stop when it has none, on its own linked stop when it has; settles as two payments', async () => {
    const r = await roundWith([{ productId: f.casedProductId, cases: 2 }]);
    await markStop(f.db, f.driver, { stopId: r.stopId, outcome: 'Delivered' });
    await assert.rejects(addPaymentToDeliveredStop(f.db, f.driver, r.stopId, { method: 'Cash', amountCents: 0 }), /how much/);

    const a = await addPaymentToDeliveredStop(f.db, f.driver, r.stopId, { method: 'Cash', amountCents: 100000 });
    assert.deepEqual(a, { stopId: r.stopId, separate: false });
    const b = await addPaymentToDeliveredStop(f.db, f.driver, r.stopId, { method: 'Cheque', amountCents: 50000 });
    assert.equal(b.separate, true);

    // Only a record so far (invariant 2): no Payment exists until settlement.
    const before = (await paymentsOf(f.db, f.customerId)).length;
    const view = await getStopForDriver(f.db, r.stopId) as { payment_amount_cents: number; laterPayments: unknown[] };
    assert.equal(Number(view.payment_amount_cents), 100000);
    assert.equal(view.laterPayments.length, 1);
    // The order and its lines are untouched.
    const lines = await f.db.query(`SELECT cases, delivered_cases FROM order_line_items WHERE order_id = $1`, [r.order.id]);
    assert.deepEqual(lines.map((l) => [Number(l.cases), Number(l.delivered_cases)]), [[2, 2]]);

    const review = await getSettlementReview(f.db, r.sheetId);
    assert.ok(review.stops.some((s) => s.paymentAfterDelivery && s.collectedCents === 50000));
    await settleRoute(f.db, f.office, r.sheetId, { actualCashCents: 150000 });
    const after = await paymentsOf(f.db, f.customerId);
    assert.equal(after.length - before, 2);
    const methods = await f.db.query<{ method: string; amount_cents: number }>(
      `SELECT method, amount_cents FROM payments WHERE delivery_sheet_id = $1 ORDER BY amount_cents DESC`, [r.sheetId]);
    assert.deepEqual(methods.map((p) => [p.method, Number(p.amount_cents)]), [['Cash', 100000], ['Cheque', 50000]]);
  });

  test('refused on a stop not delivered, and once the round is settled', async () => {
    const r = await roundWith([{ productId: f.casedProductId, cases: 1 }]);
    await assert.rejects(addPaymentToDeliveredStop(f.db, f.driver, r.stopId, { method: 'Cash', amountCents: 1000 }), /not delivered/);
    await markStop(f.db, f.driver, { stopId: r.stopId, outcome: 'Delivered' });
    await settleRoute(f.db, f.office, r.sheetId, { actualCashCents: 0 });
    await assert.rejects(addPaymentToDeliveredStop(f.db, f.driver, r.stopId, { method: 'Cash', amountCents: 1000 }), /settled/);
  });
});

describe('Point 3: collection stops', () => {
  test('stop options offer customers, products, suppliers and open POs', async () => {
    const o = await stopOptions(f.db);
    assert.ok(o.customers.length >= 2 && o.products.length >= 2);
  });

  test("collect empties: the driver's is done at once and moves the pool only when settled", async () => {
    const r = await roundWith([{ productId: f.casedProductId, cases: 1 }]);
    await markStop(f.db, f.driver, { stopId: r.stopId, outcome: 'Delivered' });
    const held = (await bottleAccount(f.db, f.otherCustomerId)).closingHolding;
    const dirty = (await listPools(f.db))[0].returnedDirty;
    const c = await addCollection(f.db, f.driver, r.sheetId, { kind: 'Empties', customerId: f.otherCustomerId, emptiesCount: 3 });
    assert.equal(c.status, 'Collected');
    assert.equal((await listPools(f.db))[0].returnedDirty, dirty, 'nothing moves before settlement');
    const s = await settleRoute(f.db, f.office, r.sheetId, { actualCashCents: 0, bottleActualReturned: 3 });
    assert.equal(s.bottleVariance, 0, 'collected empties count towards what should come back');
    assert.equal((await listPools(f.db))[0].returnedDirty, dirty + 3);
    assert.equal((await bottleAccount(f.db, f.otherCustomerId)).closingHolding, held - 3);
  });

  test('an office-planned collection waits for the driver; one not visited closes as Not collected', async () => {
    const r = await roundWith([{ productId: f.casedProductId, cases: 1 }]);
    const planned = await addCollection(f.db, f.office, r.sheetId, { kind: 'Empties', customerId: f.customerId, emptiesCount: 4 });
    const skipped = await addCollection(f.db, f.office, r.sheetId, { kind: 'Empties', customerId: f.otherCustomerId, emptiesCount: 2 });
    assert.equal(planned.status, 'Pending');
    await recordCollection(f.db, f.driver, planned.id, { status: 'Collected', emptiesCount: 3 });
    await markStop(f.db, f.driver, { stopId: r.stopId, outcome: 'Delivered' });
    await settleRoute(f.db, f.office, r.sheetId, { actualCashCents: 0 });
    const rows = await listCollections(f.db, r.sheetId) as Array<{ id: string; status: string; empties_count: number }>;
    assert.equal(rows.find((x) => x.id === planned.id)!.empties_count, 3);
    assert.equal(rows.find((x) => x.id === skipped.id)!.status, 'Not collected');
  });

  test('returned goods: the round cannot close until the office decides; credit note at their price, restock', async () => {
    const r = await roundWith([{ productId: f.casedProductId, cases: 1 }]);
    await markStop(f.db, f.driver, { stopId: r.stopId, outcome: 'Delivered' });
    await assert.rejects(addCollection(f.db, f.driver, r.sheetId, {
      kind: 'Returns', customerId: f.customerId, lines: [{ productId: f.casedProductId, cases: 2 }],
    }), /why/);
    const c = await addCollection(f.db, f.driver, r.sheetId, {
      kind: 'Returns', customerId: f.customerId, lines: [{ productId: f.casedProductId, cases: 2 }], reason: 'damaged in transit',
    });
    await assert.rejects(settleRoute(f.db, f.office, r.sheetId, { actualCashCents: 0 }), /decide on the goods returned/);
    const before = await stock(f.casedProductId);
    const d = await decideReturn(f.db, f.admin, c.id, { creditNote: true, restock: true });
    assert.match(d.creditNoteNumber ?? '', /^CN/);
    const cn = await f.db.one<{ grand_total_cents: number; notes: string }>(
      `SELECT grand_total_cents, notes FROM invoices WHERE invoice_number = $1`, [d.creditNoteNumber]);
    // 2 cases at the Corporate price (1,200.00) + 15% GCT, as a credit.
    assert.equal(Number(cn.grand_total_cents), -276000);
    assert.match(cn.notes, /damaged in transit/);
    await assert.rejects(decideReturn(f.db, f.admin, c.id, { creditNote: false, restock: true }), /already raised/);
    await settleRoute(f.db, f.office, r.sheetId, { actualCashCents: 0 });
    assert.equal(await stock(f.casedProductId), before + 48, 'the 2 cases are back in stock');
  });

  test('a supplier pick-up prefills receiving on its PO, and receiving uses it up', async () => {
    const supplier = await f.db.one<{ id: string }>(`INSERT INTO suppliers (name) VALUES ('Caribbean Caps') RETURNING id`);
    const mat = await f.db.one<{ id: string }>(
      `INSERT INTO raw_materials (name, category, unit_of_measure) VALUES ('Blue cap', 'Cap', 'pcs') RETURNING id`);
    const po = await createPurchaseOrder(f.db, f.office, {
      supplierId: supplier.id, lines: [{ rawMaterialId: mat.id, quantityOrdered: 1000, unitCostCents: 500 }],
    } as never) as { id: string };
    const line = await f.db.one<{ id: string }>(`SELECT id FROM po_line_items WHERE po_id = $1`, [po.id]);
    const r = await roundWith([{ productId: f.casedProductId, cases: 1 }]);
    await assert.rejects(addCollection(f.db, f.driver, r.sheetId, { kind: 'Supplier', supplierId: supplier.id }), /what was collected/);
    await addCollection(f.db, f.driver, r.sheetId, {
      kind: 'Supplier', supplierId: supplier.id, purchaseOrderId: po.id, lines: [{ poLineId: line.id, quantity: 600 }],
    });
    const picked = await pickupsForPo(f.db, po.id) as Array<{ lines: Array<{ poLineId: string; quantity: number }> }>;
    assert.equal(picked.length, 1);
    assert.equal(picked[0].lines[0].quantity, 600);
    await receivePurchaseOrder(f.db, f.office, po.id, [{ poLineItemId: line.id, quantityReceived: 600 }]);
    assert.equal((await pickupsForPo(f.db, po.id)).length, 0);
  });

  test('collect payment planned by the office: a stop to do, settled like any payment', async () => {
    const r = await roundWith([{ productId: f.casedProductId, cases: 1 }]);
    const { stopId } = await addPaymentStop(f.db, f.office, r.sheetId, { customerId: f.otherCustomerId, planned: true });
    const st = await f.db.one<{ stop_outcome: string }>(`SELECT stop_outcome FROM delivery_stops WHERE id = $1`, [stopId]);
    assert.equal(st.stop_outcome, 'Pending');
    await markStop(f.db, f.driver, { stopId, outcome: 'Payment Only', paymentReceived: true, paymentMethod: 'Cash', paymentAmountCents: 25000 });
    await markStop(f.db, f.driver, { stopId: r.stopId, outcome: 'Delivered' });
    const s = await settleRoute(f.db, f.office, r.sheetId, { actualCashCents: 25000 });
    assert.equal(s.paymentIds.length, 1);
  });
});

describe('Point 4: truck loading and returns', () => {
  test('loading moves the orders plus extras off the warehouse; deliveries do not come off it again', async () => {
    await f.db.query(`INSERT INTO finished_goods_stock (product_id, quantity_on_hand) VALUES ($1, 2400)
                      ON CONFLICT (product_id) DO UPDATE SET quantity_on_hand = 2400`, [f.casedProductId]);
    const r = await roundWith([{ productId: f.casedProductId, cases: 3 }]);
    const summary = await loadingSummary(f.db, r.sheetId);
    assert.equal(summary.lines.find((l) => l.productId === f.casedProductId)!.orderedBottles, 72);

    // The office logs the loading; the driver cannot.
    await assert.rejects(loadRound(f.db, f.driver, r.sheetId, { loaderIds: [loaderA] }), /not permitted|role/i);
    // Nor can the driver start before the office has logged it.
    await assert.rejects(confirmLoad(f.db, f.driver, r.sheetId), /has not logged the loading/);

    // Office staff do not choose who loaded it: it is them, from their login,
    // whatever is sent (23 Oct 2026).
    const out = await loadRound(f.db, f.office, r.sheetId, {
      extras: [{ productId: f.casedProductId, extraUnits: 2 }], loaderIds: [loaderA, loaderB],
    });
    assert.equal(out.loadedBottles, 120);
    assert.equal(await stock(f.casedProductId), 2400 - 120);
    assert.deepEqual((await truckPosition(f.db, r.sheetId))!.loaderNames, ['Office']);

    // Saving the loading again moves only the difference.
    await loadRound(f.db, f.office, r.sheetId, { extras: [{ productId: f.casedProductId, extraUnits: 1 }], loaderId: loaderA });
    assert.equal(await stock(f.casedProductId), 2400 - 96);
    assert.deepEqual((await truckPosition(f.db, r.sheetId))!.loaderNames, ['Office']);
    // An administrator names another office login; a driver or a stranger is refused.
    await assert.rejects(loadRound(f.db, f.admin, r.sheetId, { extras: [{ productId: f.casedProductId, extraUnits: 1 }], loaderId: f.driver.id }),
      /office logins/);
    await loadRound(f.db, f.admin, r.sheetId, { extras: [{ productId: f.casedProductId, extraUnits: 1 }], loaderId: loaderA });
    assert.equal(await stock(f.casedProductId), 2400 - 96);
    // Left blank, it is the administrator.
    await loadRound(f.db, f.admin, r.sheetId, { extras: [{ productId: f.casedProductId, extraUnits: 1 }] });
    assert.deepEqual((await truckPosition(f.db, r.sheetId))!.loaderNames, ['Admin']);
    await loadRound(f.db, f.office, r.sheetId, { extras: [{ productId: f.casedProductId, extraUnits: 1 }] });
    await loadRound(f.db, f.admin, r.sheetId, { extras: [{ productId: f.casedProductId, extraUnits: 1 }], loaderId: loaderA });
    const summary2 = await loadingSummary(f.db, r.sheetId);
    assert.ok(summary2.loaders.some((p) => p.name === 'Andre Loader') && !summary2.loaders.some((p) => p.name === 'Driver'),
      'the drop-down offers office logins only');

    // The driver confirms the totals and starts: dual accountability.
    const c = await confirmLoad(f.db, f.driver, r.sheetId);
    assert.ok(c.startedAt && c.confirmedAt);
    const confirmed = (await truckPosition(f.db, r.sheetId))!;
    assert.equal(confirmed.driverConfirmedName, 'Driver');
    assert.equal(confirmed.loadedByName, 'Admin', 'the user who logged it confirmed it loaded');
    // Once the driver has taken responsibility, the loading is locked.
    await assert.rejects(loadRound(f.db, f.office, r.sheetId, { loaderIds: [loaderA] }), /already confirmed/);

    await markStop(f.db, f.driver, { stopId: r.stopId, outcome: 'Delivered' });
    assert.equal(await stock(f.casedProductId), 2400 - 96, 'delivered off the truck, not the warehouse');

    const pos = (await truckPosition(f.db, r.sheetId))!;
    const line = pos.lines.find((l) => l.productId === f.casedProductId)!;
    assert.deepEqual([line.loadedBottles, line.deliveredBottles, line.expectedBackBottles], [96, 72, 24]);

    await assert.rejects(settleRoute(f.db, f.office, r.sheetId, { actualCashCents: 0 }), /came back on the truck/);
    // Half a case short: 0 cases back, so 1 case shows as missing.
    const back = await confirmReturns(f.db, f.driver, r.sheetId, { lines: [{ productId: f.casedProductId, returnedUnits: 0 }], emptiesBack: 0 });
    assert.equal(back.lines[0].differenceBottles, 24);
    // Corrected: the case was there after all. Only the difference moves.
    await confirmReturns(f.db, f.office, r.sheetId, { lines: [{ productId: f.casedProductId, returnedUnits: 1 }], emptiesBack: 0 });
    await confirmReturns(f.db, f.office, r.sheetId, { lines: [{ productId: f.casedProductId, returnedUnits: 1 }], emptiesBack: 0 });
    assert.equal(await stock(f.casedProductId), 2400 - 72, 'only what was delivered has left the warehouse');
    assert.equal((await truckPosition(f.db, r.sheetId))!.lines[0].differenceBottles, 0);

    await settleRoute(f.db, f.office, r.sheetId, { actualCashCents: 0 });
    const sheet = await getSheet(f.db, r.sheetId) as { truck: { loaderNames: string[] } };
    assert.deepEqual(sheet.truck.loaderNames, ['Andre Loader']);

    const ledger = await f.db.query<{ reference_type: string }>(
      `SELECT reference_type FROM inventory_transactions WHERE item_id = $1 AND reference_type IN ('TruckLoad','TruckReturn')`,
      [f.casedProductId]);
    assert.ok(ledger.length >= 3, 'every move is on the stock ledger');

    const report = await loadingsReport(f.db, addDays(today, -1), addDays(today, 1));
    const mine = report.find((x) => x.sheetId === r.sheetId)!;
    assert.deepEqual(mine.loaders, ['Andre Loader']);
    assert.equal(mine.loadedByName, 'Admin');
    assert.equal(mine.driverConfirmedName, 'Driver');
    assert.equal(mine.lines[0].difference, 0);
  });

  test('after the driver confirms, the office can add more; the driver reconfirms before the round settles', async () => {
    await f.db.query(`UPDATE finished_goods_stock SET quantity_on_hand = 2400 WHERE product_id = $1`, [f.casedProductId]);
    const r = await roundWith([{ productId: f.casedProductId, cases: 2 }]);
    await loadRound(f.db, f.office, r.sheetId, { loaderIds: [loaderA] });
    await assert.rejects(addToLoad(f.db, f.office, r.sheetId, { extras: [{ productId: f.casedProductId, extraUnits: 1 }], loaderIds: [loaderB] }),
      /not confirmed the load yet/);
    await confirmLoad(f.db, f.driver, r.sheetId);
    assert.equal(await stock(f.casedProductId), 2400 - 48);

    await assert.rejects(addToLoad(f.db, f.driver, r.sheetId, { extras: [{ productId: f.casedProductId, extraUnits: 1 }], loaderIds: [loaderB] }), /not permitted|role/i);
    await assert.rejects(addToLoad(f.db, f.office, r.sheetId, { extras: [], loaderIds: [loaderB] }), /what is being added/);
    const a1 = await addToLoad(f.db, f.admin, r.sheetId, { extras: [{ productId: f.casedProductId, extraUnits: 2 }], loaderId: loaderB, note: 'customer called' });
    assert.equal(await stock(f.casedProductId), 2400 - 96, 'the addition goes on the truck at once');
    let pos = (await truckPosition(f.db, r.sheetId))!;
    assert.equal(pos.lines[0].loadedBottles, 96);
    assert.equal(pos.lines[0].addedBottles, 48);
    assert.equal(pos.additions[0].driverConfirmedName, null);

    // One the driver disputes: the office cancels it and the stock goes back.
    const a2 = await addToLoad(f.db, f.office, r.sheetId, { extras: [{ productId: f.casedProductId, extraUnits: 1 }], loaderIds: [loaderB] });
    await cancelAddition(f.db, f.office, a2.id);
    assert.equal(await stock(f.casedProductId), 2400 - 96);

    await markStop(f.db, f.driver, { stopId: r.stopId, outcome: 'Delivered' });
    await confirmReturns(f.db, f.driver, r.sheetId, { lines: [{ productId: f.casedProductId, returnedUnits: 2 }] });
    await assert.rejects(settleRoute(f.db, f.office, r.sheetId, { actualCashCents: 0 }), /not confirmed what was added/);
    await confirmAddition(f.db, f.driver, a1.id);
    await assert.rejects(cancelAddition(f.db, f.office, a1.id), /it stands/);
    pos = (await truckPosition(f.db, r.sheetId))!;
    assert.equal(pos.additions[0].driverConfirmedName, 'Driver');
    assert.equal(pos.lines[0].differenceBottles, 0);
    await settleRoute(f.db, f.office, r.sheetId, { actualCashCents: 0 });
    assert.equal(await stock(f.casedProductId), 2400 - 48, 'only what was delivered left the warehouse');

    const report = await loadingsReport(f.db, addDays(today, -1), addDays(today, 1));
    const mine = report.find((x) => x.sheetId === r.sheetId)!;
    assert.deepEqual([mine.lines[0].loaded, mine.lines[0].added, mine.lines[0].difference], [48, 48, 0]);
    assert.deepEqual(mine.additions.map((a) => a.loaderNames), [['Brian Loader']]);
    // An addition by office staff is in their own name.
    const sheetAdds = await f.db.query<{ loader_names: string[] }>(
      `SELECT loader_names FROM round_load_additions WHERE delivery_sheet_id = $1 ORDER BY added_at`, [r.sheetId]);
    assert.deepEqual(sheetAdds.map((a) => a.loader_names), [['Brian Loader'], ['Office']]);
  });

  test('a round with no loading still takes deliveries off the warehouse', async () => {
    const r = await roundWith([{ productId: f.casedProductId, cases: 1 }]);
    await startRoute(f.db, f.driver, r.sheetId);
    const before = await stock(f.casedProductId);
    await markStop(f.db, f.driver, { stopId: r.stopId, outcome: 'Delivered' });
    assert.equal(await stock(f.casedProductId), before - 24);
    await assert.rejects(loadRound(f.db, f.office, r.sheetId, { loaderIds: [loaderA] }), /without a loading/);
  });
});

describe('UX review, 11 Oct 2026: the Stock page', () => {
  test('shows goods on the trucks until the returns are in, and leaves out the bottle charge', async () => {
    await f.db.query(`UPDATE finished_goods_stock SET quantity_on_hand = 2400 WHERE product_id = $1`, [f.casedProductId]);
    const onTruck = async () => (await stockSnapshot(f.db)).finishedGoods
      .find((g) => g.productId === f.casedProductId)!.onTruckBottles;
    const before = await onTruck();
    assert.equal(before, (await goodsOnTrucks(f.db)).get(f.casedProductId) ?? 0);

    const r = await roundWith([{ productId: f.casedProductId, cases: 2 }]);
    await loadRound(f.db, f.office, r.sheetId, { extras: [{ productId: f.casedProductId, extraUnits: 1 }], loaderIds: [loaderA] });
    assert.equal(await onTruck(), before + 72, 'loaded: two cases ordered and one extra');
    await confirmLoad(f.db, f.driver, r.sheetId);
    await markStop(f.db, f.driver, { stopId: r.stopId, outcome: 'Delivered' });
    assert.equal(await onTruck(), before + 24, 'the delivered cases are off the truck');
    await confirmReturns(f.db, f.driver, r.sheetId, { lines: [{ productId: f.casedProductId, returnedUnits: 1 }], emptiesBack: 0 });
    assert.equal(await onTruck(), before, 'back on the warehouse once counted back');

    const charge = await bottleChargeProduct(f.db);
    const snap = await stockSnapshot(f.db);
    assert.ok(!snap.finishedGoods.some((g) => g.productId === charge.id), 'the bottle charge is not stock');
  });
});

describe('Point 5: bank details and disclaimer on invoices and statements', () => {
  test('printed on the invoice and the statement, from the setting', async () => {
    const r = await roundWith([{ productId: f.casedProductId, cases: 1 }]);
    const done = await markStop(f.db, f.driver, { stopId: r.stopId, outcome: 'Delivered' });
    const inv = pdfText((await renderInvoicePdf(f.db, done.invoiceId!)).pdf);
    // Headings are set without their colon in the 11 Oct layout.
    for (const line of DEFAULT_DOCUMENT_FOOTER.split('\n').map((l) => l.trim().replace(/^(Electronic Transfers):$/, '$1'))) {
      assert.ok(inv.includes(line), `invoice has "${line}"`);
    }
    const stmt = pdfText((await renderStatementPdf(f.db, f.customerId)).pdf);
    assert.ok(stmt.includes('Account: 000300249266'));
    assert.ok(stmt.includes('will not assume liability for goods damaged after receipt.'));
    await setSetting('document_footer', 'Pay by transfer to account 123');
    assert.ok(pdfText((await renderInvoicePdf(f.db, done.invoiceId!)).pdf).includes('Pay by transfer to account 123'));
    await setSetting('document_footer', DEFAULT_DOCUMENT_FOOTER);
  });
});

describe('Statement wording, 11 Oct 2026', () => {
  test('same-day invoice before its payment; our bottles with them and a small note', async () => {
    const c = (await f.db.one<{ id: string }>(
      `INSERT INTO customers (name, phone, email, delivery_address, delivery_zone)
       VALUES ('Loan Bottles Ltd','8765550404','loan@example.com','1 Test Road','Kingston') RETURNING id`)).id;
    await f.db.query(`INSERT INTO customer_bottle_moves (customer_id, moved_on, delivered, reference)
                      VALUES ($1, $2, 4, 'Opening balance')`, [c, addDays(today, -40)]);
    await bottleChargeProduct(f.db);
    const r = await roundWith([{ productId: f.casedProductId, cases: 1 }], c);
    const done = await markStop(f.db, f.driver, { stopId: r.stopId, outcome: 'Delivered' });
    const inv = await f.db.one<{ grand_total_cents: number; invoice_date: string }>(
      `SELECT grand_total_cents, invoice_date::text FROM invoices WHERE id = $1`, [done.invoiceId]);
    await recordPayment(f.db, f.office, { customerId: c, invoiceId: done.invoiceId!, amountCents: Number(inv.grand_total_cents),
      method: 'Cash', paymentDate: inv.invoice_date } as never);

    const st = await getStatement(f.db, c, {});
    assert.deepEqual(st.entries.map((e) => e.type), ['Invoice', 'Payment'], 'the invoice comes first on the day');
    assert.ok(st.entries.every((e) => e.runningBalanceCents >= 0), 'the balance never dips below zero');

    const text = pdfText((await renderStatementPdf(f.db, c)).pdf);
    assert.ok(text.includes('OUR 5-GALLON BOTTLES WITH YOU'));
    assert.match(text, /These are to be returned or purchased at \$[\d,]+\.\d\d each\./);
    assert.ok(!text.includes('Held at start'), 'the old four-figure box is gone');
    // A customer with none of ours sees nothing about bottles.
    const none = pdfText((await renderStatementPdf(f.db, f.otherCustomerId)).pdf);
    assert.ok(!none.includes('OUR 5-GALLON BOTTLES'));
  });
});

describe('Point 6: card payments off for now', () => {
  test('a new card payment is refused while it is off, and taken once it is on', async () => {
    await assert.rejects(recordPayment(f.db, f.office, { customerId: f.customerId, amountCents: 1000, method: 'Card' } as never), /card/);
    await assert.rejects(counterSale(f.db, f.office, {
      customerId: f.customerId, lines: [{ productId: f.casedProductId, cases: 1 }], amountPaidCents: 1000, method: 'Card',
    } as never), /card/);
    await setSetting('take_card_payments', 'true');
    const p = await recordPayment(f.db, f.office, { customerId: f.customerId, amountCents: 1000, method: 'Card' } as never);
    assert.ok(p.id);
    await setSetting('take_card_payments', 'false');
  });

  test('a driver recording a delivery is never blocked by it (invariant 3)', async () => {
    const r = await roundWith([{ productId: f.casedProductId, cases: 1 }]);
    const out = await markStop(f.db, f.driver, {
      stopId: r.stopId, outcome: 'Delivered', paymentReceived: true, paymentMethod: 'Card', paymentAmountCents: 1000,
    });
    assert.equal(out.outcome, 'Delivered');
  });
});

describe('Point 7: order email wording', () => {
  test('"Empties to be returned: N"', async () => {
    const o = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Delivery', requestedDeliveryDate: addDays(today, 60),
      lines: [{ productId: f.fiveGalProductId, looseBottles: 3 }], emptiesExpected: 2,
    } as never);
    await sendOrderPlacedEmail(f.db, o.id);
    const m = [...sent].reverse().find((x) => x.subject.includes(o.orderNumber))!;
    assert.ok(m, 'the confirmation went');
    assert.match(m.text, /Empties to be returned: 2/);
    assert.doesNotMatch(m.text, /hand over/);
  });
});

describe('23 Oct 2026: empties a driver lists at a delivery show on the settlement', () => {
  test('per stop, in the round total with collection stops, and as counted once settled', async () => {
    const r = await roundWith([{ productId: f.fiveGalProductId, looseBottles: 4 }]);
    await markStop(f.db, f.driver, {
      stopId: r.stopId, outcome: 'Delivered', bottlesDeliveredFull: 4, bottlesEmptiesPickedUp: 3,
    } as never);
    await addCollection(f.db, f.office, r.sheetId, { kind: 'Empties', customerId: f.otherCustomerId, emptiesCount: 2 } as never);
    const col = (await listCollections(f.db, r.sheetId))[0];
    await recordCollection(f.db, f.driver, col.id, { status: 'Collected', emptiesCount: 2 });

    const review = await getSettlementReview(f.db, r.sheetId);
    const stop = review.stops.find((s) => s.stopId === r.stopId)!;
    assert.equal(stop.bottlesEmptiesPickedUp, 3);
    assert.equal(review.bottles.fullOut, 4);
    assert.equal(review.bottles.emptiesFromStops, 3);
    assert.equal(review.bottles.emptiesFromCollections, 2);
    assert.equal(review.bottles.emptiesRecorded, 5);
    assert.equal(review.bottles.counted, null);
    assert.equal(review.settledCash, null);

    await settleRoute(f.db, f.office, r.sheetId, { actualCashCents: 0, bottleActualReturned: 4 });
    const after = await getSettlementReview(f.db, r.sheetId);
    assert.equal(after.bottles.counted, 4);
    assert.equal(after.bottles.variance, -1);
    assert.equal(after.settledCash?.handedInCents, 0);

    const { roundsReport } = await import('../src/services/reports.ts');
    const report = await roundsReport(f.db, addDays(today, -400), addDays(today, 400));
    const row = report.rounds.find((x) => x.id === r.sheetId)!;
    assert.equal(row.emptiesRecorded, 5, 'the rounds report counts collection-stop empties too');
  });
});
