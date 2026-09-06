/**
 * Section 12 - "What Done Looks Like".
 *
 * Each block below corresponds to one numbered scenario in the spec, and each
 * of those corresponds to a real failure found during design. These run
 * against a real PostgreSQL engine, not a mock.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, stopsOf, paymentsOf, type Fixture } from './helpers.ts';
import { createOrder } from '../src/services/orders.ts';
import { markStop, saveStopAllocation, getStopForDriver } from '../src/services/delivery.ts';
import { settleRoute, getSettlementReview, adjustAllocation } from '../src/services/settlement.ts';
import { getInvoiceLedger, editInvoice, openInvoicesForCustomer } from '../src/services/invoices.ts';
import { reversePayment, reassignPayment, getCustomerBalance } from '../src/services/payments.ts';
import { bottleAccount } from '../src/services/bottles.ts';
import { bottlesNotRecorded } from '../src/services/reports.ts';

let f: Fixture;
before(async () => { f = await setupFixture(); });
after(async () => { await f.close(); });

/** Order 10 cases at the Corporate rate of 1200.00/case. */
async function tenCaseOrder(date: string) {
  return createOrder(f.db, f.office, {
    customerId: f.customerId,
    deliveryMode: 'Delivery',
    requestedDeliveryDate: date,
    lines: [{ productId: f.casedProductId, cases: 10 }],
  });
}

// 10 cases x 1200.00 = 12,000.00 subtotal; GCT 15% = 1,800.00; total 13,800.00
const SUBTOTAL = 1_200_000;
const GCT = 180_000;
const TOTAL = 1_380_000;

describe('1. A normal one-off delivery, fully paid', () => {
  test('correct GCT, invoice Paid, and the driver sees a TAX-INCLUSIVE amount', async () => {
    const order = await tenCaseOrder('2026-03-02');
    assert.equal(order.subtotalCents, SUBTOTAL);
    assert.equal(order.gctCents, GCT, 'GCT is 15% of the post-discount subtotal');
    assert.equal(order.grandTotalCents, TOTAL);
    assert.ok(order.deliverySheetId, 'a Delivery order is auto-routed onto a sheet');

    const [stop] = await stopsOf(f.db, order.deliverySheetId!);

    // What the driver is shown BEFORE any invoice exists must already be
    // tax-inclusive - it falls back to the order's live grand total.
    const beforeDelivery = await getStopForDriver(f.db, stop.id);
    assert.equal(beforeDelivery!.amountOwedCents, TOTAL);
    assert.notEqual(beforeDelivery!.amountOwedCents, SUBTOTAL, 'never a pre-tax figure');

    const result = await markStop(f.db, f.driver, {
      stopId: stop.id,
      outcome: 'Delivered',
      paymentReceived: true,
      paymentMethod: 'Cash',
      paymentAmountCents: TOTAL,
    });
    assert.ok(result.invoiceId, 'delivery generates the invoice');
    assert.equal(result.amountOwedCents, TOTAL, 'still tax-inclusive once invoiced');

    const invoice = await getInvoiceLedger(f.db, result.invoiceId!);
    assert.equal(invoice!.grandTotalCents, TOTAL);
    assert.equal(invoice!.amountPaidCents, 0, 'nothing is real until route settlement');
    assert.equal(invoice!.status, 'Open');

    // Settlement is what creates the money.
    await saveStopAllocation(f.db, f.office, stop.id, [
      { invoiceId: result.invoiceId!, amountCents: TOTAL },
    ]);
    await settleRoute(f.db, f.admin, order.deliverySheetId!, { actualCashCents: TOTAL });

    const settled = await getInvoiceLedger(f.db, result.invoiceId!);
    assert.equal(settled!.amountPaidCents, TOTAL);
    assert.equal(settled!.status, 'Paid');
    assert.equal(settled!.balanceCents, 0);
  });
});

