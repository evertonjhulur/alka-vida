/** Standing orders: raising each occurrence, and never raising it twice. */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, stopsOf, type Fixture } from './helpers.ts';
import { createOrder } from '../src/services/orders.ts';
import {
  startSchedule, generateDueOrders, listSchedules,
  setSchedulePaused, endSchedule, updateSchedule,
} from '../src/services/recurring.ts';
import { markStop } from '../src/services/delivery.ts';
import { getInvoiceLedger } from '../src/services/invoices.ts';
import { setTierPrice, priceMatrix } from '../src/services/pricing.ts';

let f: Fixture;
before(async () => { f = await setupFixture(); });
after(async () => { await f.close(); });

/** A weekly standing order starting on the given date. */
async function weeklyFrom(date: string, cases = 10) {
  const order = await createOrder(f.db, f.office, {
    customerId: f.customerId,
    deliveryMode: 'Delivery',
    requestedDeliveryDate: date,
    lines: [{ productId: f.casedProductId, cases }],
  });
  const started = await startSchedule(f.db, f.office, order.id, { pattern: 'Weekly' });
  return { order, nextDeliveryDate: started.nextDeliveryDate };
}

describe('Starting a schedule', () => {
  test('the first order becomes the schedule and points at the second date', async () => {
    const { order, nextDeliveryDate } = await weeklyFrom('2028-01-03');
    assert.equal(nextDeliveryDate, '2028-01-10', 'a week after the first delivery');

    const row = await f.db.one<{ is_recurring: boolean; parent_recurring_id: string | null }>(
      `SELECT is_recurring, parent_recurring_id FROM customer_orders WHERE id = $1`,
      [order.id],
    );
    assert.equal(row.is_recurring, true);
    assert.equal(row.parent_recurring_id, null, 'the schedule is the head of the series');
  });

  test('a schedule cannot be started twice, or on an occurrence', async () => {
    const { order } = await weeklyFrom('2028-02-07');
    await assert.rejects(
      startSchedule(f.db, f.office, order.id, { pattern: 'Weekly' }),
      /already a standing order/,
    );

    await generateDueOrders(f.db, f.office, { today: '2028-02-10' });
    const child = await f.db.maybeOne<{ id: string }>(
      `SELECT id FROM customer_orders WHERE parent_recurring_id = $1 LIMIT 1`, [order.id],
    );
    await assert.rejects(
      startSchedule(f.db, f.office, child!.id, { pattern: 'Weekly' }),
      /already one occurrence/,
    );
  });
});

describe('Generating occurrences', () => {
  test('raises the next occurrence once it is within the lead time', async () => {
    const { order } = await weeklyFrom('2028-03-06');
    // Next is the 13th; on the 10th that is 3 days away, inside the 7-day lead.
    const run = await generateDueOrders(f.db, f.office, { today: '2028-03-10' });

    const mine = run.created.filter((c) => c.scheduleId === order.id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].date, '2028-03-13');
  });

  test('running again the same day creates nothing further', async () => {
    const { order } = await weeklyFrom('2028-04-03');
    const first = await generateDueOrders(f.db, f.office, { today: '2028-04-05' });
    const second = await generateDueOrders(f.db, f.office, { today: '2028-04-05' });

    assert.equal(first.created.filter((c) => c.scheduleId === order.id).length, 1);
    assert.equal(second.created.filter((c) => c.scheduleId === order.id).length, 0,
      'the schedule has already been advanced past that date');

    const count = await f.db.one<{ c: number }>(
      `SELECT COUNT(*)::int c FROM customer_orders WHERE parent_recurring_id = $1`, [order.id],
    );
    assert.equal(num(count.c), 1);
  });

  test('the database refuses a second order for the same series and date', async () => {
    const { order } = await weeklyFrom('2028-05-01');
    await generateDueOrders(f.db, f.office, { today: '2028-05-03' });
    const child = await f.db.one<{ requested_delivery_date: string }>(
      `SELECT requested_delivery_date::text AS requested_delivery_date
       FROM customer_orders WHERE parent_recurring_id = $1`, [order.id],
    );

    // Force the duplicate the generator's guard would normally prevent.
    await assert.rejects(
      createOrder(f.db, f.office, {
        customerId: f.customerId, deliveryMode: 'Delivery',
        requestedDeliveryDate: child.requested_delivery_date,
        parentRecurringId: order.id,
        lines: [{ productId: f.casedProductId, cases: 1 }],
      }),
      /duplicate key|unique/i,
    );
  });

  test('catches up several recent cycles in one run', async () => {
    const { order } = await weeklyFrom('2028-06-05');
    // Two weeks later: the 12th and 19th are due, the 26th is within lead.
    const run = await generateDueOrders(f.db, f.office, { today: '2028-06-19' });
    const dates = run.created.filter((c) => c.scheduleId === order.id).map((c) => c.date);
    assert.deepEqual(dates, ['2028-06-12', '2028-06-19', '2028-06-26']);
  });

  test('reports occurrences too old to raise instead of losing them silently', async () => {
    const { order } = await weeklyFrom('2028-07-03');
    // Six months on. The missed cycles must be reported, not back-dated.
    const run = await generateDueOrders(f.db, f.office, { today: '2029-01-08' });

    const skipped = run.skipped.filter((s) => s.scheduleId === order.id);
    assert.ok(skipped.length > 0, 'the missed period is surfaced');

    const created = run.created.filter((c) => c.scheduleId === order.id);
    for (const c of created) {
      assert.ok(c.date >= '2028-12-25', 'nothing is raised from months ago');
    }
  });

  test('does nothing for a schedule whose next date is far off', async () => {
    const { order } = await weeklyFrom('2029-06-04');
    const run = await generateDueOrders(f.db, f.office, { today: '2029-03-01' });
    assert.equal(run.created.filter((c) => c.scheduleId === order.id).length, 0);
  });
});

