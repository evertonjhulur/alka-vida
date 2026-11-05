/**
 * One bank transfer across several customers' invoices (4 Nov 2026).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { counterSale } from '../src/services/counter.ts';
import { getCustomerBalance } from '../src/services/payments.ts';
import { splitTransfer } from '../src/services/splittransfer.ts';

let f: Fixture;
before(async () => { f = await setupFixture(); });
after(async () => { await f.close(); });

const sale = async (customerId: string) =>
  (await counterSale(f.db, f.office, { customerId, lines: [{ productId: f.casedProductId, cases: 1 }] })).invoiceId;
const owes = async (id: string) =>
  Number((await f.db.one<{ b: string }>(`SELECT balance_cents::text AS b FROM invoice_ledger WHERE invoice_id = $1`, [id])).b);
const balance = async (c: string) => (await getCustomerBalance(f.db, c)).balanceCents;

describe('split a bank transfer across customers', () => {
  test('two customers paid from one transfer: one payment and RCT number each, same reference', async () => {
    const a = await sale(f.customerId);
    const b = await sale(f.otherCustomerId);
    const owedA = await owes(a); const owedB = await owes(b);
    const r = await splitTransfer(f.db, f.office, {
      amountCents: owedA + owedB, reference: 'RTGS 555',
      allocations: [{ invoiceId: a, amountCents: owedA }, { invoiceId: b, amountCents: owedB }],
    });
    assert.equal(r.parts.length, 2);
    assert.equal(await owes(a), 0);
    assert.equal(await owes(b), 0);
    assert.notEqual(r.parts[0].receiptNumber, r.parts[1].receiptNumber);
    const refs = await f.db.query<{ reference: string }>(
      `SELECT DISTINCT reference FROM payments WHERE id = ANY($1::uuid[])`, [r.parts.flatMap((p) => p.paymentIds)]);
    assert.deepEqual(refs.map((x) => x.reference), ['RTGS 555']);
  });

  test('the rest stays as credit on the customer picked', async () => {
    const a = await sale(f.customerId);
    const owedA = await owes(a);
    const before = await balance(f.otherCustomerId);
    const r = await splitTransfer(f.db, f.office, {
      amountCents: owedA + 2_500, allocations: [{ invoiceId: a, amountCents: owedA }],
      leftoverCustomerId: f.otherCustomerId,
    });
    assert.equal(r.leftoverCents, 2_500);
    assert.equal(await owes(a), 0);
    assert.equal(await balance(f.otherCustomerId), before - 2_500, 'credit on the other customer');
  });

  test('refused, and nothing recorded: leftover with nobody to keep it, too much on an invoice, more than received', async () => {
    const a = await sale(f.customerId);
    const owedA = await owes(a);
    await assert.rejects(splitTransfer(f.db, f.office, { amountCents: owedA + 100, allocations: [{ invoiceId: a, amountCents: owedA }] }), /choose the customer/);
    await assert.rejects(splitTransfer(f.db, f.office, { amountCents: owedA + 100, allocations: [{ invoiceId: a, amountCents: owedA + 100 }] }), /only has/);
    await assert.rejects(splitTransfer(f.db, f.office, { amountCents: 100, allocations: [{ invoiceId: a, amountCents: owedA }] }), /more than/);
    assert.equal(await owes(a), owedA);
  });

  test('a second press with the same key records nothing more', async () => {
    const a = await sale(f.customerId);
    const owedA = await owes(a);
    const args = { amountCents: owedA, allocations: [{ invoiceId: a, amountCents: owedA }], idempotencyKey: 'split-test-1' };
    await splitTransfer(f.db, f.office, args);
    const again = await splitTransfer(f.db, f.office, args);
    assert.equal(again.replayed, true);
    const n = await f.db.one<{ n: string }>(`SELECT count(*)::text AS n FROM payments WHERE invoice_id = $1`, [a]);
    assert.equal(n.n, '1');
  });
});
