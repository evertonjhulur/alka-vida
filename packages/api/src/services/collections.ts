/**
 * Collection stops (Everton, 10 Oct 2026, point 3).
 *
 * "+ Add a stop" on My route, and the office can add them to a round. Four
 * kinds; the first is the existing "Payment only" stop (delivery.ts), the
 * other three live here:
 *
 *   Collect empties        customer + how many. Moves the bottles back into
 *                          the pool (and off what the customer holds) when the
 *                          office settles the round - not before.
 *   Collect returned goods customer + products/quantities + reason. The
 *                          office decides, when settling, whether a credit
 *                          note is raised and whether the goods go back into
 *                          stock. The round cannot close until it has.
 *   Pick up from supplier  supplier, optional PO, what was collected. The
 *                          goods are still received on the PO by the office,
 *                          prefilled from the pick-up (inventory.ts); this
 *                          moves no stock itself.
 *
 * A driver adding one records something already done (Collected). The office
 * adding one plans it (Pending); the driver then records what happened, or
 * "Not collected". Anything still Pending when the round is settled is closed
 * as Not collected.
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, num, requireRole } from './core.ts';
import { RuleViolation } from '@alka/shared';
import { createCreditNote } from './invoices.ts';
import { customerPrices } from './customers.ts';
import { applyDeliveryMovement } from './bottles.ts';
import { moveWarehouse } from './trucks.ts';

export type CollectionKind = 'Empties' | 'Returns' | 'Supplier';
const KINDS: readonly CollectionKind[] = ['Empties', 'Returns', 'Supplier'];

export interface ReturnLine { productId: string; cases?: number; looseBottles?: number }
export interface PickupLine { poLineId?: string | null; rawMaterialId?: string | null; quantity: number }

export interface CollectionInput {
  kind: CollectionKind;
  customerId?: string | null;
  supplierId?: string | null;
  purchaseOrderId?: string | null;
  emptiesCount?: number;
  lines?: Array<ReturnLine & PickupLine>;
  reason?: string | null;
  description?: string | null;
  notes?: string | null;
}

/** Everything the "+ Add a stop" form needs to offer, for office and drivers. */
export async function stopOptions(db: Queryable) {
  const customers = await db.query(
    `SELECT c.id, c.name, c.delivery_zone, COALESCE(b.balance_cents, 0)::bigint AS balance_cents
     FROM customers c LEFT JOIN customer_balances b ON b.customer_id = c.id
     WHERE c.active AND NOT c.is_walk_in ORDER BY c.name`,
  );
  const products = await db.query(
    `SELECT id, name, bottles_per_case FROM products WHERE active AND NOT is_bottle_charge ORDER BY name`,
  );
  const suppliers = await db.query(`SELECT id, name, phone, address FROM suppliers ORDER BY name`);
  const pos = await db.query<{ id: string; po_number: string; supplier_id: string; status: string; order_date: string }>(
    `SELECT id, po_number, supplier_id, status, order_date::text AS order_date FROM purchase_orders
     WHERE status IN ('Draft','Sent','Partially Received') ORDER BY order_date DESC, po_number DESC`,
  );
  const lines = pos.length ? await db.query<{
    id: string; po_id: string; raw_material_id: string; name: string; unit: string;
    quantity_ordered: number; quantity_received: number;
  }>(
    `SELECT l.id, l.po_id, l.raw_material_id, rm.name, rm.unit_of_measure AS unit,
            l.quantity_ordered, l.quantity_received
     FROM po_line_items l JOIN raw_materials rm ON rm.id = l.raw_material_id
     WHERE l.po_id = ANY($1::uuid[]) ORDER BY rm.name`, [pos.map((p) => p.id)],
  ) : [];
  return {
    customers, products, suppliers,
    purchaseOrders: pos.map((p) => ({
      ...p,
      lines: lines.filter((l) => l.po_id === p.id).map((l) => ({
        poLineId: l.id, rawMaterialId: l.raw_material_id, name: l.name, unit: l.unit,
        ordered: num(l.quantity_ordered), received: num(l.quantity_received),
        outstanding: Math.max(num(l.quantity_ordered) - num(l.quantity_received), 0),
      })),
    })),
  };
}

