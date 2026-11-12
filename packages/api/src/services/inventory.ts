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
import { markPickupsReceived } from './collections.ts';
import { jugMaterial, moveEmpties } from './bottles.ts';
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
  /** An existing line being changed (edit); left out for a new line. */
  id?: string | null;
  rawMaterialId: string;
  quantityOrdered: number;
  unitCostCents?: Cents;
  /** Overrides the supplier-product tag for this one line. */
  gctExempt?: boolean;
  envExempt?: boolean;
}

/** The Environmental Levy rate as a fraction (0.6375% from 3 Nov 2026 unless changed). */
export async function envTaxRate(t: Queryable): Promise<number> {
  const row = await t.maybeOne<{ value: string }>(
    `SELECT value FROM system_settings WHERE key = 'env_tax_rate_percent'`,
  );
  const pct = Number(row?.value ?? 0.6375);
  return Number.isFinite(pct) && pct >= 0 ? pct / 100 : 0.006375;
}

/**
 * Price and tax the lines of a PO.
 *
 * GCT (15%) and the Environmental Levy (0.6375% from 3 Nov 2026) are worked out PER LINE, from
 * how the product is tagged for that supplier (Everton, 30 Sep 2026): a line
 * tagged GCT-exempt carries no GCT, one tagged Env-exempt no levy. Each is
 * worked out on the line's own amount, then summed. GCT is charged on the
 * levy too (Everton, 11 Nov 2026): GCT = 15% of (line + levy).
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
    const envTax = envExempt ? 0 : Math.round(lineTotal * env);
    out.push({
      id: l.id ?? null, rawMaterialId: l.rawMaterialId, qty, unitCost, gctExempt, envExempt, lineTotal,
      gct: gctExempt ? 0 : Math.round((lineTotal + envTax) * GCT_RATE),
      envTax,
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
/**
 * Change a purchase order (Everton, 11 Nov 2026: "I'm not seeing an ability
 * to edit POs" - it was refused once anything had been received).
 *
 * Nothing received yet (Draft or Sent): anyone in the office changes anything.
 * Goods received against it: an administrator can still
 *   - change the expected date and notes;
 *   - change a line's quantity ordered, never below what has come in (if it
 *     now equals what came in, the line is complete);
 *   - correct a line's cost each - the stock already received from that line
 *     is re-costed too (its batches), so what is still on the shelf costs
 *     the right amount from now on (what production already used keeps the
 *     cost it was charged);
 *   - add lines, and remove or change lines nothing has been received on.
 * A line with goods received keeps its material and supplier. The status is
 * worked out again (Received when every line is in). Cancelled POs are final.
 */
