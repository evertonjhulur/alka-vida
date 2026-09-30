/** Money already on a customer's account, put against one of their invoices. */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { counterSale } from '../src/services/counter.ts';
import {
  receivePayment, unappliedPayments, applyToInvoice, getCustomerBalance,
} from '../src/services/payments.ts';

let f: Fixture;
before(async () => { f = await setupFixture(); });
after(async () => { await f.close(); });

async function unpaidInvoice(customerId: string) {
  const sale = await counterSale(f.db, f.office, {
    customerId, lines: [{ productId: f.casedProductId, cases: 1 }], amountPaidCents: 0,
  });
  return f.db.one<{ invoice_id: string; balance_cents: number }>(
    `SELECT invoice_id, balance_cents FROM invoice_ledger WHERE invoice_number = $1`,
    [sale.invoiceNumber],
  );
}

describe('Applying money on account to an invoice', () => {
  test('a larger payment is split: the invoice is cleared, the rest stays unattached', async () => {
    const inv = await unpaidInvoice(f.customerId);
    const owed = Number(inv.balance_cents);
    const before = await getCustomerBalance(f.db, f.customerId);
    await receivePayment(f.db, f.office, {
      customerId: f.customerId, amountCents: owed + 5_000, method: 'Bank Transfer', reference: 'LUMP-1',
    });

    const out = await applyToInvoice(f.db, f.office, { invoiceId: inv.invoice_id });
    assert.equal(out.appliedCents, owed);

    const after = await f.db.one<{ balance_cents: number; status: string }>(
      `SELECT balance_cents, status FROM invoice_ledger WHERE invoice_id = $1`, [inv.invoice_id]);
    assert.equal(Number(after.balance_cents), 0);
    assert.equal(after.status, 'Paid');

    const left = (await unappliedPayments(f.db, f.customerId)).filter((p) => p.reference === 'LUMP-1');
    assert.equal(left.length, 1);
    assert.equal(Number(left[0].amount_cents), 5_000, 'the remainder is still on account');

    // The running balance only moved by the payment itself, never by applying it.
    const balance = await getCustomerBalance(f.db, f.customerId);
    assert.equal(num(balance) , num(before) - (owed + 5_000));
  });

  test('never more than the invoice owes, and a named payment of another customer is refused', async () => {
    const inv = await unpaidInvoice(f.otherCustomerId);
    await receivePayment(f.db, f.office, {
      customerId: f.customerId, amountCents: 1_000, method: 'Cash', reference: 'MINE',
    });
    const mine = (await unappliedPayments(f.db, f.customerId)).find((p) => p.reference === 'MINE')!;
    await assert.rejects(
      applyToInvoice(f.db, f.office, { invoiceId: inv.invoice_id, paymentId: mine.id }),
      /another customer|already against/,
    );
    await assert.rejects(
      applyToInvoice(f.db, f.driver, { invoiceId: inv.invoice_id }),
    );
  });

  test('a paid invoice cannot take more', async () => {
    const inv = await unpaidInvoice(f.customerId);
    await receivePayment(f.db, f.office, {
      customerId: f.customerId, amountCents: Number(inv.balance_cents), method: 'Cash',
      allocations: [{ invoiceId: inv.invoice_id, amountCents: Number(inv.balance_cents) }],
    });
    await assert.rejects(applyToInvoice(f.db, f.office, { invoiceId: inv.invoice_id }), /already paid/);
  });
});

function num(b: unknown): number {
  if (typeof b === 'number') return b;
  const o = b as { balanceCents?: number; balance_cents?: number };
  return Number(o.balanceCents ?? o.balance_cents ?? b);
}
