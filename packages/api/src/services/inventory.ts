/**
 * Purchasing, receiving, FIFO consumption and production (Section 2).
 *
 * Receiving a PO line creates a MaterialBatch carrying that line's own cost.
 * Production draws from the oldest open batch first, spilling into the next
 * when one batch cannot cover the requirement, and records the TRUE drawn
 * cost plus the contributing batch ids on the InventoryTransaction.
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, businessToday, nextNumber, requireRole, num } from './core.ts';
import type { Cents } from '@alka/shared';
import {
  drawFifo, blendedAverageCost, blendedAverageBySupplier, RuleViolation, type Batch, GCT_RATE,
} from '@alka/shared';

/**
 * Resolve a supplier's price for a material at a given quantity.
 *
 * Best-matching volume tier (highest min_qty at or below the quantity), else
 * the supplier's standard cost. The result is written onto the PO line and
 * frozen there - later supplier price changes never rewrite an issued PO.
 */
export async function lookupSupplierPrice(
  t: Queryable,
  supplierId: string,
  rawMaterialId: string,
  quantity: number,
): Promise<Cents> {
  const brk = await t.maybeOne<{ unit_cost_cents: number }>(
    `SELECT unit_cost_cents FROM supplier_price_breaks
     WHERE supplier_id = $1 AND raw_material_id = $2 AND min_qty <= $3
     ORDER BY min_qty DESC LIMIT 1`,
    [supplierId, rawMaterialId, quantity],
  );
  if (brk) return num(brk.unit_cost_cents);

  const std = await t.maybeOne<{ unit_cost_cents: number }>(
    `SELECT unit_cost_cents FROM supplier_materials
     WHERE supplier_id = $1 AND raw_material_id = $2`,
    [supplierId, rawMaterialId],
  );
  if (std) return num(std.unit_cost_cents);

  const mat = await t.maybeOne<{ unit_cost_cents: number }>(
    `SELECT unit_cost_cents FROM raw_materials WHERE id = $1`, [rawMaterialId],
  );
  return num(mat?.unit_cost_cents);
}

export interface PoLineInput {
  rawMaterialId: string;
  quantityOrdered: number;
  unitCostCents?: Cents;
  /** Overrides the supplier-product tag for this one line. */
  gctExempt?: boolean;
  envExempt?: boolean;
}

/** The Environmental Levy rate as a fraction (0.375% unless changed). */
export async function envTaxRate(t: Queryable): Promise<number> {
  const row = await t.maybeOne<{ value: string }>(
    `SELECT value FROM system_settings WHERE key = 'env_tax_rate_percent'`,
  );
  const pct = Number(row?.value ?? 0.375);
  return Number.isFinite(pct) && pct >= 0 ? pct / 100 : 0.00375;
}

/**
 * Price and tax the lines of a PO.
 *
 * GCT (15%) and the Environmental Levy (0.375%) are worked out PER LINE, from
 * how the product is tagged for that supplier (Everton, 30 Sep 2026): a line
 * tagged GCT-exempt carries no GCT, one tagged Env-exempt no levy. Each is
 * worked out on the line's own amount, then summed.
 */
async function pricePoLines(t: Queryable, supplierId: string, lines: readonly PoLineInput[]) {
  if (lines.length === 0) throw new RuleViolation('a purchase order needs at least one line');
  const env = await envTaxRate(t);
  const out = [];
  for (const l of lines) {
    const qty = Number(l.quantityOrdered);
    if (!(qty > 0)) throw new RuleViolation('each line needs a quantity above zero');
    const tag = await t.maybeOne<{ gct_exempt: boolean; env_exempt: boolean }>(
      `SELECT gct_exempt, env_exempt FROM supplier_materials
       WHERE supplier_id = $1 AND raw_material_id = $2`, [supplierId, l.rawMaterialId],
    );
    const unitCost = l.unitCostCents != null && l.unitCostCents !== ('' as unknown)
      ? Math.round(Number(l.unitCostCents))
      : await lookupSupplierPrice(t, supplierId, l.rawMaterialId, qty);
    if (!(unitCost >= 0)) throw new RuleViolation('a unit cost cannot be negative');
    const gctExempt = l.gctExempt ?? tag?.gct_exempt ?? false;
    const envExempt = l.envExempt ?? tag?.env_exempt ?? false;
    const lineTotal = Math.round(unitCost * qty);
    out.push({
      rawMaterialId: l.rawMaterialId, qty, unitCost, gctExempt, envExempt, lineTotal,
      gct: gctExempt ? 0 : Math.round(lineTotal * GCT_RATE),
      envTax: envExempt ? 0 : Math.round(lineTotal * env),
    });
  }
  return out;
}

