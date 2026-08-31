/**
 * FIFO raw-material costing (Section 2, MaterialBatch).
 *
 * Costing is FIFO, NOT weighted-average. Each received PO line is its own
 * batch with its own cost. Consumption draws from the oldest open batch
 * first and spills into the next-oldest when one batch cannot cover the
 * whole requirement - so a single production run can legitimately draw the
 * same material at two different costs.
 *
 * The blended average below is a REPORTING figure only. It is computed from
 * what is still in stock and never determines what production is charged.
 */

import type { Cents } from './money.ts';
import { roundCents } from './money.ts';

export interface Batch {
  id: string;
  unitCostCents: Cents;
  quantityRemaining: number;
  /** Tie-breaker ordering is applied by the caller (received_date, id). */
  supplierId?: string | null;
}

export interface DrawSlice {
  batchId: string;
  quantity: number;
  unitCostCents: Cents;
  /** quantity * unitCost, rounded to the cent. */
  costCents: Cents;
}

export interface DrawResult {
  slices: DrawSlice[];
  totalQuantity: number;
  totalCostCents: Cents;
  /** Weighted average actually paid for THIS draw. */
  effectiveUnitCostCents: Cents;
}

export class InsufficientStockError extends Error {
  requested: number;
  available: number;
  constructor(requested: number, available: number) {
    super(`insufficient stock: needed ${requested}, only ${available} available across open batches`);
    this.name = 'InsufficientStockError';
    this.requested = requested;
    this.available = available;
  }
}

/**
 * Draw `quantity` from `batches`, which MUST already be ordered oldest-first.
 *
 * Returns the per-batch slices so the caller can decrement each batch and
 * record the true drawn cost plus the contributing batch ids on the
 * InventoryTransaction.
 */
export function drawFifo(batches: readonly Batch[], quantity: number): DrawResult {
  if (!(quantity > 0)) throw new Error(`draw quantity must be positive, got ${quantity}`);

  const available = batches.reduce((s, b) => s + b.quantityRemaining, 0);
  if (available < quantity - 1e-9) throw new InsufficientStockError(quantity, available);

  const slices: DrawSlice[] = [];
  let outstanding = quantity;

  for (const batch of batches) {
    if (outstanding <= 1e-9) break;
    if (batch.quantityRemaining <= 0) continue;
    const take = Math.min(batch.quantityRemaining, outstanding);
    slices.push({
      batchId: batch.id,
      quantity: round3(take),
      unitCostCents: batch.unitCostCents,
      costCents: roundCents(take * batch.unitCostCents),
    });
    outstanding = round3(outstanding - take);
  }

  const totalCostCents = slices.reduce((s, x) => s + x.costCents, 0);
  const totalQuantity = round3(slices.reduce((s, x) => s + x.quantity, 0));
  return {
    slices,
    totalQuantity,
    totalCostCents,
    effectiveUnitCostCents: totalQuantity > 0 ? roundCents(totalCostCents / totalQuantity) : 0,
  };
}

/**
 * Blended average cost across everything currently in stock, weighted by
 * remaining quantity. REPORTING ONLY (Section 9).
 */
export function blendedAverageCost(batches: readonly Batch[]): Cents {
  const qty = batches.reduce((s, b) => s + b.quantityRemaining, 0);
  if (qty <= 0) return 0;
  const value = batches.reduce((s, b) => s + b.quantityRemaining * b.unitCostCents, 0);
  return roundCents(value / qty);
}

/** Same blended average, broken down per supplier. REPORTING ONLY. */
export function blendedAverageBySupplier(
  batches: readonly Batch[],
): Array<{ supplierId: string | null; quantity: number; averageUnitCostCents: Cents }> {
  const groups = new Map<string | null, Batch[]>();
  for (const b of batches) {
    const key = b.supplierId ?? null;
    const list = groups.get(key);
    if (list) list.push(b);
    else groups.set(key, [b]);
  }
  return [...groups.entries()].map(([supplierId, list]) => ({
    supplierId,
    quantity: round3(list.reduce((s, b) => s + b.quantityRemaining, 0)),
    averageUnitCostCents: blendedAverageCost(list),
  }));
}

/** Quantities are numeric(14,3) in the database; keep JS arithmetic aligned. */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
