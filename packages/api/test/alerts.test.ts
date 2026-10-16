/**
 * Everton's follow-up of 15 Oct 2026: how staff hear about orders.
 *
 *   - Orders come in Pending; Ready once the round's load is logged or the
 *     order is marked ready; new online orders count until seen.
 *   - A portal delivery on a day that is not the customer's waits under Needs
 *     a decision; the admin approves it, moves it, or cancels it.
 *   - Push notifications (VAPID-signed, empty knock + inbox) and the alert
 *     run that tells the office and admins, by push and by email.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { setupFixture, type Fixture } from './helpers.ts';
import { createOrder, createPortalOrder, deliveryDaysFor, markOrdersSeen, setOrderReady } from '../src/services/orders.ts';
import { reviewApproval } from '../src/services/approvals.ts';
import { notifyUsers, setPushSink, subscribe, takeInbox, vapidKeys } from '../src/services/push.ts';
import { runAlerts } from '../src/services/alerts.ts';
import { setMailSinkForTests } from '../src/services/documents.ts';

let f: Fixture;
before(async () => { f = await setupFixture(); });
after(async () => { setPushSink(null); setMailSinkForTests(null); await f.close(); });

let n = 0;
const customer = async (days: string[] | null = null) => (await f.db.one<{ id: string }>(
  `INSERT INTO customers (name, phone, email, price_tier_id, delivery_address, delivery_zone, payment_terms, delivery_days)
   VALUES ($1, '876-555-0100', 'buyer@example.com', $2, '1 Test Rd, Kingston', 'Kingston', 'Net 30', COALESCE($3::text[], '{}')) RETURNING id`,
  [`Alerts ${++n}`, f.tierId, days],
)).id;
const portalActor = (customerId: string) => ({ id: f.admin.id, name: 'Customer', role: 'customer' as const, customerId });
/** The next date after today falling on `wd` ('Mon'..'Sun'), and one that does not. */
async function nextOn(wd: string, not = false): Promise<string> {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const today = (await f.db.one<{ d: string }>(`SELECT business_today()::text d`)).d;
  for (let i = 2; i < 12; i++) {
    const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    if ((names[d.getUTCDay()] === wd) !== not) return iso;
  }
  throw new Error('no date');
}

describe('Pending, Ready and new online orders', () => {
  test('an online order is new until seen; marking it ready records who', async () => {
    const c = await customer();
    const o = await createPortalOrder(f.db, portalActor(c), c, {
      lines: [{ productId: f.casedProductId, cases: 2 }], deliveryMode: 'Delivery',
    });
    const row = await f.db.one<{ seen_at: string | null; ready_at: string | null }>(
      `SELECT seen_at, ready_at FROM customer_orders WHERE id = $1`, [o.id]);
    assert.equal(row.seen_at, null, 'new to the office');
    assert.equal(row.ready_at, null, 'Pending until the load is logged or it is marked ready');
    const office = await createOrder(f.db, f.office, { customerId: c, deliveryMode: 'Pickup', lines: [{ productId: f.casedProductId, cases: 1 }] });
    const offRow = await f.db.one<{ seen_at: string | null }>(`SELECT seen_at FROM customer_orders WHERE id = $1`, [office.id]);
    assert.ok(offRow.seen_at, 'an office order is not "new online"');

    assert.deepEqual(await markOrdersSeen(f.db, f.office, [o.id, o.id]), { marked: 1 });
    await setOrderReady(f.db, f.office, office.id, true);
    const r = await f.db.one<{ ready_at: string | null; ready_by_name: string }>(
      `SELECT ready_at, ready_by_name FROM customer_orders WHERE id = $1`, [office.id]);
    assert.ok(r.ready_at); assert.equal(r.ready_by_name, 'Office');
    await setOrderReady(f.db, f.office, office.id, false);
    assert.equal((await f.db.one<{ ready_at: string | null }>(`SELECT ready_at FROM customer_orders WHERE id = $1`, [office.id])).ready_at, null);
  });
});

