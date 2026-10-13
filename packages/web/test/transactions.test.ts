/**
 * The customer's Transactions list (12 Oct 2026): invoices, payments and
 * credit notes in one list with the running balance the statement shows.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildTransactions, closingBalance, type TxInvoice, type TxPayment } from '../src/lib/transactions.ts';

const inv = (n: string, d: string, total: number, balance: number, extra: Partial<TxInvoice> = {}): TxInvoice => ({
  invoice_id: n, invoice_number: n, invoice_date: d, due_date: null, status: 'Open',
  grand_total_cents: total, balance_cents: balance, is_credit_note: false, ...extra,
});
const pay = (id: string, d: string, amount: number, extra: Partial<TxPayment> = {}): TxPayment => ({
  id, payment_date: d, amount_cents: amount, method: 'Cash', reference: null, receipt_number: null,
  invoice_id: null, invoice_number: null, is_reversal: false, reversed: false, ...extra,
});

describe('Transactions list', () => {
  test('one payment over several invoices is one line with one number', () => {
    const txs = buildTransactions(
      [inv('INV-1', '2026-10-06', 3795, 0), inv('INV-2', '2026-10-06', 1725, 0)],
      [pay('a', '2026-10-07', 3795, { receipt_number: 'RCT-001005', invoice_id: 'INV-1', invoice_number: 'INV-1' }),
       pay('b', '2026-10-07', 1725, { receipt_number: 'RCT-001005', invoice_id: 'INV-2', invoice_number: 'INV-2' }),
       pay('c', '2026-10-07', 500, { receipt_number: 'RCT-001005' })],
    );
    const p = txs.filter((t) => t.kind === 'payment');
    assert.equal(p.length, 1);
    assert.equal(p[0].number, 'RCT-001005');
    assert.equal(p[0].amountCents, 6020);
    assert.equal(p[0].openCents, 500, 'the part left on the account');
    assert.deepEqual(p[0].invoiceNumbers, ['INV-1', 'INV-2']);
  });

  test('the running balance matches the statement, oldest first', () => {
    const txs = buildTransactions(
      [inv('INV-1', '2026-10-06', 10_000, 4_000), inv('CN-2', '2026-10-06', -575, -575, { is_credit_note: true, status: 'Credit Note' }),
       inv('INV-3', '2026-10-09', 57_500, 57_500)],
      [pay('a', '2026-10-01', 6_000, { receipt_number: 'RCT-1', invoice_id: 'INV-1', invoice_number: 'INV-1' })],
    );
    assert.deepEqual(txs.map((t) => [t.number, t.balanceCents]), [
      ['RCT-1', -6_000], ['INV-1', 4_000], ['CN-2', 3_425], ['INV-3', 60_925],
    ]);
    assert.equal(closingBalance(txs), 60_925);
  });

  test('a cancelled invoice and a credit note waiting for approval are listed but do not count', () => {
    const txs = buildTransactions(
      [inv('INV-1', '2026-10-06', 1_000, 1_000), inv('INV-2', '2026-10-06', 2_000, 2_000, { status: 'Cancelled', lifecycle: 'Cancelled' }),
       inv('CN-3', '2026-10-07', 0, 0, { is_credit_note: true, credit_status: 'Pending' })],
      [],
    );
    assert.equal(txs.length, 3);
    assert.equal(closingBalance(txs), 1_000);
    assert.equal(txs.find((t) => t.number === 'INV-2')!.balanceCents, null);
    assert.equal(txs.find((t) => t.number === 'INV-2')!.openCents, 0);
  });

  test('a reversal is its own line and adds back what the payment took off', () => {
    const txs = buildTransactions(
      [inv('INV-1', '2026-10-06', 1_000, 1_000)],
      [pay('a', '2026-10-06', 1_000, { receipt_number: 'RCT-7', reversed: true }),
       pay('r', '2026-10-08', -1_000, { receipt_number: 'RCT-7', is_reversal: true })],
    );
    const p = txs.find((t) => t.kind === 'payment')!;
    const r = txs.find((t) => t.kind === 'reversal')!;
    assert.equal(p.reversed, 'all');
    assert.equal(p.openCents, 0, 'nothing left on account from a reversed payment');
    assert.equal(r.effectCents, 1_000);
    assert.equal(r.amountCents, 1_000);
    assert.equal(closingBalance(txs), 1_000);
  });
});