export async function updatePurchaseOrder(
  db: Db, actor: Actor, poId: string,
  input: { supplierId?: string; lines: PoLineInput[]; expectedDeliveryDate?: string | null; notes?: string | null },
): Promise<{ grandTotalCents: Cents; status: string }> {
  requireRole(actor, 'admin', 'user');
  return db.tx(async (t) => {
    const po = await t.maybeOne<{ status: string; po_number: string; supplier_id: string }>(
      `SELECT status, po_number, supplier_id FROM purchase_orders WHERE id = $1 FOR UPDATE`, [poId],
    );
    if (!po) throw new RuleViolation('that purchase order no longer exists');
    if (po.status === 'Cancelled') throw new RuleViolation(`${po.po_number} was cancelled, so it can no longer be changed`);
    const existing = await t.query<{ id: string; raw_material_id: string; quantity_received: string; unit_cost_cents: string; name: string }>(
      `SELECT l.id, l.raw_material_id, l.quantity_received::text AS quantity_received, l.unit_cost_cents::text AS unit_cost_cents,
              rm.name
       FROM po_line_items l JOIN raw_materials rm ON rm.id = l.raw_material_id WHERE l.po_id = $1 FOR UPDATE OF l`, [poId],
    );
    const anyReceived = existing.some((l) => Number(l.quantity_received) > 0);
    if (anyReceived) requireRole(actor, 'admin');
    const supplierId = input.supplierId || po.supplier_id;
    if (anyReceived && supplierId !== po.supplier_id) {
      throw new RuleViolation(`${po.po_number} has goods received from its supplier, so the supplier cannot change`);
    }
    const byId = new Map(existing.map((l) => [l.id, l]));
    for (const l of input.lines ?? []) {
      if (l.id && !byId.has(l.id)) throw new RuleViolation('one of those lines is not on this purchase order');
    }
    const priced = await pricePoLines(t, supplierId, input.lines ?? []);
    const kept = new Set(priced.map((l) => l.id).filter(Boolean) as string[]);

    // Lines taken off: only if nothing came in on them.
    for (const l of existing) {
      if (kept.has(l.id)) continue;
      if (Number(l.quantity_received) > 0) {
        throw new RuleViolation(`${l.name} has been received on this order, so it cannot be taken off; lower its quantity to what came in instead`);
      }
      await t.query(`DELETE FROM po_line_items WHERE id = $1`, [l.id]);
    }

    let subtotal = 0; let gct = 0; let envTax = 0;
    for (const l of priced) {
      const was = l.id ? byId.get(l.id)! : null;
      const received = was ? Number(was.quantity_received) : 0;
      if (was && received > 0) {
        if (l.rawMaterialId !== was.raw_material_id) {
          throw new RuleViolation(`${was.name} has been received on this order, so its material cannot change`);
        }
        if (l.qty < received - 1e-9) {
          throw new RuleViolation(`${received} of ${was.name} have already come in, so the quantity ordered cannot be less than that`);
        }
        if (l.unitCost !== Number(was.unit_cost_cents)) {
          // Re-cost what came in on this line, and what production already drew from it.
          const bs = await t.query<{ id: string }>(`SELECT id FROM material_batches WHERE po_line_item_id = $1`, [l.id]);
          for (const b of bs) await recostBatchTx(t, b.id, l.unitCost);
        }
      }
      if (was) {
        await t.query(
          `UPDATE po_line_items SET raw_material_id = $2, quantity_ordered = $3, unit_cost_cents = $4,
                  gct_exempt = $5, env_exempt = $6, line_total_cents = $7, gct_cents = $8, env_tax_cents = $9
           WHERE id = $1`,
          [l.id, l.rawMaterialId, l.qty, l.unitCost, l.gctExempt, l.envExempt, l.lineTotal, l.gct, l.envTax]);
      } else {
        await t.query(
          `INSERT INTO po_line_items
             (po_id, raw_material_id, quantity_ordered, unit_cost_cents,
              gct_exempt, env_exempt, line_total_cents, gct_cents, env_tax_cents)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [poId, l.rawMaterialId, l.qty, l.unitCost, l.gctExempt, l.envExempt, l.lineTotal, l.gct, l.envTax]);
      }
      subtotal += l.lineTotal; gct += l.gct; envTax += l.envTax;
    }

    // Status again, now the quantities may have moved.
    let status = po.status;
    if (anyReceived) {
      const out = await t.one<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM po_line_items WHERE po_id = $1 AND quantity_received < quantity_ordered`, [poId]);
      status = num(out.c) === 0 ? 'Received' : po.status === PO_CLOSED ? PO_CLOSED : 'Partially Received';
    }
    await t.query(
      `UPDATE purchase_orders
       SET supplier_id = $2, expected_delivery_date = $3, notes = $4, status = $5,
           subtotal_cents = $6, gct_cents = $7, env_tax_cents = $8, grand_total_cents = $9, updated_at = now()
       WHERE id = $1`,
      [poId, supplierId, input.expectedDeliveryDate || null, input.notes ?? null, status,
       subtotal, gct, envTax, subtotal + gct + envTax],
    );
    await audit(t, actor, 'update', 'PurchaseOrder', poId, po.po_number,
      { grandTotalCents: subtotal + gct + envTax, lines: priced.length, afterReceiving: anyReceived || undefined, status });
    return { grandTotalCents: subtotal + gct + envTax, status };
  });
}

/**
 * Correct what one stock batch cost (Everton, 11 Nov 2026: 55mm caps - and
 * the labels, caps and handles counted on 3 Nov - went into production at
 * J$0 because the 3 Nov count had no earlier cost to value them by, and PO-
 * 001011 was received at J$0). Inside the caller's transaction:
 *   - the batch's cost each, so what is left on the shelf costs that from now on;
 *   - the ledger row that brought it in (count or PO receipt);
 *   - every draw that took from this batch alone (production, issues): its
 *     cost is worked out again, and so is the production run's cost (the
 *     finished goods it made) - a run's cost on the Production screen is the
 *     sum of its draws, so it follows.
 * A draw that took from this batch AND others is left as it was (how much
 * came from each was not recorded); the count of those is returned.
 */
export async function recostBatchTx(
  t: Queryable, batchId: string, unitCostCents: Cents,
): Promise<{ drawsRecosted: number; drawsLeft: number }> {
  const cost = Math.round(Number(unitCostCents));
  if (!(cost >= 0)) throw new RuleViolation('a cost cannot be negative');
  await t.query(`UPDATE material_batches SET unit_cost_cents = $2 WHERE id = $1`, [batchId, cost]);
  await t.query(
    `UPDATE inventory_transactions SET unit_cost_cents = $2::bigint, total_cost_cents = ROUND($2::bigint * quantity)
     WHERE direction = 'in' AND batch_ids = ARRAY[$1::uuid] AND item_type = 'RawMaterial'`, [batchId, cost]);
  const draws = await t.query<{ id: string; reference: string | null }>(
    `UPDATE inventory_transactions SET unit_cost_cents = $2::bigint, total_cost_cents = ROUND($2::bigint * quantity)
     WHERE direction = 'out' AND batch_ids = ARRAY[$1::uuid] AND item_type = 'RawMaterial'
     RETURNING id, reference`, [batchId, cost]);
  const left = await t.one<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM inventory_transactions
     WHERE direction = 'out' AND item_type = 'RawMaterial' AND $1::uuid = ANY(batch_ids) AND cardinality(batch_ids) > 1`, [batchId]);
  // The production runs those draws belong to: their finished-goods row carries the run's cost.
  const runs = [...new Set(draws.map((d) => d.reference).filter((r): r is string => !!r && r.startsWith('Production ')))];
  for (const ref of runs) {
    await t.query(
      `UPDATE inventory_transactions fg SET total_cost_cents = (
         SELECT COALESCE(SUM(total_cost_cents), 0) FROM inventory_transactions r
         WHERE r.reference = $1 AND r.item_type = 'RawMaterial' AND r.direction = 'out')
       WHERE fg.reference = $1 AND fg.item_type = 'FinishedGoods' AND fg.direction = 'in'`, [ref]);
  }
  return { drawsRecosted: draws.length, drawsLeft: num(left.n) };
}

/** Correct a batch's cost from Raw materials › Batches (admins; 11 Nov 2026). */
export async function setBatchCost(
  db: Db, actor: Actor, batchId: string, unitCostCents: Cents,
): Promise<{ drawsRecosted: number; drawsLeft: number; materialName: string }> {
  requireRole(actor, 'admin');
  return db.tx(async (t) => {
    const b = await t.maybeOne<{ unit_cost_cents: string; name: string; po_line_item_id: string | null; po_number: string | null }>(
      `SELECT mb.unit_cost_cents::text AS unit_cost_cents, rm.name, mb.po_line_item_id, po.po_number
       FROM material_batches mb JOIN raw_materials rm ON rm.id = mb.raw_material_id
       LEFT JOIN purchase_orders po ON po.id = mb.po_id
       WHERE mb.id = $1 FOR UPDATE OF mb`, [batchId]);
    if (!b) throw new RuleViolation('that batch no longer exists');
    if (b.po_line_item_id) {
      throw new RuleViolation(`this batch came in on ${b.po_number ?? 'a purchase order'}: correct the cost each on the purchase order (Edit), so the order and its stock agree`);
    }
    const r = await recostBatchTx(t, batchId, unitCostCents);
    await audit(t, actor, 'update', 'RawMaterial', batchId, b.name, {
      batchCost: { from: num(b.unit_cost_cents), to: Math.round(Number(unitCostCents)) }, ...r,
    });
    return { ...r, materialName: b.name };
  });
}

/**
 * The four ways a PO ends (Everton, 7 Oct 2026, point 14):
 *
 *   Received                     everything ordered came in
 *   Partially Received           some came in, more is still expected
 *   Partially Received - Closed  some came in and nothing more is coming
 *   Cancelled                    deleted (or closed) with nothing received
 *
 * THE BUG: "Close it (nothing more coming)" called the cancel routine, which
 * set every PO it touched to Cancelled - including ones with goods received
 * against them, so a PO that had delivered half its stock read as if it had
 * never happened. Closing now records Partially Received - Closed, and
 * Cancelled is kept for a PO that delivered nothing.
 */
export const PO_CLOSED = 'Partially Received - Closed';

async function receivedOn(t: Queryable, poId: string): Promise<number> {
  const r = await t.one<{ n: number }>(
    `SELECT COALESCE(SUM(quantity_received),0)::float AS n FROM po_line_items WHERE po_id = $1`, [poId],
  );
  return num(r.n);
}

/**
 * "Delete" a PO nothing has been received against. It is kept, marked
 * Cancelled, so the number is never reused and the list shows what became
 * of it. A PO with goods against it made FIFO batches and cannot be deleted;
 * close it instead.
 */
export async function deletePurchaseOrder(db: Db, actor: Actor, poId: string): Promise<void> {
  requireRole(actor, 'admin', 'user');
  await db.tx(async (t) => {
    const po = await t.one<{ po_number: string; status: string }>(
      `SELECT po_number, status FROM purchase_orders WHERE id = $1 FOR UPDATE`, [poId],
    );
    if (await receivedOn(t, poId) > 0) {
      throw new RuleViolation(`goods have been received against ${po.po_number}, so it cannot be deleted. Close it instead (nothing more coming).`);
    }
    if (po.status === 'Cancelled') return;
    await t.query(`UPDATE purchase_orders SET status = 'Cancelled', updated_at = now() WHERE id = $1`, [poId]);
    await audit(t, actor, 'delete', 'PurchaseOrder', poId, po.po_number, { status: 'Cancelled', nothingReceived: true });
  });
}

/**
 * Close a PO: nothing more is expected against it. What was received stays.
 * With goods received it is Partially Received - Closed; with none, it is
 * simply Cancelled.
 */
export async function cancelPurchaseOrder(db: Db, actor: Actor, poId: string): Promise<{ status: string }> {
  requireRole(actor, 'admin', 'user');
  return db.tx(async (t) => {
    const po = await t.one<{ po_number: string; status: string }>(
      `SELECT po_number, status FROM purchase_orders WHERE id = $1 FOR UPDATE`, [poId],
    );
    if (po.status === 'Received') throw new RuleViolation(`${po.po_number} is fully received`);
    if (po.status === 'Cancelled' || po.status === PO_CLOSED) {
      throw new RuleViolation(`${po.po_number} is already ${po.status === 'Cancelled' ? 'cancelled' : 'closed'}`);
    }
    const status = await receivedOn(t, poId) > 0 ? PO_CLOSED : 'Cancelled';
    await t.query(`UPDATE purchase_orders SET status = $2, updated_at = now() WHERE id = $1`, [poId, status]);
    await audit(t, actor, 'update', 'PurchaseOrder', poId, po.po_number, { status, closed: true });
    return { status };
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
    if (po.status === PO_CLOSED) throw new RuleViolation(`${po.po_number} was closed: nothing more is expected against it`);

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

      const material = await t.one<{ name: string; is_returnable_jug: boolean }>(
        `SELECT name, is_returnable_jug FROM raw_materials WHERE id = $1`, [line.raw_material_id],
      );

      // The returnable 5-gallon jug (jug cycle, 3 Nov 2026): received into
      // the empties, its cost recorded here once and never charged into a
      // run - so its layer is closed as soon as it is opened.
      const jug = material.is_returnable_jug;
      const batch = await t.one<{ id: string }>(
        `INSERT INTO material_batches
           (raw_material_id, supplier_id, po_id, po_line_item_id,
            unit_cost_cents, quantity_received, quantity_remaining, status, received_date)
         VALUES ($1,$2,$3,$4,$5,$6::numeric,CASE WHEN $8::boolean THEN 0::numeric ELSE $6::numeric END,
                 CASE WHEN $8::boolean THEN 'Consumed' ELSE 'Open' END, COALESCE($7::timestamptz, now()))
         RETURNING id`,
        [line.raw_material_id, po.supplier_id, poId, line.id,
         num(line.unit_cost_cents), r.quantityReceived, at, jug],
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

    // Goods picked up from the supplier on a round are received here; their
    // pick-up stops stop offering to prefill this (10 Oct 2026, point 3).
    if (batchIds.length > 0) await markPickupsReceived(t, poId);

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
    /** 5-gallon runs: jugs taken from the empties but found unusable (jug cycle, 3 Nov 2026). */
    jugsScrapped?: number | null;
  },
): Promise<{
  batchId: string; bottlesProduced: number; materialCostCents: Cents;
  /** 5-gallon runs: empties drawn (filled + scrapped), and what is left on record. */
  empties?: { drawn: number; scrapped: number; left: number } | null;
}> {
  requireRole(actor, 'admin', 'user');
  const day = checkRunDay(input.productionDate);

  return db.tx(async (t) => {
    const product = await t.one<{ name: string; bottles_per_case: number; is_returnable: boolean }>(
      `SELECT name, bottles_per_case, is_returnable FROM products WHERE id = $1`, [input.productId],
    );
    const { cases, loose, bottles, scrapped } = runSize(product, input);

    const batch = await t.one<{ id: string }>(
      `INSERT INTO production_batches (operator, status, notes, batch_date, jugs_scrapped)
       VALUES ($1,'Completed',$2, COALESCE($3::date, business_today()), $4) RETURNING id`,
      [input.operator ?? actor.name, input.notes ?? null, day, scrapped],
    );
    await t.query(
      `INSERT INTO production_batch_line_items
         (batch_id, product_id, cases, loose_bottles, total_bottles)
       VALUES ($1,$2,$3,$4,$5)`,
      [batch.id, input.productId, cases, loose, bottles],
    );

    const made = await runMovements(t, actor, batch.id, input.productId, product, bottles, scrapped, day);

    await audit(t, actor, 'create', 'ProductionBatch', batch.id, product.name,
      { bottlesProduced: bottles, materialCostCents: made.materialCost, jugsScrapped: scrapped || undefined,
        emptiesLeft: made.empties?.left });

    return { batchId: batch.id, bottlesProduced: bottles, materialCostCents: made.materialCost, empties: made.empties };
  });
}

/** The production date given, checked; null = today. */
function checkRunDay(input: string | null | undefined): string | null {
  const day = input ? String(input).slice(0, 10) : null;
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RuleViolation('the production date is not a date');
  if (day && day > businessToday()) throw new RuleViolation('a run cannot be recorded for a day still to come');
  return day;
}

/** Bottles a run made from its cases and loose bottles, and its scrapped jugs, checked. */
function runSize(
  product: { bottles_per_case: number; is_returnable: boolean },
  input: { cases?: number; looseBottles?: number; jugsScrapped?: number | null },
) {
  const scrapped = Math.round(Number(input.jugsScrapped ?? 0) || 0);
  if (scrapped < 0) throw new RuleViolation('jugs scrapped cannot be negative');
  if (scrapped > 0 && !product.is_returnable) {
    throw new RuleViolation('jugs scrapped only apply to a 5-gallon run');
  }
  const bpc = num(product.bottles_per_case);
  const cases = Math.round(Number(input.cases ?? 0) || 0);
  const loose = Math.round(Number(input.looseBottles ?? 0) || 0);
  if (cases < 0 || loose < 0) throw new RuleViolation('cases and bottles cannot be negative');
  // Production counts BOTH, unlike the sales-side case-vs-bottle rule: a run
  // can legitimately finish with a partial case, and those bottles are real
  // stock. The restriction on selling loose bottles of a cased product is a
  // sales rule and has no bearing on what the line actually produced.
  const bottles = bpc > 0 ? cases * bpc + loose : loose;
  if (bottles <= 0) throw new RuleViolation('a production run must produce at least one bottle');
  return { cases: bpc > 0 ? cases : 0, loose, bottles, scrapped };
}

/**
 * What a run does to stock: materials drawn FIFO, finished bottles in, and
 * for a 5-gallon run the empties drawn. Every row carries the reference
 * "Production <id>", which is how the run's cost and an edit or delete find
 * them again.
 */
async function runMovements(
  t: Queryable, actor: Actor, batchId: string, productId: string,
  product: { name: string; is_returnable: boolean }, bottles: number, scrapped: number, day: string | null,
): Promise<{ materialCost: Cents; empties: { drawn: number; scrapped: number; left: number } | null }> {
  // The jug itself is never a recipe line: a 5-gallon run draws on the
  // empties below instead, at no cost (jug cycle, 3 Nov 2026).
  const bom = await t.query<{ raw_material_id: string; quantity: number }>(
    `SELECT b.raw_material_id, b.quantity FROM bom_line_items b
     JOIN raw_materials rm ON rm.id = b.raw_material_id
     WHERE b.product_id = $1 AND NOT rm.is_returnable_jug`,
    [productId],
  );

  let materialCost = 0;
  for (const component of bom) {
    const needed = num(component.quantity) * bottles;
    const used = await consumeMaterial(t, actor, {
      rawMaterialId: component.raw_material_id,
      quantity: needed,
      reference: `Production ${batchId}`,
      referenceType: 'ProductionBatch',
    });
    materialCost += used.totalCostCents;
  }

  await t.query(
    `INSERT INTO finished_goods_stock (product_id, quantity_on_hand)
     VALUES ($1,$2)
     ON CONFLICT (product_id) DO UPDATE
       SET quantity_on_hand = finished_goods_stock.quantity_on_hand + EXCLUDED.quantity_on_hand`,
    [productId, bottles],
  );
  await t.query(
    `INSERT INTO inventory_transactions
       (item_type, item_id, item_name, quantity, direction, reference,
        reference_type, total_cost_cents)
     VALUES ('FinishedGoods',$1,$2,$3,'in',$4,'ProductionBatch',$5)`,
    [productId, product.name, bottles, `Production ${batchId}`, materialCost],
    // (dated now: a backdated run still entered stock today, which is what
    // a later stock count compares against)
  );

  // A 5-gallon run washes and fills jugs from the empties: one empty per
  // jug filled, plus any found unusable. Allowed to go below zero - the
  // plant may fill from empties a driver brought back mid-round before the
  // round is settled - and the screen flags it.
  let empties: { drawn: number; scrapped: number; left: number } | null = null;
  if (product.is_returnable) {
    const ref = `Production ${batchId}`;
    const moved = await moveEmpties(t, -bottles, 'ProductionBatch', ref,
      `${bottles} jug${bottles === 1 ? '' : 's'} washed and filled: ${product.name}`, { day });
    if (scrapped > 0) {
      await moveEmpties(t, -scrapped, 'JugsScrapped', ref,
        `${scrapped} jug${scrapped === 1 ? '' : 's'} scrapped on the run - business loss`, { day });
    }
    const jug = moved || scrapped > 0 ? await jugMaterial(t) : null;
    if (jug) empties = { drawn: bottles + scrapped, scrapped, left: jug.onHand };
  }
  return { materialCost, empties };
}

interface RunRow {
  status: string; batch_date: string; jugs_scrapped: number; operator: string | null;
  product_id: string; product_name: string; bottles_per_case: number; is_returnable: boolean;
  cases: number; loose_bottles: number; total_bottles: number;
}

async function lockRun(t: Queryable, batchId: string): Promise<RunRow> {
  const run = await t.maybeOne<RunRow>(
    `SELECT pb.status, pb.batch_date::text AS batch_date, pb.jugs_scrapped, pb.operator,
            li.product_id, p.name AS product_name, p.bottles_per_case, p.is_returnable,
            li.cases, li.loose_bottles, li.total_bottles
     FROM production_batches pb
     JOIN production_batch_line_items li ON li.batch_id = pb.id
     JOIN products p ON p.id = li.product_id
     WHERE pb.id = $1 FOR UPDATE OF pb`, [batchId],
  );
  if (!run) throw new RuleViolation('that production run no longer exists');
  if (run.status === 'Reversed') throw new RuleViolation('that run has been deleted');
  if (run.status !== 'Completed') throw new RuleViolation('only a completed run can be changed');
  return run;
}

/**
 * Put back everything a run did to stock, and retire its rows so they are
 * not counted again (an edit records the run afresh under the same name):
 *   - the finished bottles come back off stock (they must still be there,
 *     less any the edited run will add back - `comingBack`);
 *   - each material goes back into the FIFO layers it was drawn from, the
 *     newest first, never above what a layer received (invariant 9);
 *   - a 5-gallon run's empties go back to the plant, scrapped jugs included.
 * The ledger keeps every row: the originals are relabelled "(deleted)" or
 * "(before edit)" and the put-backs are recorded beside them.
 */
async function takeRunBack(
  t: Queryable, batchId: string, run: RunRow, why: string, mode: 'delete' | 'edit', comingBack = 0,
  evenIfShort = false,
): Promise<{ hadEmpties: boolean }> {
  const bottles = num(run.total_bottles);
  const ref = `Production ${batchId}`;
  const backRef = mode === 'delete' ? `Deleted production ${batchId}` : `Edit of production ${batchId}`;
  const retired = mode === 'delete' ? `${ref} (deleted)` : `${ref} (before edit)`;
  const note = mode === 'delete' ? `Run deleted: ${why}` : `Run edited: ${why}`;

  const fg = await t.maybeOne<{ q: number }>(
    `SELECT quantity_on_hand AS q FROM finished_goods_stock WHERE product_id = $1 FOR UPDATE`, [run.product_id]);
  const onHand = num(fg?.q ?? 0);
  if (onHand + comingBack < bottles && !evenIfShort) {
    throw new RuleViolation(`only ${onHand} ${run.product_name} bottles are in stock, and this would take off ${bottles - comingBack}. `
      + `Some have gone out already, so the run cannot be ${mode === 'delete' ? 'deleted' : 'made smaller'} unless you confirm it was never made `
      + `(stock would go to ${onHand + comingBack - bottles}); then count the stock`);
  }
  await t.query(`UPDATE finished_goods_stock SET quantity_on_hand = quantity_on_hand - $2 WHERE product_id = $1`,
    [run.product_id, bottles]);
  await t.query(
    `INSERT INTO inventory_transactions
       (item_type, item_id, item_name, quantity, direction, reference, reference_type, notes)
     VALUES ('FinishedGoods',$1,$2,$3,'out',$4,'Adjustment',$5)`,
    [run.product_id, run.product_name, bottles, backRef, note],
  );

  const jug = await jugMaterial(t);
  const outs = await t.query<{ item_id: string; item_name: string; quantity: string; total_cost_cents: string | null;
    batch_ids: string[]; reference_type: string }>(
    `SELECT item_id, item_name, quantity::text AS quantity, total_cost_cents::text AS total_cost_cents,
            batch_ids, reference_type
     FROM inventory_transactions
     WHERE reference = $1 AND item_type = 'RawMaterial' AND direction = 'out'`, [ref],
  );
  let hadEmpties = false;
  for (const o of outs) {
    const qty = Number(o.quantity);
    if (jug && o.item_id === jug.id) {
      hadEmpties = true;
      // ProductionBatch = jugs filled; JugsScrapped = jugs thrown out on the run.
      await moveEmpties(t, Math.round(qty), o.reference_type === 'JugsScrapped' ? 'JugsScrapped' : 'Adjustment', backRef,
        `${Math.round(qty)} jug${qty === 1 ? '' : 's'} back to the empties: ${mode === 'delete' ? 'run deleted' : 'run edited'}`,
        { day: run.batch_date });
      continue;
    }
    let left = qty;
    for (const id of [...(o.batch_ids ?? [])].reverse()) {
      if (left <= 1e-9) break;
      const b = await t.maybeOne<{ room: string }>(
        `SELECT (quantity_received - quantity_remaining)::text AS room FROM material_batches WHERE id = $1 FOR UPDATE`, [id]);
      const put = Math.min(left, Number(b?.room ?? 0));
      if (put <= 0) continue;
      await t.query(
        `UPDATE material_batches SET quantity_remaining = quantity_remaining + $2, status = 'Open' WHERE id = $1`, [id, put]);
      left -= put;
    }
    if (left > 1e-6) throw new RuleViolation(`${o.item_name} cannot be put back where it came from; ask for help before changing this run`);
    await t.query(`UPDATE raw_materials SET quantity_on_hand = quantity_on_hand + $2 WHERE id = $1`, [o.item_id, qty]);
    await t.query(
      `INSERT INTO inventory_transactions
         (item_type, item_id, item_name, quantity, direction, reference, reference_type,
          total_cost_cents, batch_ids, notes)
       VALUES ('RawMaterial',$1,$2,$3,'in',$4,'Adjustment',$5,$6,$7)`,
      [o.item_id, o.item_name, qty, backRef, o.total_cost_cents == null ? null : Number(o.total_cost_cents),
       o.batch_ids ?? [], note],
    );
  }
  // Retire the run's own rows: the run's cost and a later edit read only live ones.
  await t.query(`UPDATE inventory_transactions SET reference = $2 WHERE reference = $1`, [ref, retired]);
  return { hadEmpties };
}

/**
 * Delete a production run entered by mistake (Everton, 11 Nov 2026: three
 * runs of Fri 6 Nov were entered twice). Admin only; a reason is required.
 * Everything the run did to stock is put back (takeRunBack). Refused if the
 * bottles are no longer in stock (already sold or loaded): then the run
 * happened and a stock count is the right correction. The run leaves the
 * list; the stock ledger and the audit log keep the record.
 */
export async function deleteProduction(
  db: Db, actor: Actor, batchId: string, reason: string,
  /** A run entered twice that was never made (12 Nov 2026): delete it even if stock goes below zero. */
  opts: { evenIfShort?: boolean } = {},
): Promise<{ bottles: number; productName: string; stockAfter: number }> {
  requireRole(actor, 'admin');
  const why = (reason ?? '').trim();
  if (!why) throw new RuleViolation('say why the run is being deleted');
  return db.tx(async (t) => {
    const run = await lockRun(t, batchId);
    const bottles = num(run.total_bottles);
    const { hadEmpties } = await takeRunBack(t, batchId, run, why, 'delete', 0, !!opts.evenIfShort);
    const after = await t.maybeOne<{ q: number }>(`SELECT quantity_on_hand AS q FROM finished_goods_stock WHERE product_id = $1`, [run.product_id]);
    await t.query(
      `UPDATE production_batches SET status = 'Reversed', reversed_at = now(), reversed_by_id = $2, reversed_reason = $3
       WHERE id = $1`, [batchId, actor.id, why]);
    await audit(t, actor, 'delete', 'ProductionBatch', batchId, run.product_name, {
      deleted: true, reason: why, bottles, batchDate: run.batch_date, evenIfShort: opts.evenIfShort || undefined,
      summary: `Production run of ${bottles} ${run.product_name} on ${run.batch_date} deleted: stock, materials${hadEmpties ? ' and empties' : ''} put back.`,
    });
    return { bottles, productName: run.product_name, stockAfter: num(after?.q ?? 0) };
  });
}

/**
 * Edit a production run entered wrongly (Everton, 11 Nov 2026): the day, the
 * operator, the cases / bottles, the jugs scrapped. Admin only. The product
 * cannot change - delete the run and enter it again.
 *
 * Only the day or operator changed: updated in place (a 5-gallon run's
 * empties rows move to the new day). Anything about the quantity changed:
 * the old run is taken back (takeRunBack) and recorded afresh under the same
 * run, all in one transaction - so a run made bigger needs the materials, and
 * one made smaller needs the bottles it gives back still in stock.
 */
export async function editProduction(
  db: Db, actor: Actor, batchId: string,
  input: { productionDate?: string | null; operator?: string | null; cases?: number; looseBottles?: number;
    jugsScrapped?: number | null; reason?: string | null },
): Promise<{ bottles: number; productName: string; redone: boolean }> {
  requireRole(actor, 'admin');
  return db.tx(async (t) => {
    const run = await lockRun(t, batchId);
    const day = input.productionDate === undefined ? run.batch_date : (checkRunDay(input.productionDate) ?? businessToday());
    const operator = input.operator === undefined ? run.operator : ((input.operator ?? '').trim() || run.operator);
    const size = runSize(run, {
      cases: input.cases ?? num(run.cases),
      looseBottles: input.looseBottles ?? num(run.loose_bottles),
      jugsScrapped: input.jugsScrapped ?? num(run.jugs_scrapped),
    });
    const why = (input.reason ?? '').trim() || 'entered wrongly';
    const was = { day: run.batch_date, operator: run.operator, bottles: num(run.total_bottles),
      cases: num(run.cases), loose: num(run.loose_bottles), scrapped: num(run.jugs_scrapped) };
    const sizeChanged = size.bottles !== was.bottles || size.scrapped !== was.scrapped
      || size.cases !== was.cases || size.loose !== was.loose;
    if (!sizeChanged && day === was.day && operator === was.operator) {
      throw new RuleViolation('nothing has been changed');
    }

    if (sizeChanged) {
      await takeRunBack(t, batchId, run, why, 'edit', size.bottles);
      await t.query(
        `UPDATE production_batch_line_items SET cases = $2, loose_bottles = $3, total_bottles = $4 WHERE batch_id = $1`,
        [batchId, size.cases, size.loose, size.bottles]);
      await runMovements(t, actor, batchId, run.product_id,
        { name: run.product_name, is_returnable: run.is_returnable }, size.bottles, size.scrapped, day);
    } else if (day !== was.day) {
      // Same run, another day: its empties rows are dated by the day.
      await t.query(
        `UPDATE inventory_transactions SET txn_date = ($2::text || 'T12:00:00-05:00')::timestamptz
         WHERE reference = $1 AND reference_type IN ('ProductionBatch','JugsScrapped') AND item_type = 'RawMaterial'
           AND item_id IN (SELECT id FROM raw_materials WHERE is_returnable_jug)`, [`Production ${batchId}`, day]);
    }
    await t.query(
      `UPDATE production_batches SET batch_date = $2::date, operator = $3, jugs_scrapped = $4 WHERE id = $1`,
      [batchId, day, operator, size.scrapped]);

    const changes: string[] = [];
    if (day !== was.day) changes.push(`day ${was.day} to ${day}`);
    if (operator !== was.operator) changes.push(`operator ${was.operator ?? '-'} to ${operator ?? '-'}`);
    if (size.bottles !== was.bottles) changes.push(`${was.bottles} to ${size.bottles} bottles`);
    if (size.scrapped !== was.scrapped) changes.push(`jugs scrapped ${was.scrapped} to ${size.scrapped}`);
    await audit(t, actor, 'update', 'ProductionBatch', batchId, run.product_name, {
      edited: true, reason: input.reason ?? null, before: was,
      after: { day, operator, bottles: size.bottles, cases: size.cases, loose: size.loose, scrapped: size.scrapped },
      summary: `Production run of ${run.product_name} changed: ${changes.join(', ')}.`,
    });
    return { bottles: size.bottles, productName: run.product_name, redone: sizeChanged };
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
  /** 5-gallon products: the empties a run of this size draws on. Never blocks. */
  empties: { onRecord: number; needed: number; short: number; material: string } | null;
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
     WHERE b.product_id = $1 AND NOT rm.is_returnable_jug ORDER BY b.component_type`,
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

  const p = await db.maybeOne<{ is_returnable: boolean }>(
    `SELECT is_returnable FROM products WHERE id = $1`, [productId]);
  const jug = p?.is_returnable ? await jugMaterial(db) : null;
  const empties = jug
    ? { onRecord: jug.onHand, needed: bottles, short: Math.max(bottles - jug.onHand, 0), material: jug.name }
    : null;

  return {
    canProduce: bom.length > 0 && components.every((c) => c.shortfall === 0),
    estimatedCostCents,
    empties,
    components,
  };
}

export async function listPurchaseOrders(db: Db, status?: string) {
  return db.query(
    `SELECT po.*, s.name AS supplier_name,
            (SELECT COUNT(*)::int FROM po_line_items l WHERE l.po_id = po.id) AS line_count,
            -- Still to come in (11 Nov 2026): the unreceived share of each line, taxes
            -- included; nothing once the PO is closed, cancelled or fully received.
            CASE WHEN po.status IN ('Cancelled','Partially Received - Closed','Received') THEN 0 ELSE
              (SELECT COALESCE(ROUND(SUM(
                 (l.line_total_cents + l.gct_cents + l.env_tax_cents)
                 * GREATEST(l.quantity_ordered - l.quantity_received, 0) / NULLIF(l.quantity_ordered, 0))), 0)::bigint
               FROM po_line_items l WHERE l.po_id = po.id) END AS pending_cents,
            CASE WHEN po.status IN ('Cancelled','Partially Received - Closed','Received') THEN 0 ELSE
              (SELECT COALESCE(SUM(GREATEST(l.quantity_ordered - l.quantity_received, 0)), 0)::float
               FROM po_line_items l WHERE l.po_id = po.id) END AS pending_qty
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
    `SELECT pb.id, pb.batch_date::text AS batch_date, pb.operator, pb.status, pb.notes, pb.jugs_scrapped,
            p.name AS product_name, p.bottles_per_case, p.is_returnable, li.cases, li.loose_bottles, li.total_bottles,
            (SELECT COALESCE(SUM(total_cost_cents),0) FROM inventory_transactions it
             WHERE it.reference = 'Production ' || pb.id::text
               AND it.item_type = 'RawMaterial') AS material_cost_cents
     FROM production_batches pb
     LEFT JOIN production_batch_line_items li ON li.batch_id = pb.id
     LEFT JOIN products p ON p.id = li.product_id
     -- A deleted run leaves the list (11 Nov 2026); the ledger and audit log keep it.
     WHERE pb.status <> 'Reversed'
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
