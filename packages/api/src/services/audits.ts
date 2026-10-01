/**
 * Physical stock counts and reconciliation (Section 2, InventoryAudit).
 *
 * Counting semantics, fixed here so every screen and report agrees:
 *
 *   system_qty  - what the system believed was on hand at the moment of count
 *   counted_qty - total units physically found
 *   damaged_qty - of those found, how many are unusable
 *   usable      - counted_qty - damaged_qty
 *   discrepancy - usable - system_qty   (negative = shrinkage)
 *
 * Counting alone changes nothing. An audit sits Open until it is explicitly
 * reconciled, and only reconciliation moves stock - so a miscount can be
 * corrected before it touches the books.
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit as writeAudit, requireRole, num } from './core.ts';
import { RuleViolation, drawFifo, blendedAverageCost, type Batch } from '@alka/shared';

export interface CountInput {
  itemType: 'RawMaterial' | 'FinishedGoods';
  itemId: string;
  /** Units (raw materials) or bottles (finished goods). */
  countedQty?: number;
  /** Finished goods: full cases and loose bottles; countedQty is worked out. */
  countedCases?: number | null;
  countedLoose?: number | null;
  damagedQty?: number;
  notes?: string | null;
}

/** Record a physical count. Stock is NOT changed until reconciliation. */
export async function recordCount(
  db: Db,
  actor: Actor,
  input: CountInput,
): Promise<{
  id: string; itemName: string; systemQty: number;
  usableQty: number; discrepancy: number;
}> {
  requireRole(actor, 'admin', 'user');

  return db.tx(async (t) => {
    // Finished goods are counted the way they sit on the floor: full cases,
    // then any loose bottles from the run (team feedback, point 20).
    let counted = Number(input.countedQty ?? 0);
    let cases: number | null = null;
    let loose: number | null = null;
    if (input.itemType === 'FinishedGoods' && (input.countedCases != null || input.countedLoose != null)) {
      const p = await t.one<{ bottles_per_case: number }>(
        `SELECT bottles_per_case FROM products WHERE id = $1`, [input.itemId],
      );
      cases = Math.max(0, Math.round(Number(input.countedCases) || 0));
      loose = Math.max(0, Math.round(Number(input.countedLoose) || 0));
      const bpc = num(p.bottles_per_case);
      counted = bpc > 0 ? cases * bpc + loose : loose + cases;
    }
    if (!Number.isFinite(counted) || counted < 0) throw new RuleViolation('a counted quantity cannot be negative');
    const damaged = input.damagedQty ?? 0;
    if (damaged < 0) throw new RuleViolation('a damaged quantity cannot be negative');
    if (damaged > counted) {
      throw new RuleViolation('damaged units cannot exceed the number counted');
    }

    const { name, systemQty } = await currentStock(t, input.itemType, input.itemId);
    const usable = counted - damaged;
    const discrepancy = usable - systemQty;
    // A difference has to be explained before it is saved (point 20): that
    // explanation is what the variance report is for.
    if (Math.abs(discrepancy) > 1e-9 && !input.notes?.trim()) {
      throw new RuleViolation(
        `${name}: the count is ${discrepancy > 0 ? 'over' : 'short'} by ${Math.abs(Math.round(discrepancy * 1000) / 1000)}. `
        + 'Say why in the notes before saving it.',
      );
    }

    const row = await t.one<{ id: string }>(
      `INSERT INTO inventory_audits
         (item_type, item_id, item_name, system_qty, counted_qty,
          damaged_qty, discrepancy, notes, counted_cases, counted_loose, counted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [input.itemType, input.itemId, name, systemQty,
       counted, damaged, discrepancy, input.notes?.trim() || null, cases, loose, actor.name],
    );
    input = { ...input, countedQty: counted };

    await writeAudit(t, actor, 'create', 'InventoryAudit', row.id, name, {
      itemType: input.itemType, systemQty, countedQty: counted,
      damagedQty: damaged, discrepancy, stockChanged: false,
    });

    return { id: row.id, itemName: name, systemQty, usableQty: usable, discrepancy };
  });
}

/**
 * What has moved for this item since the count was taken.
 *
 * Confirming a count sets stock to the counted figure outright, so anything
 * that moved in between is about to be overwritten. This is what lets the
 * office see that before it happens rather than after.
 */
export async function movementsSinceCount(db: Db, auditId: string): Promise<{
  countedAt: string;
  movements: Array<{ at: string; direction: string; quantity: number; what: string }>;
  netChange: number;
}> {
  const a = await db.one<{ item_type: string; item_id: string; counted_at: string }>(
    `SELECT item_type, item_id, counted_at FROM inventory_audits WHERE id = $1`, [auditId],
  );
  const rows = await db.query<{
    txn_date: string; direction: string; quantity: string; reference_type: string;
    reference: string | null;
  }>(
    `SELECT txn_date, direction, quantity, reference_type, reference
     FROM inventory_transactions
     WHERE item_type = $1 AND item_id = $2 AND txn_date > $3
     ORDER BY txn_date`,
    [a.item_type, a.item_id, a.counted_at],
  );

  let netChange = 0;
  const movements = rows.map((r) => {
    const qty = num(r.quantity);
    netChange += r.direction === 'out' ? -qty : qty;
    return {
      at: r.txn_date,
      direction: r.direction,
      quantity: qty,
      what: r.reference ? `${r.reference_type} (${r.reference})` : r.reference_type,
    };
  });
  return { countedAt: a.counted_at, movements, netChange };
}

/**
 * Apply a count to stock. Admin only - this writes off real value.
 *
 * A shortage draws FIFO from the oldest open batches, so the write-off is
 * valued at what the missing stock actually cost. An overage is added as a
 * new batch priced at the current blended average, which is an estimate and
 * is labelled as one on the transaction.
 *
 * REFUSED IF STOCK MOVED SINCE THE COUNT WAS TAKEN. Because the counted
 * figure is written outright rather than added to, a count confirmed after a
 * delivery has gone out would put the delivered stock back - the movement
 * keeps its history, but the quantity ends as though it never happened. The
 * fix for a stale count is to count again, so that is the default. Passing
 * `evenThoughStockMoved` overrides it for the case where the counter really
 * did see the floor after those movements; the override is recorded on the
 * count and in the audit trail, because it means a deliberate overwrite.
 */
export async function reconcileCount(
  db: Db,
  actor: Actor,
  auditId: string,
  notes?: string,
  opts: { evenThoughStockMoved?: boolean } = {},
): Promise<{ adjusted: number; valueCents: number; overrodeMovements: boolean }> {
  requireRole(actor, 'admin');

  return db.tx(async (t) => {
    const a = await t.one<{
      id: string; item_type: 'RawMaterial' | 'FinishedGoods'; item_id: string;
      item_name: string; counted_qty: number; damaged_qty: number; status: string;
      counted_at: string;
    }>(
      `SELECT id, item_type, item_id, item_name, counted_qty, damaged_qty, status,
              counted_at
       FROM inventory_audits WHERE id = $1 FOR UPDATE`, [auditId],
    );
    if (a.status === 'Reconciled') {
      throw new RuleViolation('this count has already been reconciled');
    }

    const moved = await t.query<{ direction: string; quantity: string; reference_type: string }>(
      `SELECT direction, quantity, reference_type
       FROM inventory_transactions
       WHERE item_type = $1 AND item_id = $2 AND txn_date > $3
       ORDER BY txn_date`,
      [a.item_type, a.item_id, a.counted_at],
    );

    if (moved.length > 0 && !opts.evenThoughStockMoved) {
      const inQty = moved.filter((m) => m.direction !== 'out')
        .reduce((s, m) => s + num(m.quantity), 0);
      const outQty = moved.filter((m) => m.direction === 'out')
        .reduce((s, m) => s + num(m.quantity), 0);
      const kinds = [...new Set(moved.map((m) => m.reference_type))].join(', ');
      const parts = [
        outQty > 0 ? `${outQty} went out` : null,
        inQty > 0 ? `${inQty} came in` : null,
      ].filter(Boolean).join(' and ');

      throw new RuleViolation(
        `${a.item_name} has moved since this count was taken — ${parts} (${kinds}). ` +
        'Confirming would set stock to the counted figure and overwrite those movements. ' +
        'Count again, or confirm anyway if you counted after they happened.',
      );
    }
    const overrodeMovements = moved.length > 0;

    // Re-read stock now rather than trusting the figure captured at count
    // time: deliveries and production may have moved it in between.
    const { systemQty } = await currentStock(t, a.item_type, a.item_id);
    const usable = num(a.counted_qty) - num(a.damaged_qty);
    const delta = usable - systemQty;

    let valueCents = 0;

    if (a.item_type === 'RawMaterial') {
      // Always run: even when the headline quantity already matches, the FIFO
      // layers underneath may not, and the count is what settles it.
      valueCents = await adjustRawMaterial(t, a.item_id, a.item_name, usable, auditId);
    } else if (delta !== 0) {
      await t.query(
        `INSERT INTO finished_goods_stock (product_id, quantity_on_hand)
         VALUES ($1,$2)
         ON CONFLICT (product_id) DO UPDATE
           SET quantity_on_hand = GREATEST(
                 finished_goods_stock.quantity_on_hand + EXCLUDED.quantity_on_hand, 0)`,
        [a.item_id, delta],
      );
      await t.query(
        `INSERT INTO inventory_transactions
           (item_type, item_id, item_name, quantity, direction,
            reference, reference_type, notes)
         VALUES ('FinishedGoods',$1,$2,$3,$4,$5,'Adjustment',$6)`,
        [a.item_id, a.item_name, Math.abs(delta), delta > 0 ? 'in' : 'out',
         `Stock count ${auditId}`, notes ?? 'Reconciled from physical count'],
      );
    }

    // An override is written onto the count itself, not just the audit log:
    // whoever reads this count later needs to see that it was applied over
    // movements rather than to a settled figure.
    const trail = [
      notes ? `\n${notes}` : '',
      overrodeMovements
        ? `\nConfirmed over ${moved.length} movement(s) made after the count was taken.`
        : '',
    ].join('');

    await t.query(
      `UPDATE inventory_audits
       SET status = 'Reconciled', system_qty = $2, discrepancy = $3,
           notes = COALESCE(notes,'') || $4, reconciled_by = $5, reconciled_at = now()
       WHERE id = $1`,
      [auditId, systemQty, delta, trail, actor.name],
    );

    await writeAudit(t, actor, 'adjust', 'InventoryAudit', auditId, a.item_name, {
      itemType: a.item_type, systemQty, usableCounted: usable,
      adjustment: delta, valueCents, notes: notes ?? null,
      overrodeMovements, movementsOverwritten: moved.length,
    });

    return { adjusted: delta, valueCents, overrodeMovements };
  });
}

/**
 * Bring raw-material stock into line with a physical count.
 *
 * The count is authoritative: after this runs, BOTH the material's headline
 * quantity and the sum of its open FIFO layers equal exactly what was
 * counted. Working to a target rather than applying a delta means a count
 * also repairs any pre-existing discrepancy between the two, instead of
 * carrying it forward forever.
 *
 * The movement is still valued properly: a reduction draws FIFO at real batch
 * cost, an increase creates a layer at the current blended average.
 */
async function adjustRawMaterial(
  t: Queryable,
  materialId: string,
  materialName: string,
  targetQty: number,
  auditId: string,
): Promise<number> {
  const rows = await t.query<{
    id: string; unit_cost_cents: number; quantity_remaining: number; supplier_id: string | null;
  }>(
    `SELECT id, unit_cost_cents, quantity_remaining, supplier_id
     FROM material_batches
     WHERE raw_material_id = $1 AND status = 'Open' AND quantity_remaining > 0
     ORDER BY received_date, id`,
    [materialId],
  );
  const batches: Batch[] = rows.map((r) => ({
    id: r.id,
    unitCostCents: num(r.unit_cost_cents),
    quantityRemaining: num(r.quantity_remaining),
    supplierId: r.supplier_id,
  }));

  let valueCents = 0;
  let batchIds: string[] = [];

  // Measured against the LAYERS, not the headline quantity, so the layers
  // land exactly on the counted figure whatever the headline said before.
  const layerTotal = batches.reduce((s, b) => s + b.quantityRemaining, 0);
  const appliedDelta = Math.round((targetQty - layerTotal) * 1000) / 1000;

  if (appliedDelta < 0) {
    const draw = drawFifo(batches, Math.abs(appliedDelta));
    for (const slice of draw.slices) {
      await t.query(
        `UPDATE material_batches
         SET quantity_remaining = quantity_remaining - $2,
             status = CASE WHEN quantity_remaining - $2 <= 0 THEN 'Consumed' ELSE 'Open' END
         WHERE id = $1`,
        [slice.batchId, slice.quantity],
      );
    }
    valueCents = draw.totalCostCents;
    batchIds = draw.slices.map((s) => s.batchId);
  } else if (appliedDelta > 0) {
    // Found more than the layers hold. Value it at the blended average of
    // what is in stock; there is no real receipt to price it against.
    const unitCost = blendedAverageCost(batches);
    const created = await t.one<{ id: string }>(
      `INSERT INTO material_batches
         (raw_material_id, unit_cost_cents, quantity_received, quantity_remaining)
       VALUES ($1,$2,$3,$3) RETURNING id`,
      [materialId, unitCost, appliedDelta],
    );
    valueCents = Math.round(unitCost * appliedDelta);
    batchIds = [created.id];
  }

  // Set outright rather than incrementing: the count is the truth.
  await t.query(
    `UPDATE raw_materials SET quantity_on_hand = $2 WHERE id = $1`,
    [materialId, targetQty],
  );

  if (appliedDelta !== 0) {
    await t.query(
      `INSERT INTO inventory_transactions
         (item_type, item_id, item_name, quantity, direction, reference,
          reference_type, unit_cost_cents, total_cost_cents, batch_ids, notes)
       VALUES ('RawMaterial',$1,$2,$3,$4,$5,'Adjustment',$6,$7,$8,$9)`,
      [materialId, materialName, Math.abs(appliedDelta), appliedDelta > 0 ? 'in' : 'out',
       `Stock count ${auditId}`,
       Math.round(valueCents / Math.abs(appliedDelta)),
       valueCents, batchIds,
       appliedDelta > 0
         ? 'Overage found at stock count, valued at blended average (estimate)'
         : 'Shortage written off at stock count, valued FIFO'],
    );
  }

  return valueCents;
}

async function currentStock(
  t: Queryable,
  itemType: 'RawMaterial' | 'FinishedGoods',
  itemId: string,
): Promise<{ name: string; systemQty: number }> {
  if (itemType === 'RawMaterial') {
    const m = await t.maybeOne<{ name: string; quantity_on_hand: number }>(
      `SELECT name, quantity_on_hand FROM raw_materials WHERE id = $1`, [itemId],
    );
    if (!m) throw new RuleViolation(`raw material ${itemId} not found`);
    return { name: m.name, systemQty: num(m.quantity_on_hand) };
  }
  const p = await t.maybeOne<{ name: string; qty: number }>(
    `SELECT p.name, COALESCE(f.quantity_on_hand, 0) AS qty
     FROM products p LEFT JOIN finished_goods_stock f ON f.product_id = p.id
     WHERE p.id = $1`, [itemId],
  );
  if (!p) throw new RuleViolation(`product ${itemId} not found`);
  return { name: p.name, systemQty: num(p.qty) };
}

export async function listAudits(
  db: Db, status?: 'Open' | 'Reconciled', range: { from?: string | null; to?: string | null } = {},
) {
  return db.query(
    `SELECT a.*, a.audit_date::text AS audit_date, p.bottles_per_case,
            rm.unit_of_measure,
            (a.counted_qty - a.damaged_qty) AS usable_qty
     FROM inventory_audits a
     LEFT JOIN products p ON a.item_type = 'FinishedGoods' AND p.id = a.item_id
     LEFT JOIN raw_materials rm ON a.item_type = 'RawMaterial' AND rm.id = a.item_id
     WHERE ($1::text IS NULL OR a.status = $1)
       AND ($2::date IS NULL OR a.audit_date >= $2::date)
       AND ($3::date IS NULL OR a.audit_date <= $3::date)
     ORDER BY a.audit_date DESC, a.counted_at DESC, a.item_name`,
    [status ?? null, range.from || null, range.to || null],
  );
}

/**
 * Stock on hand, the way the floor is counted (team feedback, point 20).
 *
 * Finished goods in full cases plus the loose bottles left from a run - the
 * loose ones are assumed to go into the next case run, so they are shown
 * separately rather than as a fraction of a case. Raw materials as plain
 * units, with how many cases of each product that uses them they would make.
 */
export async function stockSnapshot(db: Db) {
  const goods = await db.query<{
    product_id: string; name: string; size: string | null; bottles_per_case: number; bottles: number;
    is_returnable: boolean; last_counted: string | null;
  }>(
    `SELECT p.id AS product_id, p.name, p.size, p.bottles_per_case, p.is_returnable,
            COALESCE(f.quantity_on_hand, 0)::int AS bottles,
            (SELECT MAX(audit_date)::text FROM inventory_audits a
              WHERE a.item_type = 'FinishedGoods' AND a.item_id = p.id) AS last_counted
     FROM products p LEFT JOIN finished_goods_stock f ON f.product_id = p.id
     WHERE p.active ORDER BY p.name`,
  );
  const materials = await db.query<{
    id: string; name: string; unit_of_measure: string; quantity_on_hand: number;
    reorder_point: number | null; category: string | null; last_counted: string | null;
  }>(
    `SELECT rm.id, rm.name, rm.unit_of_measure, rm.quantity_on_hand, rm.reorder_point,
            rm.category,
            (SELECT MAX(audit_date)::text FROM inventory_audits a
              WHERE a.item_type = 'RawMaterial' AND a.item_id = rm.id) AS last_counted
     FROM raw_materials rm LEFT JOIN material_categories mc ON mc.name = rm.category
     WHERE rm.retired_at IS NULL OR rm.quantity_on_hand > 0
     ORDER BY mc.sort_order NULLS LAST, rm.category NULLS LAST, rm.name`,
  );
  const bom = await db.query<{ raw_material_id: string; product_id: string; product_name: string;
    quantity: number; bottles_per_case: number }>(
    `SELECT b.raw_material_id, b.product_id, p.name AS product_name, b.quantity, p.bottles_per_case
     FROM bom_line_items b JOIN products p ON p.id = b.product_id WHERE p.active`,
  );
  return {
    finishedGoods: goods.map((g) => {
      const bpc = num(g.bottles_per_case);
      const bottles = num(g.bottles);
      return {
        productId: g.product_id, name: g.name, size: g.size, bottlesPerCase: bpc,
        bottles, isReturnable: g.is_returnable,
        cases: bpc > 0 ? Math.floor(Math.max(bottles, 0) / bpc) : null,
        loose: bpc > 0 ? Math.max(bottles, 0) % bpc : bottles,
        lastCounted: g.last_counted,
      };
    }),
    rawMaterials: materials.map((m) => {
      const onHand = num(m.quantity_on_hand);
      const makes = bom.filter((b) => b.raw_material_id === m.id && num(b.quantity) > 0).map((b) => {
        const perCase = num(b.quantity) * (num(b.bottles_per_case) > 0 ? num(b.bottles_per_case) : 1);
        return {
          productId: b.product_id, productName: b.product_name,
          perCase: Math.round(perCase * 1000) / 1000,
          cases: Math.floor(Math.max(onHand, 0) / perCase),
          unit: num(b.bottles_per_case) > 0 ? 'cases' : 'bottles',
        };
      });
      return {
        id: m.id, name: m.name, unit: m.unit_of_measure, onHand, category: m.category,
        reorderPoint: m.reorder_point === null ? null : num(m.reorder_point),
        lastCounted: m.last_counted, makes,
      };
    }),
  };
}
