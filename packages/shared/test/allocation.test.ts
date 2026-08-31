import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planPayments, validateAllocation } from '../src/allocation.ts';

describe('planPayments - the single payment-creation mechanism (Step 4)', () => {
  test('a fully allocated payment produces exactly one payment per invoice', () => {
    const plan = planPayments(10_000, [
      { invoiceId: 'inv-a', amountCents: 6_000 },
      { invoiceId: 'inv-b', amountCents: 4_000 },
    ]);
    assert.deepEqual(plan, [
      { invoiceId: 'inv-a', amountCents: 6_000 },
      { invoiceId: 'inv-b', amountCents: 4_000 },
    ]);
  });

  test('an unallocated remainder becomes exactly ONE unattached payment', () => {
    const plan = planPayments(10_000, [{ invoiceId: 'inv-a', amountCents: 6_000 }]);
    assert.equal(plan.length, 2, 'one attached, one unattached - never more');
    assert.deepEqual(plan[1], { invoiceId: null, amountCents: 4_000 });
  });

  test('overpayment yields one attached and one unattached payment, no duplicate', () => {
    // Invoice is 8000; driver collected 10000 and allocated the invoice in full.
    const plan = planPayments(10_000, [{ invoiceId: 'inv-a', amountCents: 8_000 }]);
    assert.equal(plan.length, 2);
    assert.equal(plan.filter((p) => p.invoiceId === null).length, 1,
      'exactly one unattached payment - the prior build created a second, phantom one');
    const total = plan.reduce((s, p) => s + p.amountCents, 0);
    assert.equal(total, 10_000, 'created payments must sum to exactly the cash collected');
  });

  test('nothing allocated at all still produces a single unattached payment', () => {
    const plan = planPayments(5_000, []);
    assert.deepEqual(plan, [{ invoiceId: null, amountCents: 5_000 }]);
  });

  test('created payments never exceed the cash collected, even if over-allocated', () => {
    const plan = planPayments(5_000, [
      { invoiceId: 'inv-a', amountCents: 4_000 },
      { invoiceId: 'inv-b', amountCents: 4_000 },
    ]);
    const total = plan.reduce((s, p) => s + p.amountCents, 0);
    assert.equal(total, 5_000, 'capped cumulatively at the collected amount');
    assert.deepEqual(plan, [
      { invoiceId: 'inv-a', amountCents: 4_000 },
      { invoiceId: 'inv-b', amountCents: 1_000 },
    ]);
  });

  test('zero cash collected creates no payments at all', () => {
    assert.deepEqual(planPayments(0, [{ invoiceId: 'inv-a', amountCents: 1_000 }]), []);
  });

  test('zero-value allocations are skipped rather than creating empty payments', () => {
    const plan = planPayments(3_000, [
      { invoiceId: 'inv-a', amountCents: 0 },
      { invoiceId: 'inv-b', amountCents: 3_000 },
    ]);
    assert.deepEqual(plan, [{ invoiceId: 'inv-b', amountCents: 3_000 }]);
  });

  test('the plan always sums to the collected amount exactly', () => {
    for (const [collected, alloc] of [
      [10_000, 3_000], [10_000, 10_000], [1, 0], [99_999, 50_000],
    ] as const) {
      const plan = planPayments(collected, [{ invoiceId: 'x', amountCents: alloc }]);
      assert.equal(plan.reduce((s, p) => s + p.amountCents, 0), collected);
    }
  });
});

describe('validateAllocation - scoped narrowly to the allocation inputs', () => {
  test('accepts an allocation within the collected amount', () => {
    assert.deepEqual(
      validateAllocation(10_000, [{ invoiceId: 'a', amountCents: 10_000 }]),
      { ok: true },
    );
  });

  test('rejects an allocation exceeding the collected amount', () => {
    const r = validateAllocation(10_000, [{ invoiceId: 'a', amountCents: 10_001 }]);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /exceeds/);
  });

  test('rejects the same invoice twice', () => {
    const r = validateAllocation(10_000, [
      { invoiceId: 'a', amountCents: 100 },
      { invoiceId: 'a', amountCents: 200 },
    ]);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /twice/);
  });

  test('rejects negative allocations', () => {
    const r = validateAllocation(10_000, [{ invoiceId: 'a', amountCents: -5 }]);
    assert.equal(r.ok, false);
  });
});
