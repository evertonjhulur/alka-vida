import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  drawFifo, blendedAverageCost, blendedAverageBySupplier, InsufficientStockError,
} from '../src/fifo.ts';

const batches = [
  { id: 'b1', unitCostCents: 1_000, quantityRemaining: 100, supplierId: 's1' },
  { id: 'b2', unitCostCents: 1_200, quantityRemaining: 100, supplierId: 's2' },
  { id: 'b3', unitCostCents: 1_500, quantityRemaining: 50, supplierId: 's1' },
];

describe('FIFO draw', () => {
  test('draws entirely from the oldest batch when it covers the need', () => {
    const r = drawFifo(batches, 40);
    assert.equal(r.slices.length, 1);
    assert.equal(r.slices[0].batchId, 'b1');
    assert.equal(r.totalCostCents, 40 * 1_000);
    assert.equal(r.effectiveUnitCostCents, 1_000);
  });

  test('spills into the next-oldest batch at its own different cost', () => {
    const r = drawFifo(batches, 150);
    assert.equal(r.slices.length, 2);
    assert.deepEqual(
      r.slices.map((s) => [s.batchId, s.quantity, s.unitCostCents]),
      [['b1', 100, 1_000], ['b2', 50, 1_200]],
    );
    // 100 @ 10.00 + 50 @ 12.00 = 1000.00 + 600.00
    assert.equal(r.totalCostCents, 100 * 1_000 + 50 * 1_200);
    assert.equal(r.totalQuantity, 150);
  });

  test('spans three batches when needed and reports a true blended draw cost', () => {
    const r = drawFifo(batches, 250);
    assert.equal(r.slices.length, 3);
    const expected = 100 * 1_000 + 100 * 1_200 + 50 * 1_500;
    assert.equal(r.totalCostCents, expected);
    assert.equal(r.effectiveUnitCostCents, Math.round(expected / 250));
  });

  test('draws the exact full quantity available', () => {
    const r = drawFifo(batches, 250);
    assert.equal(r.totalQuantity, 250);
  });

  test('refuses to draw more than is on hand', () => {
    assert.throws(() => drawFifo(batches, 251), InsufficientStockError);
  });

  test('skips exhausted batches', () => {
    const withEmpty = [
      { id: 'b0', unitCostCents: 500, quantityRemaining: 0, supplierId: 's1' },
      ...batches,
    ];
    const r = drawFifo(withEmpty, 10);
    assert.equal(r.slices[0].batchId, 'b1', 'an exhausted batch contributes nothing');
  });

  test('rejects a non-positive draw', () => {
    assert.throws(() => drawFifo(batches, 0), /must be positive/);
  });

  test('handles fractional quantities without float drift', () => {
    const r = drawFifo([{ id: 'x', unitCostCents: 333, quantityRemaining: 10 }], 0.1);
    assert.equal(r.totalQuantity, 0.1);
    assert.equal(r.slices[0].costCents, 33); // 0.1 * 333 = 33.3 -> 33
  });
});

describe('blended average cost (reporting only)', () => {
  test('weights by remaining quantity, not by batch count', () => {
    // (100*1000 + 100*1200 + 50*1500) / 250 = 295000/250 = 1180
    assert.equal(blendedAverageCost(batches), 1_180);
  });

  test('differs from the FIFO cost actually charged, and that is expected', () => {
    const drawn = drawFifo(batches, 150).effectiveUnitCostCents;
    assert.notEqual(drawn, blendedAverageCost(batches),
      'reporting average must not equal what production was charged');
  });

  test('is zero when nothing is in stock', () => {
    assert.equal(blendedAverageCost([]), 0);
    assert.equal(blendedAverageCost([{ id: 'a', unitCostCents: 900, quantityRemaining: 0 }]), 0);
  });

  test('breaks down per supplier', () => {
    const bySupplier = blendedAverageBySupplier(batches);
    const s1 = bySupplier.find((b) => b.supplierId === 's1');
    const s2 = bySupplier.find((b) => b.supplierId === 's2');
    // s1: (100*1000 + 50*1500)/150 = 175000/150 = 1166.67 -> 1167
    assert.equal(s1?.quantity, 150);
    assert.equal(s1?.averageUnitCostCents, 1_167);
    assert.equal(s2?.averageUnitCostCents, 1_200);
  });
});
