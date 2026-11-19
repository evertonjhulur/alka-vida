/**
 * Part delivered, put right in the office (Everton, 19 Nov 2026). The driver
 * pressed Delivered for the whole of 360 Degrees' order on 17 Nov though the
 * 2 cases stayed behind. Office staff correct the driver's stop errors at
 * settlement straight away; after settlement an office correction goes to an
 * administrator; an administrator's applies at once.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { createOrder } from '../src/services/orders.ts';
import { markStop } from '../src/services/delivery.ts';
import { adjustAllocation, requestStopCorrection, settleRoute } from '../src/services/settlement.ts';
import { reviewApproval } from '../src/services/approvals.ts';
import { loadRound } from '../src/services/trucks.ts';
import { businessToday } from '../src/services/core.ts';
import { addDays } from '@alka/shared';

let f: Fixture;
before(async () => {
  f = await setupFixture();
  await f.db.query(`INSERT INTO finished_goods_stock (product_id, quantity_on_hand) VALUES ($1, 2400), ($2, 2400)
                    ON CONFLICT (product_id) DO UPDATE SET quantity_on_hand = 2400`, [f.casedProductId, f.fiveGalProductId]);
});
after(async () => { await f.close(); });

const stock = async (id: string) => Number((await f.db.one<{ q: number }>(
  `SELECT quantity_on_hand AS q FROM finished_goods_stock WHERE product_id = $1`, [id])).q);

/** 2 cases + 4 x 5-gallon, recorded Delivered in full on the round for `day`. */
async function deliveredInFull(day: string, opts: { cash?: number } = {}) {
  const o = await createOrder(f.db, f.office, {
    customerId: f.customerId, deliveryMode: 'Delivery', requestedDeliveryDate: day,
    lines: [{ productId: f.casedProductId, cases: 2 }, { productId: f.fiveGalProductId, looseBottles: 4 }],
  } as never);
  const stop = await f.db.one<{ id: string; sheet: string }>(
    `SELECT id, delivery_sheet_id AS sheet FROM delivery_stops WHERE order_id = $1`, [o.id]);
  const r = await markStop(f.db, f.driver, {
    stopId: stop.id, outcome: 'Delivered', bottlesDeliveredFull: 4, bottlesEmptiesPickedUp: 2,
    ...(opts.cash ? { paymentReceived: true, paymentMethod: 'Cash', paymentAmountCents: opts.cash } : {}),
  } as never);
  const lines = await f.db.query<{ id: string; product_id: string }>(
    `SELECT id, product_id FROM order_line_items WHERE order_id = $1`, [o.id]);
  const cased = lines.find((l) => l.product_id === f.casedProductId)!.id;
  const jugs = lines.find((l) => l.product_id === f.fiveGalProductId)!.id;
  return { order: o, stopId: stop.id, sheetId: stop.sheet, invoiceId: r.invoiceId!, cased, jugs };
}
const onlyJugs = (d: { cased: string; jugs: string }) => [
  { orderLineId: d.cased, cases: 0, looseBottles: 0 },
  { orderLineId: d.jugs, cases: 0, looseBottles: 4 },
];
const invoiceTotal = async (id: string) => Number((await f.db.one<{ g: number }>(
  `SELECT grand_total_cents AS g FROM invoices WHERE id = $1`, [id])).g);

