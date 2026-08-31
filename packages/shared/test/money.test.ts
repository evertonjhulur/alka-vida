import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeTotals, computeLineTotal, assertQuantityShape, totalBottles,
  parseAmount, formatAmount, roundCents, GCT_RATE,
} from '../src/money.ts';

describe('GCT calculation (Section 3, Step 5)', () => {
  test('GCT is charged on the POST-discount subtotal, not the pre-discount one', () => {
    // $100.00 subtotal, 10% discount.
    const t = computeTotals([{ lineTotal: 10_000 }], 10);
    assert.equal(t.subtotal, 10_000);
    assert.equal(t.discountAmount, 1_000);
    // 15% of 9000 = 1350.  Taxing the pre-discount 10000 would give 1500.
    assert.equal(t.gct, 1_350);
    assert.equal(t.grandTotal, 10_350);
    assert.notEqual(t.grandTotal, 10_500, 'must not tax the pre-discount subtotal');
  });

  test('zero discount still applies GCT to the full subtotal', () => {
    const t = computeTotals([{ lineTotal: 20_000 }], 0);
    assert.deepEqual(t, { subtotal: 20_000, discountAmount: 0, gct: 3_000, grandTotal: 23_000 });
  });

  test('a 100% discount produces a zero grand total, not negative tax', () => {
    const t = computeTotals([{ lineTotal: 5_000 }], 100);
    assert.deepEqual(t, { subtotal: 5_000, discountAmount: 5_000, gct: 0, grandTotal: 0 });
  });

  test('subtotal is the sum of all line totals', () => {
    const t = computeTotals([{ lineTotal: 1_234 }, { lineTotal: 5_66 }, { lineTotal: 100 }]);
    assert.equal(t.subtotal, 1_234 + 566 + 100);
  });

  test('quotations pass applyGct=false and carry no tax', () => {
    const t = computeTotals([{ lineTotal: 10_000 }], 10, false);
    assert.equal(t.gct, 0);
    assert.equal(t.grandTotal, 9_000, 'quotation total is simply subtotal less discount');
  });

  test('rounding lands on whole cents and grand total stays internally consistent', () => {
    // 333 cents, 33% discount -> 109.89 -> 110 cents discount; net 223; gct 33.45 -> 33
    const t = computeTotals([{ lineTotal: 333 }], 33);
    assert.equal(t.discountAmount, 110);
    assert.equal(t.gct, 33);
    assert.equal(t.grandTotal, 333 - 110 + 33);
    assert.ok(Number.isInteger(t.gct) && Number.isInteger(t.grandTotal));
  });

  test('rejects an out-of-range discount percent', () => {
    assert.throws(() => computeTotals([{ lineTotal: 100 }], 101), /0-100/);
    assert.throws(() => computeTotals([{ lineTotal: 100 }], -1), /0-100/);
  });

  test('rejects a non-integer line total, so no float money can enter', () => {
    assert.throws(() => computeTotals([{ lineTotal: 10.5 }]), /integer number of cents/);
  });

  test('GCT rate is 15%', () => assert.equal(GCT_RATE, 0.15));
});

describe('case-vs-bottle input rule', () => {
  test('a cased product accepts whole cases and rejects loose bottles', () => {
    assert.doesNotThrow(() => assertQuantityShape(24, 5, 0));
    assert.throws(() => assertQuantityShape(24, 5, 3), /loose bottles cannot be sold/);
  });

  test('the 5-gallon product accepts bottles and rejects cases', () => {
    assert.doesNotThrow(() => assertQuantityShape(0, 0, 7));
    assert.throws(() => assertQuantityShape(0, 2, 7), /never by the case/);
  });

  test('line total uses per-case price for cased goods', () => {
    const total = computeLineTotal({
      bottlesPerCase: 24, cases: 5, looseBottles: 0,
      pricePerCase: 120_000, pricePerBottle: 5_000,
    });
    assert.equal(total, 600_000);
  });

  test('line total uses per-bottle price for the 5-gallon product', () => {
    const total = computeLineTotal({
      bottlesPerCase: 0, cases: 0, looseBottles: 7,
      pricePerCase: 0, pricePerBottle: 45_000,
    });
    assert.equal(total, 315_000);
  });

  test('total bottles expands cases, and passes through for 5-gallon', () => {
    assert.equal(totalBottles(24, 5, 0), 120);
    assert.equal(totalBottles(0, 0, 7), 7);
  });

  test('rejects fractional or negative quantities', () => {
    assert.throws(() => assertQuantityShape(24, 1.5, 0), /non-negative integer/);
    assert.throws(() => assertQuantityShape(24, -1, 0), /non-negative integer/);
  });
});

describe('amount parsing and formatting', () => {
  test('parses human input with separators into cents', () => {
    assert.equal(parseAmount('1,234.50'), 123_450);
    assert.equal(parseAmount('0.05'), 5);
    assert.equal(parseAmount(99.99), 9_999);
  });

  test('formats cents back to two decimal places', () => {
    assert.equal(formatAmount(123_450), '1,234.50');
    assert.equal(formatAmount(5), '0.05');
    assert.equal(formatAmount(-2_500), '-25.00');
  });

  test('rounds half away from zero symmetrically', () => {
    assert.equal(roundCents(2.5), 3);
    assert.equal(roundCents(-2.5), -3);
  });
});