describe('Portal delivery days', () => {
  test('their own day goes straight on; another day waits as a request', async () => {
    const c = await customer(['Tue']);
    assert.deepEqual(await deliveryDaysFor(f.db, c, null), ['Tue']);
    const tue = await nextOn('Tue');
    const ok = await createPortalOrder(f.db, portalActor(c), c, {
      lines: [{ productId: f.casedProductId, cases: 1 }], deliveryMode: 'Delivery', requestedDeliveryDate: tue,
    });
    assert.ok(!ok.needsReview && ok.deliverySheetId, 'their day: on the round');

    const other = await nextOn('Tue', true);
    const asked = await createPortalOrder(f.db, portalActor(c), c, {
      lines: [{ productId: f.casedProductId, cases: 1 }], deliveryMode: 'Delivery', requestedDeliveryDate: other,
    });
    assert.equal(asked.needsReview, true);
    assert.equal(asked.deliverySheetId, null, 'not on a round until decided');
    const req = await f.db.one<{ id: string; request_type: string }>(
      `SELECT id, request_type FROM approval_requests WHERE entity_id = $1`, [asked.id]);
    assert.equal(req.request_type, 'SpecialDayOrder');

    // The admin moves it to a day of their choosing.
    const r = await reviewApproval(f.db, f.admin, req.id, 'Approved', undefined, { deliveryDate: tue });
    assert.equal(r.status, 'Approved');
    const o = await f.db.one<{ requested_delivery_date: string; needs_review: boolean; on_round: boolean }>(
      `SELECT requested_delivery_date::text, needs_review,
              EXISTS (SELECT 1 FROM delivery_stops WHERE order_id = $1) AS on_round
       FROM customer_orders WHERE id = $1`, [asked.id]);
    assert.equal(o.requested_delivery_date, tue);
    assert.equal(o.needs_review, false);
    assert.equal(o.on_round, true);
  });

  test('or the admin cancels it', async () => {
    const c = await customer(['Thu']);
    const asked = await createPortalOrder(f.db, portalActor(c), c, {
      lines: [{ productId: f.casedProductId, cases: 1 }], deliveryMode: 'Delivery', requestedDeliveryDate: await nextOn('Thu', true),
    });
    const req = await f.db.one<{ id: string }>(`SELECT id FROM approval_requests WHERE entity_id = $1`, [asked.id]);
    const r = await reviewApproval(f.db, f.admin, req.id, 'Approved', 'we do not go there that day', { cancel: true });
    assert.equal(r.orderCancelled, true);
    assert.equal(r.status, 'Rejected');
    assert.equal((await f.db.one<{ status: string }>(`SELECT status FROM customer_orders WHERE id = $1`, [asked.id])).status, 'Cancelled');
  });

  test('a collection may be any day; a customer with no days set may choose any day', async () => {
    const c = await customer(['Mon']);
    const pick = await createPortalOrder(f.db, portalActor(c), c, {
      lines: [{ productId: f.casedProductId, cases: 1 }], deliveryMode: 'Pickup', requestedDeliveryDate: await nextOn('Mon', true),
    });
    assert.ok(!pick.needsReview);
    await f.db.query(`UPDATE delivery_zones SET run_days = '{}' WHERE name = 'Kingston'`);
    const free = await customer(null);
    const any = await createPortalOrder(f.db, portalActor(free), free, {
      lines: [{ productId: f.casedProductId, cases: 1 }], deliveryMode: 'Delivery', requestedDeliveryDate: await nextOn('Sun'),
    });
    assert.ok(!any.needsReview);
  });
});

