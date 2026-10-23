/**
 * Deliveries recorded on a later day (23 Oct 2026): dated the day they went
 * out; office staff limited to backdate_days back, administrators any date.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { recordPastDelivery, backdateDays } from '../src/services/counter.ts';
import { businessToday } from '../src/services/core.ts';
import { pendingDeliveries } from '../src/services/cycles.ts';

let f: Fixture;
const daysAgo = (n: number) => {
  const d = new Date(`${businessToday()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

before(async () => { f = await setupFixture(); });
after(async () => f.close());

describe('recording a delivery on a later day', () => {
  test('three days by default', async () => {
    assert.equal(await backdateDays(f.db), 3);
  });

  test('dated the day it went out: order, invoice, due date and payment; never on a round', async () => {
    const on = daysAgo(2);
    const r = await recordPastDelivery(f.db, f.office, {
      customerId: f.customerId, deliveredOn: on, how: 'Delivered',
      lines: [{ productId: f.fiveGalProductId, looseBottles: 3 }],
      amountPaidCents: 50_000, method: 'Cash',
    });
    assert.ok(r.invoiceNumber);
    const inv = await f.db.one<{ invoice_date: string; due_date: string }>(
      `SELECT invoice_date::text, due_date::text FROM invoices WHERE id = $1`, [r.invoiceId]);
    assert.equal(inv.invoice_date, on);
    assert.ok(inv.due_date >= on);
    const o = await f.db.one<{ order_date: string; fulfilled_on: string; recorded_late: boolean; delivery_mode: string; status: string }>(
      `SELECT order_date::text, fulfilled_on::text, recorded_late, delivery_mode, status FROM customer_orders WHERE id = $1`, [r.orderId]);
    assert.deepEqual([o.order_date, o.fulfilled_on, o.recorded_late, o.delivery_mode, o.status], [on, on, true, 'Delivery', 'Delivered']);
    const stops = await f.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM delivery_stops WHERE order_id = $1`, [r.orderId]);
    assert.equal(stops.n, 0, 'never on a round');
    const pay = await f.db.one<{ d: string }>(
      `SELECT business_date(payment_date)::text AS d FROM payments WHERE invoice_id = $1`, [r.invoiceId]);
    assert.equal(pay.d, on);
  });

  test('office staff: no further back than the setting; administrators: any day', async () => {
    const line = [{ productId: f.casedProductId, cases: 1 }];
    await assert.rejects(recordPastDelivery(f.db, f.office, {
      customerId: f.customerId, deliveredOn: daysAgo(4), how: 'Collected', lines: line,
    }), /up to 3 days back/);
    const r = await recordPastDelivery(f.db, f.admin, {
      customerId: f.customerId, deliveredOn: daysAgo(40), how: 'Collected', lines: line,
    });
    assert.ok(r.invoiceNumber);
    await f.db.query(`UPDATE system_settings SET value = '1' WHERE key = 'backdate_days'`);
    await assert.rejects(recordPastDelivery(f.db, f.office, {
      customerId: f.customerId, deliveredOn: daysAgo(2), how: 'Collected', lines: line,
    }), /up to 1 day back/);
    await f.db.query(`UPDATE system_settings SET value = '3' WHERE key = 'backdate_days'`);
  });

  test('not a day in the future', async () => {
    const d = new Date(`${businessToday()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1);
    await assert.rejects(recordPastDelivery(f.db, f.admin, {
      customerId: f.customerId, deliveredOn: d.toISOString().slice(0, 10), how: 'Delivered',
      lines: [{ productId: f.casedProductId, cases: 1 }],
    }), /not happened yet/);
  });

  test('a weekly customer: no invoice now; it waits for that week', async () => {
    await f.db.query(`UPDATE customers SET invoice_cycle = 'Weekly' WHERE id = $1`, [f.otherCustomerId]);
    const on = daysAgo(1);
    const r = await recordPastDelivery(f.db, f.office, {
      customerId: f.otherCustomerId, deliveredOn: on, how: 'Delivered',
      lines: [{ productId: f.fiveGalProductId, looseBottles: 2 }],
    });
    assert.equal(r.onCycle, true);
    assert.equal(r.invoiceId, null);
    const waiting = await pendingDeliveries(f.db, f.otherCustomerId);
    const mine = waiting.find((w) => w.orderId === r.orderId);
    assert.ok(mine, 'waiting for the weekly invoice');
    assert.equal(mine!.date, on);
  });
});