describe('2. A partial payment at a stop', () => {
  test('invoice is left Partial and the delivery is NOT blocked', async () => {
    const order = await tenCaseOrder('2026-03-03');
    const [stop] = await stopsOf(f.db, order.deliverySheetId!);

    // Customer pays only 500.00 of a 13,800.00 bill.
    const PART = 50_000;
    const result = await markStop(f.db, f.driver, {
      stopId: stop.id,
      outcome: 'Delivered',
      paymentReceived: true,
      paymentMethod: 'Cash',
      paymentAmountCents: PART,
    });

    // The delivery itself completed regardless of the shortfall.
    assert.equal(result.outcome, 'Delivered');
    assert.ok(result.invoiceId);
    const stopRow = await f.db.one<{ stop_outcome: string }>(
      `SELECT stop_outcome FROM delivery_stops WHERE id = $1`, [stop.id],
    );
    assert.equal(stopRow.stop_outcome, 'Delivered');

    await saveStopAllocation(f.db, f.office, stop.id, [
      { invoiceId: result.invoiceId!, amountCents: PART },
    ]);
    await settleRoute(f.db, f.admin, order.deliverySheetId!, { actualCashCents: PART });

    const invoice = await getInvoiceLedger(f.db, result.invoiceId!);
    assert.equal(invoice!.amountPaidCents, PART);
    assert.equal(invoice!.status, 'Partial', 'never forced closed');
    assert.equal(invoice!.balanceCents, TOTAL - PART);
  });

  test('a stop can be completed even with no payment information at all', async () => {
    const order = await tenCaseOrder('2026-03-04');
    const [stop] = await stopsOf(f.db, order.deliverySheetId!);
    const result = await markStop(f.db, f.driver, { stopId: stop.id, outcome: 'Delivered' });
    assert.equal(result.outcome, 'Delivered');
  });

  test('an impossible allocation is rejected WITHOUT blocking the stop', async () => {
    const order = await tenCaseOrder('2026-03-05');
    const [stop] = await stopsOf(f.db, order.deliverySheetId!);
    const result = await markStop(f.db, f.driver, {
      stopId: stop.id, outcome: 'Delivered',
      paymentAmountCents: 10_000, paymentMethod: 'Cash',
    });
    assert.equal(result.outcome, 'Delivered', 'the stop completed first');

    // Only the allocation itself fails - the delivery above already stands.
    await assert.rejects(
      saveStopAllocation(f.db, f.office, stop.id, [
        { invoiceId: result.invoiceId!, amountCents: 999_999 },
      ]),
      /exceeds/,
    );
    const after = await f.db.one<{ stop_outcome: string }>(
      `SELECT stop_outcome FROM delivery_stops WHERE id = $1`, [stop.id],
    );
    assert.equal(after.stop_outcome, 'Delivered', 'still delivered after the allocation error');
  });
});

describe('3. An overpayment at a stop', () => {
  test('exactly ONE extra unattached payment, no duplicate, no phantom label', async () => {
    const order = await tenCaseOrder('2026-03-06');
    const [stop] = await stopsOf(f.db, order.deliverySheetId!);

    const OVERPAY = TOTAL + 200_000; // pays 2,000.00 too much
    const result = await markStop(f.db, f.driver, {
      stopId: stop.id, outcome: 'Delivered',
      paymentReceived: true, paymentMethod: 'Cash', paymentAmountCents: OVERPAY,
    });
    await saveStopAllocation(f.db, f.office, stop.id, [
      { invoiceId: result.invoiceId!, amountCents: TOTAL },
    ]);

    const before = await paymentsOf(f.db, f.customerId);
    const settle = await settleRoute(f.db, f.admin, order.deliverySheetId!,
      { actualCashCents: OVERPAY });

    assert.equal(settle.paymentIds.length, 2,
      'one payment against the invoice, one unattached - never three');

    const created = (await paymentsOf(f.db, f.customerId)).slice(before.length);
    const attached = created.filter((p) => p.invoice_id === result.invoiceId);
    const unattached = created.filter((p) => p.invoice_id === null);

    assert.equal(attached.length, 1);
    assert.equal(Number(attached[0].amount_cents), TOTAL);
    assert.equal(unattached.length, 1, 'exactly one unattached payment - no phantom duplicate');
    assert.equal(Number(unattached[0].amount_cents), 200_000);

    const total = created.reduce((s, p) => s + Number(p.amount_cents), 0);
    assert.equal(total, OVERPAY, 'created payments sum to exactly the cash collected');

    const invoice = await getInvoiceLedger(f.db, result.invoiceId!);
    assert.equal(invoice!.status, 'Paid');
    assert.equal(invoice!.amountPaidCents, TOTAL, 'the excess never inflates the invoice');
  });

  test('the unattached payment still counts toward the ONE running balance', async () => {
    const before = await getCustomerBalance(f.db, f.customerId);
    // The 2,000.00 excess reduces what the customer owes overall, with no
    // separate "credit balance" concept anywhere.
    assert.ok(before.paidCents > 0);
    const manual = await f.db.one<{ c: number }>(
      `SELECT COALESCE(SUM(amount_cents),0)::bigint AS c FROM payments
       WHERE customer_id = $1 AND status = 'Confirmed'`, [f.customerId],
    );
    assert.equal(before.paidCents, Number(manual.c),
      'balance counts every confirmed payment, attached or not');
  });
});

