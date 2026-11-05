/**
 * The payment ⋯ menu (Everton, 4 Nov 2026): edit, move, reverse, delete.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { counterSale } from '../src/services/counter.ts';
import { receivePayment, getCustomerBalance } from '../src/services/payments.ts';
import { paymentFixInfo, requestPaymentFix } from '../src/services/paymentfix.ts';
import { reviewApproval } from '../src/services/approvals.ts';
import { listAuditLog } from '../src/services/auditlog.ts';

let f: Fixture;
before(async () => { f = await setupFixture(); });
after(async () => { await f.close(); });

const sale = async (customerId: string) =>
  (await counterSale(f.db, f.office, { customerId, lines: [{ productId: f.casedProductId, cases: 1 }] })).invoiceId;
const owes = async (invoiceId: string) =>
  Number((await f.db.one<{ b: string }>(`SELECT balance_cents::text AS b FROM invoice_ledger WHERE invoice_id = $1`, [invoiceId])).b);
const linesOf = (receipt: string) => f.db.query<{ customer_id: string; invoice_id: string | null; amount_cents: string }>(
  `SELECT customer_id, invoice_id, amount_cents::text AS amount_cents FROM payments
   WHERE receipt_number = $1 AND NOT is_reversal ORDER BY created_at, id`, [receipt]);
const receiptOf = async (id: string) =>
  (await f.db.one<{ r: string }>(`SELECT receipt_number AS r FROM payments WHERE id = $1`, [id])).r;

describe('payment ⋯ menu', () => {
  test('info covers the whole payment when it was spread over two invoices', async () => {
    const a = await sale(f.customerId);
    const b = await sale(f.customerId);
    const owedA = await owes(a);
    const owedB = await owes(b);
    const p = await receivePayment(f.db, f.office, {
      customerId: f.customerId, amountCents: owedA + owedB + 500, method: 'Cash',
      allocations: [{ invoiceId: a, amountCents: owedA }, { invoiceId: b, amountCents: owedB }],
    });
    const info = await paymentFixInfo(f.db, f.office, p.paymentIds[1]);
    assert.equal(info.lines.length, 3);
    assert.equal(info.totalCents, owedA + owedB + 500);
    assert.equal(info.settledRound, null);
  });

  test('admin deletes a payment: gone, invoices owe again, only the audit log keeps it', async () => {
    const inv = await sale(f.customerId);
    const owed = await owes(inv);
    const p = await receivePayment(f.db, f.office, {
      customerId: f.customerId, amountCents: owed, method: 'Cash', allocations: [{ invoiceId: inv, amountCents: owed }],
    });
    const rct = await receiptOf(p.paymentIds[0]);
    assert.equal(await owes(inv), 0);
    await assert.rejects(requestPaymentFix(f.db, f.admin, p.paymentIds[0], { action: 'delete' }, ''), /say why/);
    const r = await requestPaymentFix(f.db, f.admin, p.paymentIds[0], { action: 'delete' }, 'entered twice');
    assert.equal(r.applied, true);
    assert.equal((await linesOf(rct)).length, 0);
    assert.equal(await owes(inv), owed);
    const log = await f.db.one<{ details: { summary: string } }>(
      `SELECT details FROM audit_log WHERE action = 'delete' AND entity_type = 'Payment' ORDER BY ts DESC LIMIT 1`);
    assert.match(log.details.summary, new RegExp(`${rct}.*deleted`));
  });

  test('office asks to delete; nothing happens until an admin approves', async () => {
    const p = await receivePayment(f.db, f.office, { customerId: f.customerId, amountCents: 9_900, method: 'Cash' });
    const rct = await receiptOf(p.paymentIds[0]);
    const r = await requestPaymentFix(f.db, f.office, p.paymentIds[0], { action: 'delete' }, 'duplicate');
    assert.equal(r.applied, false);
    assert.equal((await linesOf(rct)).length, 1);
    assert.equal((await paymentFixInfo(f.db, f.office, p.paymentIds[0])).waiting, true);
    await assert.rejects(requestPaymentFix(f.db, f.office, p.paymentIds[0], { action: 'reverse' }, 'x'), /already waiting/);
    await reviewApproval(f.db, f.admin, r.approvalRequestId!, 'Approved');
    assert.equal((await linesOf(rct)).length, 0);
  });

  test('move with nothing picked: oldest open invoice first, rest as credit, same RCT, no notes added', async () => {
    const old1 = await sale(f.otherCustomerId);
    const old2 = await sale(f.otherCustomerId);
    const owed1 = await owes(old1);
    const owed2 = await owes(old2);
    const p = await receivePayment(f.db, f.office, { customerId: f.customerId, amountCents: owed1 + 1_000, method: 'Bank Transfer', reference: 'TT 55' });
    const rct = await receiptOf(p.paymentIds[0]);
    const beforeFrom = (await getCustomerBalance(f.db, f.customerId)).balanceCents;
    await requestPaymentFix(f.db, f.admin, p.paymentIds[0], { action: 'move', customerId: f.otherCustomerId });
    const lines = await linesOf(rct);
    assert.ok(lines.every((l) => l.customer_id === f.otherCustomerId));
    assert.equal(await owes(old1), 0);
    assert.equal(await owes(old2), owed2 - 1_000);
    assert.equal(lines.find((l) => l.invoice_id === old2)?.amount_cents, '1000');
    assert.equal((await getCustomerBalance(f.db, f.customerId)).balanceCents, beforeFrom + owed1 + 1_000);
    const notes = await f.db.query<{ notes: string | null }>(`SELECT notes FROM payments WHERE receipt_number = $1`, [rct]);
    assert.ok(notes.every((n) => !n.notes));
  });

  test('move to a picked invoice; what is over stays as credit', async () => {
    const x = await sale(f.otherCustomerId);
    const p = await receivePayment(f.db, f.office, { customerId: f.customerId, amountCents: 3_000, method: 'Cash' });
    const rct = await receiptOf(p.paymentIds[0]);
    await requestPaymentFix(f.db, f.admin, p.paymentIds[0], {
      action: 'move', customerId: f.otherCustomerId, allocations: [{ invoiceId: x, amountCents: 2_000 }],
    });
    const lines = await linesOf(rct);
    // Both lines keep the payment's created_at, so their order is not fixed: compare as a set.
    const got = lines.map((l) => [l.invoice_id, l.amount_cents]).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    assert.deepEqual(got, [[null, '1000'], [x, '2000']]);
  });

  test('a picked invoice of the wrong customer is refused', async () => {
    const mine = await sale(f.customerId);
    const p = await receivePayment(f.db, f.office, { customerId: f.customerId, amountCents: 3_000, method: 'Cash' });
    await assert.rejects(requestPaymentFix(f.db, f.admin, p.paymentIds[0], {
      action: 'move', customerId: f.otherCustomerId, allocations: [{ invoiceId: mine }],
    }), /different customer/);
  });

  test('edit the date, method and reference in place; the money stays where it is', async () => {
    const inv = await sale(f.customerId);
    const owed = await owes(inv);
    const p = await receivePayment(f.db, f.office, {
      customerId: f.customerId, amountCents: owed, method: 'Cash', allocations: [{ invoiceId: inv, amountCents: owed }],
    });
    await requestPaymentFix(f.db, f.admin, p.paymentIds[0], {
      action: 'edit', paymentDate: '2026-10-30', method: 'Cheque', reference: 'chq 12',
    });
    const row = await f.db.one<{ d: string; method: string; reference: string; invoice_id: string }>(
      `SELECT business_date(payment_date)::text AS d, method, reference, invoice_id FROM payments WHERE id = $1`, [p.paymentIds[0]]);
    assert.deepEqual([row.d, row.method, row.reference, row.invoice_id], ['2026-10-30', 'Cheque', 'chq 12', inv]);
    assert.equal(await owes(inv), 0);
  });

  test('edit a smaller amount comes off the newest invoice; a larger one goes where picked', async () => {
    const a = await sale(f.customerId);
    const b = await sale(f.customerId);
    const oa = await owes(a); const ob = await owes(b);
    const p = await receivePayment(f.db, f.office, {
      customerId: f.customerId, amountCents: oa + ob, method: 'Cash',
      allocations: [{ invoiceId: a, amountCents: oa }, { invoiceId: b, amountCents: ob }],
    });
    const rct = await receiptOf(p.paymentIds[0]);
    await requestPaymentFix(f.db, f.admin, p.paymentIds[0], { action: 'edit', amountCents: oa + 100 });
    assert.equal(await owes(a), 0);
    assert.equal(await owes(b), ob - 100);
    assert.equal((await linesOf(rct)).length, 2);
    await requestPaymentFix(f.db, f.admin, p.paymentIds[0], {
      action: 'edit', amountCents: oa + ob + 700,
      allocations: [{ invoiceId: a, amountCents: oa }, { invoiceId: b, amountCents: ob }],
    });
    assert.equal(await owes(b), 0);
    assert.deepEqual((await linesOf(rct)).map((l) => l.amount_cents).sort(), [String(oa), String(ob), '700'].sort());
    await assert.rejects(requestPaymentFix(f.db, f.admin, p.paymentIds[0], {
      action: 'edit', allocations: [{ invoiceId: a, amountCents: oa + 1 }],
    }), /only owes/);
  });

  test('reverse the whole payment: original and reversal both stay', async () => {
    const a = await sale(f.customerId);
    const oa = await owes(a);
    const p = await receivePayment(f.db, f.office, {
      customerId: f.customerId, amountCents: oa + 400, method: 'Cash', allocations: [{ invoiceId: a, amountCents: oa }],
    });
    const rct = await receiptOf(p.paymentIds[0]);
    await requestPaymentFix(f.db, f.admin, p.paymentIds[1], { action: 'reverse' }, 'bounced');
    const all = await f.db.query(`SELECT 1 FROM payments WHERE receipt_number = $1`, [rct]);
    assert.equal(all.length, 4);
    assert.equal(await owes(a), oa);
    await assert.rejects(paymentFixInfo(f.db, f.office, p.paymentIds[0]), /reversed/);
  });

  test('the audit log reads the sentence', async () => {
    const page = await listAuditLog(f.db, f.admin, { types: ['Payment'] } as never);
    const rows = (page as { rows: Array<{ summary?: string }> }).rows ?? [];
    assert.ok(rows.some((r) => /moved from Blue Mountain Offices to/.test(r.summary ?? '')));
  });
});
