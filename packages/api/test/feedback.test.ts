/**
 * The Florida team's testing round, 1 Oct 2026.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { cancelOwnOrder, createOrder, createPortalOrder, editOrder, sameDayCheck } from '../src/services/orders.ts';
import { markStop } from '../src/services/delivery.ts';
import { startRoute } from '../src/services/routing.ts';
import { counterSale, collectOrder } from '../src/services/counter.ts';
import { createCreditNote, getInvoiceLedger } from '../src/services/invoices.ts';
import { listPendingApprovals, reviewApproval } from '../src/services/approvals.ts';
import { receivePayment, requestPaymentChange, getCustomerBalance } from '../src/services/payments.ts';
import { recordCount, stockSnapshot } from '../src/services/audits.ts';
import { salesReport, salesTransactions } from '../src/services/reports.ts';
import { bottleAccount, customerHoldings } from '../src/services/bottles.ts';
import { completeProduction } from '../src/services/inventory.ts';
import {
  createBroadcast, getBroadcast, resolveList, saveCustomerList, sendOrderPlacedEmail,
  sendDeliveredEmail, whatsappDigits, saveNews, listNews,
} from '../src/services/messaging.ts';
import { requestPasswordReset, acceptInvitation, inviteeFor } from '../src/services/invitations.ts';
import { startSchedule, expectedOn } from '../src/services/recurring.ts';
import { getMyProfile, saveMyAddress, updateMyProfile } from '../src/services/portal.ts';
import { accountPosition } from '../src/services/customers.ts';
import { setMailSinkForTests, type MailMessage } from '../src/services/documents.ts';
import { businessToday } from '../src/services/core.ts';
import { addDays } from '@alka/shared';

let f: Fixture;
const sent: MailMessage[] = [];
const today = businessToday();
const setSetting = (key: string, value: string) => f.db.query(
  `INSERT INTO system_settings (key, value) VALUES ($1,$2)
   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);

before(async () => {
  f = await setupFixture();
  setMailSinkForTests((m) => { sent.push(m); });
});
after(async () => { setMailSinkForTests(null); await f.close(); });

const stopOf = (orderId: string) => f.db.maybeOne<{ id: string; delivery_sheet_id: string; day: string }>(
  `SELECT st.id, st.delivery_sheet_id, ds.delivery_date::text AS day
   FROM delivery_stops st JOIN delivery_sheets ds ON ds.id = st.delivery_sheet_id
   WHERE st.order_id = $1 AND st.stop_outcome = 'Pending'`, [orderId]);
const order = (days = 1, extra: Record<string, unknown> = {}) => createOrder(f.db, f.office, {
  customerId: f.customerId, deliveryMode: 'Delivery',
  requestedDeliveryDate: addDays(today, days),
  lines: [{ productId: f.casedProductId, cases: 2 }], ...extra,
});

describe('Invoices get a due date from the terms (point 5)', () => {
  test('Net 30 is 30 days, cash on delivery is the same day', async () => {
    const sale = await counterSale(f.db, f.office, {
      customerId: f.customerId, lines: [{ productId: f.casedProductId, cases: 1 }],
    });
    const inv = await f.db.one<{ due: string; d: string }>(
      `SELECT due_date::text AS due, invoice_date::text AS d FROM invoices WHERE id = $1`, [sale.invoiceId]);
    assert.equal(inv.due, addDays(inv.d, 30));
    const other = await counterSale(f.db, f.office, {
      customerId: f.otherCustomerId, lines: [{ productId: f.casedProductId, cases: 1 }],
    });
    const o = await f.db.one<{ due: string; d: string }>(
      `SELECT due_date::text AS due, invoice_date::text AS d FROM invoices WHERE id = $1`, [other.invoiceId]);
    assert.equal(o.due, o.d);
  });

  test('overdue is what is owed past its due date', async () => {
    const sale = await counterSale(f.db, f.office, {
      customerId: f.otherCustomerId, lines: [{ productId: f.casedProductId, cases: 1 }],
    });
    await f.db.query(`UPDATE invoices SET due_date = $2::date WHERE id = $1`, [sale.invoiceId, addDays(today, -3)]);
    const p = await accountPosition(f.db, f.otherCustomerId);
    assert.ok(p.overdueCents >= sale.grandTotalCents);
    assert.ok(p.overdueInvoices >= 1);
  });
});

describe('Orders and rounds (points 7, 9, 10, 15, 16)', () => {
  test('changing the delivery date moves the order to that day\'s round', async () => {
    const o = await order(1);
    const before_ = await stopOf(o.id);
    assert.equal(before_!.day, addDays(today, 1));
    await editOrder(f.db, f.office, o.id, { requestedDeliveryDate: addDays(today, 3) });
    const after_ = await stopOf(o.id);
    assert.equal(after_!.day, addDays(today, 3));
    const left = await f.db.one<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM delivery_stops WHERE order_id = $1`, [o.id]);
    assert.equal(left.n, 1, 'the stop moved rather than being copied');
  });

  test('a customer cannot cancel once the driver has started the round', async () => {
    const o = await order(0);
    const stop = await stopOf(o.id);
    await startRoute(f.db, f.driver, stop!.delivery_sheet_id);
    await assert.rejects(cancelOwnOrder(f.db, f.admin, f.customerId, o.id), /out for delivery/);
    const o2 = await order(5);
    await cancelOwnOrder(f.db, f.admin, f.customerId, o2.id);
  });

  test('a same-day order after the cut-off waits for approval, then goes on the round', async () => {
    await setSetting('same_day_cutoff', '00:00');
    const check = await sameDayCheck(f.db, f.office, f.customerId, 'Delivery', today);
    assert.equal(check.needsReview, true);
    const o = await order(0, { needsReview: true });
    assert.equal(o.needsReview, true);
    assert.equal(await stopOf(o.id), null, 'not on a round yet');
    const req = (await listPendingApprovals(f.db)).find((a) => a.entityId === o.id);
    assert.equal(req?.requestType, 'SameDayOrder');
    await reviewApproval(f.db, f.admin, req!.id, 'Approved');
    assert.equal((await stopOf(o.id))!.day, today);

    const late = await order(0, { needsReview: true });
    const r2 = (await listPendingApprovals(f.db)).find((a) => a.entityId === late.id)!;
    await reviewApproval(f.db, f.admin, r2.id, 'Rejected');
    const moved = await stopOf(late.id);
    assert.ok(moved && moved.day > today, 'not refused: it goes on the next delivery day');
    await setSetting('same_day_cutoff', '23:59');
  });

  test('a portal order with no date goes on the next delivery day', async () => {
    await setSetting('same_day_cutoff', '00:00');
    const o = await createPortalOrder(f.db, { ...f.admin, role: 'customer' }, f.customerId, {
      lines: [{ productId: f.casedProductId, cases: 1 }], customerPo: 'PO-778',
    });
    assert.ok(o.deliveryDate && o.deliveryDate > today);
    const row = await f.db.one<{ customer_po: string }>(`SELECT customer_po FROM customer_orders WHERE id = $1`, [o.id]);
    assert.equal(row.customer_po, 'PO-778');
    await setSetting('same_day_cutoff', '23:59');
  });

  test('"Another day" moves the order to the day chosen, with the reason', async () => {
    const o = await order(0);
    const stop = await stopOf(o.id);
    const r = await markStop(f.db, f.driver, {
      stopId: stop!.id, outcome: 'Rescheduled', rescheduleTo: addDays(today, 2), rescheduleReason: 'gate locked',
    });
    assert.equal(r.rescheduledTo, addDays(today, 2));
    assert.equal((await stopOf(o.id))!.day, addDays(today, 2));
    const old = await f.db.one<{ reschedule_reason: string; stop_outcome: string }>(
      `SELECT reschedule_reason, stop_outcome FROM delivery_stops WHERE id = $1`, [stop!.id]);
    assert.equal(old.reschedule_reason, 'gate locked');
    assert.equal(old.stop_outcome, 'Rescheduled');
  });

  test('standing orders further ahead than a week show as expected on their day', async () => {
    const first = await order(1);
    await startSchedule(f.db, f.office, first.id, { pattern: 'Weekly', firstNextDate: addDays(today, 15) });
    const expected = await expectedOn(f.db, addDays(today, 22));
    assert.ok(expected.some((e) => e.scheduleId === first.id));
    assert.equal((await expectedOn(f.db, addDays(today, 23))).some((e) => e.scheduleId === first.id), false);
  });
});

describe('Stock and bottles (points 12, 18, 19, 20)', () => {
  test('a delivery takes the goods off finished-goods stock', async () => {
    await f.db.query(
      `INSERT INTO finished_goods_stock (product_id, quantity_on_hand) VALUES ($1, 1000)
       ON CONFLICT (product_id) DO UPDATE SET quantity_on_hand = 1000`, [f.casedProductId]);
    const o = await order(0);
    await markStop(f.db, f.driver, { stopId: (await stopOf(o.id))!.id, outcome: 'Delivered' });
    const left = await f.db.one<{ q: number }>(
      `SELECT quantity_on_hand AS q FROM finished_goods_stock WHERE product_id = $1`, [f.casedProductId]);
    assert.equal(Number(left.q), 1000 - 48);
  });

  test('5-gallon bottles sold at the counter count against the customer and the pool', async () => {
    const before_ = await bottleAccount(f.db, f.otherCustomerId);
    const pool0 = await f.db.one<{ clean: number }>(`SELECT clean_ready AS clean FROM five_gal_bottle_pool LIMIT 1`);
    await counterSale(f.db, f.office, {
      customerId: f.otherCustomerId, lines: [{ productId: f.fiveGalProductId, looseBottles: 3 }],
      emptiesReturned: 1,
    });
    const after_ = await bottleAccount(f.db, f.otherCustomerId);
    // Rewritten for Everton's ruling of 7 Oct 2026 (point 13): 3 full out and
    // 1 empty back means 2 bottles short, which they BUY. Those are theirs,
    // so what they hold of ours does not move. (Before the ruling they held
    // 2 more of ours on loan.)
    assert.equal(after_.closingHolding - before_.closingHolding, 0);
    assert.equal(after_.sold - before_.sold, 2);
    const pool1 = await f.db.one<{ clean: number }>(`SELECT clean_ready AS clean FROM five_gal_bottle_pool LIMIT 1`);
    assert.equal(Number(pool0.clean) - Number(pool1.clean), 3);
    const holdings = await customerHoldings(f.db) as Array<{ customer_id: string; sold: number }>;
    assert.ok(holdings.some((h) => h.customer_id === f.otherCustomerId && h.sold >= 2));
  });

  test('a pickup collected takes stock off too', async () => {
    const o = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Pickup', lines: [{ productId: f.casedProductId, cases: 1 }],
    });
    const before_ = await f.db.one<{ q: number }>(
      `SELECT quantity_on_hand AS q FROM finished_goods_stock WHERE product_id = $1`, [f.casedProductId]);
    await collectOrder(f.db, f.office, { orderId: o.id });
    const after_ = await f.db.one<{ q: number }>(
      `SELECT quantity_on_hand AS q FROM finished_goods_stock WHERE product_id = $1`, [f.casedProductId]);
    assert.equal(Number(before_.q) - Number(after_.q), 24);
  });

  test('finished goods are counted in cases and loose bottles, and a difference needs a reason', async () => {
    const snap = await stockSnapshot(f.db);
    const g = snap.finishedGoods.find((x) => x.productId === f.casedProductId)!;
    assert.equal(g.cases! * 24 + g.loose, g.bottles);
    await assert.rejects(recordCount(f.db, f.office, {
      itemType: 'FinishedGoods', itemId: f.casedProductId, countedCases: g.cases! - 1, countedLoose: g.loose,
    }), /Say why/);
    const r = await recordCount(f.db, f.office, {
      itemType: 'FinishedGoods', itemId: f.casedProductId, countedCases: g.cases! - 1, countedLoose: g.loose,
      notes: 'one case damaged in the van',
    });
    assert.equal(r.discrepancy, -24);
    const row = await f.db.one<{ counted_cases: number; counted_by: string }>(
      `SELECT counted_cases, counted_by FROM inventory_audits WHERE id = $1`, [r.id]);
    assert.equal(Number(row.counted_cases), g.cases! - 1);
    assert.equal(row.counted_by, 'Office');
  });

  test('a production run can be dated', async () => {
    const r = await completeProduction(f.db, f.office, {
      productId: f.fiveGalProductId, looseBottles: 10, productionDate: addDays(today, -2),
    });
    const b = await f.db.one<{ d: string }>(`SELECT batch_date::text AS d FROM production_batches WHERE id = $1`, [r.batchId]);
    assert.equal(b.d, addDays(today, -2));
    await assert.rejects(completeProduction(f.db, f.office, {
      productId: f.fiveGalProductId, looseBottles: 1, productionDate: addDays(today, 3),
    }), /still to come/);
  });
});

describe('Payments (points 11 and 14)', () => {
  test('a payment dated with a day keeps that day', async () => {
    const r = await receivePayment(f.db, f.office, {
      customerId: f.customerId, amountCents: 1_000, method: 'Cash', paymentDate: '2026-09-15',
    });
    const p = await f.db.one<{ d: string }>(
      `SELECT business_date(payment_date)::text AS d FROM payments WHERE id = $1`, [r.paymentIds[0]]);
    assert.equal(p.d, '2026-09-15');
  });

  test('a change from the office waits for approval; an approved new amount reverses and re-posts', async () => {
    const r = await receivePayment(f.db, f.office, {
      customerId: f.customerId, amountCents: 50_000, method: 'Cash', reference: 'slip 1',
    });
    const before_ = await getCustomerBalance(f.db, f.customerId);
    const req = await requestPaymentChange(f.db, f.office, r.paymentIds[0], { amountCents: 45_000 }, 'typed wrong');
    assert.equal(req.applied, false);
    assert.equal((await getCustomerBalance(f.db, f.customerId)).balanceCents, before_.balanceCents, 'nothing moves yet');
    await assert.rejects(requestPaymentChange(f.db, f.office, r.paymentIds[0], { method: 'Card' }, 'again'), /already waiting/);
    await reviewApproval(f.db, f.admin, req.approvalRequestId, 'Approved');
    assert.equal((await getCustomerBalance(f.db, f.customerId)).balanceCents, before_.balanceCents + 5_000);
  });

  test('an administrator can move a payment to another customer at once', async () => {
    const r = await receivePayment(f.db, f.office, {
      customerId: f.customerId, amountCents: 7_000, method: 'Bank Transfer',
    });
    const res = await requestPaymentChange(f.db, f.admin, r.paymentIds[0], { customerId: f.otherCustomerId }, 'wrong account');
    assert.equal(res.applied, true);
    const p = await f.db.one<{ customer_id: string }>(`SELECT customer_id FROM payments WHERE id = $1`, [r.paymentIds[0]]);
    assert.equal(p.customer_id, f.otherCustomerId);
    await assert.rejects(requestPaymentChange(f.db, f.office, r.paymentIds[0], { method: 'Cash' }, ''), /say why/);
  });
});

describe('Reports (point 21)', () => {
  test('credit notes come off sales, and the transaction list adds up', async () => {
    const sale = await counterSale(f.db, f.office, {
      customerId: f.customerId, lines: [{ productId: f.casedProductId, cases: 1 }],
    });
    await createCreditNote(f.db, f.admin, { invoiceId: sale.invoiceId, amountCents: 11_500, reason: 'short' });
    const rep = await salesReport(f.db, today, today);
    assert.ok(rep.totals.creditNoteNetCents > 0);
    assert.equal(rep.totals.netAfterCreditsCents, rep.totals.netCents - rep.totals.creditNoteNetCents);
    const rows = await salesTransactions(f.db, today, today);
    const net = rows.reduce((s, r) => s + r.netCents, 0);
    assert.equal(net, rep.totals.netAfterCreditsCents);
    assert.ok(rows.some((r) => r.type === 'Credit note' && r.totalCents < 0));
    assert.ok(rows.some((r) => r.orders), 'each invoice names its order');
  });
});

describe('Talking to customers (points 8 and 23)', () => {
  test('order placed and delivered emails go to the customer', async () => {
    const o = await order(0);
    const n = sent.length;
    await sendOrderPlacedEmail(f.db, o.id);
    assert.equal(sent.length, n + 1);
    assert.match(sent.at(-1)!.subject, /received/);
    assert.match(sent.at(-1)!.text, /GCT/);
    await sendOrderPlacedEmail(f.db, o.id);
    assert.equal(sent.length, n + 1, 'never twice');
    const stop = await stopOf(o.id);
    await markStop(f.db, f.driver, { stopId: stop!.id, outcome: 'Delivered' });
    await sendDeliveredEmail(f.db, stop!.id);
    assert.match(sent.at(-1)!.subject, /delivered/);
    assert.equal(sent.at(-1)!.attachments?.length, 1, 'the invoice is attached');
  });

  test('a customer who opted out of order emails gets none', async () => {
    await f.db.query(`UPDATE customers SET order_emails = false WHERE id = $1`, [f.otherCustomerId]);
    const o = await createOrder(f.db, f.office, {
      customerId: f.otherCustomerId, deliveryMode: 'Delivery', requestedDeliveryDate: addDays(today, 1),
      lines: [{ productId: f.casedProductId, cases: 1 }],
    });
    const r = await sendOrderPlacedEmail(f.db, o.id);
    assert.equal(r.sent, false);
    await f.db.query(`UPDATE customers SET order_emails = true WHERE id = $1`, [f.otherCustomerId]);
  });

  test('lists pick customers by zone, and messages skip those who opted out of offers', async () => {
    const kingston = await resolveList(f.db, { zones: ['Kingston'] });
    assert.ok(kingston.every((m) => m.delivery_zone === 'Kingston'));
    assert.ok(kingston.some((m) => m.id === f.customerId));
    const saved = await saveCustomerList(f.db, f.office, null, { name: 'Everybody', criteria: {} });
    await f.db.query(`UPDATE customers SET marketing_opt_out = true WHERE id = $1`, [f.otherCustomerId]);
    const n = sent.length;
    const b = await createBroadcast(f.db, f.office, {
      subject: 'Easter special', body: '10% off 5-gallon this week', listId: saved.id, purpose: 'Marketing',
      postAsNews: { kind: 'Promotion' },
    });
    const detail = await getBroadcast(f.db, b.id);
    const other = detail!.recipients.find((r) => r.customer_id === f.otherCustomerId)!;
    assert.equal(other.status, 'Skipped');
    const mine = detail!.recipients.find((r) => r.customer_id === f.customerId)!;
    assert.equal(mine.status, 'Sent');
    assert.match(mine.whatsappLink ?? '', /^https:\/\/wa\.me\/18765551234\?text=/);
    assert.ok(sent.length > n);
    assert.ok((await listNews(f.db, { live: true }) as Array<{ title: string }>).some((p) => p.title === 'Easter special'));
  });

  test('a service message reaches people who opted out of offers', async () => {
    const b = await createBroadcast(f.db, f.office, {
      subject: 'Closed Monday', body: 'Public holiday', customerIds: [f.otherCustomerId], purpose: 'Service',
    });
    const d = await getBroadcast(f.db, b.id);
    assert.equal(d!.recipients[0].status, 'Sent');
  });

  test('WhatsApp numbers get the Jamaican country code', () => {
    assert.equal(whatsappDigits('876-555-1234'), '18765551234');
    assert.equal(whatsappDigits('555-1234'), '18765551234');
    assert.equal(whatsappDigits('+1 (876) 555 1234'), '18765551234');
    assert.equal(whatsappDigits(''), null);
  });

  test('news only shows while it is live', async () => {
    await saveNews(f.db, f.office, null, { title: 'Old news', startsOn: addDays(today, -10), endsOn: addDays(today, -1) });
    const live = await listNews(f.db, { live: true }) as Array<{ title: string }>;
    assert.equal(live.some((p) => p.title === 'Old news'), false);
  });
});

describe('Portal profile and password reset (points 4 and 8)', () => {
  test('the customer updates their own details and adds an address in their zone', async () => {
    const actor = { ...f.admin, role: 'customer' as const };
    await updateMyProfile(f.db, actor, f.customerId, { deliveryInstructions: 'Gate code 1234', phone: '876-555-0000' });
    const a = await saveMyAddress(f.db, actor, f.customerId, null, { label: 'Warehouse', addressLine1: '4 Spanish Town Rd' });
    const p = await getMyProfile(f.db, f.customerId) as Record<string, unknown> & { addresses: Array<{ id: string }> };
    assert.equal(p.delivery_instructions, 'Gate code 1234');
    assert.ok(p.addresses.some((x) => x.id === a.id));
    const zone = await f.db.one<{ delivery_zone: string }>(`SELECT delivery_zone FROM customer_addresses WHERE id = $1`, [a.id]);
    assert.equal(zone.delivery_zone, 'Kingston');
    await assert.rejects(updateMyProfile(f.db, actor, f.customerId, { phone: ' ' }), /phone/);
  });

  test('forgotten password sends a one-time link that sets a new one', async () => {
    const u = await f.db.one<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role) VALUES ('reset@me.jm','Reset Me','x','customer') RETURNING id`);
    const n = sent.length;
    const r = await requestPasswordReset(f.db, 'RESET@me.jm');
    assert.equal(r.sent, true);
    assert.equal(sent.length, n + 1);
    const token = /token=([A-Za-z0-9_-]+)/.exec(sent.at(-1)!.text)![1];
    assert.equal((await inviteeFor(f.db, token))?.purpose, 'reset');
    await acceptInvitation(f.db, token, 'new-password-1');
    assert.equal((await requestPasswordReset(f.db, 'nobody@nowhere.jm')).sent, false);
    void u;
  });
});
