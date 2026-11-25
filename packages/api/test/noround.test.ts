/**
 * Delivery orders with no round (Everton, 25 Nov 2026).
 *
 *   - Counted the moment a delivery order has no round: no zone, taken off
 *     its round, its round deleted, missed and not moved. Not counted:
 *     collections, counter sales, orders waiting for approval of their day,
 *     deliveries recorded after the fact.
 *   - The count clears itself once the order is on a round.
 *   - Put on its round: its zone's round for its day; a zone set on the
 *     customer if they have none; a new day if its date has passed.
 *   - Customers who signed up "Not sure" of their zone count until it is
 *     set; setting it places their waiting orders and emails their day;
 *     "Looks right" needs the zone first. Office staff may set it.
 *   - The loading screen lists this zone and day's orders not on the round.
 *   - A backup phone notification, once, after a short grace.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { createOrder } from '../src/services/orders.ts';
import { removeStop, deleteRound } from '../src/services/routing.ts';
import { noRound, putOnRound, putOnRounds, setCustomerZone } from '../src/services/noround.ts';
import { createZone } from '../src/services/zones.ts';
import { updateCustomer } from '../src/services/customers.ts';
import { markSignupReviewed } from '../src/services/signup.ts';
import { loadingSummary } from '../src/services/trucks.ts';
import { runAlerts } from '../src/services/alerts.ts';
import { setPushSink } from '../src/services/push.ts';
import { setMailSinkForTests } from '../src/services/documents.ts';
import { businessToday } from '../src/services/core.ts';
import { addDays } from '@alka/shared';

let f: Fixture;
const today = businessToday();
const day = addDays(today, 3);
const mails: Array<{ to: unknown; subject: string; text: string }> = [];

const cust = async (name: string, zone: string | null, signedUp = false) => (await f.db.one<{ id: string }>(
  `INSERT INTO customers (name, phone, email, delivery_address, delivery_zone, signed_up_at)
   VALUES ($1,'876-555-0199',$2,'3 Test Ave', $3, CASE WHEN $4 THEN now() END) RETURNING id`,
  [name, `${name.toLowerCase().replace(/\W+/g, '.')}@example.com`, zone, signedUp])).id;
const order = (customerId: string, extra: Record<string, unknown> = {}) => createOrder(f.db, f.office, {
  customerId, deliveryMode: 'Delivery', requestedDeliveryDate: day,
  lines: [{ productId: f.casedProductId, cases: 1 }], ...extra,
} as never);
const listed = async () => (await noRound(f.db)).orders.map((o) => o.orderNumber);
const stopOf = async (orderId: string) => (await f.db.one<{ id: string; delivery_sheet_id: string }>(
  `SELECT id, delivery_sheet_id FROM delivery_stops WHERE order_id = $1`, [orderId]));

before(async () => {
  f = await setupFixture();
  for (const name of ['Kingston', 'Boulevard']) {
    const has = await f.db.maybeOne(`SELECT 1 FROM delivery_zones WHERE name = $1`, [name]);
    if (!has) await createZone(f.db, f.admin, { name });
  }
  setMailSinkForTests(async (m) => { mails.push({ to: m.to, subject: m.subject, text: m.text }); });
});
after(async () => { setPushSink(null); setMailSinkForTests(null); await f.close(); });

describe('What has no round', () => {
  test('an order on its round is not counted; taken off, it is, and says why', async () => {
    const o = await order(f.customerId);
    assert.ok(!(await listed()).includes(o.orderNumber));
    const st = await stopOf(o.id);
    await removeStop(f.db, f.office, st.id);
    const nr = await noRound(f.db);
    const row = nr.orders.find((x) => x.orderNumber === o.orderNumber)!;
    assert.equal(row.kind, 'off-round');
    assert.match(row.reason, /^Taken off the Kingston round for \w{3} \d+ \w{3} by /);

    // Back on: it clears itself, and the reason is forgotten.
    await putOnRound(f.db, f.office, o.id);
    assert.ok(!(await listed()).includes(o.orderNumber));
    const back = await f.db.one(`SELECT off_round_note FROM customer_orders WHERE id = $1`, [o.id]);
    assert.equal(back.off_round_note, null);
  });

  test('a deleted round leaves its orders counted, saying so', async () => {
    const c = await cust('Deleted Round Co', 'Boulevard');
    const o = await order(c);
    await deleteRound(f.db, f.office, (await stopOf(o.id)).delivery_sheet_id);
    const row = (await noRound(f.db)).orders.find((x) => x.orderNumber === o.orderNumber)!;
    assert.match(row.reason, /^Its Boulevard round for .* was deleted by /);
    await putOnRound(f.db, f.office, o.id);
  });

  test('no zone counts; collections, approval-waiting and after-the-fact do not', async () => {
    const nz = await cust('No Zone Ltd', null);
    const o = await order(nz);
    const row = (await noRound(f.db)).orders.find((x) => x.orderNumber === o.orderNumber)!;
    assert.equal(row.kind, 'no-zone');
    assert.equal(row.reason, 'No delivery zone on file');

    const pickup = await createOrder(f.db, f.office, {
      customerId: nz, deliveryMode: 'Pickup', requestedDeliveryDate: day, lines: [{ productId: f.casedProductId, cases: 1 }],
    });
    const waiting = await order(f.customerId);
    await f.db.query(`UPDATE customer_orders SET needs_review = true WHERE id = $1`, [waiting.id]);
    await removeStop(f.db, f.office, (await stopOf(waiting.id)).id);
    const late = await order(nz);
    await f.db.query(`UPDATE customer_orders SET recorded_late = true WHERE id = $1`, [late.id]);
    const now = await listed();
    assert.ok(!now.includes(pickup.orderNumber));
    assert.ok(!now.includes(waiting.orderNumber));
    assert.ok(!now.includes(late.orderNumber));
    await f.db.query(`UPDATE customer_orders SET status = 'Cancelled' WHERE id IN ($1, $2)`, [waiting.id, late.id]);
  });
});

describe('Put on its round', () => {
  test('no zone: one must be picked, and it is saved on the customer', async () => {
    const c = await cust('Pick A Zone', null);
    const o = await order(c);
    await assert.rejects(putOnRound(f.db, f.office, o.id), /pick a delivery zone/);
    const r = await putOnRound(f.db, f.office, o.id, { zone: 'Boulevard' });
    assert.deepEqual([r.zone, r.day], ['Boulevard', day]);
    assert.equal((await f.db.one(`SELECT delivery_zone FROM customers WHERE id = $1`, [c])).delivery_zone, 'Boulevard');
    const sheet = await f.db.one(`SELECT d.zone, d.delivery_date::text AS day FROM delivery_stops s
      JOIN delivery_sheets d ON d.id = s.delivery_sheet_id WHERE s.order_id = $1`, [o.id]);
    assert.deepEqual([sheet.zone, sheet.day], ['Boulevard', day]);
  });

  test('a date that has passed needs a new day; the batch reports what it skipped', async () => {
    const a = await order(f.customerId); const b = await order(f.customerId);
    for (const o of [a, b]) await removeStop(f.db, f.office, (await stopOf(o.id)).id);
    await f.db.query(`UPDATE customer_orders SET requested_delivery_date = $2::date WHERE id = $1`, [a.id, addDays(today, -2)]);
    const row = (await noRound(f.db)).orders.find((x) => x.id === a.id)!;
    assert.equal(row.late, true);
    const r = await putOnRounds(f.db, f.office, [a.id, b.id]);
    assert.deepEqual(r.placed.map((p) => p.orderNumber), [b.orderNumber]);
    assert.match(r.skipped[0].why, /has passed: pick a new day/);
    const moved = await putOnRound(f.db, f.office, a.id, { date: addDays(today, 1) });
    assert.equal(moved.day, addDays(today, 1));
    assert.equal((await f.db.one(`SELECT requested_delivery_date::text AS d FROM customer_orders WHERE id = $1`, [a.id])).d, addDays(today, 1));
  });

  test('a driver cannot; a collection or an approval-waiting order is refused', async () => {
    const o = await order(f.customerId);
    await assert.rejects(putOnRound(f.db, f.driver, o.id), /requires role/);
    const p = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Pickup', lines: [{ productId: f.casedProductId, cases: 1 }],
    });
    await assert.rejects(putOnRound(f.db, f.office, p.id), /not a delivery/);
  });
});

describe('Sign-ups "Not sure" of their zone', () => {
  test('counted until set; setting it places their orders and emails their day', async () => {
    const c = await cust('Not Sure Nadine', null, true);
    let nr = await noRound(f.db);
    assert.ok(nr.customers.some((x) => x.id === c));
    const before = nr.count;

    // Their order with no zone: one thing to fix, not two.
    const o = await order(c);
    nr = await noRound(f.db);
    assert.equal(nr.count, before, 'the order replaces the customer in the count');

    await assert.rejects(markSignupReviewed(f.db, f.office, c), /set their delivery zone first/);
    mails.length = 0;
    const r = await setCustomerZone(f.db, f.office, c, 'Boulevard');
    assert.deepEqual(r.placed, [o.orderNumber]);
    assert.equal(r.emailed, true);
    assert.equal(mails.length, 1);
    assert.match(mails[0].subject, /your delivery day is/);
    assert.match(mails[0].text, /Boulevard area/);
    assert.ok(mails[0].text.includes(o.orderNumber));
    nr = await noRound(f.db);
    assert.ok(!nr.customers.some((x) => x.id === c));
    assert.ok(!nr.orders.some((x) => x.id === o.id));
    await markSignupReviewed(f.db, f.office, c); // now it goes through

    // Once per zone.
    mails.length = 0;
    await setCustomerZone(f.db, f.office, c, 'Boulevard');
    assert.equal(mails.length, 0);
  });

  test('setting the zone on the Details tab does the same', async () => {
    const c = await cust('Details Dave', null, true);
    const o = await order(c);
    mails.length = 0;
    const r = await updateCustomer(f.db, f.office, c, { deliveryZone: 'Kingston' });
    assert.ok(r.warnings.some((w) => w.includes(o.orderNumber) && w.includes('Kingston round')));
    assert.equal(mails.length, 1);
    assert.ok(!(await listed()).includes(o.orderNumber));
  });

  test('an office customer given a zone gets no sign-up email', async () => {
    const c = await cust('Office Made', null, false);
    await order(c);
    mails.length = 0;
    await setCustomerZone(f.db, f.office, c, 'Kingston');
    assert.equal(mails.length, 0);
  });
});

describe('Loading and the backup notification', () => {
  test("the loading screen lists this zone and day's orders not on the round", async () => {
    const keep = await order(f.customerId);
    const off = await order(f.customerId);
    await removeStop(f.db, f.office, (await stopOf(off.id)).id);
    const sum = await loadingSummary(f.db, (await stopOf(keep.id)).delivery_sheet_id);
    assert.ok(sum!.notOnRound.some((x) => x.orderNumber === off.orderNumber));
    assert.ok(!sum!.notOnRound.some((x) => x.orderNumber === keep.orderNumber));
    await putOnRound(f.db, f.office, off.id);
  });

  test('one phone notification after the grace, not before, and not twice', async () => {
    await f.db.query(`UPDATE system_settings SET value = (now() - interval '1 hour')::text WHERE key = 'alerts_since'`);
    await f.db.query(`UPDATE users SET notify_orders = true WHERE id = $1`, [f.office.id]);
    setPushSink(async () => 201);
    const o = await order(f.customerId);
    await removeStop(f.db, f.office, (await stopOf(o.id)).id);
    const notes = async () => (await f.db.query<{ title: string }>(
      `SELECT title FROM staff_notifications WHERE user_id = $1 AND title = $2`, [f.office.id, `No round: ${o.orderNumber}`])).length;

    await runAlerts(f.db);
    assert.equal(await notes(), 0, 'not inside the grace');
    await f.db.query(`UPDATE customer_orders SET off_round_at = now() - interval '5 minutes' WHERE id = $1`, [o.id]);
    await runAlerts(f.db);
    assert.equal(await notes(), 1);
    await runAlerts(f.db);
    assert.equal(await notes(), 1, 'once');
  });
});