describe('Push notifications', () => {
  test('one key pair per install; a knock is VAPID-signed and carries nothing', async () => {
    const a = await vapidKeys(f.db);
    const b = await vapidKeys(f.db);
    assert.equal(a.publicKey, b.publicKey, 'made once, then kept');

    await subscribe(f.db, f.office, { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'p', auth: 'q' }, device: 'test' });
    const knocks: Array<{ endpoint: string; headers: Record<string, string> }> = [];
    setPushSink(async (endpoint, headers) => { knocks.push({ endpoint, headers }); return 201; });
    const r = await notifyUsers(f.db, [f.office.id], { title: 'Hello', body: 'there', url: '/#/orders' });
    assert.deepEqual(r, { notes: 1, knocked: 1 });
    const auth = knocks[0].headers.Authorization;
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(auth)!;
    assert.ok(m, auth);
    assert.equal(m[4], a.publicKey);
    const claims = JSON.parse(Buffer.from(m[2], 'base64url').toString());
    assert.equal(claims.aud, 'https://push.example.com');
    // The signature checks out against the public key the browser was given.
    const raw = Buffer.from(a.publicKey, 'base64url');
    const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
    assert.ok(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')));
    assert.equal(knocks[0].headers['Content-Length'], '0');

    const inbox = await takeInbox(f.db, f.office);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].title, 'Hello');
    const again = await takeInbox(f.db, f.office);
    assert.equal(again[0]?.id, inbox[0].id, 'a second knock shows the latest again, under the same tag');

    // A device that has gone away is forgotten.
    setPushSink(async () => 410);
    await notifyUsers(f.db, [f.office.id], { title: 'Gone' });
    assert.equal((await f.db.query(`SELECT 1 FROM push_subscriptions WHERE user_id = $1`, [f.office.id])).length, 0);
  });

  test('the alert run tells the office of online orders and admins of decisions, by push and email', async () => {
    await f.db.query(`UPDATE system_settings SET value = (now() - interval '1 hour')::text WHERE key = 'alerts_since'`);
    await f.db.query(`UPDATE users SET email = 'boss@example.com' WHERE id = $1`, [f.admin.id]);
    const knocks: string[] = [];
    setPushSink(async (endpoint) => { knocks.push(endpoint); return 201; });
    const mails: Array<{ to: string; subject: string }> = [];
    setMailSinkForTests(async (m) => { mails.push({ to: m.to, subject: m.subject }); });
    await subscribe(f.db, f.office, { endpoint: 'https://push.example.com/office' });
    await subscribe(f.db, f.admin, { endpoint: 'https://push.example.com/admin' });
    await f.db.query(`DELETE FROM staff_notifications`);
    const waiting = await customer(['Wed']);
    await createPortalOrder(f.db, portalActor(waiting), waiting, {
      lines: [{ productId: f.casedProductId, cases: 1 }], deliveryMode: 'Delivery', requestedDeliveryDate: await nextOn('Wed', true),
    });

    const first = await runAlerts(f.db);
    assert.ok(first.orders >= 1, 'online orders from this file are announced');
    assert.ok(first.decisions >= 1, 'pending decisions are announced');
    assert.ok(mails.some((m) => m.to === 'boss@example.com' && /needs a decision/i.test(m.subject)));
    const officeNotes = await f.db.query<{ title: string }>(`SELECT title FROM staff_notifications WHERE user_id = $1`, [f.office.id]);
    assert.ok(officeNotes.some((x) => /^New online order/.test(x.title)));
    assert.ok(!officeNotes.some((x) => /Needs a decision/.test(x.title)), 'decisions go to admins');
    assert.ok(knocks.includes('https://push.example.com/admin') && knocks.includes('https://push.example.com/office'));

    const second = await runAlerts(f.db);
    assert.deepEqual(second, { orders: 0, decisions: 0, emails: 0 }, 'nothing is announced twice');

    // An admin who turned decision emails off gets the push only.
    await f.db.query(`UPDATE users SET decision_emails = false WHERE id = $1`, [f.admin.id]);
    mails.length = 0;
    const c = await customer(['Tue']);
    await createPortalOrder(f.db, portalActor(c), c, {
      lines: [{ productId: f.casedProductId, cases: 1 }], deliveryMode: 'Delivery', requestedDeliveryDate: await nextOn('Tue', true),
    });
    const third = await runAlerts(f.db);
    assert.equal(third.decisions, 1);
    assert.equal(third.orders, 0, 'an order waiting for a decision is announced once, as the decision');
    assert.equal(mails.length, 0);
  });
});