describe('An occurrence is an ordinary order', () => {
  test('it routes onto a delivery sheet and invoices at delivery, like any other', async () => {
    const { order } = await weeklyFrom('2028-08-07', 4);
    const run = await generateDueOrders(f.db, f.office, { today: '2028-08-10' });
    const raised = run.created.find((c) => c.scheduleId === order.id)!;

    const stop = await f.db.one<{ id: string; delivery_sheet_id: string }>(
      `SELECT id, delivery_sheet_id FROM delivery_stops WHERE order_id = $1`,
      [raised.orderId],
    );
    assert.ok(stop.id, 'auto-routed exactly like a one-off');

    const delivered = await markStop(f.db, f.driver, {
      stopId: stop.id, outcome: 'Delivered',
    });
    assert.ok(delivered.invoiceId, 'its own invoice at the moment of delivery');

    // 4 x 1200.00 = 4,800.00 + 15% = 5,520.00
    const inv = await getInvoiceLedger(f.db, delivered.invoiceId!);
    assert.equal(inv!.grandTotalCents, 552_000);
  });

  test('consecutive occurrences get separate invoices, never batched', async () => {
    const { order } = await weeklyFrom('2028-09-04', 2);
    const run = await generateDueOrders(f.db, f.office, { today: '2028-09-18' });
    const raised = run.created.filter((c) => c.scheduleId === order.id);
    assert.ok(raised.length >= 2);

    const invoiceIds: string[] = [];
    for (const r of raised.slice(0, 2)) {
      const stop = await f.db.one<{ id: string }>(
        `SELECT id FROM delivery_stops WHERE order_id = $1`, [r.orderId],
      );
      const d = await markStop(f.db, f.driver, { stopId: stop.id, outcome: 'Delivered' });
      invoiceIds.push(d.invoiceId!);
    }
    assert.equal(new Set(invoiceIds).size, 2, 'two distinct invoices');
  });

  test('each occurrence is priced at the rate in force when it is raised', async () => {
    const m = await priceMatrix(f.db);
    const corporate = m.tiers.find((t) => t.name === 'Corporate')!;
    const { order } = await weeklyFrom('2028-10-02', 10);

    // 10 cases at the current 1,200.00 = 12,000.00 + 15% = 13,800.00
    const before = await generateDueOrders(f.db, f.office, { today: '2028-10-05' });
    const firstId = before.created.find((c) => c.scheduleId === order.id)!.orderId;
    const firstTotal = await f.db.one<{ g: number }>(
      `SELECT grand_total_cents g FROM customer_orders WHERE id = $1`, [firstId],
    );
    assert.equal(Number(firstTotal.g), 1_380_000);

    await setTierPrice(f.db, f.office, {
      priceTierId: corporate.id, productId: f.casedProductId, priceCents: 150_000,
    });

    const after = await generateDueOrders(f.db, f.office, { today: '2028-10-12' });
    const laterId = after.created.find((c) => c.scheduleId === order.id)!.orderId;
    const laterTotal = await f.db.one<{ g: number }>(
      `SELECT grand_total_cents g FROM customer_orders WHERE id = $1`, [laterId],
    );
    // 10 x 1,500.00 = 15,000.00 + 15% = 17,250.00
    assert.equal(Number(laterTotal.g), 1_725_000, 'the new rate applies from the next one');

    // And the one already raised is untouched.
    const unchanged = await f.db.one<{ g: number }>(
      `SELECT grand_total_cents g FROM customer_orders WHERE id = $1`, [firstId],
    );
    assert.equal(Number(unchanged.g), 1_380_000);

    // Put it back for other tests.
    await setTierPrice(f.db, f.office, {
      priceTierId: corporate.id, productId: f.casedProductId, priceCents: 120_000,
    });
  });
});

