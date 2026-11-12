/**
 * A delivered stop after the fact (Everton, 12 Nov 2026): a settled round
 * shows what each stop recorded and the payments settling it created, and an
 * admin can still correct the bottles (Lightfire Partners' 12 empties).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { createOrder } from '../src/services/orders.ts';
import { markStop, getStopForDriver } from '../src/services/delivery.ts';
import { getSettlementReview, requestStopCorrection, settleRoute } from '../src/services/settlement.ts';
import { reviewApproval } from '../src/services/approvals.ts';
import { businessToday } from '../src/services/core.ts';
import { addDays } from '@alka/shared';

let f: Fixture;
before(async () => {
  f = await setupFixture();
  await f.db.query(`INSERT INTO finished_goods_stock (product_id, quantity_on_hand) VALUES ($1, 1000), ($2, 1000)
                    ON CONFLICT (product_id) DO UPDATE SET quantity_on_hand = 1000`, [f.casedProductId, f.fiveGalProductId]);
});
after(async () => { await f.close(); });

const empties = async () => Number((await f.db.one<{ q: number }>(
  `SELECT quantity_on_hand AS q FROM raw_materials WHERE id = $1`, [f.jugMaterialId])).q);

async function deliveredStop(day: number, cash = 0) {
  const o = await createOrder(f.db, f.office, { customerId: f.customerId, deliveryMode: 'Delivery',
    requestedDeliveryDate: addDays(businessToday(), day), lines: [{ productId: f.fiveGalProductId, looseBottles: 4 }] });
  const st = await f.db.one<{ id: string; delivery_sheet_id: string }>(
    `SELECT id, delivery_sheet_id FROM delivery_stops WHERE order_id = $1`, [o.id]);
  await markStop(f.db, f.driver, { stopId: st.id, outcome: 'Delivered',
    deliveredLines: undefined, bottlesDeliveredFull: 4, bottlesEmptiesPickedUp: 0,
    paymentReceived: cash > 0, paymentMethod: cash > 0 ? 'Cash' : null, paymentAmountCents: cash } as never);
  return st;
}

describe('a delivered stop, after the fact', () => {
  test('a settled stop shows the payments it created; its screen shows what was recorded', async () => {
    const st = await deliveredStop(5, 30_000);
    await settleRoute(f.db, f.office, st.delivery_sheet_id, { actualCashCents: 30_000 });
    const review = await getSettlementReview(f.db, st.delivery_sheet_id);
    const row = review.stops.find((s) => s.stopId === st.id)!;
    assert.equal(row.settled, true);
    assert.equal(row.paidAtSettlement!.reduce((s, p) => s + p.amountCents, 0), 30_000);
    assert.ok(row.paidAtSettlement![0].invoiceNumber, 'paid against the delivery invoice');
    assert.ok(row.paidAtSettlement![0].receiptNumber);

    const screen = await getStopForDriver(f.db, st.id) as unknown as {
      recordedLines: Array<{ loose_bottles: number }>; settledPayments: unknown[]; invoice_number: string | null;
    };
    assert.equal(Number(screen.recordedLines[0].loose_bottles), 4);
    assert.equal(screen.settledPayments.length, row.paidAtSettlement!.length);
    assert.ok(screen.invoice_number);
  });

  test('admin corrects the empties on a settled round: the stop, the empties in stock and the round difference follow', async () => {
    const st = await deliveredStop(6);
    await settleRoute(f.db, f.office, st.delivery_sheet_id, { actualCashCents: 0, bottleActualReturned: 12 });
    const before = await empties();
    const r = await requestStopCorrection(f.db, f.admin, st.id, { bottlesEmptiesPickedUp: 12 }, 'Lightfire handed back 12');
    assert.equal(r.applied, true);
    const s = await f.db.one<{ e: number }>(`SELECT bottles_empties_picked_up AS e FROM delivery_stops WHERE id = $1`, [st.id]);
    assert.equal(Number(s.e), 12);
    assert.equal(await empties(), before + 12, 'empties in stock up by the difference');
    const sheet = await f.db.one<{ v: number }>(`SELECT bottle_variance AS v FROM delivery_sheets WHERE id = $1`, [st.delivery_sheet_id]);
    assert.equal(Number(sheet.v), 0, 'counted 12, recorded 12 now');

    // Down again: only the difference moves.
    await requestStopCorrection(f.db, f.admin, st.id, { bottlesEmptiesPickedUp: 10 }, 'it was 10');
    assert.equal(await empties(), before + 10);
  });

  test('the cash on a settled stop is refused (it goes through Payments received); unchanged cash sent along is fine', async () => {
    const st = await deliveredStop(7, 10_000);
    await settleRoute(f.db, f.office, st.delivery_sheet_id, { actualCashCents: 10_000 });
    await assert.rejects(requestStopCorrection(f.db, f.admin, st.id, { paymentAmountCents: 5_000 }, 'x'), /Payments received/);
    const r = await requestStopCorrection(f.db, f.admin, st.id,
      { paymentAmountCents: 10_000, paymentMethod: 'Cash', bottlesLostDamaged: 1, notes: 'one cracked' }, 'cracked');
    assert.equal(r.applied, true);
    const s = await f.db.one<{ l: number; n: string }>(`SELECT bottles_lost_damaged AS l, driver_notes AS n FROM delivery_stops WHERE id = $1`, [st.id]);
    assert.equal(Number(s.l), 1);
    assert.equal(s.n, 'one cracked');
  });

  test('office staff raise it on a settled round; it applies when an admin approves', async () => {
    const st = await deliveredStop(8);
    await settleRoute(f.db, f.office, st.delivery_sheet_id, { actualCashCents: 0 });
    const before = await empties();
    const r = await requestStopCorrection(f.db, f.office, st.id, { bottlesEmptiesPickedUp: 3 }, 'three came back');
    assert.equal(r.applied, false);
    assert.equal(await empties(), before, 'nothing yet');
    await reviewApproval(f.db, f.admin, r.requestId!, 'Approved');
    assert.equal(await empties(), before + 3);
  });

  test('before settlement the cash can still be corrected, and the empties move', async () => {
    const st = await deliveredStop(9, 5_000);
    const before = await empties();
    await requestStopCorrection(f.db, f.admin, st.id, { paymentAmountCents: 6_000, bottlesEmptiesPickedUp: 2 }, 'recount');
    const s = await f.db.one<{ c: number }>(`SELECT payment_amount_cents AS c FROM delivery_stops WHERE id = $1`, [st.id]);
    assert.equal(Number(s.c), 6_000);
    assert.equal(await empties(), before + 2);
  });
});
