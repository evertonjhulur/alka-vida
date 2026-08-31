/**
 * Customer records and merging (Section 6).
 */

import type { Db } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, requireRole } from './core.ts';
import { RuleViolation } from '@alka/shared';

/**
 * Merge two customer records.
 *
 * Every order, invoice, payment, delivery stop and quotation is reassigned to
 * the survivor. The merged-away record is DEACTIVATED, never deleted, so its
 * history stays intact and auditable - it simply can no longer be selected
 * for new orders.
 */
export async function mergeCustomers(
  db: Db,
  actor: Actor,
  args: { survivorId: string; mergedId: string; reason?: string },
): Promise<{ survivorId: string; moved: Record<string, number> }> {
  requireRole(actor, 'admin');
  if (args.survivorId === args.mergedId) {
    throw new RuleViolation('cannot merge a customer into itself');
  }

  return db.tx(async (t) => {
    const survivor = await t.maybeOne<{ name: string; active: boolean }>(
      `SELECT name, active FROM customers WHERE id = $1`, [args.survivorId],
    );
    const merged = await t.maybeOne<{ name: string; active: boolean }>(
      `SELECT name, active FROM customers WHERE id = $1`, [args.mergedId],
    );
    if (!survivor) throw new RuleViolation('survivor customer not found');
    if (!merged) throw new RuleViolation('customer to merge not found');
    if (!survivor.active) throw new RuleViolation('the survivor must be an active customer');

    const moved: Record<string, number> = {};
    const reassign = async (table: string, column = 'customer_id') => {
      const rows = await t.query<{ id: string }>(
        `UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2 RETURNING id`,
        [args.survivorId, args.mergedId],
      );
      moved[table] = rows.length;
    };

    await reassign('customer_orders');
    await reassign('invoices');
    await reassign('payments');
    await reassign('delivery_stops');
    await reassign('quotations');
    await reassign('approval_requests');

    // Deactivated, not deleted. History stays; new orders cannot select it.
    await t.query(
      `UPDATE customers
       SET active = false, merged_into_id = $2, updated_at = now(),
           notes = COALESCE(notes,'') || $3
       WHERE id = $1`,
      [args.mergedId, args.survivorId,
       `\n[merged into ${survivor.name} on ${new Date().toISOString().slice(0, 10)}]`],
    );

    await audit(t, actor, 'update', 'Customer', args.mergedId, merged.name, {
      mergedInto: args.survivorId,
      survivorName: survivor.name,
      reason: args.reason ?? null,
      recordsMoved: moved,
      deleted: false,
    });

    return { survivorId: args.survivorId, moved };
  });
}

export async function createCustomer(
  db: Db,
  actor: Actor,
  input: {
    name: string; phone: string; email: string;
    deliveryAddress?: string | null; contactPerson?: string | null;
    brandId?: string | null; paymentTerms?: string | null;
    priceTierId?: string | null; defaultDeliveryDay?: string | null;
    deliveryZone?: string | null; routeSequence?: number;
    userId?: string | null; notes?: string | null;
  },
): Promise<{ id: string; warnings: string[] }> {
  requireRole(actor, 'admin', 'user');

  return db.tx(async (t) => {
    const row = await t.one<{ id: string }>(
      `INSERT INTO customers
         (name, phone, email, delivery_address, contact_person, brand_id,
          payment_terms, price_tier_id, default_delivery_day, delivery_zone,
          route_sequence, user_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11,0),$12,$13)
       RETURNING id`,
      [input.name, input.phone, input.email, input.deliveryAddress ?? null,
       input.contactPerson ?? null, input.brandId ?? null, input.paymentTerms ?? null,
       input.priceTierId ?? null, input.defaultDeliveryDay ?? null,
       input.deliveryZone ?? null, input.routeSequence ?? 0,
       input.userId ?? null, input.notes ?? null],
    );
    await audit(t, actor, 'create', 'Customer', row.id, input.name, {});

    const warnings: string[] = [];
    if (!input.deliveryZone) {
      warnings.push('No delivery zone set - delivery orders for this customer cannot be auto-routed.');
    }
    return { id: row.id, warnings };
  });
}

export async function updateCustomer(
  db: Db,
  actor: Actor,
  customerId: string,
  input: {
    name?: string; phone?: string; email?: string;
    deliveryAddress?: string | null; contactPerson?: string | null;
    paymentTerms?: string | null; priceTierId?: string | null;
    defaultDeliveryDay?: string | null; deliveryZone?: string | null;
    routeSequence?: number; notes?: string | null;
  },
): Promise<{ warnings: string[] }> {
  requireRole(actor, 'admin', 'user');

  return db.tx(async (t) => {
    const before = await t.maybeOne<{ name: string; active: boolean }>(
      `SELECT name, active FROM customers WHERE id = $1`, [customerId],
    );
    if (!before) throw new RuleViolation('customer not found');
    if (!before.active) {
      throw new RuleViolation('this customer was merged away and can no longer be edited');
    }

    await t.query(
      `UPDATE customers
       SET name = COALESCE($2,name), phone = COALESCE($3,phone),
           email = COALESCE($4,email), delivery_address = COALESCE($5,delivery_address),
           contact_person = COALESCE($6,contact_person),
           payment_terms = COALESCE($7,payment_terms),
           price_tier_id = COALESCE($8,price_tier_id),
           default_delivery_day = COALESCE($9,default_delivery_day),
           delivery_zone = COALESCE($10,delivery_zone),
           route_sequence = COALESCE($11,route_sequence),
           notes = COALESCE($12,notes),
           updated_at = now()
       WHERE id = $1`,
      [customerId, input.name ?? null, input.phone ?? null, input.email ?? null,
       input.deliveryAddress ?? null, input.contactPerson ?? null,
       input.paymentTerms ?? null, input.priceTierId ?? null,
       input.defaultDeliveryDay ?? null, input.deliveryZone ?? null,
       input.routeSequence ?? null, input.notes ?? null],
    );

    await audit(t, actor, 'update', 'Customer', customerId, input.name ?? before.name, input);

    const after = await t.one<{ delivery_zone: string | null }>(
      `SELECT delivery_zone FROM customers WHERE id = $1`, [customerId],
    );
    const warnings: string[] = [];
    if (!after.delivery_zone) {
      warnings.push('No delivery zone set - delivery orders cannot be auto-routed.');
    }
    return { warnings };
  });
}

export async function getCustomer(db: Db, customerId: string) {
  return db.maybeOne(
    `SELECT c.*, pt.name AS price_tier
     FROM customers c LEFT JOIN price_tiers pt ON pt.id = c.price_tier_id
     WHERE c.id = $1`, [customerId],
  );
}

/** Only active customers may be selected for new orders. */
export async function listSelectableCustomers(db: Db) {
  return db.query(
    `SELECT c.id, c.name, c.phone, c.email, c.delivery_zone, c.route_sequence,
            c.delivery_address, pt.name AS price_tier,
            b.balance_cents
     FROM customers c
     LEFT JOIN price_tiers pt ON pt.id = c.price_tier_id
     LEFT JOIN customer_balances b ON b.customer_id = c.id
     WHERE c.active
     ORDER BY c.name`,
  );
}
