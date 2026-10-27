/**
 * Emailing an order's confirmation by hand (Everton, 27 Oct 2026).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { createOrder, listOrders } from '../src/services/orders.ts';
import { emailOrderConfirmation, sendOrderPlacedEmail } from '../src/services/messaging.ts';
import { setMailSinkForTests, type MailMessage } from '../src/services/documents.ts';
import { businessToday } from '../src/services/core.ts';
import { addDays } from '@alka/shared';

let f: Fixture;
const sent: MailMessage[] = [];
before(async () => { f = await setupFixture(); setMailSinkForTests((m) => { sent.push(m); }); });
after(async () => { setMailSinkForTests(null); await f.close(); });

describe('Email the order confirmation by hand', () => {
  test('sends again, to the address on file or one typed in, even with the automatic ones off', async () => {
    await f.db.query(`INSERT INTO system_settings (key, value) VALUES ('order_placed_emails','false')
                      ON CONFLICT (key) DO UPDATE SET value = 'false'`);
    await f.db.query(`UPDATE customers SET email = 'ap@corp.jm' WHERE id = $1`, [f.customerId]);
    const o = await createOrder(f.db, f.office, { customerId: f.customerId, deliveryMode: 'Delivery',
      requestedDeliveryDate: addDays(businessToday(), 3), lines: [{ productId: f.fiveGalProductId, looseBottles: 2 }] });
    assert.equal((await sendOrderPlacedEmail(f.db, o.id)).sent, false, 'the automatic one is switched off');

    const n = sent.length;
    const a = await emailOrderConfirmation(f.db, f.office, o.id, {});
    assert.equal(a.sentTo, 'ap@corp.jm');
    const b = await emailOrderConfirmation(f.db, f.office, o.id, { to: 'buyer@corp.jm' });
    assert.equal(b.sentTo, 'buyer@corp.jm');
    assert.equal(sent.length, n + 2, 'sent each time it is asked for');
    assert.match(sent.at(-1)!.subject, /received/);
    assert.equal(sent.at(-1)!.to, 'buyer@corp.jm');

    const row = (await listOrders(f.db, {})).find((x) => (x as { id: string }).id === o.id) as unknown as {
      customer_email: string; confirmation_email: { ok: boolean; to: string } };
    assert.equal(row.customer_email, 'ap@corp.jm');
    assert.equal(row.confirmation_email.ok, true);
    assert.equal(row.confirmation_email.to, 'buyer@corp.jm');

    await assert.rejects(emailOrderConfirmation(f.db, f.office, o.id, { to: 'not an address' }), /not an email address/);
    await assert.rejects(emailOrderConfirmation(f.db, f.driver, o.id, {}), /requires role/);
    await f.db.query(`UPDATE customers SET email = '' WHERE id = $1`, [f.customerId]);
    await assert.rejects(emailOrderConfirmation(f.db, f.office, o.id, {}), /no email address on file/);
  });
});
