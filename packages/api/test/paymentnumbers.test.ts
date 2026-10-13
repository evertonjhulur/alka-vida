/**
 * Every payment has a number from the moment it is taken (Everton,
 * 12 Oct 2026): to identify payments and to trace mistakes.
 *
 * A payment spread over several invoices is several rows sharing ONE number;
 * part of a payment later put against an invoice keeps its number; a
 * reversal carries the number of the payment it reverses.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setupFixture, type Fixture } from './helpers.ts';
import { counterSale } from '../src/services/counter.ts';
import { applyToInvoice, receivePayment, reversePayment, unappliedPayments } from '../src/services/payments.ts';
import { printReceipts, renderReceiptPdf } from '../src/services/paperwork.ts';

let f: Fixture;
before(async () => { f = await setupFixture(); });
after(async () => { await f.close(); });

let n = 0;
const customer = async () => (await f.db.one<{ id: string }>(
  `INSERT INTO customers (name, phone, email, price_tier_id, delivery_address, delivery_zone, payment_terms)
   VALUES ($1, '876-555-0100', '', $2, '1 Test Rd, Kingston', 'Kingston', 'Net 30') RETURNING id`,
  [`Payment Numbers ${++n}`, f.tierId],
)).id;
const sale = (customerId: string) =>
  counterSale(f.db, f.office, { customerId, lines: [{ productId: f.casedProductId, cases: 1 }] });
const numbersOf = (ids: readonly string[]) => f.db.query<{ id: string; receipt_number: string | null; is_reversal: boolean }>(
  `SELECT id, receipt_number, is_reversal FROM payments WHERE id = ANY($1::uuid[])`, [[...ids]]);

describe('Payment numbers', () => {
  test('a payment over two invoices plus money left on account is one number', async () => {
    const c = await customer();
    const a = await sale(c);
    const b = await sale(c);
    const p = await receivePayment(f.db, f.office, {
      customerId: c, amountCents: a.grandTotalCents + b.grandTotalCents + 50_000, method: 'Cash',
      allocations: [{ invoiceId: a.invoiceId, amountCents: a.grandTotalCents }, { invoiceId: b.invoiceId, amountCents: b.grandTotalCents }],
    });
    assert.equal(p.paymentIds.length, 3, 'two invoices and the rest on account');
    const rows = await numbersOf(p.paymentIds);
    const nums = new Set(rows.map((r) => r.receipt_number));
    assert.equal(nums.size, 1, 'one number for the whole payment');
    assert.match([...nums][0]!, /^RCT-\d{6}$/);

    const next = await receivePayment(f.db, f.office, { customerId: c, amountCents: 10_000, method: 'Cash' });
    const [nextRow] = await numbersOf(next.paymentIds);
    assert.notEqual(nextRow.receipt_number, [...nums][0], 'the next payment gets the next number');
  });

  test('part of a payment put against an invoice later keeps its number', async () => {
    const c = await customer();
    const p = await receivePayment(f.db, f.office, { customerId: c, amountCents: 500_000, method: 'Bank Transfer' });
    const [orig] = await numbersOf(p.paymentIds);
    // A new invoice uses money on the account: part of the $5,000 is split off onto it.
    await sale(c);
    const rows = await f.db.query<{ receipt_number: string; invoice_id: string | null }>(
      `SELECT receipt_number, invoice_id FROM payments WHERE customer_id = $1 AND method = 'Bank Transfer'`, [c]);
    assert.ok(rows.length >= 2, 'split into the part on the invoice and the rest on account');
    assert.ok(rows.some((r) => r.invoice_id) && rows.some((r) => !r.invoice_id));
    assert.ok(rows.every((r) => r.receipt_number === orig.receipt_number), 'every part keeps the number');
  });

  test('money taken at the counter is not given the number of older money used in the same sale', async () => {
    const c = await customer();
    const p = await receivePayment(f.db, f.office, { customerId: c, amountCents: 50_000, method: 'Bank Transfer' });
    const [old] = await numbersOf(p.paymentIds);
    // The sale uses the $500 on account (split off, keeping its number) and the rest is paid now.
    const s = await counterSale(f.db, f.office, {
      customerId: c, lines: [{ productId: f.casedProductId, cases: 1 }], method: 'Cash', amountPaidCents: 88_000,
    });
    const oldParts = await f.db.query<{ receipt_number: string }>(
      `SELECT receipt_number FROM payments WHERE customer_id = $1 AND method = 'Bank Transfer'`, [c]);
    assert.ok(oldParts.every((r) => r.receipt_number === old.receipt_number));
    const cash = await f.db.query<{ receipt_number: string }>(
      `SELECT receipt_number FROM payments WHERE customer_id = $1 AND method = 'Cash'`, [c]);
    assert.ok(cash.length >= 1, `cash taken at the counter (sale ${s.grandTotalCents})`);
    for (const r of cash) assert.notEqual(r.receipt_number, old.receipt_number);
  });

  test('a reversal carries the number of the payment it reverses', async () => {
    const c = await customer();
    const p = await receivePayment(f.db, f.office, { customerId: c, amountCents: 30_000, method: 'Cash' });
    const r = await reversePayment(f.db, f.admin, p.paymentIds[0], 'typed twice');
    const rows = await numbersOf([p.paymentIds[0], r.reversalId]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].receipt_number, rows[1].receipt_number);
  });

  test('a receipt shows the whole payment, whichever row is picked, and prints once per payment', async () => {
    const c = await customer();
    const a = await sale(c);
    const p = await receivePayment(f.db, f.office, {
      customerId: c, amountCents: a.grandTotalCents + 20_000, method: 'Cash',
      allocations: [{ invoiceId: a.invoiceId, amountCents: a.grandTotalCents }],
    });
    const one = await renderReceiptPdf(f.db, [p.paymentIds[1]]);
    assert.equal(one.totalCents, a.grandTotalCents + 20_000, 'both rows on the receipt');
    const [row] = await numbersOf([p.paymentIds[0]]);
    assert.equal(one.receiptNumber, row.receipt_number);
    const printed = await printReceipts(f.db, p.paymentIds);
    assert.equal(printed.filename, 'Receipts-1.pdf', 'one receipt for one payment');
  });

  test('the migration numbers payments recorded before it, one number per recording', async () => {
    const c = await customer();
    const a = await sale(c);
    const p = await receivePayment(f.db, f.office, {
      customerId: c, amountCents: a.grandTotalCents + 7_000, method: 'Cash',
      allocations: [{ invoiceId: a.invoiceId, amountCents: a.grandTotalCents }],
    });
    const lone = await receivePayment(f.db, f.office, { customerId: c, amountCents: 9_000, method: 'Cash' });
    const rev = await reversePayment(f.db, f.admin, lone.paymentIds[0], 'test');
    // As things stood before migration 024: no numbers, an old-style one on one row.
    await f.db.query(`UPDATE payments SET receipt_number = NULL WHERE customer_id = $1`, [c]);
    await f.db.query(`UPDATE payments SET receipt_number = 'RC-009999' WHERE id = $1`, [p.paymentIds[0]]);

    const sql = await readFile(new URL('../src/migrations/024_payment_numbers.sql', import.meta.url), 'utf8');
    await f.db.tx((t) => t.exec(sql));

    const both = await numbersOf(p.paymentIds);
    assert.deepEqual([...new Set(both.map((r) => r.receipt_number))], ['RCT-009999'], 'renamed and shared');
    const [l, r] = [(await numbersOf(lone.paymentIds))[0], (await numbersOf([rev.reversalId]))[0]];
    assert.match(l.receipt_number!, /^RCT-\d{6}$/);
    assert.notEqual(l.receipt_number, 'RCT-009999');
    assert.equal(r.receipt_number, l.receipt_number, 'the reversal takes its number');

    // And the next payment does not reuse a number already given.
    const after_ = await receivePayment(f.db, f.office, { customerId: c, amountCents: 1_000, method: 'Cash' });
    const [x] = await numbersOf(after_.paymentIds);
    const clash = await f.db.query(`SELECT 1 FROM payments WHERE receipt_number = $1 AND customer_id <> $2`, [x.receipt_number, c]);
    assert.equal(clash.length, 0);
    assert.notEqual(x.receipt_number, l.receipt_number);
    assert.ok(Number(x.receipt_number!.slice(4)) > 9999, 'the sequence moved past the highest number');
  });

  test('a reversed payment is not money on the account, and is never put against an invoice', async () => {
    const c = await customer();
    const p = await receivePayment(f.db, f.office, { customerId: c, amountCents: 20_000, method: 'Cash' });
    await reversePayment(f.db, f.admin, p.paymentIds[0], 'entered twice');
    const listed = await unappliedPayments(f.db, c);
    assert.equal(listed.length, 0, 'not listed as on account');
    // A new invoice must not take the reversed money: it stays owed in full.
    const s = await sale(c);
    const used = await f.db.query(`SELECT 1 FROM payments WHERE invoice_id = $1`, [s.invoiceId]);
    assert.equal(used.length, 0);
    await assert.rejects(applyToInvoice(f.db, f.office, { invoiceId: s.invoiceId }), /no money on their account/);
  });
});