async function writePoLines(t: Queryable, poId: string, priced: Awaited<ReturnType<typeof pricePoLines>>) {
  let subtotal = 0; let gct = 0; let envTax = 0;
  for (const l of priced) {
    await t.query(
      `INSERT INTO po_line_items
         (po_id, raw_material_id, quantity_ordered, unit_cost_cents,
          gct_exempt, env_exempt, line_total_cents, gct_cents, env_tax_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [poId, l.rawMaterialId, l.qty, l.unitCost, l.gctExempt, l.envExempt,
       l.lineTotal, l.gct, l.envTax],
    );
    subtotal += l.lineTotal; gct += l.gct; envTax += l.envTax;
  }
  await t.query(
    `UPDATE purchase_orders
     SET subtotal_cents = $2, gct_cents = $3, env_tax_cents = $4, grand_total_cents = $5,
         updated_at = now()
     WHERE id = $1`,
    [poId, subtotal, gct, envTax, subtotal + gct + envTax],
  );
  return { subtotal, gct, envTax, grandTotal: subtotal + gct + envTax };
}

export async function createPurchaseOrder(
  db: Db,
  actor: Actor,
  input: {
    supplierId: string;
    lines: PoLineInput[];
    expectedDeliveryDate?: string | null;
    notes?: string | null;
  },
): Promise<{ id: string; poNumber: string; subtotalCents: Cents; gctCents: Cents;
             envTaxCents: Cents; grandTotalCents: Cents }> {
  requireRole(actor, 'admin', 'user');
  if (!input.lines || input.lines.length === 0) {
    throw new RuleViolation('a purchase order needs at least one line');
  }

  return db.tx(async (t) => {
    const priced = await pricePoLines(t, input.supplierId, input.lines);
    const poNumber = await nextNumber(t, 'po_number_seq', 'PO');
    const po = await t.one<{ id: string }>(
      `INSERT INTO purchase_orders (supplier_id, po_number, expected_delivery_date, notes)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [input.supplierId, poNumber, input.expectedDeliveryDate || null, input.notes ?? null],
    );
    const totals = await writePoLines(t, po.id, priced);

    await audit(t, actor, 'create', 'PurchaseOrder', po.id, poNumber,
      { supplierId: input.supplierId, subtotalCents: totals.subtotal,
        gctCents: totals.gct, envTaxCents: totals.envTax });

    return { id: po.id, poNumber, subtotalCents: totals.subtotal, gctCents: totals.gct,
             envTaxCents: totals.envTax, grandTotalCents: totals.grandTotal };
  });
}

/**
 * Change a PO nothing has been received against yet (Everton, 30 Sep 2026:
 * POs must be editable). Once goods have come in, the lines are history -
 * they made FIFO batches at their cost - so it can no longer change.
 */
export async function updatePurchaseOrder(
  db: Db, actor: Actor, poId: string,
  input: { supplierId?: string; lines: PoLineInput[]; expectedDeliveryDate?: string | null; notes?: string | null },
): Promise<{ grandTotalCents: Cents }> {
  requireRole(actor, 'admin', 'user');
  return db.tx(async (t) => {
    const po = await t.maybeOne<{ status: string; po_number: string; supplier_id: string }>(
      `SELECT status, po_number, supplier_id FROM purchase_orders WHERE id = $1 FOR UPDATE`, [poId],
    );
    if (!po) throw new RuleViolation('that purchase order no longer exists');
    const received = await t.one<{ n: number }>(
      `SELECT COALESCE(SUM(quantity_received),0)::float AS n FROM po_line_items WHERE po_id = $1`, [poId],
    );
    if (num(received.n) > 0 || !['Draft', 'Sent'].includes(po.status)) {
      throw new RuleViolation(`${po.po_number} has goods received against it, so it can no longer be changed`);
    }
    const supplierId = input.supplierId || po.supplier_id;
    const priced = await pricePoLines(t, supplierId, input.lines ?? []);
    await t.query(`DELETE FROM po_line_items WHERE po_id = $1`, [poId]);
    await t.query(
      `UPDATE purchase_orders SET supplier_id = $2, expected_delivery_date = $3, notes = $4 WHERE id = $1`,
      [poId, supplierId, input.expectedDeliveryDate || null, input.notes ?? null],
    );
    const totals = await writePoLines(t, poId, priced);
    await audit(t, actor, 'update', 'PurchaseOrder', poId, po.po_number,
      { grandTotalCents: totals.grandTotal, lines: priced.length });
    return { grandTotalCents: totals.grandTotal };
  });
}