/** Check and tidy what was collected, per kind. */
async function cleanDetails(t: Queryable, kind: CollectionKind, input: CollectionInput, forDriverRecord = false) {
  const out = {
    emptiesCount: 0,
    lines: [] as Array<Record<string, unknown>>,
    reason: input.reason?.trim() || null,
    description: input.description?.trim() || null,
  };
  if (kind === 'Empties') {
    out.emptiesCount = Math.max(0, Math.round(Number(input.emptiesCount) || 0));
    if (out.emptiesCount === 0 && !forDriverRecord) throw new RuleViolation('say how many empties');
  } else if (kind === 'Returns') {
    for (const l of input.lines ?? []) {
      const p = await t.maybeOne<{ id: string; name: string; bottles_per_case: number }>(
        `SELECT id, name, bottles_per_case FROM products WHERE id = $1`, [l.productId],
      );
      if (!p) throw new RuleViolation('choose the products that came back');
      const bpc = num(p.bottles_per_case);
      const cases = bpc > 0 ? Math.max(0, Math.round(Number(l.cases) || 0)) : 0;
      const loose = bpc > 0 ? 0 : Math.max(0, Math.round(Number(l.looseBottles ?? l.cases) || 0));
      if (cases + loose === 0) continue;
      out.lines.push({ productId: p.id, name: p.name, bottlesPerCase: bpc, cases, looseBottles: loose });
    }
    if (out.lines.length === 0 && !forDriverRecord) throw new RuleViolation('say what came back and how much');
    if (!out.reason && !forDriverRecord) throw new RuleViolation('say why the goods came back');
  } else {
    for (const l of input.lines ?? []) {
      const qty = Math.max(0, Number(l.quantity) || 0);
      if (qty === 0) continue;
      if (l.poLineId) {
        const pl = await t.maybeOne<{ id: string; po_id: string; raw_material_id: string; name: string; unit: string }>(
          `SELECT l.id, l.po_id, l.raw_material_id, rm.name, rm.unit_of_measure AS unit
           FROM po_line_items l JOIN raw_materials rm ON rm.id = l.raw_material_id WHERE l.id = $1`, [l.poLineId],
        );
        if (!pl || pl.po_id !== input.purchaseOrderId) throw new RuleViolation('that line is not on the chosen PO');
        out.lines.push({ poLineId: pl.id, rawMaterialId: pl.raw_material_id, name: pl.name, unit: pl.unit, quantity: qty });
      }
    }
    if (out.lines.length === 0 && !out.description && !forDriverRecord) {
      throw new RuleViolation('say what was collected from the supplier');
    }
  }
  return out;
}

/**
 * Add a collection stop to a round. A driver's is already done; the
 * office's is planned for the driver to do.
 */
export async function addCollection(
  db: Db, actor: Actor, sheetId: string, input: CollectionInput,
): Promise<{ id: string; status: string }> {
  requireRole(actor, 'admin', 'user', 'driver');
  if (!KINDS.includes(input.kind)) throw new RuleViolation('choose what kind of stop it is');
  return db.tx(async (t) => {
    const sheet = await t.maybeOne<{ status: string; assigned_driver_id: string | null }>(
      `SELECT status, assigned_driver_id FROM delivery_sheets WHERE id = $1`, [sheetId],
    );
    if (!sheet) throw new RuleViolation('that round no longer exists');
    if (sheet.status !== 'Open') throw new RuleViolation('this round is settled');
    if (actor.role === 'driver' && sheet.assigned_driver_id && sheet.assigned_driver_id !== actor.id) {
      throw new RuleViolation('this is not your round');
    }

    let customerId: string | null = null;
    let supplierId: string | null = null;
    let poId: string | null = null;
    let sequence = 0;
    if (input.kind === 'Supplier') {
      const s = await t.maybeOne<{ id: string }>(`SELECT id FROM suppliers WHERE id = $1`, [input.supplierId ?? null]);
      if (!s) throw new RuleViolation('choose the supplier');
      supplierId = s.id;
      if (input.purchaseOrderId) {
        const po = await t.maybeOne<{ id: string; supplier_id: string; status: string; po_number: string }>(
          `SELECT id, supplier_id, status, po_number FROM purchase_orders WHERE id = $1`, [input.purchaseOrderId],
        );
        if (!po || po.supplier_id !== supplierId) throw new RuleViolation('that PO is not for this supplier');
        if (!['Draft', 'Sent', 'Partially Received'].includes(po.status)) {
          throw new RuleViolation(`${po.po_number} is ${po.status.toLowerCase()}: nothing more is expected on it`);
        }
        poId = po.id;
      }
      const last = await t.one<{ n: number }>(
        `SELECT GREATEST(COALESCE((SELECT MAX(sequence_no) FROM delivery_stops WHERE delivery_sheet_id = $1), 0),
                         COALESCE((SELECT MAX(sequence_no) FROM round_collections WHERE delivery_sheet_id = $1), 0))::int AS n`,
        [sheetId],
      );
      sequence = num(last.n) + 10;
    } else {
      const c = await t.maybeOne<{ id: string; route_sequence: number; active: boolean }>(
        `SELECT id, route_sequence, active FROM customers WHERE id = $1`, [input.customerId ?? null],
      );
      if (!c || !c.active) throw new RuleViolation('choose the customer');
      customerId = c.id;
      sequence = num(c.route_sequence);
    }

    const d = await cleanDetails(t, input.kind, { ...input, purchaseOrderId: poId });
    const done = actor.role === 'driver';
    const row = await t.one<{ id: string; status: string }>(
      `INSERT INTO round_collections
         (delivery_sheet_id, kind, customer_id, supplier_id, purchase_order_id, status, empties_count,
          lines, reason, description, notes, sequence_no, added_by, added_by_name,
          collected_at, collected_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,
               CASE WHEN $6 = 'Collected' THEN now() END, CASE WHEN $6 = 'Collected' THEN $14 END)
       RETURNING id, status`,
      [sheetId, input.kind, customerId, supplierId, poId, done ? 'Collected' : 'Pending', d.emptiesCount,
       JSON.stringify(d.lines), d.reason, d.description, input.notes?.trim() || null, sequence,
       actor.id, actor.name],
    );
    await audit(t, actor, 'update', 'DeliverySheet', sheetId, `${input.kind} collection`, {
      collectionId: row.id, kind: input.kind, status: row.status, customerId, supplierId, purchaseOrderId: poId,
      emptiesCount: d.emptiesCount, lines: d.lines,
    });
    return row;
  });
}

