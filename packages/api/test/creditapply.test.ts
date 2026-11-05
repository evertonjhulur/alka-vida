/**
 * Applying credit notes to invoices (Everton, 4 Nov 2026; migration 039).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { counterSale } from '../src/services/counter.ts';
import { createCreditNote, getInvoiceDetail } from '../src/services/invoices.ts';
import { getCustomerBalance } from '../src/services/payments.ts';
import { reviewApproval } from '../src/services/approvals.ts';
import { applyCredit, unapplyCredit, unusedCredit } from '../src/services/creditapply.ts';

let f: Fixture;
before(async () => { f = await setupFixture(); });
after(async () => { await f.close(); });

const sale = async (customerId = f.customerId) =>
  (await counterSale(f.db, f.office, { customerId, lines: [{ productId: f.casedProductId, cases: 1 }] })).invoiceId;
const row = (id: string) => f.db.one<{ b: string; status: string }>(
  `SELECT balance_cents::text AS b, status FROM invoice_ledger WHERE invoice_id = $1`, [id]);
const owes = async (id: string) => Number((await row(id)).b);
const balance = async (c = f.customerId) => (await getCustomerBalance(f.db, c)).balanceCents;

describe('credit notes applied to invoices', () => {
  test("an admin's credit note against an invoice settles it at once; the account balance moves once", async () => {
    const inv = await sale();
    const owed = await owes(inv);
    const before = await balance();
    const cn = await createCreditNote(f.db, f.admin, { invoiceId: inv, amountCents: owed, reason: 'damaged' });
    assert.equal(await owes(inv), 0);
    assert.equal((await row(inv)).status, 'Paid');
    assert.equal(await owes(cn.id), 0, 'all of the credit used');
    assert.equal(await balance(), before - owed, 'balance falls by the credit, not twice');
  });

  test("office staff's credit note applies when it is approved, not before", async () => {
    const inv = await sale();
    const owed = await owes(inv);
    const cn = await createCreditNote(f.db, f.office, { invoiceId: inv, amountCents: 1_000, reason: 'short one' });
    assert.equal(await owes(inv), owed, 'waiting: nothing applied');
    await reviewApproval(f.db, f.admin, cn.approvalRequestId!, 'Approved');
    assert.equal(await owes(inv), owed - 1_000);
    assert.equal((await row(inv)).status, 'Partial');
  });

  test('credit bigger than the invoice: the rest stays unused and can go on another invoice', async () => {
    const a = await sale();
    const b = await sale();
    const owedA = await owes(a);
    const owedB = await owes(b);
    const cn = await createCreditNote(f.db, f.admin, { invoiceId: a, amountCents: owedA + 500, reason: 'goodwill' });
    assert.equal(await owes(a), 0);
    assert.equal(await owes(cn.id), -500, '500 unused');
    const r = await applyCredit(f.db, f.office, { invoiceId: b, creditNoteId: cn.id });
    assert.equal(r.appliedCents, 500);
    assert.equal(await owes(b), owedB - 500);
    assert.equal(await owes(cn.id), 0);
    await assert.rejects(applyCredit(f.db, f.office, { invoiceId: b, creditNoteId: cn.id }), /no credit left/);
  });

  test('credit on the account only is applied from the invoice, oldest first; an admin can take it back', async () => {
    const inv = await sale(f.otherCustomerId);
    const owed = await owes(inv);
    const before = await balance(f.otherCustomerId);
    await createCreditNote(f.db, f.admin, { customerId: f.otherCustomerId, amountCents: 700, reason: 'promo' });
    assert.equal(await owes(inv), owed, 'not against an invoice: not applied by itself');
    assert.equal((await unusedCredit(f.db, f.otherCustomerId)).length, 1);
    await applyCredit(f.db, f.office, { invoiceId: inv });
    assert.equal(await owes(inv), owed - 700);
    assert.equal(await balance(f.otherCustomerId), before - 700, 'applying moves no money');
    const detail = await getInvoiceDetail(f.db, inv);
    assert.equal(detail!.creditApplied.length, 1);
    await assert.rejects(unapplyCredit(f.db, f.office, detail!.creditApplied[0].id), /admin|not allowed|permission/i);
    await unapplyCredit(f.db, f.admin, detail!.creditApplied[0].id);
    assert.equal(await owes(inv), owed);
  });

  test("another customer's credit note is refused", async () => {
    const inv = await sale(f.otherCustomerId);
    const cn = await createCreditNote(f.db, f.admin, { customerId: f.customerId, amountCents: 300, reason: 'x' });
    await assert.rejects(applyCredit(f.db, f.office, { invoiceId: inv, creditNoteId: cn.id }), /different customer/);
  });
});