/**
 * Delete a PO (Everton, 30 Sep 2026). Only while nothing has been received:
 * a PO with goods against it made FIFO batches and must stay. Such a PO can
 * be cancelled for what is still outstanding instead.
 */
export async function deletePurchaseOrder(db: Db, actor: Actor, poId: string): Promise<void> {
  requireRole(actor, 'admin', 'user');
  await db.tx(async (t) => {
    const po = await t.one<{ po_number: string }>(
      `SELECT po_number FROM purchase_orders WHERE id = $1`, [poId],
    );
    const received = await t.one<{ n: number }>(
      `SELECT COALESCE(SUM(quantity_received),0)::float AS n FROM po_line_items WHERE po_id = $1`, [poId],
    );
    if (num(received.n) > 0) {
      throw new RuleViolation(`goods have been received against ${po.po_number}, so it cannot be deleted. Cancel what is still outstanding instead.`);
    }
    await t.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
    await audit(t, actor, 'delete', 'PurchaseOrder', poId, po.po_number, {});
  });
}

/** Close a PO: nothing more is expected against it. What was received stays. */
export async function cancelPurchaseOrder(db: Db, actor: Actor, poId: string): Promise<void> {
  requireRole(actor, 'admin', 'user');
  await db.tx(async (t) => {
    const po = await t.one<{ po_number: string; status: string }>(
      `SELECT po_number, status FROM purchase_orders WHERE id = $1`, [poId],
    );
    if (po.status === 'Received') throw new RuleViolation(`${po.po_number} is fully received`);
    await t.query(`UPDATE purchase_orders SET status = 'Cancelled', updated_at = now() WHERE id = $1`, [poId]);
    await audit(t, actor, 'update', 'PurchaseOrder', poId, po.po_number, { status: 'Cancelled' });
  });
}

/**
 * Receive quantities against a PO. Each received line creates its OWN
 * MaterialBatch at that line's frozen cost - this is what makes costing FIFO
 * rather than weighted-average.
 */