/** The driver (or office) records a planned collection: what was collected, or not. */
export async function recordCollection(
  db: Db, actor: Actor, id: string,
  input: { status: 'Collected' | 'Not collected'; emptiesCount?: number; lines?: CollectionInput['lines'];
           reason?: string | null; description?: string | null; notes?: string | null },
): Promise<void> {
  requireRole(actor, 'admin', 'user', 'driver');
  if (input.status !== 'Collected' && input.status !== 'Not collected') throw new RuleViolation('say whether it was collected');
  await db.tx(async (t) => {
    const c = await t.maybeOne<{
      kind: CollectionKind; purchase_order_id: string | null; settled_at: string | null;
      sheet_status: string; assigned_driver_id: string | null; reason: string | null; credit_note_id: string | null;
    }>(
      `SELECT rc.kind, rc.purchase_order_id, rc.settled_at, rc.reason, rc.credit_note_id,
              ds.status AS sheet_status, ds.assigned_driver_id
       FROM round_collections rc JOIN delivery_sheets ds ON ds.id = rc.delivery_sheet_id
       WHERE rc.id = $1 FOR UPDATE OF rc`, [id],
    );
    if (!c) throw new RuleViolation('that stop no longer exists');
    if (c.sheet_status !== 'Open' || c.settled_at) throw new RuleViolation('this round is settled');
    if (c.credit_note_id) throw new RuleViolation('a credit note has been raised for these goods, so they cannot be changed');
    if (actor.role === 'driver' && c.assigned_driver_id && c.assigned_driver_id !== actor.id) {
      throw new RuleViolation('this is not your round');
    }
    if (input.status === 'Not collected') {
      await t.query(
        `UPDATE round_collections SET status = 'Not collected', collected_at = now(), collected_by_name = $2,
                notes = COALESCE($3, notes) WHERE id = $1`, [id, actor.name, input.notes?.trim() || null],
      );
    } else {
      const d = await cleanDetails(t, c.kind, {
        kind: c.kind, purchaseOrderId: c.purchase_order_id, emptiesCount: input.emptiesCount, lines: input.lines,
        reason: input.reason ?? c.reason, description: input.description,
      });
      await t.query(
        `UPDATE round_collections SET status = 'Collected', empties_count = $2, lines = $3::jsonb,
                reason = $4, description = COALESCE($5, description), notes = COALESCE($6, notes),
                collected_at = now(), collected_by_name = $7, credit_decision = NULL
         WHERE id = $1`,
        [id, d.emptiesCount, JSON.stringify(d.lines), d.reason, d.description, input.notes?.trim() || null, actor.name],
      );
    }
    await audit(t, actor, 'update', 'RoundCollection', id, `${c.kind} collection`, { recorded: input.status });
  });
}