describe('4. A recurring customer, second consecutive delivery', () => {
  test('each delivery gets its own independent invoice, never batched', async () => {
    const first = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Delivery',
      requestedDeliveryDate: '2026-04-06',
      isRecurring: true, recurrencePattern: 'Weekly',
      lines: [{ productId: f.fiveGalProductId, looseBottles: 20 }],
    });
    const second = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Delivery',
      requestedDeliveryDate: '2026-04-13',
      isRecurring: true, recurrencePattern: 'Weekly',
      lines: [{ productId: f.fiveGalProductId, looseBottles: 20 }],
    });
    assert.notEqual(first.deliverySheetId, second.deliverySheetId,
      'different dates produce different sheets');

    const [s1] = await stopsOf(f.db, first.deliverySheetId!);
    const r1 = await markStop(f.db, f.driver, {
      stopId: s1.id, outcome: 'Delivered', bottlesDeliveredFull: 20,
    });
    const [s2] = await stopsOf(f.db, second.deliverySheetId!);
    const r2 = await markStop(f.db, f.driver, {
      stopId: s2.id, outcome: 'Delivered', bottlesDeliveredFull: 20,
    });

    assert.ok(r1.invoiceId && r2.invoiceId);
    assert.notEqual(r1.invoiceId, r2.invoiceId, 'two separate real invoices');

    // 20 x 450.00 = 9,000.00 + 15% = 10,350.00 each, independently.
    for (const id of [r1.invoiceId!, r2.invoiceId!]) {
      const inv = await getInvoiceLedger(f.db, id);
      assert.equal(inv!.grandTotalCents, 1_035_000);
    }
    const numbers = await f.db.query<{ invoice_number: string }>(
      `SELECT invoice_number FROM invoices WHERE id = ANY($1::uuid[])`,
      [[r1.invoiceId, r2.invoiceId]],
    );
    assert.equal(new Set(numbers.map((n) => n.invoice_number)).size, 2);
  });
});