describe('Correcting what was handed over', () => {
  test('the 360 Degrees case, at settlement by the office: invoice, stock, order and the rest all follow', async () => {
    const day = addDays(businessToday(), 1);
    const restDay = addDays(day, 1);
    const d = await deliveredInFull(day);
    const fullTotal = await invoiceTotal(d.invoiceId);
    const casedBefore = await stock(f.casedProductId);
    const jugsBefore = await stock(f.fiveGalProductId);

    const out = await requestStopCorrection(f.db, f.office, d.stopId,
      { deliveredLines: onlyJugs(d), restOn: restDay }, 'driver pressed Delivered; the 2 cases stayed on the truck');
    assert.equal(out.applied, true, 'the office applies it at settlement');

    // Invoice: only the 4 jugs now.
    const lines = await f.db.query<{ product_id: string; loose_bottles: number }>(
      `SELECT product_id, loose_bottles FROM invoice_line_items WHERE invoice_id = $1`, [d.invoiceId]);
    assert.deepEqual(lines.map((l) => l.product_id), [f.fiveGalProductId]);
    assert.ok(await invoiceTotal(d.invoiceId) < fullTotal);
    // Stock: the 2 cases back on the shelf (no truck loading on this round); jugs untouched.
    assert.equal(await stock(f.casedProductId), casedBefore + 48);
    assert.equal(await stock(f.fiveGalProductId), jugsBefore);
    // Order: part delivered, the rest on the next day's round.
    const o = await f.db.one<{ status: string; requested: string }>(
      `SELECT status, requested_delivery_date::text AS requested FROM customer_orders WHERE id = $1`, [d.order.id]);
    assert.equal(o.status, 'Partially Delivered');
    assert.equal(o.requested, restDay);
    const rest = await f.db.one<{ id: string; summary: string }>(
      `SELECT st.id, st.line_items_summary AS summary FROM delivery_stops st JOIN delivery_sheets ds ON ds.id = st.delivery_sheet_id
       WHERE st.order_id = $1 AND ds.delivery_date = $2::date`, [d.order.id, restDay]);
    assert.match(rest.summary, /Rest of order: 2 cs/);
    // Bottles out unchanged (the jugs did go).
    const st = await f.db.one<{ full: number }>(`SELECT bottles_delivered_full AS full FROM delivery_stops WHERE id = $1`, [d.stopId]);
    assert.equal(Number(st.full), 4);

    // The rest goes out: invoiced on its own, for the 2 cases only; the order is done.
    const r2 = await markStop(f.db, f.driver, { stopId: rest.id, outcome: 'Delivered' } as never);
    const l2 = await f.db.query<{ product_id: string; cases: number }>(
      `SELECT product_id, cases FROM invoice_line_items WHERE invoice_id = $1`, [r2.invoiceId]);
    assert.deepEqual(l2.map((l) => [l.product_id, Number(l.cases)]), [[f.casedProductId, 2]]);
    assert.equal((await invoiceTotal(d.invoiceId)) + (await invoiceTotal(r2.invoiceId!)), fullTotal, 'billed once in all');
    const done = await f.db.one<{ status: string }>(`SELECT status FROM customer_orders WHERE id = $1`, [d.order.id]);
    assert.equal(done.status, 'Delivered');
  });

  test('after settlement the office sends it for approval; approving applies it, and money paid over becomes credit', async () => {
    const day = addDays(businessToday(), 3);
    const d = await deliveredInFull(day);
    const total = await invoiceTotal(d.invoiceId);
    // Paid in full at the door, settled.
    await f.db.query(`UPDATE delivery_stops SET payment_received = true, payment_method = 'Cash', payment_amount_cents = $2 WHERE id = $1`,
      [d.stopId, total]);
    await adjustAllocation(f.db, f.office, d.stopId, [{ invoiceId: d.invoiceId, amountCents: total }]);
    await settleRoute(f.db, f.office, d.sheetId, { actualCashCents: total });

    const out = await requestStopCorrection(f.db, f.office, d.stopId,
      { deliveredLines: onlyJugs(d), restOn: addDays(day, 2) }, 'the 2 cases did not go');
    assert.equal(out.applied, false);
    const req = await f.db.one<{ payload: { quantitiesSummary?: string } }>(
      `SELECT payload FROM approval_requests WHERE id = $1`, [out.requestId]);
    assert.match(req.payload.quantitiesSummary ?? '', /2 cs → 0 cs/);
    assert.equal((await invoiceTotal(d.invoiceId)), total, 'nothing changes until approved');

    await reviewApproval(f.db, f.admin, out.requestId!, 'Approved');
    assert.ok(await invoiceTotal(d.invoiceId) < total);
    const cn = await f.db.maybeOne<{ g: number }>(
      `SELECT grand_total_cents AS g FROM invoices WHERE is_credit_note AND linked_invoice_id = $1`, [d.invoiceId]);
    assert.ok(cn, 'a credit note for what was paid over');
    assert.equal(-Number(cn!.g), total - await invoiceTotal(d.invoiceId));
  });

  test('an administrator applies it at once, even after settlement', async () => {
    const day = addDays(businessToday(), 6);
    const d = await deliveredInFull(day);
    await settleRoute(f.db, f.office, d.sheetId, { actualCashCents: 0 });
    const out = await requestStopCorrection(f.db, f.admin, d.stopId,
      { deliveredLines: onlyJugs(d), restOn: addDays(day, 1) }, 'cases stayed behind');
    assert.equal(out.applied, true);
  });

  test('on a loaded round the goods are counted back with the truck, so stock is not moved', async () => {
    const day = addDays(businessToday(), 9);
    const o = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Delivery', requestedDeliveryDate: day,
      lines: [{ productId: f.casedProductId, cases: 2 }, { productId: f.fiveGalProductId, looseBottles: 4 }],
    } as never);
    const stop = await f.db.one<{ id: string; sheet: string }>(
      `SELECT id, delivery_sheet_id AS sheet FROM delivery_stops WHERE order_id = $1`, [o.id]);
    await loadRound(f.db, f.office, stop.sheet, {} as never);
    await markStop(f.db, f.driver, { stopId: stop.id, outcome: 'Delivered' } as never);
    const lines = await f.db.query<{ id: string; product_id: string }>(`SELECT id, product_id FROM order_line_items WHERE order_id = $1`, [o.id]);
    const before = await stock(f.casedProductId);
    await requestStopCorrection(f.db, f.office, stop.id, {
      deliveredLines: [
        { orderLineId: lines.find((l) => l.product_id === f.casedProductId)!.id, cases: 0, looseBottles: 0 },
        { orderLineId: lines.find((l) => l.product_id === f.fiveGalProductId)!.id, cases: 0, looseBottles: 4 },
      ], restOn: addDays(day, 1),
    }, 'cases stayed on the truck');
    assert.equal(await stock(f.casedProductId), before);
  });

  test('fewer 5-gallons handed over brings the full bottles out down with them', async () => {
    const day = addDays(businessToday(), 12);
    const d = await deliveredInFull(day);
    await requestStopCorrection(f.db, f.office, d.stopId, {
      deliveredLines: [{ orderLineId: d.cased, cases: 2, looseBottles: 0 }, { orderLineId: d.jugs, cases: 0, looseBottles: 3 }],
      restOn: addDays(day, 1),
    }, 'one jug stayed behind');
    const st = await f.db.one<{ full: number }>(`SELECT bottles_delivered_full AS full FROM delivery_stops WHERE id = $1`, [d.stopId]);
    assert.equal(Number(st.full), 3);
  });

  test('refused: more than the order has, nothing left at all, or no day for the rest', async () => {
    const day = addDays(businessToday(), 15);
    const d = await deliveredInFull(day);
    await assert.rejects(requestStopCorrection(f.db, f.office, d.stopId,
      { deliveredLines: [{ orderLineId: d.cased, cases: 3, looseBottles: 0 }] }, 'x'), /more than the order has left/);
    await assert.rejects(requestStopCorrection(f.db, f.office, d.stopId,
      { deliveredLines: [{ orderLineId: d.cased, cases: 0, looseBottles: 0 }, { orderLineId: d.jugs, cases: 0, looseBottles: 0 }] }, 'x'),
      /leaves nothing handed over/);
    await assert.rejects(requestStopCorrection(f.db, f.office, d.stopId,
      { deliveredLines: onlyJugs(d) }, 'x'), /choose the day the rest goes out/);
    // Nothing changed by the refusals.
    const o = await f.db.one<{ status: string }>(`SELECT status FROM customer_orders WHERE id = $1`, [d.order.id]);
    assert.equal(o.status, 'Delivered');
  });
});