/** Take a collection stop off the round (office; not once settled or credited). */
export async function removeCollection(db: Db, actor: Actor, id: string): Promise<void> {
  requireRole(actor, 'admin', 'user');
  await db.tx(async (t) => {
    const c = await t.maybeOne<{ kind: string; settled_at: string | null; credit_note_id: string | null; sheet_status: string }>(
      `SELECT rc.kind, rc.settled_at, rc.credit_note_id, ds.status AS sheet_status
       FROM round_collections rc JOIN delivery_sheets ds ON ds.id = rc.delivery_sheet_id WHERE rc.id = $1`, [id],
    );
    if (!c) throw new RuleViolation('that stop no longer exists');
    if (c.sheet_status !== 'Open' || c.settled_at) throw new RuleViolation('a settled round cannot be changed');
    if (c.credit_note_id) throw new RuleViolation('a credit note has been raised for these goods');
    await t.query(`DELETE FROM round_collections WHERE id = $1`, [id]);
    await audit(t, actor, 'update', 'RoundCollection', id, `${c.kind} collection`, { removed: true });
  });
}

const SELECT = `
  SELECT rc.*, c.name AS customer_name, c.delivery_address, c.phone AS customer_phone,
         s.name AS supplier_name, s.address AS supplier_address, s.phone AS supplier_phone,
         po.po_number, cn.invoice_number AS credit_note_number, cn.credit_status,
         ds.delivery_date::text AS sheet_date, ds.zone AS sheet_zone, ds.status AS sheet_status
  FROM round_collections rc
  JOIN delivery_sheets ds ON ds.id = rc.delivery_sheet_id
  LEFT JOIN customers c ON c.id = rc.customer_id
  LEFT JOIN suppliers s ON s.id = rc.supplier_id
  LEFT JOIN purchase_orders po ON po.id = rc.purchase_order_id
  LEFT JOIN invoices cn ON cn.id = rc.credit_note_id`;

export async function listCollections(db: Queryable, sheetId: string) {
  return db.query(`${SELECT} WHERE rc.delivery_sheet_id = $1 ORDER BY rc.sequence_no, rc.added_at`, [sheetId]);
}

export async function getCollection(db: Queryable, id: string) {
  return db.maybeOne(`${SELECT} WHERE rc.id = $1`, [id]);
}

/**
 * Returned goods: the office's decision, made when settling. A credit note
 * is raised for the goods at the customer's own prices (an office user's
 * waits for an administrator's approval, like any credit note). Putting the
 * goods back in stock happens when the round is settled.
 */
export async function decideReturn(
  db: Db, actor: Actor, id: string, input: { creditNote: boolean; restock: boolean },
): Promise<{ creditNoteNumber: string | null; approvalRequestId: string | null }> {
  requireRole(actor, 'admin', 'user');
  const c = await db.maybeOne<{
    kind: string; status: string; customer_id: string; lines: Array<{ productId: string; cases: number; looseBottles: number }>;
    reason: string | null; settled_at: string | null; credit_note_id: string | null; sheet_status: string; sheet_date: string;
  }>(
    `SELECT rc.kind, rc.status, rc.customer_id, rc.lines, rc.reason, rc.settled_at, rc.credit_note_id,
            ds.status AS sheet_status, ds.delivery_date::text AS sheet_date
     FROM round_collections rc JOIN delivery_sheets ds ON ds.id = rc.delivery_sheet_id WHERE rc.id = $1`, [id],
  );
  if (!c) throw new RuleViolation('that stop no longer exists');
  if (c.kind !== 'Returns') throw new RuleViolation('only returned goods need a decision');
  if (c.status !== 'Collected') throw new RuleViolation('nothing was collected on this stop');
  if (c.settled_at || c.sheet_status !== 'Open') throw new RuleViolation('this round is settled');
  if (c.credit_note_id && !input.creditNote) {
    throw new RuleViolation('a credit note is already raised for these goods; cancel it on Credit notes if it was wrong');
  }

  let creditNoteId = c.credit_note_id;
  let creditNoteNumber: string | null = null;
  let approvalRequestId: string | null = null;
  if (input.creditNote && !creditNoteId) {
    const prices = new Map((await customerPrices(db, c.customer_id) as Array<{
      product_id: string; price_per_case_cents: number; price_per_bottle_cents: number;
    }>).map((p) => [p.product_id, p]));
    const lines = (c.lines ?? []).map((l) => {
      const p = prices.get(l.productId);
      return {
        productId: l.productId, cases: num(l.cases), looseBottles: num(l.looseBottles),
        pricePerCaseCents: num(p?.price_per_case_cents ?? 0), pricePerBottleCents: num(p?.price_per_bottle_cents ?? 0),
      };
    });
    const cn = await createCreditNote(db, actor, {
      customerId: c.customer_id, lines,
      reason: `Goods returned on the ${c.sheet_date} round${c.reason ? `: ${c.reason}` : ''}`,
    });
    creditNoteId = cn.id;
    creditNoteNumber = cn.invoiceNumber;
    approvalRequestId = cn.approvalRequestId;
  }
  await db.tx(async (t) => {
    await t.query(
      `UPDATE round_collections SET credit_decision = $2, credit_note_id = $3, restock = $4, decided_by_name = $5
       WHERE id = $1`,
      [id, input.creditNote ? 'Credit note' : 'No credit note', creditNoteId, !!input.restock, actor.name],
    );
    await audit(t, actor, 'update', 'RoundCollection', id, 'Returns collection', {
      creditNote: input.creditNote, creditNoteId, restock: !!input.restock,
    });
  });
  return { creditNoteNumber, approvalRequestId };
}