describe('5. A payment reversal', () => {
  test('the original is untouched and a paired negative entry is visible', async () => {
    const sale = await tenCaseOrder('2026-05-04');
    const [stop] = await stopsOf(f.db, sale.deliverySheetId!);
    const r = await markStop(f.db, f.driver, {
      stopId: stop.id, outcome: 'Delivered',
      paymentAmountCents: TOTAL, paymentMethod: 'Cash', paymentReceived: true,
    });
    await saveStopAllocation(f.db, f.office, stop.id, [
      { invoiceId: r.invoiceId!, amountCents: TOTAL },
    ]);
    const settled = await settleRoute(f.db, f.admin, sale.deliverySheetId!,
      { actualCashCents: TOTAL });
    const paymentId = settled.paymentIds[0];

    const paidBefore = (await getInvoiceLedger(f.db, r.invoiceId!))!.amountPaidCents;
    assert.equal(paidBefore, TOTAL);

    const { reversalId } = await reversePayment(f.db, f.admin, paymentId, 'Cheque bounced');

    const original = await f.db.one<{ amount_cents: number; is_reversal: boolean }>(
      `SELECT amount_cents, is_reversal FROM payments WHERE id = $1`, [paymentId],
    );
    assert.equal(Number(original.amount_cents), TOTAL, 'original amount untouched');
    assert.equal(original.is_reversal, false);

    const reversal = await f.db.one<{
      amount_cents: number; is_reversal: boolean; reverses_payment_id: string;
    }>(
      `SELECT amount_cents, is_reversal, reverses_payment_id FROM payments WHERE id = $1`,
      [reversalId],
    );
    assert.equal(Number(reversal.amount_cents), -TOTAL, 'paired negated entry');
    assert.equal(reversal.is_reversal, true);
    assert.equal(reversal.reverses_payment_id, paymentId);

    const after = await getInvoiceLedger(f.db, r.invoiceId!);
    assert.equal(after!.amountPaidCents, 0, 'the two entries net to zero');
    assert.equal(after!.status, 'Open');

    // Both entries remain visible in the ledger.
    const both = await f.db.query(
      `SELECT id FROM payments WHERE id = $1 OR reverses_payment_id = $1`, [paymentId],
    );
    assert.equal(both.length, 2);
  });

  test('a payment cannot be reversed twice, and a reversal cannot be reversed', async () => {
    const p = await f.db.one<{ id: string }>(
      `INSERT INTO payments (customer_id, amount_cents, method)
       VALUES ($1, 10000, 'Cash') RETURNING id`, [f.customerId],
    );
    const { reversalId } = await reversePayment(f.db, f.admin, p.id);
    await assert.rejects(reversePayment(f.db, f.admin, p.id), /already been reversed/);
    await assert.rejects(reversePayment(f.db, f.admin, reversalId), /cannot itself be reversed/);
  });

  test('only an Admin may reverse a payment', async () => {
    const p = await f.db.one<{ id: string }>(
      `INSERT INTO payments (customer_id, amount_cents, method)
       VALUES ($1, 5000, 'Cash') RETURNING id`, [f.customerId],
    );
    await assert.rejects(reversePayment(f.db, f.office, p.id), /requires role admin/);
  });
});

describe('6. Payment reassignment', () => {
  test('same customer: the invoice link moves and both invoices re-derive', async () => {
    const a = await tenCaseOrder('2026-06-01');
    const [stopA] = await stopsOf(f.db, a.deliverySheetId!);
    const ra = await markStop(f.db, f.driver, { stopId: stopA.id, outcome: 'Delivered' });

    const b = await tenCaseOrder('2026-06-02');
    const [stopB] = await stopsOf(f.db, b.deliverySheetId!);
    const rb = await markStop(f.db, f.driver, { stopId: stopB.id, outcome: 'Delivered' });

    // A payment landed on invoice A but belonged to invoice B.
    const p = await f.db.one<{ id: string }>(
      `INSERT INTO payments (customer_id, invoice_id, amount_cents, method, status)
       VALUES ($1,$2,$3,'Cash','Confirmed') RETURNING id`,
      [f.customerId, ra.invoiceId, TOTAL],
    );
    assert.equal((await getInvoiceLedger(f.db, ra.invoiceId!))!.status, 'Paid');

    await reassignPayment(f.db, f.admin, p.id, { invoiceId: rb.invoiceId }, 'logged to wrong invoice');

    assert.equal((await getInvoiceLedger(f.db, ra.invoiceId!))!.amountPaidCents, 0);
    assert.equal((await getInvoiceLedger(f.db, ra.invoiceId!))!.status, 'Open');
    assert.equal((await getInvoiceLedger(f.db, rb.invoiceId!))!.amountPaidCents, TOTAL);
    assert.equal((await getInvoiceLedger(f.db, rb.invoiceId!))!.status, 'Paid');
  });

  test('cross-customer: customer changes and the invoice link is CLEARED', async () => {
    const c = await tenCaseOrder('2026-06-03');
    const [stop] = await stopsOf(f.db, c.deliverySheetId!);
    const r = await markStop(f.db, f.driver, { stopId: stop.id, outcome: 'Delivered' });

    const p = await f.db.one<{ id: string }>(
      `INSERT INTO payments (customer_id, invoice_id, amount_cents, method, status)
       VALUES ($1,$2,$3,'Cash','Confirmed') RETURNING id`,
      [f.customerId, r.invoiceId, TOTAL],
    );

    const before = await getCustomerBalance(f.db, f.otherCustomerId);
    const out = await reassignPayment(f.db, f.admin, p.id,
      { customerId: f.otherCustomerId }, 'paid by the wrong account');

    assert.equal(out.customerId, f.otherCustomerId);
    assert.equal(out.invoiceId, null,
      'an invoice link from the wrong customer books must never carry over');

    const row = await f.db.one<{ customer_id: string; invoice_id: string | null }>(
      `SELECT customer_id, invoice_id FROM payments WHERE id = $1`, [p.id],
    );
    assert.equal(row.invoice_id, null);
    assert.equal(row.customer_id, f.otherCustomerId);

    // It lands as unattached credit on the correct customer's single balance.
    const after = await getCustomerBalance(f.db, f.otherCustomerId);
    assert.equal(after.paidCents - before.paidCents, TOTAL);

    // And the original invoice is unpaid again.
    assert.equal((await getInvoiceLedger(f.db, r.invoiceId!))!.amountPaidCents, 0);
  });

  test('a payment cannot be attached to another customer invoice directly', async () => {
    const p = await f.db.one<{ id: string }>(
      `INSERT INTO payments (customer_id, amount_cents, method, status)
       VALUES ($1, 1000, 'Cash','Confirmed') RETURNING id`, [f.customerId],
    );
    const foreign = await f.db.one<{ id: string }>(
      `INSERT INTO invoices (invoice_number, customer_id, grand_total_cents)
       VALUES ('INV-FOREIGN', $1, 1000) RETURNING id`, [f.otherCustomerId],
    );
    await assert.rejects(
      reassignPayment(f.db, f.admin, p.id, { invoiceId: foreign.id }),
      /belongs to a different customer/,
    );
  });
});

