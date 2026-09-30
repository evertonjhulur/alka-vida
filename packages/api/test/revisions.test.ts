/**
 * Everton's revision list, 30 Sep 2026.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, stopsOf, type Fixture } from './helpers.ts';
import { createOrder, editOrder } from '../src/services/orders.ts';
import { markStop } from '../src/services/delivery.ts';
import { settleRoute } from '../src/services/settlement.ts';
import { collectOrder, counterSale } from '../src/services/counter.ts';
import { getInvoiceLedger, createCreditNote, editInvoice } from '../src/services/invoices.ts';
import { reviewApproval, requestInvoiceDiscount } from '../src/services/approvals.ts';
import {
  createCustomer, updateCustomer, saveAddress, setSpecialPrice, customerPrices, billingAddress,
} from '../src/services/customers.ts';
import { createZone, listZones } from '../src/services/zones.ts';
import { raiseCycleInvoices, pendingDeliveries, invoiceCustomerNow } from '../src/services/cycles.ts';
import {
  createQuotation, convertQuotation, quoteByToken, answerByToken, updateQuotation, deleteQuotation,
} from '../src/services/quotations.ts';
import {
  emailQuote, emailReceipt, runAutomation, setAutomation, renderPoPdf, emailPurchaseOrder,
} from '../src/services/paperwork.ts';
import { emailInvoices, renderInvoicePdf, setMailSinkForTests, type MailMessage } from '../src/services/documents.ts';
import {
  createPurchaseOrder, updatePurchaseOrder, deletePurchaseOrder, receivePurchaseOrder, getPurchaseOrder,
} from '../src/services/inventory.ts';
import { createSupplier, createRawMaterial, setSupplierMaterial } from '../src/services/catalog.ts';
import { receivePayment } from '../src/services/payments.ts';
import { computeTotals, cyclePeriod, nextRunDate, weekdayOf } from '@alka/shared';

let f: Fixture;
const sent: MailMessage[] = [];
before(async () => {
  f = await setupFixture();
  setMailSinkForTests((m) => { sent.push(m); });
});
after(async () => { setMailSinkForTests(null); await f.close(); });

const stopFor = async (orderId: string) =>
  (await f.db.one<{ id: string; delivery_sheet_id: string }>(
    `SELECT id, delivery_sheet_id FROM delivery_stops WHERE order_id = $1`, [orderId]));

describe('Shared arithmetic', () => {
  test('a discount can be an amount instead of a percentage, and never goes below zero', () => {
    const t = computeTotals([{ lineTotal: 100_000 }], 0, true, 25_000);
    assert.equal(t.discountAmount, 25_000);
    assert.equal(t.gct, 11_250);
    assert.equal(t.grandTotal, 86_250);
    assert.equal(computeTotals([{ lineTotal: 10_000 }], 0, true, 50_000).grandTotal, 0);
  });
  test('weeks run Monday to Sunday, months are calendar months', () => {
    assert.equal(weekdayOf('2026-09-30'), 'Wed');
    assert.deepEqual(cyclePeriod('2026-09-30', 'Weekly'), { from: '2026-09-28', to: '2026-10-04' });
    assert.deepEqual(cyclePeriod('2026-02-10', 'Monthly'), { from: '2026-02-01', to: '2026-02-28' });
  });
  test('the next day a round runs', () => {
    assert.equal(nextRunDate('2026-09-30', ['Mon', 'Thu']), '2026-10-01');
    assert.equal(nextRunDate('2026-10-02', ['Mon', 'Thu']), '2026-10-05');
    assert.equal(nextRunDate('2026-10-02', []), '2026-10-02');
  });
});

describe('Customers', () => {
  test('a business or an individual, with several delivery days, GCT exemption and a cycle', async () => {
    await createZone(f.db, f.admin, { name: 'Spanish Town', runDays: ['Tue', 'Fri'] });
    const zones = await listZones(f.db) as Array<{ name: string; run_days: string[] }>;
    assert.deepEqual(zones.find((z) => z.name === 'Spanish Town')!.run_days, ['Tue', 'Fri']);

    const c = await createCustomer(f.db, f.office, {
      accountType: 'Individual', name: 'Marcia Brown', phone: '876-555-0101', email: ' marcia@example.com ',
      addressLine1: '4 Oak Lane', city: 'Spanish Town', parish: 'St Catherine',
      deliveryZone: 'Spanish Town', deliveryDays: ['Fri', 'Tue', 'Xyz'],
      gctExempt: true, gctExemptRef: 'TAJ-123', invoiceCycle: 'Monthly',
    });
    const row = await f.db.one<Record<string, unknown>>(`SELECT * FROM customers WHERE id = $1`, [c.id]);
    assert.equal(row.account_type, 'Individual');
    assert.equal(row.email, 'marcia@example.com');
    assert.deepEqual(row.delivery_days, ['Tue', 'Fri']);
    assert.equal(row.default_delivery_day, 'Tue');
    assert.equal(row.delivery_address, '4 Oak Lane, Spanish Town, St Catherine');
    assert.equal(row.gct_exempt, true);
    assert.equal(row.invoice_cycle, 'Monthly');

    // Clearing a field is possible now (it used to be ignored).
    await updateCustomer(f.db, f.office, c.id, { gctExempt: false, gctExemptRef: null, invoiceCycle: 'PerDelivery' });
    const after2 = await f.db.one<Record<string, unknown>>(`SELECT * FROM customers WHERE id = $1`, [c.id]);
    assert.equal(after2.gct_exempt, false);
    assert.equal(after2.gct_exempt_ref, null);
    assert.equal(after2.name, 'Marcia Brown', 'untouched fields stay');
  });

  test('a special price beats the price list, and is what the order charges', async () => {
    await setSpecialPrice(f.db, f.office, f.otherCustomerId, f.casedProductId, 110_000);
    const prices = await customerPrices(f.db, f.otherCustomerId) as Array<Record<string, unknown>>;
    const p = prices.find((x) => x.product_id === f.casedProductId)!;
    assert.equal(Number(p.price_per_case_cents), 110_000);
    assert.equal(p.special_price, true);

    const o = await createOrder(f.db, f.office, {
      customerId: f.otherCustomerId, deliveryMode: 'Pickup',
      lines: [{ productId: f.casedProductId, cases: 2 }],
    });
    assert.equal(o.subtotalCents, 220_000);
    // The other customer (Corporate list) still pays 1,200.00.
    const o2 = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Pickup',
      lines: [{ productId: f.casedProductId, cases: 2 }],
    });
    assert.equal(o2.subtotalCents, 240_000);
    await setSpecialPrice(f.db, f.office, f.otherCustomerId, f.casedProductId, null);
  });

  test('a second delivery address has its own zone, and the order goes on that round', async () => {
    const addr = await saveAddress(f.db, f.office, f.customerId, null, {
      label: 'Warehouse', addressLine1: '9 Industrial Terrace', city: 'Spanish Town',
      parish: 'St Catherine', deliveryZone: 'Spanish Town', isDelivery: true,
    });
    const o = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Delivery', requestedDeliveryDate: '2026-11-06',
      addressId: addr.id, lines: [{ productId: f.fiveGalProductId, looseBottles: 3 }],
    });
    const sheet = await f.db.one<{ zone: string }>(
      `SELECT ds.zone FROM delivery_sheets ds WHERE ds.id = $1`, [o.deliverySheetId],
    );
    assert.equal(sheet.zone, 'Spanish Town');
    const stop = await f.db.one<{ delivery_address: string }>(
      `SELECT delivery_address FROM delivery_stops WHERE order_id = $1`, [o.id],
    );
    assert.match(stop.delivery_address, /^Warehouse: 9 Industrial Terrace/);

    // Another customer's address cannot be used.
    await assert.rejects(createOrder(f.db, f.office, {
      customerId: f.otherCustomerId, deliveryMode: 'Delivery', addressId: addr.id,
      lines: [{ productId: f.fiveGalProductId, looseBottles: 1 }],
    }), /not one of this customer/);
  });

  test('a billing address is what paperwork is addressed to', async () => {
    await saveAddress(f.db, f.office, f.customerId, null, {
      label: 'Head office', addressLine1: '1 Knutsford Blvd', city: 'Kingston', parish: 'St Andrew',
      isBilling: true, isDelivery: false,
    });
    const b = await billingAddress(f.db, f.customerId);
    assert.equal(b.line, '1 Knutsford Blvd, Kingston, St Andrew');
  });
});

describe('Orders and invoices: GCT and discounts', () => {
  test('a GCT-exempt customer is charged no GCT on the order or the invoice', async () => {
    await updateCustomer(f.db, f.office, f.otherCustomerId, { gctExempt: true });
    const o = await createOrder(f.db, f.office, {
      customerId: f.otherCustomerId, deliveryMode: 'Pickup',
      lines: [{ productId: f.casedProductId, cases: 1 }],
    });
    assert.equal(o.gctCents, 0);
    const c = await collectOrder(f.db, f.office, { orderId: o.id });
    const inv = await f.db.one<{ gct_cents: number; gct_exempt: boolean }>(
      `SELECT gct_cents, gct_exempt FROM invoices WHERE id = $1`, [c.invoiceId],
    );
    assert.equal(Number(inv.gct_cents), 0);
    assert.equal(inv.gct_exempt, true);
    await updateCustomer(f.db, f.office, f.otherCustomerId, { gctExempt: false });
  });

  test('GCT can be taken off one order, and a fixed-amount discount carries to the invoice', async () => {
    const o = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Pickup', gctExempt: true, discountFixedCents: 20_000,
      lines: [{ productId: f.casedProductId, cases: 1 }],
    });
    assert.equal(o.grandTotalCents, 100_000);
    const c = await collectOrder(f.db, f.office, { orderId: o.id });
    assert.equal(c.grandTotalCents, 100_000);

    await editOrder(f.db, f.office, (await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Pickup', lines: [{ productId: f.casedProductId, cases: 1 }],
    })).id, { discountFixedCents: 10_000 });
  });

  test('an admin can take GCT off an invoice after the fact', async () => {
    const sale = await counterSale(f.db, f.office, {
      customerId: f.customerId, lines: [{ productId: f.casedProductId, cases: 1 }],
    });
    assert.equal(sale.grandTotalCents, 138_000);
    const r = await editInvoice(f.db, f.admin, sale.invoiceId, { gctExempt: true, reason: 'exempt' });
    assert.equal(r.invoice.grandTotalCents, 120_000);
  });

  test('an office discount as an amount waits for approval, then applies', async () => {
    const sale = await counterSale(f.db, f.office, {
      customerId: f.customerId, lines: [{ productId: f.casedProductId, cases: 2 }],
    });
    const req = await requestInvoiceDiscount(f.db, f.office, sale.invoiceId, 0, 'loyal', 30_000);
    assert.equal((await getInvoiceLedger(f.db, sale.invoiceId))!.grandTotalCents, 276_000);
    await reviewApproval(f.db, f.admin, req.approvalRequestId, 'Approved');
    // 2,400.00 - 300.00 = 2,100.00 + 15% = 2,415.00
    assert.equal((await getInvoiceLedger(f.db, sale.invoiceId))!.grandTotalCents, 241_500);
  });
});

describe('Credit notes', () => {
  test('by product: priced like an invoice, GCT included, reduces the balance', async () => {
    const before = await f.db.one<{ b: string }>(
      `SELECT balance_cents::text AS b FROM customer_balances WHERE customer_id = $1`, [f.customerId]);
    const cn = await createCreditNote(f.db, f.admin, {
      customerId: f.customerId, reason: 'Two damaged cases',
      lines: [{ productId: f.casedProductId, cases: 2, looseBottles: 0,
        pricePerCaseCents: 120_000, pricePerBottleCents: 0 }],
    });
    assert.equal(cn.totalCents, 276_000);
    const row = await f.db.one<Record<string, unknown>>(`SELECT * FROM invoices WHERE id = $1`, [cn.id]);
    assert.equal(Number(row.subtotal_cents), -240_000);
    assert.equal(Number(row.gct_cents), -36_000);
    const afterB = await f.db.one<{ b: string }>(
      `SELECT balance_cents::text AS b FROM customer_balances WHERE customer_id = $1`, [f.customerId]);
    assert.equal(Number(afterB.b), Number(before.b) - 276_000);
    const pdf = await renderInvoicePdf(f.db, cn.id);
    assert.ok(pdf.pdf.length > 1000);
  });

  test('by amount from the office: GCT split out, and nothing counts until approved', async () => {
    const cn = await createCreditNote(f.db, f.office, {
      customerId: f.customerId, reason: 'Overcharged', amountCents: 11_500,
    });
    assert.ok(cn.approvalRequestId);
    let row = await f.db.one<Record<string, unknown>>(`SELECT * FROM invoices WHERE id = $1`, [cn.id]);
    assert.equal(Number(row.grand_total_cents), 0);
    await reviewApproval(f.db, f.admin, cn.approvalRequestId!, 'Approved');
    row = await f.db.one<Record<string, unknown>>(`SELECT * FROM invoices WHERE id = $1`, [cn.id]);
    assert.equal(Number(row.grand_total_cents), -11_500);
    assert.equal(Number(row.gct_cents), -1_500);
  });

  test('needs a reason and something to credit', async () => {
    await assert.rejects(createCreditNote(f.db, f.admin, { customerId: f.customerId, reason: '', amountCents: 5 }), /why/);
    await assert.rejects(createCreditNote(f.db, f.admin, { customerId: f.customerId, reason: 'x' }), /products or an amount/);
  });
});

describe('Weekly and monthly invoicing', () => {
  let cust: string;
  test('deliveries for a monthly customer raise no invoice; the month closes into ONE, due on receipt', async () => {
    cust = (await createCustomer(f.db, f.office, {
      name: 'Monthly Ltd', phone: '1', email: 'ap@monthly.jm', deliveryZone: 'Kingston',
      invoiceCycle: 'Monthly', paymentTerms: 'Net 30',
    })).id;
    const orderIds: string[] = [];
    for (const d of ['2026-08-05', '2026-08-19']) {
      const o = await createOrder(f.db, f.office, {
        customerId: cust, deliveryMode: 'Delivery', requestedDeliveryDate: d,
        lines: [{ productId: f.fiveGalProductId, looseBottles: 10 }],
      });
      orderIds.push(o.id);
      const stop = await stopFor(o.id);
      const r = await markStop(f.db, f.driver, {
        stopId: stop.id, outcome: 'Delivered', bottlesDeliveredFull: 10,
        paymentReceived: d === '2026-08-19', paymentMethod: 'Cash',
        paymentAmountCents: d === '2026-08-19' ? 200_000 : 0,
      });
      assert.equal(r.invoiceId, null, 'no invoice at the door');
      if (d === '2026-08-19') {
        await settleRoute(f.db, f.office, stop.delivery_sheet_id, { actualCashCents: 200_000 });
      }
    }
    const pickup = await createOrder(f.db, f.office, {
      customerId: cust, deliveryMode: 'Pickup', requestedDeliveryDate: '2026-08-25',
      lines: [{ productId: f.casedProductId, cases: 1 }],
    });
    const col = await collectOrder(f.db, f.office, { orderId: pickup.id });
    assert.equal(col.invoiceId, null);
    await f.db.query(`UPDATE customer_orders SET fulfilled_on = '2026-08-25' WHERE id = $1`, [pickup.id]);

    const waiting = await pendingDeliveries(f.db, cust);
    assert.equal(waiting.length, 3);

    // Still August: the month is open, so nothing is raised.
    assert.equal((await raiseCycleInvoices(f.db, f.admin, { today: '2026-08-31' })).length, 0);

    const raised = await raiseCycleInvoices(f.db, f.admin, { today: '2026-09-01' });
    const mine = raised.filter((r) => r.customerId === cust);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].deliveries, 3);
    assert.equal(mine[0].periodFrom, '2026-08-01');
    assert.equal(mine[0].periodTo, '2026-08-31');
    // 20 x 500.00 (list) + 1 case at 1,300.00 = 11,300.00 + 15% = 12,995.00
    assert.equal(mine[0].totalCents, 1_299_500);
    // The driver's 2,000.00 went straight onto it.
    assert.equal(mine[0].appliedFromAccountCents, 200_000);

    const inv = await f.db.one<Record<string, unknown>>(
      `SELECT invoice_date::text AS d, due_date::text AS due, cycle FROM invoices WHERE id = $1`, [mine[0].invoiceId]);
    assert.equal(inv.due, inv.d, 'due on receipt');
    assert.equal(inv.cycle, 'Monthly');
    const lines = await f.db.query<{ delivered_on: string; reference: string }>(
      `SELECT delivered_on::text AS delivered_on, reference FROM invoice_line_items
       WHERE invoice_id = $1 ORDER BY delivered_on`, [mine[0].invoiceId]);
    assert.deepEqual(lines.map((l) => l.delivered_on), ['2026-08-05', '2026-08-19', '2026-08-25']);

    // Running again raises nothing more.
    assert.equal((await raiseCycleInvoices(f.db, f.admin, { today: '2026-09-02' }))
      .filter((r) => r.customerId === cust).length, 0);
    assert.equal((await pendingDeliveries(f.db, cust)).length, 0);
    const pdf = await renderInvoicePdf(f.db, mine[0].invoiceId);
    assert.ok(pdf.pdf.length > 1000);
  });

  test('"Invoice now" bills everything waiting, whatever the period', async () => {
    const o = await createOrder(f.db, f.office, {
      customerId: cust, deliveryMode: 'Delivery', requestedDeliveryDate: '2026-09-09',
      lines: [{ productId: f.fiveGalProductId, looseBottles: 2 }],
    });
    await markStop(f.db, f.driver, { stopId: (await stopFor(o.id)).id, outcome: 'Delivered' });
    const r = await invoiceCustomerNow(f.db, f.office, cust);
    assert.equal(r.deliveries, 1);
    await assert.rejects(invoiceCustomerNow(f.db, f.office, cust), /nothing is waiting/);
  });
});

describe('Quotations: sending and accepting', () => {
  test('emailed with an accept link that works without signing in', async () => {
    const q = await createQuotation(f.db, f.office, {
      customerId: f.customerId, validUntil: '2099-01-01',
      lines: [{ productId: f.casedProductId, cases: 3 }],
    });
    await updateQuotation(f.db, f.office, q.id, {
      customerId: f.customerId, lines: [{ productId: f.casedProductId, cases: 4 }], discountFixedCents: 10_000,
    });
    const r = await emailQuote(f.db, f.office, q.id);
    const mail = sent.at(-1)!;
    assert.match(mail.subject, /quotation QT-/);
    assert.equal(mail.attachments?.length, 1);
    const token = r.link.split('/quote/')[1];
    const pub = await quoteByToken(f.db, token) as Record<string, unknown>;
    assert.equal(pub.status, 'Sent');
    assert.equal('id' in pub, false, 'no internal ids on the public page');
    assert.equal(await quoteByToken(f.db, 'x'.repeat(30)), null);

    await answerByToken(f.db, token, 'Accepted');
    const row = await f.db.one<{ status: string; accepted_via: string }>(
      `SELECT status, accepted_via FROM quotations WHERE id = $1`, [q.id]);
    assert.deepEqual(row, { status: 'Accepted', accepted_via: 'Email link' });

    const conv = await convertQuotation(f.db, f.office, q.id);
    // 4 x 1,200.00 - 100.00 = 4,700.00 + 15% = 5,405.00
    assert.equal(conv.grandTotalCents, 540_500);
  });

  test('a draft can be thrown away; a sent one cannot', async () => {
    const q = await createQuotation(f.db, f.office, {
      customerId: f.customerId, lines: [{ productId: f.casedProductId, cases: 1 }],
    });
    await deleteQuotation(f.db, f.office, q.id);
    const q2 = await createQuotation(f.db, f.office, {
      customerId: f.customerId, lines: [{ productId: f.casedProductId, cases: 1 }],
    });
    await emailQuote(f.db, f.office, q2.id);
    await assert.rejects(deleteQuotation(f.db, f.office, q2.id), /declined instead/);
  });
});

describe('Sending', () => {
  test('several open invoices go in one email with one attachment', async () => {
    const a = await counterSale(f.db, f.office, { customerId: f.customerId, lines: [{ productId: f.casedProductId, cases: 1 }] });
    const b = await counterSale(f.db, f.office, { customerId: f.customerId, lines: [{ productId: f.casedProductId, cases: 1 }] });
    const before = sent.length;
    const r = await emailInvoices(f.db, f.office, [a.invoiceId, b.invoiceId]);
    assert.equal(sent.length, before + 1);
    assert.equal(sent.at(-1)!.attachments!.length, 1);
    assert.deepEqual(r.invoiceNumbers.sort(), [a.invoiceNumber, b.invoiceNumber].sort());
    await assert.rejects(emailInvoices(f.db, f.office, [a.invoiceId, (await counterSale(f.db, f.office, {
      customerId: f.otherCustomerId, lines: [{ productId: f.casedProductId, cases: 1 }] })).invoiceId]), /one customer/);
  });

  test('a receipt for a payment spread over invoices has one number', async () => {
    const a = await counterSale(f.db, f.office, { customerId: f.otherCustomerId, lines: [{ productId: f.casedProductId, cases: 1 }] });
    const pay = await receivePayment(f.db, f.office, {
      customerId: f.otherCustomerId, amountCents: 200_000, method: 'Bank Transfer',
      allocations: [{ invoiceId: a.invoiceId, amountCents: a.grandTotalCents }],
    });
    const r = await emailReceipt(f.db, f.office, pay.paymentIds);
    assert.match(r.receiptNumber, /^RC-/);
    assert.match(sent.at(-1)!.subject, /receipt RC-/);
    const again = await emailReceipt(f.db, f.office, pay.paymentIds);
    assert.equal(again.receiptNumber, r.receiptNumber, 'the same receipt keeps its number');
  });

  test('automatic statements go once a month; reminders once per interval', async () => {
    await setAutomation(f.db, f.admin, {
      statementsEnabled: true, statementsDay: 1, remindersEnabled: true,
      remindersAfterDays: 7, remindersEveryDays: 14,
    });
    // An overdue invoice for the other customer.
    const s = await counterSale(f.db, f.office, { customerId: f.otherCustomerId, lines: [{ productId: f.casedProductId, cases: 1 }] });
    await f.db.query(`UPDATE invoices SET due_date = '2026-09-01' WHERE id = $1`, [s.invoiceId]);

    const first = await runAutomation(f.db, f.admin, { today: '2026-10-02' });
    assert.ok(first.statements >= 1);
    assert.ok(first.reminders >= 1);
    const second = await runAutomation(f.db, f.admin, { today: '2026-10-03' });
    assert.equal(second.statements, 0, 'not twice in one month');
    assert.equal(second.reminders, 0, 'not again inside the interval');
    const later = await runAutomation(f.db, f.admin, { today: '2026-10-17' });
    assert.ok(later.reminders >= 1, 'again after the interval');

    // A customer who opted out gets nothing.
    await updateCustomer(f.db, f.office, f.otherCustomerId, { autoReminders: false, autoStatements: false });
    const mark = sent.length;
    await runAutomation(f.db, f.admin, { today: '2026-11-02' });
    const toOther = sent.slice(mark).filter((m) => m.to === 'acct@portmorerx.jm');
    assert.equal(toOther.length, 0);
    await setAutomation(f.db, f.admin, { statementsEnabled: false, remindersEnabled: false });
  });
});

describe('Purchasing', () => {
  let supplierId: string; let taxed: string; let exempt: string;
  test('GCT and the Environmental Levy follow how each product is tagged', async () => {
    supplierId = (await createSupplier(f.db, f.office, { name: 'Caribbean Plastics', email: 'sales@cp.jm' })).id;
    taxed = (await createRawMaterial(f.db, f.office, { name: 'Preform 28mm', category: 'Bottle' })).id;
    exempt = (await createRawMaterial(f.db, f.office, { name: 'Water treatment', category: 'Water' })).id;
    await setSupplierMaterial(f.db, f.office, { supplierId, rawMaterialId: taxed, unitCostCents: 1_000 });
    await setSupplierMaterial(f.db, f.office, {
      supplierId, rawMaterialId: exempt, unitCostCents: 10_000, gctExempt: true, envExempt: true,
    });
    const po = await createPurchaseOrder(f.db, f.office, {
      supplierId, lines: [
        { rawMaterialId: taxed, quantityOrdered: 1_000 },  // 10,000.00
        { rawMaterialId: exempt, quantityOrdered: 10 },    // 1,000.00, no taxes
      ],
    });
    assert.equal(po.subtotalCents, 1_100_000);
    assert.equal(po.gctCents, 150_000);
    assert.equal(po.envTaxCents, 3_750);
    assert.equal(po.grandTotalCents, 1_253_750);
    const pdf = await renderPoPdf(f.db, po.id);
    assert.ok(pdf.pdf.length > 1000);

    await emailPurchaseOrder(f.db, f.office, po.id);
    assert.equal(sent.at(-1)!.to, 'sales@cp.jm');
    const after = await getPurchaseOrder(f.db, po.id) as { status: string };
    assert.equal(after.status, 'Sent');

    await updatePurchaseOrder(f.db, f.office, po.id, { lines: [{ rawMaterialId: taxed, quantityOrdered: 500 }] });
    const edited = await getPurchaseOrder(f.db, po.id) as { grand_total_cents: number; lines: unknown[] };
    assert.equal(edited.lines.length, 1);
    assert.equal(Number(edited.grand_total_cents), 500_000 + 75_000 + 1_875);

    await deletePurchaseOrder(f.db, f.office, po.id);
    assert.equal(await getPurchaseOrder(f.db, po.id), null);
  });

  test('once goods are received, a PO can be neither changed nor deleted', async () => {
    const po = await createPurchaseOrder(f.db, f.office, {
      supplierId, lines: [{ rawMaterialId: taxed, quantityOrdered: 100 }],
    });
    const detail = await getPurchaseOrder(f.db, po.id) as { lines: Array<{ id: string }> };
    await receivePurchaseOrder(f.db, f.office, po.id, [{ poLineItemId: detail.lines[0].id, quantityReceived: 50 }]);
    await assert.rejects(updatePurchaseOrder(f.db, f.office, po.id,
      { lines: [{ rawMaterialId: taxed, quantityOrdered: 10 }] }), /can no longer be changed/);
    await assert.rejects(deletePurchaseOrder(f.db, f.office, po.id), /cannot be deleted/);
  });
});
