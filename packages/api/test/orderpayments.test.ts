/**
 * Payment on the New order screen (Everton, 11 Oct 2026).
 *
 * Money taken with an order before delivery sits on the account and goes
 * against that order's invoice the moment it is raised; customers can prepay
 * or overpay; credit is used first. The driver is only asked for what is left.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { buildServer } from '../src/server.ts';
import { createOrder } from '../src/services/orders.ts';
import { markStop, getStopForDriver } from '../src/services/delivery.ts';
import { settleRoute } from '../src/services/settlement.ts';
import { counterSale } from '../src/services/counter.ts';
import { receivePayment } from '../src/services/payments.ts';
import { getInvoiceLedger } from '../src/services/invoices.ts';
import { businessToday } from '../src/services/core.ts';
import { addDays } from '@alka/shared';

let f: Fixture;
const today = businessToday();

before(async () => { f = await setupFixture(); });
after(async () => { await f.close(); });

let n = 0;
/** A customer of its own for each test, so no money carries between them. */
const customer = async (zone = 'Kingston') => (await f.db.one<{ id: string }>(
  `INSERT INTO customers (name, phone, email, price_tier_id, delivery_address, delivery_zone, payment_terms)
   VALUES ($1, '876-555-0100', '', $2, '1 Test Rd, Kingston', $3, 'Net 30') RETURNING id`,
  [`Order Payments ${++n}`, f.tierId, zone],
)).id;
// 2 cases at the Corporate $1,200.00 + GCT = $2,760.00.
const TOTAL = 276_000;
const deliveryOrder = (customerId: string, days = 1) => createOrder(f.db, f.office, {
  customerId, deliveryMode: 'Delivery', requestedDeliveryDate: addDays(today, days),
  lines: [{ productId: f.casedProductId, cases: 2 }],
});
const stopOf = (orderId: string) => f.db.one<{ id: string; delivery_sheet_id: string }>(
  `SELECT id, delivery_sheet_id FROM delivery_stops WHERE order_id = $1`, [orderId]);
const pay = (customerId: string, amountCents: number, extra: Record<string, unknown> = {}) =>
  receivePayment(f.db, f.office, { customerId, amountCents, method: 'Cash', ...extra });

describe('Paid with the order, before delivery', () => {
  test('the driver is asked only for what is left, and the invoice is paid on delivery', async () => {
    const c = await customer();
    const o = await deliveryOrder(c);
    assert.equal(o.grandTotalCents, TOTAL);
    await pay(c, 100_000, { orderId: o.id });

    const stop = await stopOf(o.id);
    const before_ = await getStopForDriver(f.db, stop.id) as { amountOwedCents: number; alreadyPaidCents: number };
    assert.equal(before_.amountOwedCents, TOTAL - 100_000, 'to collect at the door');
    assert.equal(before_.alreadyPaidCents, 100_000);

    const r = await markStop(f.db, f.driver, { stopId: stop.id, outcome: 'Delivered' });
    assert.equal(r.amountOwedCents, TOTAL - 100_000);
    const inv = (await getInvoiceLedger(f.db, r.invoiceId!))!;
    assert.equal(inv.amountPaidCents, 100_000, 'the prepayment went on the invoice');
    assert.equal(inv.balanceCents, TOTAL - 100_000);

    // The driver collects the rest; settling the round does not move the figure.
    await f.db.query(`UPDATE delivery_stops SET payment_amount_cents = $2, payment_method = 'Cash',
                       payment_received = true WHERE id = $1`, [stop.id, TOTAL - 100_000]);
    await f.db.query(`INSERT INTO delivery_stop_allocations (stop_id, invoice_id, amount_cents) VALUES ($1,$2,$3)`,
      [stop.id, r.invoiceId, TOTAL - 100_000]);
    await settleRoute(f.db, f.office, stop.delivery_sheet_id, { actualCashCents: TOTAL - 100_000 });
    const after_ = (await getInvoiceLedger(f.db, r.invoiceId!))!;
    assert.equal(after_.balanceCents, 0);
    const again = await getStopForDriver(f.db, stop.id) as { amountOwedCents: number };
    assert.equal(again.amountOwedCents, TOTAL - 100_000, 'unchanged by settling');
  });

  test('more than the order stays on the account as credit', async () => {
    const c = await customer();
    const o = await deliveryOrder(c);
    await pay(c, 300_000, { orderId: o.id });
    const stop = await stopOf(o.id);
    const r = await markStop(f.db, f.driver, { stopId: stop.id, outcome: 'Delivered' });
    assert.equal(r.amountOwedCents, 0, 'nothing to collect');
    const inv = (await getInvoiceLedger(f.db, r.invoiceId!))!;
    assert.equal(inv.balanceCents, 0);
    const bal = await f.db.one<{ b: number }>(`SELECT balance_cents AS b FROM customer_balances WHERE customer_id = $1`, [c]);
    assert.equal(Number(bal.b), -(300_000 - TOTAL), 'in credit by the difference');
  });

  test('money taken with one order is kept for it, not spent on another delivered first', async () => {
    const c = await customer();
    const a = await deliveryOrder(c, 3);
    const b = await deliveryOrder(c, 1);
    await pay(c, TOTAL, { orderId: a.id });
    const sb = await getStopForDriver(f.db, (await stopOf(b.id)).id) as { amountOwedCents: number };
    assert.equal(sb.amountOwedCents, TOTAL, 'the driver collects B in full');
    const sa = await getStopForDriver(f.db, (await stopOf(a.id)).id) as { amountOwedCents: number };
    assert.equal(sa.amountOwedCents, 0, 'and nothing for A');
    const rb = await markStop(f.db, f.driver, { stopId: (await stopOf(b.id)).id, outcome: 'Delivered' });
    assert.equal((await getInvoiceLedger(f.db, rb.invoiceId!))!.balanceCents, TOTAL, 'B is not paid from A\'s money');
    const ra = await markStop(f.db, f.driver, { stopId: (await stopOf(a.id)).id, outcome: 'Delivered' });
    assert.equal((await getInvoiceLedger(f.db, ra.invoiceId!))!.balanceCents, 0, 'A is');
  });
});

