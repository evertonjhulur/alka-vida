/**
 * Everton's round of 7 Oct 2026 - 14 points, his rulings final.
 * One describe per point (or pair of points), named by its number.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, paymentsOf, type Fixture } from './helpers.ts';
import { buildServer } from '../src/server.ts';
import { createOrder, listOrders, cancelOrder, bottleChargeProduct } from '../src/services/orders.ts';
import { markStop, addPaymentStop, getStopForDriver } from '../src/services/delivery.ts';
import { settleRoute } from '../src/services/settlement.ts';
import { counterSale } from '../src/services/counter.ts';
import { getStatement } from '../src/services/ledger.ts';
import { receivePayment } from '../src/services/payments.ts';
import { bottleAccount } from '../src/services/bottles.ts';
import { submitApplication, approveApplication } from '../src/services/registration.ts';
import {
  createBroadcast, listNews, saveNews, sendOrderPlacedEmail, sendOrderCancelledEmail, uploadNewsImage,
} from '../src/services/messaging.ts';
import { updateMyProfile, getMyProfile } from '../src/services/portal.ts';
import { setByToken, customerWants, renderEmail } from '../src/services/emailkit.ts';
import {
  createPurchaseOrder, getPurchaseOrder, receivePurchaseOrder, cancelPurchaseOrder, deletePurchaseOrder,
} from '../src/services/inventory.ts';
import { renderStatementPdf, setMailSinkForTests, type MailMessage } from '../src/services/documents.ts';
import { businessToday } from '../src/services/core.ts';
import { addDays } from '@alka/shared';

let f: Fixture;
const sent: MailMessage[] = [];
const today = businessToday();
// 1x1 transparent PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

before(async () => {
  f = await setupFixture();
  setMailSinkForTests((m) => { sent.push(m); });
});
after(async () => { setMailSinkForTests(null); await f.close(); });

const stopOf = (orderId: string, outcome = 'Pending') =>
  f.db.maybeOne<{ id: string; delivery_sheet_id: string; day: string; line_items_summary: string }>(
    `SELECT st.id, st.delivery_sheet_id, ds.delivery_date::text AS day, st.line_items_summary
     FROM delivery_stops st JOIN delivery_sheets ds ON ds.id = st.delivery_sheet_id
     WHERE st.order_id = $1 AND st.stop_outcome = $2 ORDER BY ds.delivery_date DESC LIMIT 1`, [orderId, outcome]);
const order = (days = 1, extra: Record<string, unknown> = {}) => createOrder(f.db, f.office, {
  customerId: f.customerId, deliveryMode: 'Delivery',
  requestedDeliveryDate: addDays(today, days),
  lines: [{ productId: f.casedProductId, cases: 4 }], ...extra,
});
const lastTo = (to: string) => [...sent].reverse().find((m) => m.to === to);

describe('Point 1: approving a customer emails them a link to set a password', () => {
  test('the approval email goes out with the set-password link', async () => {
    const appl = await submitApplication(f.db, {
      accountType: 'Individual', firstName: 'Petra', lastName: 'Gayle',
      email: 'petra@example.jm', phone: '876-555-0101', addressLine1: '4 Lady Musgrave Rd', parish: 'St Andrew',
    });
    const r = await approveApplication(f.db, f.admin, appl.id, { deliveryZone: null });
    assert.equal(r.emailed, true);
    const m = lastTo('petra@example.jm')!;
    assert.match(m.subject, /approved/i);
    assert.ok(m.html!.includes(r.invitation!.link.replace(/&/g, '&amp;')), 'the link is in the email');
    assert.match(m.text, /Set my password/);
  });
});

describe('Point 3: News & offers carry pictures', () => {
  test('a picture uploaded from the office is on the post, and public', async () => {
    const img = await uploadNewsImage(f.db, f.office, PNG);
    const post = await saveNews(f.db, f.office, null, {
      kind: 'Promotion', title: 'Buy 10 get 1 free', body: 'All October', imageIds: [img.id],
    });
    const live = await listNews(f.db, { live: true }) as Array<{ id: string; images: Array<{ id: string }> }>;
    assert.deepEqual(live.find((p) => p.id === post.id)!.images.map((i) => i.id), [img.id]);
    await assert.rejects(uploadNewsImage(f.db, f.office, 'data:text/plain;base64,aGk='), /picture/);
  });

  test('the current offer, picture and all, is in the footer band of customer emails', async () => {
    const o = await order(2);
    await sendOrderPlacedEmail(f.db, o.id);
    const m = lastTo('ap@bluemountain.jm')!;
    assert.match(m.html!, /Current offer/);
    assert.match(m.html!, /Buy 10 get 1 free/);
    assert.match(m.html!, /\/api\/public\/news-images\//);
  });
});

describe('Points 4 and 5: every email category respects its tick, and unsubscribes without a login', () => {
  test('My Profile has the "Order cancelled" and "Service announcements" ticks', async () => {
    await updateMyProfile(f.db, f.admin, f.otherCustomerId, { cancelEmails: false, serviceEmails: false });
    const p = await getMyProfile(f.db, f.otherCustomerId) as unknown as { cancel_emails: boolean; service_emails: boolean };
    assert.equal(p.cancel_emails, false);
    assert.equal(p.service_emails, false);
  });

  test('"Order cancelled" email, only when ticked', async () => {
    const o = await order(3);
    await cancelOrder(f.db, f.office, o.id, 'customer rang');
    const r = await sendOrderCancelledEmail(f.db, o.id, 'customer rang');
    assert.equal(r.sent, true);
    assert.match(lastTo('ap@bluemountain.jm')!.subject, /cancelled/);

    const other = await createOrder(f.db, f.office, {
      customerId: f.otherCustomerId, deliveryMode: 'Delivery', requestedDeliveryDate: addDays(today, 3),
      lines: [{ productId: f.casedProductId, cases: 1 }],
    });
    await cancelOrder(f.db, f.office, other.id);
    assert.equal((await sendOrderCancelledEmail(f.db, other.id)).sent, false, 'they turned it off');
  });

  test('service announcements respect their tick', async () => {
    const b = await createBroadcast(f.db, f.office, {
      subject: 'Closed Heroes Day', body: 'No deliveries on Monday.', purpose: 'Service',
      customerIds: [f.customerId, f.otherCustomerId],
    });
    const rows = await f.db.query<{ customer_id: string; status: string }>(
      `SELECT customer_id, status FROM broadcast_recipients WHERE broadcast_id = $1`, [b.id]);
    assert.equal(rows.find((r) => r.customer_id === f.otherCustomerId)!.status, 'Skipped');
    assert.equal(rows.find((r) => r.customer_id === f.customerId)!.status, 'Sent');
  });

  test('non-essential email carries a working unsubscribe link; essential email does not', async () => {
    const o = await order(4);
    await sendOrderPlacedEmail(f.db, o.id);
    const m = lastTo('ap@bluemountain.jm')!;
    const url = /href="([^"]*\/unsubscribe\?t=[^"]+)"/.exec(m.html!)![1].replace(/&amp;/g, '&');
    assert.ok(m.headers?.['List-Unsubscribe'], 'mail programs get their own button too');
    const u = new URL(url);

    const app = await buildServer(f.db);
    try {
      // Opening the link asks; it changes nothing (mail scanners open links).
      const get = await app.inject({ method: 'GET', url: `${u.pathname}${u.search}` });
      assert.equal(get.statusCode, 200);
      assert.match(get.body, /Unsubscribe/);
      assert.equal(await customerWants(f.db, f.customerId, 'orders'), true);
      // No sign-in: a plain form post does it.
      const post = await app.inject({
        method: 'POST', url: '/unsubscribe',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: `t=${u.searchParams.get('t')}&c=orders`,
      });
      assert.equal(post.statusCode, 200);
      assert.match(post.body, /unsubscribed/i);
      assert.equal(await customerWants(f.db, f.customerId, 'orders'), false);
    } finally { await app.close(); }

    const o2 = await order(5);
    assert.equal((await sendOrderPlacedEmail(f.db, o2.id)).sent, false, 'the tick is respected');
    const token = (await f.db.one<{ t: string }>(`SELECT email_token::text AS t FROM customers WHERE id = $1`, [f.customerId])).t;
    await f.db.tx((t) => setByToken(t, token, 'orders', true));
    assert.equal(await customerWants(f.db, f.customerId, 'orders'), true);
  });
});

describe('Points 6 and 7: the order confirmation, the look, the domain', () => {
  test('tick, thank you, number, items, Subtotal / GCT / Total, address and date, contact line', async () => {
    const o = await order(6);
    await sendOrderPlacedEmail(f.db, o.id);
    const m = lastTo('ap@bluemountain.jm')!;
    for (const want of ['&#10003;', 'Thank you for your order', o.orderNumber, 'Alka Vida 500ml',
      'Subtotal', 'GCT', 'Total', 'Delivery address', 'Delivery date', 'orders@alkavidaja.com',
      'for any orders or queries', 'Unsubscribe']) {
      assert.ok(m.html!.includes(want), `the email shows ${want}`);
    }
    assert.match(m.text, /Contact orders@alkavidaja\.com for any orders or queries/);
    assert.match(m.html!, /#0E76BC/i);
    assert.match(m.html!, /#2D3590/i);
    assert.doesNotMatch(m.html!, /#0b7285/i, 'no teal');
  });

  test('nothing anywhere says alkavidja.com', () => {
    const e = renderEmail({ heading: 'x' });
    assert.doesNotMatch(e.html + e.text, /alkavidja/);
    assert.match(e.text, /alkavidaja\.com/);
  });
});

describe('Point 8: a rescheduled stop', () => {
  test('emails the new date and reason, and the order shows "Rescheduled from X to Y"', async () => {
    const o = await order(1);
    const stop = await stopOf(o.id);
    const to = addDays(today, 4);
    const r = await markStop(f.db, f.driver, {
      stopId: stop!.id, outcome: 'Rescheduled', rescheduleTo: to, rescheduleReason: 'Gate locked',
    });
    assert.equal(r.rescheduledTo, to);
    const { sendRescheduledEmail } = await import('../src/services/messaging.ts');
    await sendRescheduledEmail(f.db, stop!.id);
    const m = lastTo('ap@bluemountain.jm')!;
    assert.match(m.subject, /new delivery date/);
    assert.match(m.text, /Gate locked/);
    const list = await listOrders(f.db, { customerId: f.customerId, limit: 500 }) as Array<{
      id: string; events: Array<{ kind: string; from: string; to: string; reason: string }>;
    }>;
    const ev = list.find((x) => x.id === o.id)!.events;
    assert.deepEqual(ev.map((e) => [e.kind, e.from, e.to, e.reason]),
      [['Rescheduled', stop!.day, to, 'Gate locked']]);
  });
});

describe('Point 9: partially delivered', () => {
  test('invoice what was handed over; the rest goes on the chosen day and is invoiced then', async () => {
    const o = await order(0, { lines: [{ productId: f.casedProductId, cases: 4 }] });
    const stop = await stopOf(o.id);
    const lines = await f.db.query<{ id: string }>(`SELECT id FROM order_line_items WHERE order_id = $1`, [o.id]);
    const rest = addDays(today, 2);
    const r = await markStop(f.db, f.driver, {
      stopId: stop!.id, outcome: 'Delivered', remainderTo: rest,
      deliveredLines: [{ orderLineId: lines[0].id, cases: 1 }],
    });
    assert.equal(r.orderStatus, 'Partially Delivered');
    assert.equal(r.remainderTo, rest);
    const inv1 = await f.db.one<{ subtotal_cents: number }>(`SELECT subtotal_cents FROM invoices WHERE id = $1`, [r.invoiceId]);
    assert.equal(Number(inv1.subtotal_cents), 120_000, 'one case invoiced, not four');

    const next = await stopOf(o.id);
    assert.equal(next!.day, rest, 'the rest is on that day\'s round');
    assert.match(next!.line_items_summary, /3 cs/);
    const driverView = await getStopForDriver(f.db, next!.id) as { lines: Array<{ cases: number }>; amountOwedCents: number };
    assert.equal(driverView.lines[0].cases, 3, 'the driver sees what is left');
    assert.equal(driverView.amountOwedCents, 414_000);

    const list = await listOrders(f.db, { customerId: f.customerId, limit: 500 }) as Array<{
      id: string; remaining_summary: string; events: Array<{ kind: string; to: string }>;
    }>;
    const mine = list.find((x) => x.id === o.id)!;
    assert.match(mine.remaining_summary, /3 cs/);
    assert.deepEqual(mine.events.map((e) => [e.kind, e.to]), [['Part delivered', rest]]);

    const r2 = await markStop(f.db, f.driver, { stopId: next!.id, outcome: 'Delivered' });
    assert.equal(r2.orderStatus, 'Delivered');
    const inv2 = await f.db.one<{ subtotal_cents: number }>(`SELECT subtotal_cents FROM invoices WHERE id = $1`, [r2.invoiceId]);
    assert.equal(Number(inv2.subtotal_cents), 360_000, 'the rest invoiced when delivered');
  });

  test('a "partial" that handed over everything is refused', async () => {
    const o = await order(0, { lines: [{ productId: f.casedProductId, cases: 1 }] });
    const stop = await stopOf(o.id);
    await assert.rejects(markStop(f.db, f.driver, { stopId: stop!.id, outcome: 'Delivered', remainderTo: addDays(today, 2) }),
      /nothing left/);
  });
});

describe('Point 10: a payment at a stop with no delivery', () => {
  test('waits for the office to settle the round before it touches the account', async () => {
    const o = await order(0);
    const stop = await stopOf(o.id);
    const before_ = (await paymentsOf(f.db, f.otherCustomerId)).length;
    await addPaymentStop(f.db, f.driver, stop!.delivery_sheet_id, {
      customerId: f.otherCustomerId, method: 'Cash', amountCents: 50_000,
    });
    assert.equal((await paymentsOf(f.db, f.otherCustomerId)).length, before_, 'nothing yet');
    await markStop(f.db, f.driver, { stopId: stop!.id, outcome: 'Delivered' });
    await settleRoute(f.db, f.office, stop!.delivery_sheet_id, { actualCashCents: 50_000 });
    const after_ = await paymentsOf(f.db, f.otherCustomerId);
    assert.equal(after_.length, before_ + 1);
    assert.equal(Number(after_.at(-1)!.amount_cents), 50_000);
  });
});

describe('Point 11: statements filtered by invoice state', () => {
  test('Open / Paid / Partially paid / Overdue, with balances that follow', async () => {
    const mk = async (cases: number) => counterSale(f.db, f.office, {
      customerId: f.otherCustomerId, lines: [{ productId: f.casedProductId, cases }], amountPaidCents: 0,
    });
    const paid = await mk(1); const part = await mk(2); const open = await mk(3);
    await receivePayment(f.db, f.office, { customerId: f.otherCustomerId, amountCents: paid.grandTotalCents, method: 'Cash',
      allocations: [{ invoiceId: paid.invoiceId, amountCents: paid.grandTotalCents }] });
    await receivePayment(f.db, f.office, { customerId: f.otherCustomerId, amountCents: 10_000, method: 'Cash',
      allocations: [{ invoiceId: part.invoiceId, amountCents: 10_000 }] });
    await f.db.query(`UPDATE invoices SET due_date = $2::date WHERE id = $1`, [open.invoiceId, addDays(today, -5)]);

    const refs = async (status: string) => (await getStatement(f.db, f.otherCustomerId, { status }))
      .entries.filter((e) => e.type === 'Invoice').map((e) => e.reference);
    assert.ok((await refs('Paid')).includes(paid.invoiceNumber));
    assert.ok(!(await refs('Paid')).includes(open.invoiceNumber));
    assert.deepEqual((await refs('Partially paid')).filter((x) => [paid, part, open].some((s) => s.invoiceNumber === x)), [part.invoiceNumber]);
    assert.ok((await refs('Overdue')).includes(open.invoiceNumber));
    assert.ok(!(await refs('Open')).includes(paid.invoiceNumber));

    const paidOnly = await getStatement(f.db, f.otherCustomerId, { status: 'Paid' });
    assert.equal(paidOnly.closingBalanceCents, 0, 'paid invoices owe nothing');
    const overdue = await getStatement(f.db, f.otherCustomerId, { status: 'Overdue' });
    assert.equal(overdue.closingBalanceCents, open.grandTotalCents);
    const pdf = await renderStatementPdf(f.db, f.otherCustomerId, { status: 'Overdue' });
    assert.ok(pdf.pdf.length > 1000);
  });
});

describe('Point 12: counter sales', () => {
  test('a walk-in pays in full; part payment only on a customer account', async () => {
    const lines = [{ productId: f.casedProductId, cases: 1 }];
    await assert.rejects(counterSale(f.db, f.office, { lines, amountPaidCents: 50_000 }), /walk-in pays in full/);
    const full = await counterSale(f.db, f.office, { lines });
    assert.equal(full.balanceCents, 0, 'no customer chosen: the shared walk-in record, paid in full');
    const acct = await counterSale(f.db, f.office, { customerId: f.customerId, lines, amountPaidCents: 50_000 });
    assert.ok(acct.balanceCents > 0);
  });
});

describe('Point 13: 5-gallon empties', () => {
  test('the bottle is a product at $1,200, priced from Products', async () => {
    const b = await bottleChargeProduct(f.db);
    assert.equal(Number(b.price_per_bottle_cents), 120_000);
  });

  test('an order short of empties gets the shortfall as bottles, at the Products price', async () => {
    const b = await bottleChargeProduct(f.db);
    await f.db.query(`UPDATE products SET price_per_bottle_cents = 130000 WHERE id = $1`, [b.id]);
    const o = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Delivery', requestedDeliveryDate: addDays(today, 1),
      lines: [{ productId: f.fiveGalProductId, looseBottles: 5 }], emptiesExpected: 3,
    });
    const line = await f.db.one<{ loose_bottles: number; price_per_bottle_cents: number }>(
      `SELECT loose_bottles, price_per_bottle_cents FROM order_line_items WHERE order_id = $1 AND product_id = $2`, [o.id, b.id]);
    assert.equal(Number(line.loose_bottles), 2);
    assert.equal(Number(line.price_per_bottle_cents), 130_000);
    await f.db.query(`UPDATE products SET price_per_bottle_cents = 120000 WHERE id = $1`, [b.id]);

    // The driver sees the empties to expect; the bought bottles are theirs.
    const stop = await stopOf(o.id);
    const view = await getStopForDriver(f.db, stop!.id) as { empties_expected: number; bottleCharge: { priceCents: number } };
    assert.equal(view.empties_expected, 3);
    assert.equal(view.bottleCharge.priceCents, 120_000);
    const held0 = await bottleAccount(f.db, f.customerId);
    await markStop(f.db, f.driver, {
      stopId: stop!.id, outcome: 'Delivered', bottlesDeliveredFull: 5, bottlesEmptiesPickedUp: 3,
    });
    const held1 = await bottleAccount(f.db, f.customerId);
    assert.equal(held1.sold - held0.sold, 2);
    assert.equal(held1.closingHolding - held0.closingHolding, 0, 'the 2 bought are theirs, not ours on loan');
  });

  test('fewer empties than expected at the door: the driver adds the bottle charge', async () => {
    const o = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Delivery', requestedDeliveryDate: addDays(today, 1),
      lines: [{ productId: f.fiveGalProductId, looseBottles: 2 }], emptiesExpected: 2,
    });
    const stop = await stopOf(o.id);
    const r = await markStop(f.db, f.driver, {
      stopId: stop!.id, outcome: 'Delivered', bottlesDeliveredFull: 2, bottlesEmptiesPickedUp: 1, bottlesCharged: 1,
    });
    const b = await bottleChargeProduct(f.db);
    const invLine = await f.db.one<{ loose_bottles: number }>(
      `SELECT loose_bottles FROM invoice_line_items WHERE invoice_id = $1 AND product_id = $2`, [r.invoiceId, b.id]);
    assert.equal(Number(invLine.loose_bottles), 1, 'the bottle is on the invoice');
  });
});

describe('Point 14: purchase order statuses', () => {
  const po = async () => {
    const m = await f.db.one<{ id: string }>(
      `INSERT INTO raw_materials (name, category, unit_of_measure, unit_cost_cents)
       VALUES ('Cap ' || gen_random_uuid(), 'Cap', 'each', 500) RETURNING id`);
    const s = await f.db.one<{ id: string }>(`INSERT INTO suppliers (name) VALUES ('Caps Ltd ' || gen_random_uuid()) RETURNING id`);
    return createPurchaseOrder(f.db, f.office, {
      supplierId: s.id, lines: [{ rawMaterialId: m.id, quantityOrdered: 100, unitCostCents: 500 }],
    });
  };
  const statusOf = async (id: string) => ((await getPurchaseOrder(f.db, id)) as { status: string }).status;

  test('closing a part-received PO is "Partially Received - Closed", not Cancelled', async () => {
    const p = await po();
    const d = await getPurchaseOrder(f.db, p.id) as { lines: Array<{ id: string }> };
    await receivePurchaseOrder(f.db, f.office, p.id, [{ poLineItemId: d.lines[0].id, quantityReceived: 40 }]);
    assert.equal(await statusOf(p.id), 'Partially Received');
    const r = await cancelPurchaseOrder(f.db, f.office, p.id);
    assert.equal(r.status, 'Partially Received - Closed');
    assert.equal(await statusOf(p.id), 'Partially Received - Closed');
    await assert.rejects(receivePurchaseOrder(f.db, f.office, p.id, [{ poLineItemId: d.lines[0].id, quantityReceived: 1 }]), /closed/);
  });

  test('deleting with nothing received is Cancelled; fully received is Received', async () => {
    const p = await po();
    await deletePurchaseOrder(f.db, f.office, p.id);
    assert.equal(await statusOf(p.id), 'Cancelled');
    const q = await po();
    const d = await getPurchaseOrder(f.db, q.id) as { lines: Array<{ id: string }> };
    await receivePurchaseOrder(f.db, f.office, q.id, [{ poLineItemId: d.lines[0].id, quantityReceived: 100 }]);
    assert.equal(await statusOf(q.id), 'Received');
  });
});