export async function receivePurchaseOrder(
  db: Db,
  actor: Actor,
  poId: string,
  receipts: Array<{ poLineItemId: string; quantityReceived: number }>,
  /** The day it actually arrived (team feedback, point 18); blank = today. */
  receivedOn?: string | null,
): Promise<{ status: string; batchIds: string[] }> {
  requireRole(actor, 'admin', 'user');
  const day = receivedOn ? String(receivedOn).slice(0, 10) : null;
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RuleViolation('the date it arrived is not a date');
  if (day && day > businessToday()) throw new RuleViolation('it cannot have arrived in the future');
  // Noon Jamaica time, so the day reads the same everywhere it is shown.
  const at = day ? `${day}T12:00:00-05:00` : null;

  return db.tx(async (t) => {
    const po = await t.one<{ supplier_id: string; po_number: string; status: string }>(
      `SELECT supplier_id, po_number, status FROM purchase_orders WHERE id = $1`, [poId],
    );
    if (po.status === 'Cancelled') throw new RuleViolation('this purchase order was cancelled');

    const batchIds: string[] = [];
    for (const r of receipts) {
      if (r.quantityReceived <= 0) continue;
      const line = await t.one<{
        id: string; raw_material_id: string; unit_cost_cents: number;
        quantity_ordered: number; quantity_received: number;
      }>(
        `SELECT id, raw_material_id, unit_cost_cents, quantity_ordered, quantity_received
         FROM po_line_items WHERE id = $1 AND po_id = $2`,
        [r.poLineItemId, poId],
      );

      const material = await t.one<{ name: string }>(
        `SELECT name FROM raw_materials WHERE id = $1`, [line.raw_material_id],
      );

      const batch = await t.one<{ id: string }>(
        `INSERT INTO material_batches
           (raw_material_id, supplier_id, po_id, po_line_item_id,
            unit_cost_cents, quantity_received, quantity_remaining, received_date)
         VALUES ($1,$2,$3,$4,$5,$6,$6,COALESCE($7::timestamptz, now()))
         RETURNING id`,
        [line.raw_material_id, po.supplier_id, poId, line.id,
         num(line.unit_cost_cents), r.quantityReceived, at],
      );
      batchIds.push(batch.id);

      await t.query(
        `UPDATE po_line_items SET quantity_received = quantity_received + $2 WHERE id = $1`,
        [line.id, r.quantityReceived],
      );
      await t.query(
        `UPDATE raw_materials SET quantity_on_hand = quantity_on_hand + $2 WHERE id = $1`,
        [line.raw_material_id, r.quantityReceived],
      );
      await t.query(
        `INSERT INTO inventory_transactions
           (item_type, item_id, item_name, quantity, direction, reference,
            reference_type, unit_cost_cents, total_cost_cents, batch_ids, txn_date)
         VALUES ('RawMaterial',$1,$2,$3,'in',$4,'PurchaseOrder',$5,$6,$7,COALESCE($8::timestamptz, now()))`,
        [line.raw_material_id, material.name, r.quantityReceived, po.po_number,
         num(line.unit_cost_cents),
         Math.round(num(line.unit_cost_cents) * r.quantityReceived), [batch.id], at],
      );
    }

    // Fully received only when every line has met its ordered quantity.
    const outstanding = await t.one<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM po_line_items
       WHERE po_id = $1 AND quantity_received < quantity_ordered`, [poId],
    );
    const status = num(outstanding.c) === 0 ? 'Received' : 'Partially Received';
    await t.query(
      `UPDATE purchase_orders SET status = $2, receiving_date = COALESCE($3::date, business_today()) WHERE id = $1`,
      [poId, status, day],
    );

    await audit(t, actor, 'receive', 'PurchaseOrder', poId, po.po_number,
      { receipts, batchIds, status, receivedOn: day });

    return { status, batchIds };
  });
}

/** Open batches for a material, in FIFO order. */
async function openBatches(t: Queryable, rawMaterialId: string): Promise<Batch[]> {
  const rows = await t.query<{
    id: string; unit_cost_cents: number; quantity_remaining: number; supplier_id: string | null;
  }>(
    `SELECT id, unit_cost_cents, quantity_remaining, supplier_id
     FROM material_batches
     WHERE raw_material_id = $1 AND status = 'Open' AND quantity_remaining > 0
     ORDER BY received_date, id`,
    [rawMaterialId],
  );
  return rows.map((r) => ({
    id: r.id,
    unitCostCents: num(r.unit_cost_cents),
    quantityRemaining: num(r.quantity_remaining),
    supplierId: r.supplier_id,
  }));
}

/**
 * Consume raw material, drawing FIFO across batches.
 * Records the true drawn cost and every contributing batch id.
 */
export async function consumeMaterial(
  t: Queryable,
  actor: Actor | null,
  args: {
    rawMaterialId: string; quantity: number;
    reference: string; referenceType: 'ProductionBatch' | 'Manual' | 'Adjustment';
  },
): Promise<{ totalCostCents: Cents; batchIds: string[]; effectiveUnitCostCents: Cents }> {
  const batches = await openBatches(t, args.rawMaterialId);
  const material = await t.one<{ name: string }>(
    `SELECT name FROM raw_materials WHERE id = $1`, [args.rawMaterialId],
  );

  const draw = drawFifo(batches, args.quantity);

  for (const slice of draw.slices) {
    await t.query(
      `UPDATE material_batches
       SET quantity_remaining = quantity_remaining - $2,
           status = CASE WHEN quantity_remaining - $2 <= 0 THEN 'Consumed' ELSE 'Open' END
       WHERE id = $1`,
      [slice.batchId, slice.quantity],
    );
  }

  await t.query(
    `UPDATE raw_materials SET quantity_on_hand = quantity_on_hand - $2 WHERE id = $1`,
    [args.rawMaterialId, args.quantity],
  );

  await t.query(
    `INSERT INTO inventory_transactions
       (item_type, item_id, item_name, quantity, direction, reference,
        reference_type, unit_cost_cents, total_cost_cents, batch_ids)
     VALUES ('RawMaterial',$1,$2,$3,'out',$4,$5,$6,$7,$8)`,
    [args.rawMaterialId, material.name, args.quantity, args.reference,
     args.referenceType, draw.effectiveUnitCostCents, draw.totalCostCents,
     draw.slices.map((s) => s.batchId)],
  );

  return {
    totalCostCents: draw.totalCostCents,
    batchIds: draw.slices.map((s) => s.batchId),
    effectiveUnitCostCents: draw.effectiveUnitCostCents,
  };
}

/**
 * Issue material outside a production run.
 *
 * The 5-gallon line is why this exists: bottles are rotated, so labels are
 * applied when a returned bottle needs one rather than once per bottle
 * filled. Putting a nominal figure in the BOM would consume a label for
 * every bottle produced, including the ones that came back already
 * labelled, and 5gal cost would drift from reality.
 *
 * The draw is ordinary FIFO at true cost, so an issue is costed exactly the
 * way production is and shows up in the same transaction history.
 */
export async function issueMaterial(
  db: Db,
  actor: Actor,
  input: { rawMaterialId: string; quantity: number; reason?: string | null },
): Promise<{ quantity: number; totalCostCents: Cents; effectiveUnitCostCents: Cents }> {
  requireRole(actor, 'admin', 'user');
  if (!(input.quantity > 0)) throw new RuleViolation('the quantity used must be more than zero');

  return db.tx(async (t) => {
    const material = await t.maybeOne<{ name: string; unit_of_measure: string }>(
      `SELECT name, unit_of_measure FROM raw_materials WHERE id = $1`,
      [input.rawMaterialId],
    );
    if (!material) throw new RuleViolation('that material no longer exists');

    const used = await consumeMaterial(t, actor, {
      rawMaterialId: input.rawMaterialId,
      quantity: input.quantity,
      reference: input.reason?.trim() || 'Used outside production',
      referenceType: 'Manual',
    });

    await audit(t, actor, 'adjust', 'RawMaterial', input.rawMaterialId, material.name, {
      quantity: input.quantity,
      reason: input.reason ?? null,
      totalCostCents: used.totalCostCents,
    });

    return {
      quantity: input.quantity,
      totalCostCents: used.totalCostCents,
      effectiveUnitCostCents: used.effectiveUnitCostCents,
    };
  });
}

/**
 * Complete a production run: explode the BOM, consume materials FIFO, and
 * add the finished bottles to stock.
 */
export async function completeProduction(
  db: Db,
  actor: Actor,
  input: {
    productId: string; cases?: number; looseBottles?: number;
    operator?: string; notes?: string | null;
    /** The day it was made (team feedback, point 19); blank = today. */
    productionDate?: string | null;
  },
): Promise<{ batchId: string; bottlesProduced: number; materialCostCents: Cents }> {
  requireRole(actor, 'admin', 'user');
  const day = input.productionDate ? String(input.productionDate).slice(0, 10) : null;
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RuleViolation('the production date is not a date');
  if (day && day > businessToday()) throw new RuleViolation('a run cannot be recorded for a day still to come');

  return db.tx(async (t) => {
    const product = await t.one<{ name: string; bottles_per_case: number }>(
      `SELECT name, bottles_per_case FROM products WHERE id = $1`, [input.productId],
    );
    const bpc = num(product.bottles_per_case);
    const cases = input.cases ?? 0;
    const loose = input.looseBottles ?? 0;
    // Production counts BOTH, unlike the sales-side case-vs-bottle rule: a run
    // can legitimately finish with a partial case, and those bottles are real
    // stock. The restriction on selling loose bottles of a cased product is a
    // sales rule and has no bearing on what the line actually produced.
    const bottles = bpc > 0 ? cases * bpc + loose : loose;
    if (bottles <= 0) throw new RuleViolation('a production run must produce at least one bottle');

    const batch = await t.one<{ id: string }>(
      `INSERT INTO production_batches (operator, status, notes, batch_date)
       VALUES ($1,'Completed',$2, COALESCE($3::date, business_today())) RETURNING id`,
      [input.operator ?? actor.name, input.notes ?? null, day],
    );
    await t.query(
      `INSERT INTO production_batch_line_items
         (batch_id, product_id, cases, loose_bottles, total_bottles)
       VALUES ($1,$2,$3,$4,$5)`,
      [batch.id, input.productId, cases, loose, bottles],
    );

    const bom = await t.query<{ raw_material_id: string; quantity: number }>(
      `SELECT raw_material_id, quantity FROM bom_line_items WHERE product_id = $1`,
      [input.productId],
    );

    let materialCost = 0;
    for (const component of bom) {
      const needed = num(component.quantity) * bottles;
      const used = await consumeMaterial(t, actor, {
        rawMaterialId: component.raw_material_id,
        quantity: needed,
        reference: `Production ${batch.id}`,
        referenceType: 'ProductionBatch',
      });
      materialCost += used.totalCostCents;
    }

    await t.query(
      `INSERT INTO finished_goods_stock (product_id, quantity_on_hand)
       VALUES ($1,$2)
       ON CONFLICT (product_id) DO UPDATE
         SET quantity_on_hand = finished_goods_stock.quantity_on_hand + EXCLUDED.quantity_on_hand`,
      [input.productId, bottles],
    );
    await t.query(
      `INSERT INTO inventory_transactions
         (item_type, item_id, item_name, quantity, direction, reference,
          reference_type, total_cost_cents)
       VALUES ('FinishedGoods',$1,$2,$3,'in',$4,'ProductionBatch',$5)`,
      [input.productId, product.name, bottles, `Production ${batch.id}`, materialCost],
      // (dated now: a backdated run still entered stock today, which is what
      // a later stock count compares against)
    );

    await audit(t, actor, 'create', 'ProductionBatch', batch.id, product.name,
      { bottlesProduced: bottles, materialCostCents: materialCost });

    return { batchId: batch.id, bottlesProduced: bottles, materialCostCents: materialCost };
  });
}

/**
 * Can this run actually be made from stock on hand?
 *
 * Explodes the BOM without consuming anything, so the production screen can
 * show shortages before an operator commits - rather than failing partway
 * through with an insufficient-stock error.
 */
export async function productionFeasibility(
  db: Db,
  productId: string,
  bottles: number,
): Promise<{
  canProduce: boolean;
  estimatedCostCents: Cents;
  components: Array<{
    rawMaterialId: string; name: string; unitOfMeasure: string;
    required: number; onHand: number; shortfall: number;
    estimatedCostCents: Cents;
  }>;
}> {
  const bom = await db.query<{
    raw_material_id: string; quantity: number; name: string;
    unit_of_measure: string; quantity_on_hand: number;
  }>(
    `SELECT b.raw_material_id, b.quantity, rm.name, rm.unit_of_measure, rm.quantity_on_hand
     FROM bom_line_items b JOIN raw_materials rm ON rm.id = b.raw_material_id
     WHERE b.product_id = $1 ORDER BY b.component_type`,
    [productId],
  );

  const components = [];
  let estimatedCostCents = 0;

  for (const c of bom) {
    const required = num(c.quantity) * bottles;
    const onHand = num(c.quantity_on_hand);
    const batches = await openBatches(db, c.raw_material_id);

    // Price the requirement against the batches it would actually draw.
    let cost = 0;
    let outstanding = required;
    for (const b of batches) {
      if (outstanding <= 0) break;
      const take = Math.min(b.quantityRemaining, outstanding);
      cost += Math.round(take * b.unitCostCents);
      outstanding -= take;
    }
    estimatedCostCents += cost;

    components.push({
      rawMaterialId: c.raw_material_id,
      name: c.name,
      unitOfMeasure: c.unit_of_measure,
      required: Math.round(required * 1000) / 1000,
      onHand,
      shortfall: Math.max(Math.round((required - onHand) * 1000) / 1000, 0),
      estimatedCostCents: cost,
    });
  }

  return {
    canProduce: bom.length > 0 && components.every((c) => c.shortfall === 0),
    estimatedCostCents,
    components,
  };
}

export async function listPurchaseOrders(db: Db, status?: string) {
  return db.query(
    `SELECT po.*, s.name AS supplier_name,
            (SELECT COUNT(*)::int FROM po_line_items l WHERE l.po_id = po.id) AS line_count
     FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
     WHERE ($1::text IS NULL OR po.status = $1)
     ORDER BY po.order_date DESC, po.po_number DESC`,
    [status ?? null],
  );
}

export async function getPurchaseOrder(db: Db, poId: string) {
  const po = await db.maybeOne(
    `SELECT po.*, po.order_date::text AS order_date,
            po.expected_delivery_date::text AS expected_delivery_date,
            s.name AS supplier_name, s.email AS supplier_email, s.contact_person AS supplier_contact,
            s.phone AS supplier_phone, s.address AS supplier_address
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = $1`, [poId],
  );
  if (!po) return null;
  const lines = await db.query(
    `SELECT l.*, rm.name AS raw_material_name, rm.unit_of_measure
     FROM po_line_items l JOIN raw_materials rm ON rm.id = l.raw_material_id
     WHERE l.po_id = $1 ORDER BY rm.name`,
    [poId],
  );
  return { ...po, lines };
}

export async function listProductionBatches(db: Db, limit = 50) {
  return db.query(
    `SELECT pb.id, pb.batch_date::text AS batch_date, pb.operator, pb.status, pb.notes,
            p.name AS product_name, li.cases, li.loose_bottles, li.total_bottles,
            (SELECT COALESCE(SUM(total_cost_cents),0) FROM inventory_transactions it
             WHERE it.reference = 'Production ' || pb.id::text
               AND it.item_type = 'RawMaterial') AS material_cost_cents
     FROM production_batches pb
     LEFT JOIN production_batch_line_items li ON li.batch_id = pb.id
     LEFT JOIN products p ON p.id = li.product_id
     ORDER BY pb.batch_date DESC, pb.created_at DESC
     LIMIT $1`,
    [limit],
  );
}

/** Finished goods on hand, in bottles and whole cases. */
export async function finishedGoods(db: Db) {
  return db.query(
    `SELECT p.id AS product_id, p.name, p.size, p.bottles_per_case,
            COALESCE(f.quantity_on_hand, 0) AS bottles_on_hand,
            CASE WHEN p.bottles_per_case > 0
                 THEN FLOOR(COALESCE(f.quantity_on_hand,0)::numeric / p.bottles_per_case)
                 ELSE NULL END AS full_cases
     FROM products p
     LEFT JOIN finished_goods_stock f ON f.product_id = p.id
     WHERE p.active
     ORDER BY p.name`,
  );
}

/** The stock movement ledger - every in, out and adjustment. */
export async function listInventoryTransactions(
  db: Db,
  opts: { itemType?: string; itemId?: string; limit?: number } = {},
) {
  return db.query(
    `SELECT t.*, business_date(t.txn_date)::text AS txn_day
     FROM inventory_transactions t
     WHERE ($1::text IS NULL OR t.item_type = $1)
       AND ($2::uuid IS NULL OR t.item_id = $2::uuid)
     ORDER BY t.txn_date DESC
     LIMIT $3`,
    [opts.itemType ?? null, opts.itemId ?? null, opts.limit ?? 100],
  );
}

/**
 * Blended average cost per material - overall and per supplier.
 * REPORTING ONLY: never affects what production is charged (Section 9).
 */
export async function materialCostReport(db: Db, rawMaterialId?: string) {
  const materials = await db.query<{ id: string; name: string; unit_of_measure: string }>(
    rawMaterialId
      ? `SELECT id, name, unit_of_measure FROM raw_materials WHERE id = $1`
      : `SELECT id, name, unit_of_measure FROM raw_materials ORDER BY name`,
    rawMaterialId ? [rawMaterialId] : [],
  );

  const out = [];
  for (const m of materials) {
    const batches = await openBatches(db, m.id);
    const bySupplier = blendedAverageBySupplier(batches);
    const supplierNames = await db.query<{ id: string; name: string }>(
      `SELECT id, name FROM suppliers`,
    );
    const nameOf = new Map(supplierNames.map((s) => [s.id, s.name]));

    out.push({
      rawMaterialId: m.id,
      name: m.name,
      unitOfMeasure: m.unit_of_measure,
      quantityOnHand: batches.reduce((s, b) => s + b.quantityRemaining, 0),
      blendedAverageUnitCostCents: blendedAverageCost(batches),
      perSupplier: bySupplier.map((s) => ({
        supplierId: s.supplierId,
        supplierName: s.supplierId ? (nameOf.get(s.supplierId) ?? 'Unknown') : 'Unknown',
        quantity: s.quantity,
        averageUnitCostCents: s.averageUnitCostCents,
      })),
      openBatches: batches.length,
    });
  }
  return out;
}