describe('Managing a schedule', () => {
  test('pausing stops it producing work', async () => {
    const { order } = await weeklyFrom('2028-11-06');
    await setSchedulePaused(f.db, f.office, order.id, true);
    const run = await generateDueOrders(f.db, f.office, { today: '2028-11-10' });
    assert.equal(run.created.filter((c) => c.scheduleId === order.id).length, 0);
  });

  test('resuming rolls forward instead of back-filling the silent period', async () => {
    const { order } = await weeklyFrom('2029-02-05');
    await setSchedulePaused(f.db, f.office, order.id, true);

    // Resume months later. It must not dump the whole pause as orders.
    const resumed = await setSchedulePaused(f.db, f.office, order.id, false);
    assert.ok(resumed.nextDeliveryDate, 'still scheduled');

    const run = await generateDueOrders(f.db, f.office, { today: '2029-02-05' });
    const created = run.created.filter((c) => c.scheduleId === order.id);
    assert.ok(created.length <= 2, `expected a normal week or two, got ${created.length}`);
  });

  test('ending it stops it for good but keeps what was already raised', async () => {
    const { order } = await weeklyFrom('2029-04-02');
    await generateDueOrders(f.db, f.office, { today: '2029-04-05' });
    const raisedBefore = await f.db.one<{ c: number }>(
      `SELECT COUNT(*)::int c FROM customer_orders WHERE parent_recurring_id = $1`, [order.id],
    );

    await endSchedule(f.db, f.admin, order.id, 'contract finished');
    const run = await generateDueOrders(f.db, f.office, { today: '2029-04-20' });
    assert.equal(run.created.filter((c) => c.scheduleId === order.id).length, 0);

    const raisedAfter = await f.db.one<{ c: number }>(
      `SELECT COUNT(*)::int c FROM customer_orders WHERE parent_recurring_id = $1`, [order.id],
    );
    assert.equal(num(raisedAfter.c), num(raisedBefore.c), 'history is untouched');
  });

  test('an end date stops the series without anyone intervening', async () => {
    const { order } = await weeklyFrom('2029-05-07');
    await updateSchedule(f.db, f.office, order.id, { endsOn: '2029-05-21' });

    const run = await generateDueOrders(f.db, f.office, { today: '2029-06-20' });
    const dates = run.created.filter((c) => c.scheduleId === order.id).map((c) => c.date);
    for (const d of dates) assert.ok(d <= '2029-05-21', `${d} is past the end date`);
  });

  test('the pattern can be changed on a running schedule', async () => {
    const { order } = await weeklyFrom('2029-07-02');
    await updateSchedule(f.db, f.office, order.id, {
      pattern: 'Monthly', nextDeliveryDate: '2029-08-02',
    });
    const run = await generateDueOrders(f.db, f.office, { today: '2029-07-29' });
    const dates = run.created.filter((c) => c.scheduleId === order.id).map((c) => c.date);
    assert.deepEqual(dates, ['2029-08-02']);
  });

  test('a schedule for an inactive customer produces nothing', async () => {
    const { order } = await weeklyFrom('2029-09-03');
    await f.db.query(`UPDATE customers SET active = false WHERE id = $1`, [f.customerId]);
    const run = await generateDueOrders(f.db, f.office, { today: '2029-09-06' });
    assert.equal(run.created.filter((c) => c.scheduleId === order.id).length, 0);
    await f.db.query(`UPDATE customers SET active = true WHERE id = $1`, [f.customerId]);
  });
});

describe('The schedules list', () => {
  test('shows each series with its next date and how many it has raised', async () => {
    const list = await listSchedules(f.db);
    assert.ok(list.length > 0);
    const one = list.find((s) => s.occurrencesRaised > 0);
    assert.ok(one, 'at least one series has raised occurrences');
    assert.ok(one!.customerName);
    assert.ok(one!.lineSummary.length > 0, 'shows what is on the standing order');
  });

  test('records what the last run did, so a silent schedule can be explained', async () => {
    const { order } = await weeklyFrom('2029-10-01');
    await generateDueOrders(f.db, f.office, { today: '2029-10-05' });
    const s = (await listSchedules(f.db)).find((x) => x.id === order.id)!;
    assert.ok(s.lastRunAt, 'the run is timestamped');
    assert.match(s.lastNote ?? '', /raised|nothing/);
  });
});

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v);
}
