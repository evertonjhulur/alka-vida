/**
 * Undo a delivery recorded in error (Everton, 26 Oct 2026): admin only, with
 * a reason; the order ends up Cancelled.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { createOrder } from '../src/services/orders.ts';
import { markStop } from '../src/services/delivery.ts';
import { settleRoute } from '../src/services/settlement.ts';
import { recordPastDelivery } from '../src/services/counter.ts';
import { recordPayment } from '../src/services/payments.ts';
import { undoDelivery } from '../src/services/undodelivery.ts';
import { businessToday } from '../src/services/core.ts';
import { addDays } from '@alka/shared';

let f: Fixture;
before(async () => {
  f = await setupFixture();
  await f.db.query(`INSERT INTO finished_goods_stock (product_id, quantity_on_hand) VALUES ($1, 1000), ($2, 1000)
                    ON CONFLICT (product_id) DO UPDATE SET quantity_on_hand = 1000`, [f.casedProductId, f.fiveGalProductId]);
});
after(async () => { await f.close(); });

const stock = async (id: string) => Number((await f.db.one<{ q: number }>(
  `SELECT quantity_on_hand AS q FROM finished_goods_stock WHERE product_id = $1`, [id])).q);
const balance = async (id: string) => Number((await f.db.one<{ b: number }>(
  `SELECT balance_cents AS b FROM customer_balances WHERE customer_id = $1`, [id])).b);
const holding = async (id: string) => Number((await f.db.one<{ n: number }>(
  `SELECT COALESCE(SUM(d),0)::int AS n FROM (
     SELECT s.bottles_delivered_full - s.bottles_empties_picked_up AS d FROM delivery_stops s
     WHERE s.customer_id = $1 AND s.stop_outcome = 'Delivered'
     UNION ALL SELECT delivered - returned - sold FROM customer_bottle_moves WHERE customer_id = $1) x`, [id])).n);
const pool = async () => f.db.one<{ clean_ready: number; filled_with_customer: number }>(
  `SELECT clean_ready, filled_with_customer FROM five_gal_bottle_pool LIMIT 1`);

describe('Undo a delivery recorded in error', () => {
  test('a delivery on an open round: invoice cancelled, cash removed, stock and bottles back, off the round', async () => {
    const day = addDays(businessToday(), 3);
    const balBefore = await balance(f.customerId);
    const stockBefore = await stock(f.fiveGalProductId);
    const poolBefore = await pool();
    const o = await createOrder(f.db, f.office, { customerId: f.customerId, deliveryMode: 'Delivery', requestedDeliveryDate: day,
      lines: [{ productId: f.fiveGalProductId, looseBottles: 3 }] });
    const st = await f.db.one<{ id: string; delivery_sheet_id: string }>(`SELECT id, delivery_sheet_id FROM delivery_stops WHERE order_id = $1`, [o.id]);
    const r = await markStop(f.db, f.driver, { stopId: st.id, outcome: 'Delivered', bottlesDeliveredFull: 3, bottlesEmptiesPickedUp: 1,
      paymentReceived: true, paymentMethod: 'Cash', paymentAmountCents: 50000 } as never);
    assert.ok(r.invoiceId);
    assert.equal(await stock(f.fiveGalProductId), stockBefore - 3);

    await assert.rejects(undoDelivery(f.db, f.office, o.id, { reason: 'x' }), /requires role admin/);
    await assert.rejects(undoDelivery(f.db, f.admin, o.id, { reason: ' ' }), /say why/);
    const plan = await undoDelivery(f.db, f.admin, o.id, { dryRun: true });
    assert.equal(plan.invoices.length, 1);
    assert.equal(plan.cashAtStopRemovedCents, 50000);
    assert.deepEqual(plan.bottlesBack, { delivered: 3, empties: 1, lost: 0, sold: 0 });
    assert.equal(plan.stockBack[0].bottles, 3);

    const done = await undoDelivery(f.db, f.admin, o.id, { reason: 'entered on the wrong customer' });
    assert.equal(done.done, true);
    const order = await f.db.one<{ status: string }>(`SELECT status FROM customer_orders WHERE id = $1`, [o.id]);
    assert.equal(order.status, 'Cancelled');
    const inv = await f.db.one<{ lifecycle: string; notes: string }>(`SELECT lifecycle, notes FROM invoices WHERE id = $1`, [r.invoiceId]);
    assert.equal(inv.lifecycle, 'Cancelled');
    assert.match(inv.notes, /entered on the wrong customer/);
    assert.equal(await balance(f.customerId), balBefore, 'nothing owed for it');
    assert.equal(await stock(f.fiveGalProductId), stockBefore, 'stock back');
    assert.equal(await holding(f.customerId), 0, 'bottles off the customer');
    const p = await pool();
    assert.equal(Number(p.clean_ready), Number(poolBefore.clean_ready));
    assert.equal((await f.db.query(`SELECT 1 FROM delivery_stops WHERE order_id = $1`, [o.id])).length, 0, 'off the round');
    await assert.rejects(undoDelivery(f.db, f.admin, o.id, { reason: 'again' }), /already cancelled/);
    // The round can still be settled cleanly.
    await settleRoute(f.db, f.office, st.delivery_sheet_id, { actualCashCents: 0 });
  });

  test('a sale recorded for an earlier day: its payment is reversed, other money goes back to credit', async () => {
    const before = await balance(f.otherCustomerId);
    const stockBefore = await stock(f.casedProductId);
    const sale = await recordPastDelivery(f.db, f.office, {
      customerId: f.otherCustomerId, deliveredOn: addDays(businessToday(), -1), how: 'Delivered',
      lines: [{ productId: f.casedProductId, cases: 2 }],
      amountPaidCents: 100000, method: 'Cash',
    } as never);
    assert.ok(sale.invoiceId);
    // Money from elsewhere applied to the same invoice.
    await recordPayment(f.db, f.office, { customerId: f.otherCustomerId, invoiceId: sale.invoiceId, amountCents: 20000, method: 'Cheque' } as never);
    const plan = await undoDelivery(f.db, f.admin, sale.orderId, { dryRun: true });
    assert.equal(plan.paymentsReversed.length, 1, 'the payment taken with the sale');
    assert.equal(plan.paymentsToCredit.length, 1, 'the cheque applied from elsewhere');
    await undoDelivery(f.db, f.admin, sale.orderId, { reason: 'double entry' });
    assert.equal(await stock(f.casedProductId), stockBefore);
    assert.equal(await balance(f.otherCustomerId), before - 20000, 'the cheque stays as credit on the account');
    const cheque = await f.db.one<{ invoice_id: string | null }>(
      `SELECT invoice_id FROM payments WHERE method = 'Cheque' AND customer_id = $1 AND NOT is_reversal`, [f.otherCustomerId]);
    assert.equal(cheque.invoice_id, null);
  });

  test('refused on a settled round, and for an order not delivered', async () => {
    const day = addDays(businessToday(), 5);
    const o = await createOrder(f.db, f.office, { customerId: f.customerId, deliveryMode: 'Delivery', requestedDeliveryDate: day,
      lines: [{ productId: f.casedProductId, cases: 1 }] });
    await assert.rejects(undoDelivery(f.db, f.admin, o.id, { dryRun: true }), /has not been delivered/);
    const st = await f.db.one<{ id: string; delivery_sheet_id: string }>(`SELECT id, delivery_sheet_id FROM delivery_stops WHERE order_id = $1`, [o.id]);
    await markStop(f.db, f.driver, { stopId: st.id, outcome: 'Delivered' } as never);
    await settleRoute(f.db, f.office, st.delivery_sheet_id, { actualCashCents: 0 });
    await assert.rejects(undoDelivery(f.db, f.admin, o.id, { dryRun: true }), /settled\. Raise a credit note/);
  });
});
