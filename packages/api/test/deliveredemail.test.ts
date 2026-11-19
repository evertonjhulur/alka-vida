/**
 * The "your order was delivered" email goes when the round is settled, not
 * when the driver records the stop (Everton, 19 Nov 2026). Broadbent Constant
 * Spring's went at 11:23 on 19 Nov saying "To pay $200" though the driver had
 * taken the full $600: his cash only reaches the invoice at settlement.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPgliteDb, type Db } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { seed } from '../src/db/seed.ts';
import { buildServer } from '../src/server.ts';
import { setMailSinkForTests, type MailMessage } from '../src/services/documents.ts';
import { businessToday } from '../src/services/core.ts';

let db: Db;
let app: Awaited<ReturnType<typeof buildServer>>;
const sent: MailMessage[] = [];
let token = '';

before(async () => {
  db = await createPgliteDb();
  await migrate(db, { quiet: true });
  await seed(db, { quiet: true });
  app = await buildServer(db);
  await app.ready();
  const res = await app.inject({ method: 'POST', url: '/api/auth/login',
    payload: { email: 'admin@alkavida.jm', password: 'admin1234' } });
  token = res.cookies.find((c) => c.name === 'av_session')!.value;
  setMailSinkForTests((m) => { sent.push(m); });
});
after(async () => { setMailSinkForTests(null); await app.close(); await db.close(); });

const settle = () => new Promise((r) => setTimeout(r, 400));

describe('Delivered emails go at settlement', () => {
  test('recording the stop sends nothing; settling sends one, with the cash on the invoice', async () => {
    const cust = await db.one<{ id: string }>(
      `SELECT id FROM customers WHERE delivery_zone IS NOT NULL AND NOT is_walk_in ORDER BY name LIMIT 1`);
    await db.query(`UPDATE customers SET email = 'buyer@corp.jm', order_emails = true WHERE id = $1`, [cust.id]);
    const jug = await db.one<{ id: string }>(`SELECT id FROM products WHERE bottles_per_case = 0 AND active ORDER BY name LIMIT 1`);
    await db.query(`INSERT INTO finished_goods_stock (product_id, quantity_on_hand) VALUES ($1, 500)
                    ON CONFLICT (product_id) DO UPDATE SET quantity_on_hand = 500`, [jug.id]);
    const h = { authorization: `Bearer ${token}` };

    const o = await app.inject({ method: 'POST', url: '/api/orders', headers: h, payload: {
      customerId: cust.id, deliveryMode: 'Delivery', requestedDeliveryDate: businessToday(),
      lines: [{ productId: jug.id, looseBottles: 1 }], emptiesExpected: 1,
    } });
    assert.equal(o.statusCode, 200, o.body);
    const orderId = o.json().id as string;
    const stop = await db.one<{ id: string; sheet: string }>(
      `SELECT id, delivery_sheet_id AS sheet FROM delivery_stops WHERE order_id = $1`, [orderId]);
    const inv = await db.one<{ g: number }>(`SELECT grand_total_cents AS g FROM customer_orders WHERE id = $1`, [orderId]);
    const total = Number(inv.g);

    const before = sent.length;
    const m = await app.inject({ method: 'POST', url: `/api/stops/${stop.id}/outcome`, headers: h, payload: {
      outcome: 'Delivered', paymentReceived: true, paymentMethod: 'Cash', paymentAmountCents: total,
      bottlesDeliveredFull: 1, bottlesEmptiesPickedUp: 1,
    } });
    assert.equal(m.statusCode, 200, m.body);
    await settle();
    assert.equal(sent.filter((x) => /delivered/i.test(x.subject)).length,
      sent.slice(0, before).filter((x) => /delivered/i.test(x.subject)).length, 'nothing when the stop is recorded');

    const s = await app.inject({ method: 'POST', url: `/api/delivery-sheets/${stop.sheet}/settle`, headers: h,
      payload: { actualCashCents: total } });
    assert.equal(s.statusCode, 200, s.body);
    await settle();
    const mails = sent.slice(before).filter((x) => /delivered/i.test(x.subject));
    assert.equal(mails.length, 1, 'one delivered email, at settlement');
    assert.equal(mails[0].to, 'buyer@corp.jm');
    assert.match(mails[0].html ?? '', /Paid, thank you/, 'the driver\'s cash is on the invoice');

    // Settling does not send it twice.
    const { sendRoundDeliveredEmails } = await import('../src/services/messaging.ts');
    const again = await sendRoundDeliveredEmails(db, stop.sheet);
    assert.equal(again.sent, 0);
  });
});
