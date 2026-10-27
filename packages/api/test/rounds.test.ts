/**
 * An order is never placed on a round twice, and a round made by mistake can
 * be deleted (Everton, 27 Oct 2026: SO-001018 for 7 Basiks ended up on two
 * rounds the same day).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { createOrder } from '../src/services/orders.ts';
import { addOrderToSheet, markStop } from '../src/services/delivery.ts';
import { settleRoute } from '../src/services/settlement.ts';
import { reviewApproval } from '../src/services/approvals.ts';
import { deleteRound } from '../src/services/routing.ts';
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
const stopsOf = (orderId: string) => f.db.query<{ sheet: string; outcome: string; status: string }>(
  `SELECT st.delivery_sheet_id AS sheet, st.stop_outcome AS outcome, ds.status
   FROM delivery_stops st JOIN delivery_sheets ds ON ds.id = st.delivery_sheet_id WHERE st.order_id = $1`, [orderId]);

/** An order waiting under Needs a decision for its day, as the cut-off makes one. */
async function waitingForDecision(day: string) {
  const o = await createOrder(f.db, f.office, { customerId: f.customerId, deliveryMode: 'Delivery', noRound: true,
    requestedDeliveryDate: day, lines: [{ productId: f.casedProductId, cases: 2 }] } as never);
  await f.db.query(`UPDATE customer_orders SET needs_review = true WHERE id = $1`, [o.id]);
  const r = await f.db.one<{ id: string }>(
    `INSERT INTO approval_requests (request_type, entity_type, entity_id, entity_label, customer_id, amount_cents, reason, requested_by_id)
     VALUES ('SameDayOrder','CustomerOrder',$1,$2,$3,0,'after the cut-off',$4) RETURNING id`,
    [o.id, o.orderNumber, f.customerId, f.office.id]);
  return { order: o, requestId: r.id };
}

describe('One round per order', () => {
  test('putting a waiting order on a round settles its same-day request', async () => {
    const day = addDays(businessToday(), 2);
    const other = await createOrder(f.db, f.office, { customerId: f.customerId, deliveryMode: 'Delivery',
      requestedDeliveryDate: day, lines: [{ productId: f.fiveGalProductId, looseBottles: 1 }] });
    const sheet = (await stopsOf(other.id))[0].sheet;
    const w = await waitingForDecision(day);
    await addOrderToSheet(f.db, f.office, sheet, w.order.id);
    const req = await f.db.one<{ status: string; review_notes: string }>(`SELECT status, review_notes FROM approval_requests WHERE id = $1`, [w.requestId]);
    assert.equal(req.status, 'Approved');
    assert.match(req.review_notes, /Put on the .* round/);
    const o = await f.db.one<{ needs_review: boolean }>(`SELECT needs_review FROM customer_orders WHERE id = $1`, [w.order.id]);
    assert.equal(o.needs_review, false);
  });

  test('approving a request for an order already delivered and settled does not open a second round', async () => {
    const day = addDays(businessToday(), 3);
    const other = await createOrder(f.db, f.office, { customerId: f.customerId, deliveryMode: 'Delivery',
      requestedDeliveryDate: day, lines: [{ productId: f.fiveGalProductId, looseBottles: 1 }] });
    const sheet = (await stopsOf(other.id))[0].sheet;
    const w = await waitingForDecision(day);
    await addOrderToSheet(f.db, f.office, sheet, w.order.id);
    // As on live data from before this fix: the request still pending.
    await f.db.query(`UPDATE approval_requests SET status = 'Pending' WHERE id = $1`, [w.requestId]);
    const stop = await f.db.one<{ id: string }>(`SELECT id FROM delivery_stops WHERE order_id = $1`, [w.order.id]);
    await markStop(f.db, f.driver, { stopId: stop.id, outcome: 'Delivered' } as never);
    const otherStop = await f.db.one<{ id: string }>(`SELECT id FROM delivery_stops WHERE order_id = $1`, [other.id]);
    await markStop(f.db, f.driver, { stopId: otherStop.id, outcome: 'Delivered' } as never);
    await settleRoute(f.db, f.office, sheet, { actualCashCents: 0 });

    await reviewApproval(f.db, f.admin, w.requestId, 'Approved');
    const stops = await stopsOf(w.order.id);
    assert.equal(stops.length, 1, 'still only the round it was delivered on');
    assert.equal(stops[0].outcome, 'Delivered');
    const open = await f.db.one<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM delivery_sheets WHERE delivery_date = $1::date AND status = 'Open'`, [day]);
    assert.equal(Number(open.n), 0, 'no new round');
  });
});

describe('Deleting a round', () => {
  test('a round not started, with nothing recorded: orders back to waiting, the loading back on the shelf', async () => {
    const day = addDays(businessToday(), 4);
    const o = await createOrder(f.db, f.office, { customerId: f.customerId, deliveryMode: 'Delivery',
      requestedDeliveryDate: day, lines: [{ productId: f.casedProductId, cases: 3 }] });
    const sheet = (await stopsOf(o.id))[0].sheet;
    const before = await stock(f.casedProductId);
    await loadRound(f.db, f.office, sheet, {});
    assert.equal(await stock(f.casedProductId), before - 72);

    await assert.rejects(deleteRound(f.db, f.driver, sheet), /requires role/);
    const r = await deleteRound(f.db, f.office, sheet);
    assert.deepEqual(r.ordersBackToWaiting, [o.orderNumber]);
    assert.equal(r.stockBack[0].bottles, 72);
    assert.equal(await stock(f.casedProductId), before, 'the loading is back on the shelf');
    assert.equal((await stopsOf(o.id)).length, 0);
    const ord = await f.db.one<{ status: string }>(`SELECT status FROM customer_orders WHERE id = $1`, [o.id]);
    assert.equal(ord.status, 'Pending', 'the order waits for delivery again');
    assert.equal((await f.db.query(`SELECT 1 FROM delivery_sheets WHERE id = $1`, [sheet])).length, 0);
  });

  test('refused once anything is recorded on it, or it is settled', async () => {
    const day = addDays(businessToday(), 5);
    const o = await createOrder(f.db, f.office, { customerId: f.customerId, deliveryMode: 'Delivery',
      requestedDeliveryDate: day, lines: [{ productId: f.fiveGalProductId, looseBottles: 2 }] });
    const sheet = (await stopsOf(o.id))[0].sheet;
    const stop = await f.db.one<{ id: string }>(`SELECT id FROM delivery_stops WHERE order_id = $1`, [o.id]);
    await markStop(f.db, f.driver, { stopId: stop.id, outcome: 'Customer Not Home' } as never);
    await assert.rejects(deleteRound(f.db, f.office, sheet), /already recorded/);
    await settleRoute(f.db, f.office, sheet, { actualCashCents: 0 });
    await assert.rejects(deleteRound(f.db, f.office, sheet), /settled round cannot be deleted/);
  });
});
