/**
 * Master data: suppliers, raw materials, the links between them, and bills
 * of material (Section 2).
 *
 * A material can have several suppliers, each with a standard cost and its
 * own volume price breaks. That structure is what lets a purchase order
 * auto-price a line from the supplier and quantity chosen.
 */

import type { Db } from '../db/index.ts';
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

export async function updateSupplier(
  db: Db, actor: Actor, supplierId: string, input: Partial<SupplierInput>,
): Promise<void> {
  requireRole(actor, 'admin', 'user');
  await db.tx(async (t) => {
    await t.query(
      `UPDATE suppliers
       SET name = COALESCE($2, name), contact_person = COALESCE($3, contact_person),
           phone = COALESCE($4, phone), email = COALESCE($5, email),
           address = COALESCE($6, address), notes = COALESCE($7, notes)
       WHERE id = $1`,
      [supplierId, input.name ?? null, input.contactPerson ?? null, input.phone ?? null,
       input.email ?? null, input.address ?? null, input.notes ?? null],
    );
    await audit(t, actor, 'update', 'Supplier', supplierId, input.name ?? supplierId, input);
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

export async function updateRawMaterial(
  db: Db, actor: Actor, materialId: string, input: Partial<RawMaterialInput>,
): Promise<void> {
  requireRole(actor, 'admin', 'user');
  await db.tx(async (t) => {
    await t.query(
      `UPDATE raw_materials
       SET name = COALESCE($2,name), category = COALESCE($3,category),
           size_spec = COALESCE($4,size_spec), unit_of_measure = COALESCE($5,unit_of_measure),
           reorder_point = COALESCE($6,reorder_point), unit_cost_cents = COALESCE($7,unit_cost_cents),
           made_to_order = COALESCE($8,made_to_order), consigned = COALESCE($9,consigned),
           notes = COALESCE($10,notes)
       WHERE id = $1`,
      [materialId, input.name ?? null, input.category ?? null, input.sizeSpec ?? null,
       input.unitOfMeasure ?? null, input.reorderPoint ?? null, input.unitCostCents ?? null,
       input.madeToOrder ?? null, input.consigned ?? null, input.notes ?? null],
    );
    await audit(t, actor, 'update', 'RawMaterial', materialId, input.name ?? materialId, input);
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
            (rm.quantity_on_hand <= rm.reorder_point) AS needs_reorder
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