describe('7. Admin edit reducing an already-paid invoice', () => {
  test('a Credit Note posts automatically with NO second approval', async () => {
    const order = await tenCaseOrder('2026-07-06');
    const [stop] = await stopsOf(f.db, order.deliverySheetId!);
    const r = await markStop(f.db, f.driver, {
      stopId: stop.id, outcome: 'Delivered',
      paymentAmountCents: TOTAL, paymentMethod: 'Cash', paymentReceived: true,
    });
    await saveStopAllocation(f.db, f.office, stop.id, [
      { invoiceId: r.invoiceId!, amountCents: TOTAL },
    ]);
    await settleRoute(f.db, f.admin, order.deliverySheetId!, { actualCashCents: TOTAL });
    assert.equal((await getInvoiceLedger(f.db, r.invoiceId!))!.status, 'Paid');

    // The customer was billed 10 cases but only 6 were really delivered.
    const { invoice, creditNoteId } = await editInvoice(f.db, f.admin, r.invoiceId!, {
      lines: [{
        productId: f.casedProductId, cases: 6, looseBottles: 0,
        pricePerCaseCents: 120_000, pricePerBottleCents: 0,
      }],
      reason: 'over-billed: only 6 cases delivered',
    });

    // 6 x 1200.00 = 7,200.00 + 15% = 8,280.00
    assert.equal(invoice.grandTotalCents, 828_000);
    assert.ok(creditNoteId, 'reducing below the amount paid generates a credit note');

    const cn = await f.db.one<{
      grand_total_cents: number; credit_status: string;
      linked_invoice_id: string; is_credit_note: boolean; approval_request_id: string | null;
    }>(
      `SELECT grand_total_cents, credit_status, linked_invoice_id,
              is_credit_note, approval_request_id
       FROM invoices WHERE id = $1`, [creditNoteId],
    );
    assert.equal(cn.is_credit_note, true);
    assert.equal(Number(cn.grand_total_cents), -(TOTAL - 828_000), 'negative, for the difference');
    assert.equal(cn.credit_status, 'Approved', 'the admin edit is itself the authorisation');
    assert.equal(cn.linked_invoice_id, r.invoiceId);
    assert.equal(cn.approval_request_id, null, 'no separate approval request is raised');

    // No pending approval was created by this path.
    const pending = await f.db.query(
      `SELECT id FROM approval_requests WHERE entity_id = $1`, [creditNoteId],
    );
    assert.equal(pending.length, 0);

    // Always logged with before/after values.
    const log = await f.db.one<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log
       WHERE entity_type='Invoice' AND entity_id=$1 AND action='update'
       ORDER BY ts DESC LIMIT 1`, [r.invoiceId],
    );
    const d = log.details as { before: { grandTotalCents: number }; after: { grandTotalCents: number } };
    assert.equal(d.before.grandTotalCents, TOTAL);
    assert.equal(d.after.grandTotalCents, 828_000);
  });

  test('an edit that INCREASES the total just reopens the invoice, no document', async () => {
    const order = await tenCaseOrder('2026-07-07');
    const [stop] = await stopsOf(f.db, order.deliverySheetId!);
    const r = await markStop(f.db, f.driver, {
      stopId: stop.id, outcome: 'Delivered',
      paymentAmountCents: TOTAL, paymentMethod: 'Cash',
    });
    await saveStopAllocation(f.db, f.office, stop.id, [
      { invoiceId: r.invoiceId!, amountCents: TOTAL },
    ]);
    await settleRoute(f.db, f.admin, order.deliverySheetId!, { actualCashCents: TOTAL });

    const { invoice, creditNoteId } = await editInvoice(f.db, f.admin, r.invoiceId!, {
      lines: [{
        productId: f.casedProductId, cases: 14, looseBottles: 0,
        pricePerCaseCents: 120_000, pricePerBottleCents: 0,
      }],
    });
    assert.equal(creditNoteId, null, 'no credit note when the bill goes up');
    assert.equal(invoice.status, 'Partial', 'simply carries the new remaining balance');
    assert.ok(invoice.balanceCents > 0);
  });

  test('an office User cannot edit an issued invoice', async () => {
    const order = await tenCaseOrder('2026-07-08');
    const [stop] = await stopsOf(f.db, order.deliverySheetId!);
    const r = await markStop(f.db, f.driver, { stopId: stop.id, outcome: 'Delivered' });
    await assert.rejects(
      editInvoice(f.db, f.office, r.invoiceId!, { discountPercent: 50 }),
      /requires role admin/,
    );
  });
});

describe('8. A driver cash shortfall at day end', () => {
  test('flagged as a route variance, never absorbed into a customer account', async () => {
    const order = await tenCaseOrder('2026-08-03');
    const [stop] = await stopsOf(f.db, order.deliverySheetId!);
    const r = await markStop(f.db, f.driver, {
      stopId: stop.id, outcome: 'Delivered',
      paymentReceived: true, paymentMethod: 'Cash', paymentAmountCents: TOTAL,
    });
    await saveStopAllocation(f.db, f.office, stop.id, [
      { invoiceId: r.invoiceId!, amountCents: TOTAL },
    ]);

    // Driver recorded collecting 13,800.00 but hands in 13,000.00 - short 800.00.
    const SHORT = 80_000;
    const handedIn = TOTAL - SHORT;

    const balanceBefore = await getCustomerBalance(f.db, f.customerId);
    const settle = await settleRoute(f.db, f.admin, order.deliverySheetId!, {
      actualCashCents: handedIn,
      settlementNotes: 'driver short at cash-up',
    });

    assert.equal(settle.expectedCashCents, TOTAL, 'expected = what the driver recorded');
    assert.equal(settle.actualCashCents, handedIn);
    assert.equal(settle.cashVarianceCents, -SHORT, 'the shortfall is flagged');

    // The customer's invoice is fully paid: they handed over the full amount.
    const invoice = await getInvoiceLedger(f.db, r.invoiceId!);
    assert.equal(invoice!.amountPaidCents, TOTAL,
      'the driver shortfall must not reduce what the customer paid');
    assert.equal(invoice!.status, 'Paid');

    // The variance created no payment and touched no customer balance. The
    // invoice was already raised at delivery, so settlement moves the balance
    // by exactly the payment - and by nothing else. Had the 800.00 shortfall
    // leaked into the customer's account the drop would have been smaller.
    const balanceAfter = await getCustomerBalance(f.db, f.customerId);
    assert.equal(
      balanceBefore.balanceCents - balanceAfter.balanceCents,
      TOTAL,
      'balance moved by the full payment, never reduced by the driver shortfall',
    );
    const varianceLinked = await f.db.query(
      `SELECT id FROM payments WHERE amount_cents = $1 AND customer_id = $2`,
      [-SHORT, f.customerId],
    );
    assert.equal(varianceLinked.length, 0, 'no payment record represents the shortfall');

    // It is recorded on the sheet, for follow-up with the driver.
    const sheet = await f.db.one<{ cash_variance_cents: number; status: string }>(
      `SELECT cash_variance_cents, status FROM delivery_sheets WHERE id = $1`,
      [order.deliverySheetId],
    );
    assert.equal(Number(sheet.cash_variance_cents), -SHORT);
    assert.equal(sheet.status, 'Completed');
  });

  test('the settlement review shows per-stop figures, not one route-wide number', async () => {
    const order = await tenCaseOrder('2026-08-10');
    const [stop] = await stopsOf(f.db, order.deliverySheetId!);
    await markStop(f.db, f.driver, {
      stopId: stop.id, outcome: 'Delivered',
      paymentAmountCents: 100_000, paymentMethod: 'Cash',
    });

    const review = await getSettlementReview(f.db, order.deliverySheetId!);
    assert.equal(review.stops.length, 1);
    const row = review.stops[0];
    assert.equal(row.customerName, 'Blue Mountain Offices');
    assert.equal(row.expectedCents, TOTAL, 'per-stop expected is tax-inclusive');
    assert.equal(row.collectedCents, 100_000);
    assert.equal(row.varianceCents, TOTAL - 100_000, 'variance traces to this stop');
    assert.ok(row.deliveredSummary.includes('Alka Vida 500ml'));
  });
});

/**
 * The bottle pool only learns what the driver's screen tells it.
 *
 * There was no "bottles delivered" field on that screen at all: the column
 * existed and the API accepted it, but nothing ever sent a value. So every
 * delivery of 5-gallon bottles recorded zero going out, and both the pool and
 * each customer's holding quietly understated what was on loan. Two real
 * deliveries were found in that state.
 */
describe('Returnable bottles reach the pool', () => {
  test('a delivery that carries returnables records them going out', async () => {
    const order = await createOrder(f.db, f.office, {
      customerId: f.customerId,
      deliveryMode: 'Delivery',
      requestedDeliveryDate: '2026-08-12',
      lines: [{ productId: f.fiveGalProductId, looseBottles: 3 }],
    });
    const [stop] = await stopsOf(f.db, order.deliverySheetId!);

    // This customer carries deliveries from earlier tests in the file, so
    // measure the MOVEMENT rather than the running total.
    const before = await bottleAccount(f.db, f.customerId);

    await markStop(f.db, f.driver, {
      stopId: stop.id, outcome: 'Delivered',
      bottlesDeliveredFull: 3, bottlesEmptiesPickedUp: 1,
    });

    const row = await f.db.one<{ full: number; empties: number }>(
      `SELECT bottles_delivered_full AS full, bottles_empties_picked_up AS empties
       FROM delivery_stops WHERE id = $1`, [stop.id],
    );
    assert.equal(Number(row.full), 3, 'three bottles went out on loan');
    assert.equal(Number(row.empties), 1);

    const after = await bottleAccount(f.db, f.customerId);
    assert.equal(after.delivered - before.delivered, 3);
    assert.equal(after.returned - before.returned, 1);
    assert.equal(after.closingHolding - before.closingHolding, 2,
      'three out and one back leaves two more of ours with the customer');
  });

  test('the report finds a delivery that recorded fewer bottles than it carried',
    async () => {
      const order = await createOrder(f.db, f.office, {
        customerId: f.customerId,
        deliveryMode: 'Delivery',
        requestedDeliveryDate: '2026-08-13',
        lines: [{ productId: f.fiveGalProductId, looseBottles: 4 }],
      });
      const [stop] = await stopsOf(f.db, order.deliverySheetId!);
      // Delivered, but nobody recorded the bottles - the old behaviour.
      await markStop(f.db, f.driver, { stopId: stop.id, outcome: 'Delivered' });

      const gaps = await bottlesNotRecorded(f.db);
      const mine = gaps.find((g) => (g as { stop_id: string }).stop_id === stop.id) as
        { bottles_on_the_order: number; bottles_recorded: number } | undefined;
      assert.ok(mine, 'a delivery of four bottles recording none must be reported');
      assert.equal(Number(mine.bottles_on_the_order), 4);
      assert.equal(Number(mine.bottles_recorded), 0);
    });
});
