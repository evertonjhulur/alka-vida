/**
 * Admins edit invoices at any stage (Everton, 26 Oct 2026): dates, prices,
 * add or remove products, and void with a reason.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { recordPastDelivery } from '../src/services/counter.ts';
import { recordPayment } from '../src/services/payments.ts';
import { editInvoice, voidInvoice, createCreditNote, getInvoiceLedger } from '../src/services/invoices.ts';
import { businessToday } from '../src/services/core.ts';
import { addDays } from '@alka/shared';

let f: Fixture;
before(async () => {
  f = await setupFixture();
  await f.db.query(`INSERT INTO finished_goods_stock (product_id, quantity_on_hand) VALUES ($1, 1000), ($2, 1000)
                    ON CONFLICT (product_id) DO UPDATE SET quantity_on_hand = 1000`, [f.casedProductId, f.fiveGalProductId]);
});
after(async () => { await f.close(); });

const balance = async (id: string) => Number((await f.db.one<{ b: number }>(
  `SELECT balance_cents AS b FROM customer_balances WHERE customer_id = $1`, [id])).b);

async function sale(customerId: string, cases = 2, paid = 0) {
  const r = await recordPastDelivery(f.db, f.office, {
    customerId, deliveredOn: addDays(businessToday(), -2), how: 'Delivered',
    lines: [{ productId: f.casedProductId, cases }],
    amountPaidCents: paid, method: 'Cash',
  } as never);
  return r.invoiceId as string;
}

describe('Admin invoice editing', () => {
  test('dates, prices, and adding or removing products', async () => {
    const id = await sale(f.customerId);
    const lines = await f.db.query<{ order_id: string | null; delivered_on: string | null; price_per_case_cents: number }>(
      `SELECT order_id, delivered_on::text AS delivered_on, price_per_case_cents FROM invoice_line_items WHERE invoice_id = $1`, [id]);

    // Dates only: the money stays as it is.
    const before = (await getInvoiceLedger(f.db, id))!;
    const d1 = addDays(businessToday(), -10);
    const d2 = addDays(businessToday(), 20);
    const r1 = await editInvoice(f.db, f.admin, id, { invoiceDate: d1, dueDate: d2, reason: 'wrong date' });
    assert.equal(r1.invoice.invoiceDate, d1);
    assert.equal(r1.invoice.dueDate, d2);
    assert.equal(r1.invoice.grandTotalCents, before.grandTotalCents);
    await assert.rejects(editInvoice(f.db, f.admin, id, { invoiceDate: d2, dueDate: d1 }), /due date cannot be before/);
    await assert.rejects(editInvoice(f.db, f.admin, id, { invoiceDate: '26/10/2026' }), /not a date/);
    await assert.rejects(editInvoice(f.db, f.office, id, { dueDate: d2 }), /requires role admin/);

    // A new price on the line, and a 5-gallon line added.
    const r2 = await editInvoice(f.db, f.admin, id, {
      lines: [
        { productId: f.casedProductId, cases: 2, looseBottles: 0, pricePerCaseCents: 100_000, pricePerBottleCents: 0,
          orderId: lines[0].order_id, deliveredOn: lines[0].delivered_on },
        { productId: f.fiveGalProductId, cases: 0, looseBottles: 3, pricePerCaseCents: 0, pricePerBottleCents: 45_000 },
      ],
      reason: 'agreed price, and the 5-gallon was missed',
    });
    // (2 x 1,000.00 + 3 x 450.00) = 3,350.00 + 15% GCT = 3,852.50
    assert.equal(r2.invoice.grandTotalCents, 385_250);
    const kept = await f.db.one<{ order_id: string | null }>(
      `SELECT order_id FROM invoice_line_items WHERE invoice_id = $1 AND product_id = $2`, [id, f.casedProductId]);
    assert.equal(kept.order_id, lines[0].order_id, 'the line keeps its order');
    assert.equal((await getInvoiceLedger(f.db, id))!.invoiceDate, d1, 'dates untouched by a price change');

    // Remove the cased line.
    const r3 = await editInvoice(f.db, f.admin, id, {
      lines: [{ productId: f.fiveGalProductId, cases: 0, looseBottles: 3, pricePerCaseCents: 0, pricePerBottleCents: 45_000 }],
      reason: 'cases were not delivered',
    });
    assert.equal(r3.invoice.grandTotalCents, 155_250);
    await assert.rejects(editInvoice(f.db, f.admin, id, { lines: [] }), /at least one product/);
    await assert.rejects(editInvoice(f.db, f.admin, id, {
      lines: [{ productId: f.fiveGalProductId, cases: 0, looseBottles: 1, pricePerCaseCents: 0, pricePerBottleCents: -5 }],
    }), /below nothing/);
  });

  test('a QuickBooks opening balance: dates can change, the amount cannot be zeroed', async () => {
    const ob = await f.db.one<{ id: string }>(
      `INSERT INTO invoices (invoice_number, customer_id, invoice_date, due_date, subtotal_cents, gct_cents,
                             grand_total_cents, is_opening_balance, notes)
       VALUES ('OB-TEST-1', $1, '2026-09-01', '2026-10-01', 50000, 0, 50000, true, 'From QuickBooks') RETURNING id`,
      [f.customerId]);
    const r = await editInvoice(f.db, f.admin, ob.id, { invoiceDate: '2026-09-05', dueDate: '2026-10-05', reason: 'QB date' });
    assert.equal(r.invoice.grandTotalCents, 50000);
    assert.equal(r.invoice.invoiceDate, '2026-09-05');
    await assert.rejects(editInvoice(f.db, f.admin, ob.id, { discountPercent: 10, gctExempt: false }), /brought across from QuickBooks/);

    // Its amount and QuickBooks reference can be changed (27 Oct 2026).
    const r2 = await editInvoice(f.db, f.admin, ob.id, { openingAmountCents: 42_500, openingReference: 'QB-16001', reason: 'agreed with the customer' });
    assert.equal(r2.invoice.grandTotalCents, 42_500);
    const row = await f.db.one<{ subtotal_cents: number; gct_cents: number; opening_reference: string; notes: string }>(
      `SELECT subtotal_cents, gct_cents, opening_reference, notes FROM invoices WHERE id = $1`, [ob.id]);
    assert.equal(Number(row.subtotal_cents), 42_500);
    assert.equal(Number(row.gct_cents), 0);
    assert.equal(row.opening_reference, 'QB-16001');
    assert.doesNotMatch(row.notes, /agreed with the customer/, 'the reason stays in the history, off the customer\'s copy');
    const hist = await f.db.one<{ details: { reason: string; before: { grandTotalCents: number } } }>(
      `SELECT details FROM audit_log WHERE entity_id = $1 AND action = 'update' ORDER BY ts DESC LIMIT 1`, [ob.id]);
    assert.equal(hist.details.reason, 'agreed with the customer');
    assert.equal(hist.details.before.grandTotalCents, 50_000);
    await assert.rejects(editInvoice(f.db, f.admin, ob.id, { openingAmountCents: 0 }), /more than nothing/);
    // Paid more than the new amount: the difference becomes a credit note.
    const { recordPayment } = await import('../src/services/payments.ts');
    await recordPayment(f.db, f.office, { customerId: f.customerId, invoiceId: ob.id, amountCents: 40_000, method: 'Cash' } as never);
    const r3 = await editInvoice(f.db, f.admin, ob.id, { openingAmountCents: 30_000, reason: 'over-stated in QuickBooks' });
    assert.ok(r3.creditNoteId, 'credit note for what was paid above the new amount');
    // Not for an ordinary invoice.
    const plain = await sale(f.customerId);
    await assert.rejects(editInvoice(f.db, f.admin, plain, { openingAmountCents: 100 }), /only a balance brought across/);
    await voidInvoice(f.db, f.admin, ob.id, { reason: 'paid in QuickBooks already' });
  });

  test('void at any stage: off the balance, money back to credit, its credit notes voided too', async () => {
    const start = await balance(f.otherCustomerId);
    const id = await sale(f.otherCustomerId, 2, 50_000);       // 2 x 1,200 + GCT = 2,760.00; 500.00 paid with it
    await recordPayment(f.db, f.office, { customerId: f.otherCustomerId, invoiceId: id, amountCents: 20_000, method: 'Cheque' } as never);
    const cn = await createCreditNote(f.db, f.admin, { invoiceId: id, amountCents: 10_000, reason: 'one case damaged' });
    // A credit asked for by office staff, still waiting for a decision.
    const pending = await createCreditNote(f.db, f.office, { invoiceId: id, amountCents: 5_000, reason: 'late' });
    assert.ok(pending.approvalRequestId);
    const mid = await balance(f.otherCustomerId);
    assert.equal(mid, start + 276_000 - 70_000 - 10_000);

    await assert.rejects(voidInvoice(f.db, f.office, id, { reason: 'x' }), /requires role admin/);
    await assert.rejects(voidInvoice(f.db, f.admin, id, { reason: '  ' }), /say why/);
    const r = await voidInvoice(f.db, f.admin, id, { reason: 'billed to the wrong customer' });
    assert.equal(r.movedToCreditCents, 70_000);
    assert.deepEqual(r.creditNotesVoided.sort(), [cn.invoiceNumber, pending.invoiceNumber].sort());

    const led = (await getInvoiceLedger(f.db, id))!;
    assert.equal(led.status, 'Cancelled');
    // The bill and its credits are gone; the 700.00 paid stays theirs, as credit.
    assert.equal(await balance(f.otherCustomerId), start - 70_000);
    const req = await f.db.one<{ status: string }>(`SELECT status FROM approval_requests WHERE id = $1`, [pending.approvalRequestId]);
    assert.equal(req.status, 'Rejected');
    const notes = await f.db.one<{ notes: string }>(`SELECT notes FROM invoices WHERE id = $1`, [id]);
    assert.match(notes.notes, /billed to the wrong customer/);

    await assert.rejects(voidInvoice(f.db, f.admin, id, { reason: 'again' }), /already void/);
    await assert.rejects(editInvoice(f.db, f.admin, id, { dueDate: businessToday() }), /void and cannot be changed/);
  });

  test('a credit note on its own can be voided', async () => {
    const start = await balance(f.customerId);
    const cn = await createCreditNote(f.db, f.admin, { customerId: f.customerId, amountCents: 11_500, reason: 'goodwill' });
    assert.equal(await balance(f.customerId), start - 11_500);
    await voidInvoice(f.db, f.admin, cn.id, { reason: 'raised twice' });
    assert.equal(await balance(f.customerId), start);
  });
});