describe('Credit on the account', () => {
  test('a prepayment with no order goes against the next invoice', async () => {
    const c = await customer();
    await pay(c, 50_000);
    const o = await deliveryOrder(c);
    const stop = await stopOf(o.id);
    const r = await markStop(f.db, f.driver, { stopId: stop.id, outcome: 'Delivered' });
    assert.equal((await getInvoiceLedger(f.db, r.invoiceId!))!.balanceCents, TOTAL - 50_000);
  });

  test('money that belongs against older invoices is left for the office to put there', async () => {
    const c = await customer();
    const old = await counterSale(f.db, f.office, {
      customerId: c, lines: [{ productId: f.casedProductId, cases: 2 }], amountPaidCents: 0,
    });
    assert.equal(old.balanceCents, TOTAL);
    await pay(c, 100_000); // not in credit: they still owe $1,760 overall
    const o = await deliveryOrder(c);
    const r = await markStop(f.db, f.driver, { stopId: (await stopOf(o.id)).id, outcome: 'Delivered' });
    assert.equal((await getInvoiceLedger(f.db, r.invoiceId!))!.balanceCents, TOTAL, 'nothing taken from the older money');
  });

  test('at the counter, credit goes on first and the cash pays the rest', async () => {
    const c = await customer();
    await pay(c, 76_000);
    const s = await counterSale(f.db, f.office, {
      customerId: c, lines: [{ productId: f.casedProductId, cases: 2 }], amountPaidCents: 200_000, method: 'Cash',
    });
    assert.equal(s.balanceCents, 0);
    const bal = await f.db.one<{ b: number }>(`SELECT balance_cents AS b FROM customer_balances WHERE customer_id = $1`, [c]);
    assert.equal(Number(bal.b), 0, 'no phantom credit from the cash');
  });

  test('the shared walk-in record never has credit applied', async () => {
    const w = await counterSale(f.db, f.office, { lines: [{ productId: f.casedProductId, cases: 1 }], amountPaidCents: 200_000 });
    assert.equal(w.balanceCents, 0);
    const again = await counterSale(f.db, f.office, { lines: [{ productId: f.casedProductId, cases: 1 }] });
    assert.equal(again.amountPaidCents, again.grandTotalCents, 'paid by the walk-in, not from earlier change');
  });
});

describe('The New order screen in one request', () => {
  test('an order with payment: older invoice paid, the rest kept for this order', async () => {
    const c = await customer();
    const old = await counterSale(f.db, f.office, {
      customerId: c, lines: [{ productId: f.casedProductId, cases: 1 }], amountPaidCents: 0,
    });
    const app = await buildServer(f.db);
    try {
      const { signToken } = await import('../src/lib/auth.ts');
      const tok = signToken({ id: f.office.id, name: f.office.name, role: 'user', customerId: null });
      const res = await app.inject({
        method: 'POST', url: '/api/orders', headers: { authorization: `Bearer ${tok}` },
        payload: {
          customerId: c, deliveryMode: 'Delivery', requestedDeliveryDate: addDays(today, 2),
          lines: [{ productId: f.casedProductId, cases: 2 }], payWhen: 'Now',
          payment: {
            amountCents: old.grandTotalCents + 100_000, method: 'Cheque', reference: 'Chq 1',
            allocations: [{ invoiceId: old.invoiceId, amountCents: old.grandTotalCents }],
          },
        },
      });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json() as { id: string; paymentError?: string };
      assert.equal(body.paymentError, undefined);
      assert.equal((await getInvoiceLedger(f.db, old.invoiceId))!.balanceCents, 0);
      const kept = await f.db.one<{ c: number }>(
        `SELECT COALESCE(SUM(amount_cents),0)::bigint AS c FROM payments WHERE order_id = $1 AND invoice_id IS NULL`, [body.id]);
      assert.equal(Number(kept.c), 100_000);
      const o = await f.db.one<{ pay_when: string }>(`SELECT pay_when FROM customer_orders WHERE id = $1`, [body.id]);
      assert.equal(o.pay_when, 'Now');

      const refused = await app.inject({
        method: 'POST', url: '/api/orders', headers: { authorization: `Bearer ${tok}` },
        payload: {
          customerId: c, deliveryMode: 'Pickup', requestedDeliveryDate: addDays(today, 2),
          lines: [{ productId: f.casedProductId, cases: 1 }],
          payment: { amountCents: 1000, method: 'Card' },
        },
      });
      assert.equal(refused.statusCode, 400, 'card is off: the order is not made either');
    } finally {
      await app.close();
    }
  });
});
