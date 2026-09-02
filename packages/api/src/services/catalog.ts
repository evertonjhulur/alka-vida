/**
 * Master data: suppliers, raw materials, the links between them, and bills
 * of material (Section 2).
 *
 * A material can have several suppliers, each with a standard cost and its
 * own volume price breaks. That structure is what lets a purchase order
 * auto-price a line from the supplier and quantity chosen.
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, requireRole, num } from './core.ts';
import type { Cents, MaterialCategory } from '@alka/shared';
import { RuleViolation } from '@alka/shared';

/* ------------------------------------------------------------------ */
/* Suppliers                                                           */
/* ------------------------------------------------------------------ */

export interface SupplierInput {
  name: string;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
}

export async function createSupplier(
  db: Db, actor: Actor, input: SupplierInput,
): Promise<{ id: string }> {
  requireRole(actor, 'admin', 'user');
  if (!input.name?.trim()) throw new RuleViolation('a supplier needs a name');

  return db.tx(async (t) => {
    const row = await t.one<{ id: string }>(
      `INSERT INTO suppliers (name, contact_person, phone, email, address, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [input.name.trim(), input.contactPerson ?? null, input.phone ?? null,
       input.email ?? null, input.address ?? null, input.notes ?? null],
    );
    await audit(t, actor, 'create', 'Supplier', row.id, input.name, {});
    return { id: row.id };
  });
}

/**
 * Change a supplier's details.
 *
 * Only the fields actually supplied are written. This was built out of
 * COALESCE, which meant a detail could be changed but never CLEARED - an
 * email address that had stopped working, or the phone number of a rep who
 * had left, could only ever be replaced, never emptied. Every field here bar
 * the name is optional contact detail, so clearing one is an ordinary thing
 * to want. Testing that the key is present, rather than that the value is
 * non-null, separates "leave it alone" from "empty it".
 */
export async function updateSupplier(
  db: Db, actor: Actor, supplierId: string, input: Partial<SupplierInput>,
): Promise<void> {
  requireRole(actor, 'admin', 'user');

  const sets: string[] = [];
  const args: unknown[] = [supplierId];
  const set = (col: string, value: unknown) => {
    args.push(value);
    sets.push(`${col} = $${args.length}`);
  };

  if ('name' in input) {
    if (!input.name?.trim()) throw new RuleViolation('a supplier needs a name');
    set('name', input.name.trim());
  }
  if ('contactPerson' in input) set('contact_person', input.contactPerson?.trim() || null);
  if ('phone' in input) set('phone', input.phone?.trim() || null);
  if ('email' in input) set('email', input.email?.trim() || null);
  if ('address' in input) set('address', input.address?.trim() || null);
  if ('notes' in input) set('notes', input.notes?.trim() || null);

  if (sets.length === 0) return;

  await db.tx(async (t) => {
    const before = await t.one<{ name: string }>(
      `SELECT name FROM suppliers WHERE id = $1`, [supplierId],
    );
    await t.query(`UPDATE suppliers SET ${sets.join(', ')} WHERE id = $1`, args);
    await audit(t, actor, 'update', 'Supplier', supplierId, input.name ?? before.name, input);
  });
}

/** Suppliers with the materials they supply and each material's price breaks. */
export async function listSuppliers(db: Db) {
  const suppliers = await db.query<Record<string, unknown>>(
    `SELECT * FROM suppliers ORDER BY name`,
  );
  const out = [];
  for (const s of suppliers) {
    const materials = await db.query<Record<string, unknown>>(
      `SELECT sm.raw_material_id, rm.name, rm.unit_of_measure, sm.unit_cost_cents
       FROM supplier_materials sm JOIN raw_materials rm ON rm.id = sm.raw_material_id
       WHERE sm.supplier_id = $1 ORDER BY rm.name`,
      [s.id],
    );
    const breaks = await db.query<Record<string, unknown>>(
      `SELECT spb.raw_material_id, rm.name, spb.min_qty, spb.unit_cost_cents
       FROM supplier_price_breaks spb JOIN raw_materials rm ON rm.id = spb.raw_material_id
       WHERE spb.supplier_id = $1 ORDER BY rm.name, spb.min_qty`,
      [s.id],
    );
    out.push({
      ...s,
      materials: materials.map((m) => ({
        rawMaterialId: m.raw_material_id as string,
        name: m.name as string,
        unitOfMeasure: m.unit_of_measure as string,
        unitCostCents: num(m.unit_cost_cents),
        priceBreaks: breaks
          .filter((b) => b.raw_material_id === m.raw_material_id)
          .map((b) => ({ minQty: num(b.min_qty), unitCostCents: num(b.unit_cost_cents) })),
      })),
    });
  }
  return out;
}

/**
 * Attach a material to a supplier at a standard cost, optionally with volume
 * price breaks. Re-running replaces that supplier's pricing for the material.
 *
 * Changing pricing here never rewrites costs on purchase orders already
 * issued - those froze their cost at creation.
 */
export async function setSupplierMaterial(
  db: Db,
  actor: Actor,
  input: {
    supplierId: string;
    rawMaterialId: string;
    unitCostCents: Cents;
    priceBreaks?: Array<{ minQty: number; unitCostCents: Cents }>;
  },
): Promise<void> {
  requireRole(actor, 'admin', 'user');
  if (input.unitCostCents < 0) throw new RuleViolation('a unit cost cannot be negative');

  await db.tx(async (t) => {
    await t.query(
      `INSERT INTO supplier_materials (supplier_id, raw_material_id, unit_cost_cents)
       VALUES ($1,$2,$3)
       ON CONFLICT (supplier_id, raw_material_id)
         DO UPDATE SET unit_cost_cents = EXCLUDED.unit_cost_cents`,
      [input.supplierId, input.rawMaterialId, input.unitCostCents],
    );

    await t.query(
      `DELETE FROM supplier_price_breaks WHERE supplier_id = $1 AND raw_material_id = $2`,
      [input.supplierId, input.rawMaterialId],
    );
    for (const b of input.priceBreaks ?? []) {
      if (b.minQty <= 0) throw new RuleViolation('a price break needs a positive minimum quantity');
      await t.query(
        `INSERT INTO supplier_price_breaks
           (supplier_id, raw_material_id, min_qty, unit_cost_cents)
         VALUES ($1,$2,$3,$4)`,
        [input.supplierId, input.rawMaterialId, b.minQty, b.unitCostCents],
      );
    }

    await audit(t, actor, 'update', 'Supplier', input.supplierId, input.supplierId, {
      rawMaterialId: input.rawMaterialId,
      unitCostCents: input.unitCostCents,
      priceBreaks: input.priceBreaks ?? [],
      note: 'affects future purchase orders only',
    });
  });
}

export async function removeSupplierMaterial(
  db: Db, actor: Actor, supplierId: string, rawMaterialId: string,
): Promise<void> {
  requireRole(actor, 'admin', 'user');
  await db.tx(async (t) => {
    await t.query(
      `DELETE FROM supplier_price_breaks WHERE supplier_id = $1 AND raw_material_id = $2`,
      [supplierId, rawMaterialId],
    );
    await t.query(
      `DELETE FROM supplier_materials WHERE supplier_id = $1 AND raw_material_id = $2`,
      [supplierId, rawMaterialId],
    );
    await audit(t, actor, 'delete', 'Supplier', supplierId, supplierId, { rawMaterialId });
  });
}

/* ------------------------------------------------------------------ */
/* Material categories and their sizes                                 */
/* ------------------------------------------------------------------ */

/**
 * Categories and the sizes under them are data the office manages, not a list
 * in the code (migration 010). Nothing in the business logic branches on a
 * material's category — it groups the screen and drives reorder alerts — so a
 * new one is safe by construction.
 *
 * Sizes exist to stop "28mm", "28 mm" and "28MM" becoming three materials
 * that never group, never total and never reorder together. A category with
 * no sizes takes free text, which is right for water, for handles, and for a
 * brand new category before its sizes are known.
 */
export interface MaterialCategoryInput {
  name: string;
  /** Replaces the category's sizes outright when given, the way supplier
   *  pricing is replaced. Omit to leave the existing sizes alone. */
  sizes?: string[];
}

export async function listMaterialCategories(db: Db) {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT c.id, c.name, c.retired_at, c.sort_order,
            COALESCE(m.n, 0)::int AS material_count,
            COALESCE(m.live, 0)::int AS live_material_count
     FROM material_categories c
     LEFT JOIN (
       SELECT category,
              COUNT(*) AS n,
              COUNT(*) FILTER (WHERE retired_at IS NULL) AS live
       FROM raw_materials GROUP BY category
     ) m ON m.category = c.name
     ORDER BY c.sort_order, c.name`,
  );

  const out = [];
  for (const c of rows) {
    const sizes = await db.query<{ name: string }>(
      `SELECT name FROM material_sizes WHERE category_id = $1 ORDER BY sort_order, name`,
      [c.id],
    );
    out.push({ ...c, sizes: sizes.map((s) => s.name) });
  }
  return out;
}

/** The category must exist and still be in use before anything is filed under it. */
async function assertCategoryUsable(db: Db, name: string): Promise<void> {
  const rows = await db.query<{ retired_at: string | null }>(
    `SELECT retired_at FROM material_categories WHERE name = $1`, [name],
  );
  if (rows.length === 0) throw new RuleViolation(`there is no category called "${name}"`);
  if (rows[0].retired_at != null) {
    throw new RuleViolation(`the category "${name}" has been retired; bring it back to use it`);
  }
}

/** Replace a category's sizes. Shared by create and update. */
async function writeSizes(t: Queryable, categoryId: string, sizes: string[]): Promise<void> {
  await t.query(`DELETE FROM material_sizes WHERE category_id = $1`, [categoryId]);
  let order = 10;
  const seen = new Set<string>();
  for (const raw of sizes) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    await t.query(
      `INSERT INTO material_sizes (category_id, name, sort_order) VALUES ($1,$2,$3)`,
      [categoryId, name, order],
    );
    order += 10;
  }
}

export async function createMaterialCategory(
  db: Db, actor: Actor, input: MaterialCategoryInput,
): Promise<{ id: string }> {
  requireRole(actor, 'admin');
  const name = input.name?.trim();
  if (!name) throw new RuleViolation('a category needs a name');

  return db.tx(async (t) => {
    const clash = await t.query<{ id: string }>(
      `SELECT id FROM material_categories WHERE lower(name) = lower($1)`, [name],
    );
    if (clash.length > 0) throw new RuleViolation(`there is already a category called "${name}"`);

    const last = await t.one<{ n: number }>(
      `SELECT COALESCE(MAX(sort_order), 0) + 10 AS n FROM material_categories`,
    );
    const row = await t.one<{ id: string }>(
      `INSERT INTO material_categories (name, sort_order) VALUES ($1,$2) RETURNING id`,
      [name, num(last.n)],
    );
    await writeSizes(t, row.id, input.sizes ?? []);
    await audit(t, actor, 'create', 'MaterialCategory', row.id, name, { sizes: input.sizes ?? [] });
    return { id: row.id };
  });
}

/**
 * Rename a category and/or replace its sizes.
 *
 * A material stores its category as text, so a rename has to carry the new
 * name across to every material filed under it and to their recipe lines. All
 * of it happens in one transaction: the alternative is a category whose
 * materials still answer to the old name and vanish from the screen.
 *
 * Removing a size that materials already carry is allowed and deliberate — it
 * stops the size being offered from now on without rewriting what those
 * materials are.
 */
export async function updateMaterialCategory(
  db: Db, actor: Actor, categoryId: string, input: Partial<MaterialCategoryInput>,
): Promise<void> {
  requireRole(actor, 'admin');
  await db.tx(async (t) => {
    const before = await t.one<{ name: string }>(
      `SELECT name FROM material_categories WHERE id = $1`, [categoryId],
    );
    const name = input.name?.trim();

    if (name && name !== before.name) {
      const clash = await t.query<{ id: string }>(
        `SELECT id FROM material_categories WHERE lower(name) = lower($1) AND id <> $2`,
        [name, categoryId],
      );
      if (clash.length > 0) throw new RuleViolation(`there is already a category called "${name}"`);

      await t.query(`UPDATE material_categories SET name = $2 WHERE id = $1`, [categoryId, name]);
      await t.query(`UPDATE raw_materials SET category = $2 WHERE category = $1`,
        [before.name, name]);
      await t.query(`UPDATE bom_line_items SET component_type = $2 WHERE component_type = $1`,
        [before.name, name]);
    }

    if (input.sizes) await writeSizes(t, categoryId, input.sizes);

    await audit(t, actor, 'update', 'MaterialCategory', categoryId, name ?? before.name, input);
  });
}

/**
 * Remove a category — truly if nothing is filed under it, by retiring it if
 * anything is. Same shape as removing a material, for the same reason:
 * deleting a category that materials answer to would orphan them.
 */
export async function deleteMaterialCategory(
  db: Db, actor: Actor, categoryId: string,
): Promise<{ deleted: boolean; retired: boolean; name: string; materialCount: number }> {
  requireRole(actor, 'admin');
  const category = await db.one<{ name: string }>(
    `SELECT name FROM material_categories WHERE id = $1`, [categoryId],
  );
  const used = await db.one<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM raw_materials WHERE category = $1`, [category.name],
  );
  const materialCount = num(used.n);

  return db.tx(async (t) => {
    if (materialCount === 0) {
      await t.query(`DELETE FROM material_categories WHERE id = $1`, [categoryId]);
      await audit(t, actor, 'delete', 'MaterialCategory', categoryId, category.name, {});
      return { deleted: true, retired: false, name: category.name, materialCount };
    }
    await t.query(
      `UPDATE material_categories SET retired_at = now() WHERE id = $1 AND retired_at IS NULL`,
      [categoryId],
    );
    await audit(t, actor, 'update', 'MaterialCategory', categoryId, category.name,
      { retired: materialCount });
    return { deleted: false, retired: true, name: category.name, materialCount };
  });
}

/** Put a retired category back into use. */
export async function restoreMaterialCategory(
  db: Db, actor: Actor, categoryId: string,
): Promise<void> {
  requireRole(actor, 'admin');
  await db.tx(async (t) => {
    const c = await t.one<{ name: string }>(
      `SELECT name FROM material_categories WHERE id = $1`, [categoryId]);
    await t.query(`UPDATE material_categories SET retired_at = NULL WHERE id = $1`, [categoryId]);
    await audit(t, actor, 'update', 'MaterialCategory', categoryId, c.name, { restored: true });
  });
}

/* ------------------------------------------------------------------ */
/* Raw materials                                                       */
/* ------------------------------------------------------------------ */

export interface RawMaterialInput {
  name: string;
  category: MaterialCategory;
  sizeSpec?: string | null;
  unitOfMeasure?: string;
  reorderPoint?: number;
  unitCostCents?: Cents;
  madeToOrder?: boolean;
  consigned?: boolean;
  brandId?: string | null;
  notes?: string | null;
}

export async function createRawMaterial(
  db: Db, actor: Actor, input: RawMaterialInput,
): Promise<{ id: string }> {
  requireRole(actor, 'admin', 'user');
  if (!input.name?.trim()) throw new RuleViolation('a material needs a name');
  // The permitted categories are a table now, so this is where they are checked.
  await assertCategoryUsable(db, input.category);

  return db.tx(async (t) => {
    const row = await t.one<{ id: string }>(
      `INSERT INTO raw_materials
         (name, category, size_spec, unit_of_measure, reorder_point,
          unit_cost_cents, made_to_order, consigned, brand_id, notes)
       VALUES ($1,$2,$3,COALESCE($4,'pcs'),COALESCE($5,0),COALESCE($6,0),
               COALESCE($7,false),COALESCE($8,false),$9,$10)
       RETURNING id`,
      [input.name.trim(), input.category, input.sizeSpec ?? null,
       input.unitOfMeasure ?? null, input.reorderPoint ?? null,
       input.unitCostCents ?? null, input.madeToOrder ?? null,
       input.consigned ?? null, input.brandId ?? null, input.notes ?? null],
    );
    await audit(t, actor, 'create', 'RawMaterial', row.id, input.name, {});
    return { id: row.id };
  });
}

/**
 * Change any part of a material.
 *
 * Only the fields actually supplied are written, so a caller sending just a
 * reorder point cannot blank the rest. The previous version built the update
 * out of COALESCE, which had the effect that a field could be changed but
 * never CLEARED — a cap entered as "28mm" could not be corrected back to no
 * size at all, because an empty size read as "leave it alone". Testing that
 * the key is present, rather than that the value is non-null, separates the
 * two.
 */
export async function updateRawMaterial(
  db: Db, actor: Actor, materialId: string, input: Partial<RawMaterialInput>,
): Promise<void> {
  requireRole(actor, 'admin', 'user');

  const sets: string[] = [];
  const args: unknown[] = [materialId];
  const set = (col: string, value: unknown) => {
    args.push(value);
    sets.push(`${col} = $${args.length}`);
  };

  if ('name' in input) {
    if (!input.name?.trim()) throw new RuleViolation('a material needs a name');
    set('name', input.name.trim());
  }
  if ('category' in input && input.category != null) {
    await assertCategoryUsable(db, input.category);
    set('category', input.category);
  }
  // The nullable text: an empty box means "clear it", not "skip it".
  if ('sizeSpec' in input) set('size_spec', input.sizeSpec?.trim() || null);
  if ('notes' in input) set('notes', input.notes?.trim() || null);
  if ('unitOfMeasure' in input && input.unitOfMeasure?.trim()) {
    set('unit_of_measure', input.unitOfMeasure.trim());
  }
  if ('reorderPoint' in input && input.reorderPoint != null) {
    if (input.reorderPoint < 0) throw new RuleViolation('a reorder point cannot be negative');
    set('reorder_point', input.reorderPoint);
  }
  if ('unitCostCents' in input && input.unitCostCents != null) {
    if (input.unitCostCents < 0) throw new RuleViolation('a cost cannot be negative');
    set('unit_cost_cents', input.unitCostCents);
  }
  if ('madeToOrder' in input && input.madeToOrder != null) set('made_to_order', input.madeToOrder);
  if ('consigned' in input && input.consigned != null) set('consigned', input.consigned);
  if ('brandId' in input) set('brand_id', input.brandId ?? null);

  if (sets.length === 0) return;

  await db.tx(async (t) => {
    const before = await t.one<{ name: string }>(
      `SELECT name FROM raw_materials WHERE id = $1`, [materialId],
    );
    await t.query(`UPDATE raw_materials SET ${sets.join(', ')} WHERE id = $1`, args);
    await audit(t, actor, 'update', 'RawMaterial', materialId, input.name ?? before.name, input);
  });
}

/**
 * What stands in the way of removing this material, in the words the person
 * pressing the button would use. An empty list means nothing has ever touched
 * it, so deleting it outright loses nothing.
 *
 * Supplier prices are deliberately not counted: they cascade away with the
 * material and describe what it would cost to buy, not anything that happened.
 */
export async function materialUsage(db: Db, materialId: string): Promise<string[]> {
  const recipes = await db.query<{ name: string }>(
    `SELECT p.name FROM bom_line_items b JOIN products p ON p.id = b.product_id
     WHERE b.raw_material_id = $1 ORDER BY p.name`, [materialId]);
  const poLines = await db.query<{ po_number: string }>(
    `SELECT po.po_number FROM po_line_items l
     JOIN purchase_orders po ON po.id = l.po_id
     WHERE l.raw_material_id = $1 ORDER BY po.po_number`, [materialId]);
  const batches = await db.one<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM material_batches WHERE raw_material_id = $1`, [materialId]);
  const txns = await db.one<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM inventory_transactions
     WHERE item_type = 'RawMaterial' AND item_id = $1`, [materialId]);
  const stock = await db.one<{ qty: string }>(
    `SELECT quantity_on_hand::text AS qty FROM raw_materials WHERE id = $1`, [materialId]);

  const reasons: string[] = [];
  if (recipes.length > 0) {
    reasons.push(`it is on the recipe for ${recipes.map((r) => r.name).join(', ')}`);
  }
  if (poLines.length > 0) {
    const shown = poLines.slice(0, 3).map((r) => r.po_number).join(', ');
    reasons.push(poLines.length > 3
      ? `it is on ${poLines.length} purchase orders (${shown}, …)`
      : `it is on purchase order ${shown}`);
  }
  if (num(batches.n) > 0) reasons.push('it has stock batches with real cost against them');
  if (num(txns.n) > 0) reasons.push('it has movement history');
  if (num(stock.qty) > 0) reasons.push(`there is still ${num(stock.qty)} on hand`);
  return reasons;
}

/**
 * Remove a material — truly if nothing has ever used it, by retiring it if
 * anything has.
 *
 * A material that has been bought, counted or built into a product carries
 * the cost of work already done. Deleting it would either be refused by the
 * database or would tear that record out from under past production, so it is
 * withdrawn from use instead: it keeps its history and its stock value, and
 * stops being offered for new purchase orders, recipes and usage. A material
 * nobody ever touched — a typo, a trial — is genuinely deleted, taking its
 * supplier prices with it.
 *
 * The caller is told which of the two happened, and why.
 */
export async function deleteRawMaterial(
  db: Db, actor: Actor, materialId: string,
): Promise<{ deleted: boolean; retired: boolean; name: string; reasons: string[] }> {
  requireRole(actor, 'admin');
  const material = await db.one<{ name: string; retired_at: string | null }>(
    `SELECT name, retired_at FROM raw_materials WHERE id = $1`, [materialId],
  );
  const reasons = await materialUsage(db, materialId);

  return db.tx(async (t) => {
    if (reasons.length === 0) {
      // supplier_materials and supplier_price_breaks cascade away with it.
      await t.query(`DELETE FROM raw_materials WHERE id = $1`, [materialId]);
      await audit(t, actor, 'delete', 'RawMaterial', materialId, material.name, {});
      return { deleted: true, retired: false, name: material.name, reasons };
    }
    if (material.retired_at == null) {
      await t.query(`UPDATE raw_materials SET retired_at = now() WHERE id = $1`, [materialId]);
    }
    await audit(t, actor, 'update', 'RawMaterial', materialId, material.name, { retired: reasons });
    return { deleted: false, retired: true, name: material.name, reasons };
  });
}

/** Put a retired material back into use. */
export async function restoreRawMaterial(
  db: Db, actor: Actor, materialId: string,
): Promise<void> {
  requireRole(actor, 'admin');
  await db.tx(async (t) => {
    const m = await t.one<{ name: string }>(
      `SELECT name FROM raw_materials WHERE id = $1`, [materialId]);
    await t.query(`UPDATE raw_materials SET retired_at = NULL WHERE id = $1`, [materialId]);
    await audit(t, actor, 'update', 'RawMaterial', materialId, m.name, { restored: true });
  });
}

/**
 * Every material with live stock, its FIFO batch position and who supplies it.
 * This is the raw-material management screen's data in one call.
 */
export async function listRawMaterials(db: Db) {
  const materials = await db.query<Record<string, unknown>>(
    `SELECT rm.*,
            COALESCE(b.open_batches, 0)     AS open_batches,
            COALESCE(b.batch_qty, 0)        AS batch_qty,
            b.oldest_cost_cents,
            b.newest_cost_cents,
            CASE WHEN COALESCE(b.batch_qty,0) > 0
                 THEN ROUND(b.stock_value_cents / b.batch_qty)
                 ELSE 0 END                 AS blended_cost_cents,
            COALESCE(b.stock_value_cents, 0) AS stock_value_cents,
            -- A material withdrawn from use must never ask to be reordered,
            -- however far its remaining stock has fallen.
            (rm.quantity_on_hand <= rm.reorder_point
               AND rm.retired_at IS NULL)     AS needs_reorder
     FROM raw_materials rm
     LEFT JOIN (
       SELECT raw_material_id,
              COUNT(*)::int AS open_batches,
              SUM(quantity_remaining) AS batch_qty,
              SUM(quantity_remaining * unit_cost_cents) AS stock_value_cents,
              (array_agg(unit_cost_cents ORDER BY received_date))[1] AS oldest_cost_cents,
              (array_agg(unit_cost_cents ORDER BY received_date DESC))[1] AS newest_cost_cents
       FROM material_batches
       WHERE status = 'Open' AND quantity_remaining > 0
       GROUP BY raw_material_id
     ) b ON b.raw_material_id = rm.id
     ORDER BY rm.category, rm.name`,
  );

  const out = [];
  for (const m of materials) {
    const suppliers = await db.query<Record<string, unknown>>(
      `SELECT s.id, s.name, sm.unit_cost_cents
       FROM supplier_materials sm JOIN suppliers s ON s.id = sm.supplier_id
       WHERE sm.raw_material_id = $1 ORDER BY sm.unit_cost_cents`,
      [m.id],
    );
    out.push({
      ...m,
      suppliers: suppliers.map((s) => ({
        id: s.id as string,
        name: s.name as string,
        unitCostCents: num(s.unit_cost_cents),
      })),
    });
  }
  return out;
}

/** Open FIFO batches for one material, oldest first - the draw order. */
export async function materialBatches(db: Db, materialId: string) {
  return db.query(
    `SELECT mb.id, business_date(mb.received_date)::text AS received_date,
            mb.unit_cost_cents, mb.quantity_received,
            mb.quantity_remaining, mb.status, s.name AS supplier_name, po.po_number
     FROM material_batches mb
     LEFT JOIN suppliers s ON s.id = mb.supplier_id
     LEFT JOIN purchase_orders po ON po.id = mb.po_id
     WHERE mb.raw_material_id = $1
     ORDER BY mb.received_date DESC, mb.id`,
    [materialId],
  );
}

/* ------------------------------------------------------------------ */
/* Bills of material                                                   */
/* ------------------------------------------------------------------ */

/** Replace a product's BOM. Quantities are per ONE bottle produced. */
export async function setBom(
  db: Db,
  actor: Actor,
  productId: string,
  lines: Array<{ rawMaterialId: string; componentType: MaterialCategory; quantity: number }>,
): Promise<void> {
  requireRole(actor, 'admin', 'user');
  for (const l of lines) {
    if (!(l.quantity > 0)) throw new RuleViolation('each BOM quantity must be greater than zero');
  }

  await db.tx(async (t) => {
    await t.query(`DELETE FROM bom_line_items WHERE product_id = $1`, [productId]);
    for (const l of lines) {
      await t.query(
        `INSERT INTO bom_line_items (product_id, raw_material_id, component_type, quantity)
         VALUES ($1,$2,$3,$4)`,
        [productId, l.rawMaterialId, l.componentType, l.quantity],
      );
    }
    await audit(t, actor, 'update', 'Product', productId, productId, { bomLines: lines.length });
  });
}

export async function getBom(db: Db, productId: string) {
  return db.query(
    `SELECT b.*, rm.name AS raw_material_name, rm.unit_of_measure, rm.quantity_on_hand
     FROM bom_line_items b JOIN raw_materials rm ON rm.id = b.raw_material_id
     WHERE b.product_id = $1
     ORDER BY b.component_type`,
    [productId],
  );
}