/**
 * Called from settleRoute, inside its transaction: what each collection
 * does when the round is settled. Refuses (rolling the settlement back) if
 * returned goods are still waiting for the office's decision.
 */
export async function settleCollections(t: Queryable, actor: Actor, sheetId: string): Promise<void> {
  const rows = await t.query<{
    id: string; kind: CollectionKind; status: string; customer_id: string | null; customer_name: string | null;
    empties_count: number; lines: Array<{ productId: string; bottlesPerCase: number; cases: number; looseBottles: number; name: string }>;
    credit_decision: string | null; restock: boolean; sheet_date: string;
  }>(
    `SELECT rc.id, rc.kind, rc.status, rc.customer_id, c.name AS customer_name, rc.empties_count, rc.lines,
            rc.credit_decision, rc.restock, ds.delivery_date::text AS sheet_date
     FROM round_collections rc JOIN delivery_sheets ds ON ds.id = rc.delivery_sheet_id
     LEFT JOIN customers c ON c.id = rc.customer_id
     WHERE rc.delivery_sheet_id = $1 AND rc.settled_at IS NULL`, [sheetId],
  );
  const undecided = rows.filter((r) => r.kind === 'Returns' && r.status === 'Collected' && !r.credit_decision);
  if (undecided.length) {
    throw new RuleViolation(`decide on the goods returned by ${undecided.map((r) => r.customer_name).join(', ')} `
      + '(credit note or not) before closing the round');
  }
  for (const r of rows) {
    const reference = `Round ${r.sheet_date}`;
    if (r.status === 'Pending') {
      await t.query(`UPDATE round_collections SET status = 'Not collected' WHERE id = $1`, [r.id]);
    } else if (r.status === 'Collected' && r.kind === 'Empties' && num(r.empties_count) > 0) {
      await t.query(
        `INSERT INTO customer_bottle_moves (customer_id, moved_on, returned, reference)
         VALUES ($1, $2::date, $3, $4)`, [r.customer_id, r.sheet_date, num(r.empties_count), `Empties collected, ${reference}`],
      );
      await applyDeliveryMovement(t, actor, {
        emptiesPickedUp: num(r.empties_count), reference: `Collection ${r.id}`, customerName: r.customer_name ?? undefined,
      });
    } else if (r.status === 'Collected' && r.kind === 'Returns' && r.restock) {
      for (const l of r.lines ?? []) {
        const bottles = num(l.cases) * (num(l.bottlesPerCase) || 1) + num(l.looseBottles);
        await moveWarehouse(t, l.productId, bottles, 'CustomerReturn', `${r.customer_name ?? 'Customer'}, ${reference}`,
          'Returned by the customer and put back in stock');
      }
    }
    await t.query(`UPDATE round_collections SET settled_at = now() WHERE id = $1`, [r.id]);
  }
}

/** Empties collected on a round, for the bottle count at settlement. */
export async function collectedEmpties(t: Queryable, sheetId: string): Promise<number> {
  const r = await t.one<{ n: number }>(
    `SELECT COALESCE(SUM(empties_count), 0)::int AS n FROM round_collections
     WHERE delivery_sheet_id = $1 AND kind = 'Empties' AND status = 'Collected'`, [sheetId],
  );
  return num(r.n);
}

/** Supplier pick-ups on a PO not yet received, for prefilling Receive goods. */
export async function pickupsForPo(db: Queryable, poId: string) {
  return db.query(
    `${SELECT} WHERE rc.purchase_order_id = $1 AND rc.kind = 'Supplier' AND rc.status = 'Collected'
       AND rc.received_at IS NULL ORDER BY rc.collected_at`, [poId],
  );
}

/** Receiving on the PO uses up its pick-ups. */
export async function markPickupsReceived(t: Queryable, poId: string): Promise<void> {
  await t.query(
    `UPDATE round_collections SET received_at = now()
     WHERE purchase_order_id = $1 AND kind = 'Supplier' AND status = 'Collected' AND received_at IS NULL`, [poId],
  );
}
