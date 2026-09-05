/**
 * Delivery zones - the rounds deliveries are grouped into.
 *
 * A managed list rather than free text (migration 014). The zone decides which
 * delivery sheet an order lands on, so "Kingston" and "kingston " being two
 * different rounds is not a cosmetic problem: it is two half-empty trucks.
 *
 * A zone is stored on the customer as text, the same choice made for material
 * categories and for the same reasons - every existing query keeps working,
 * and a customer's round still reads correctly after the zone is retired. The
 * price is that renaming has to carry the new name across, which happens here
 * in one transaction.
 */

import type { Db } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, requireRole } from './core.ts';
import { RuleViolation } from '@alka/shared';

export interface ZoneInput {
  name: string;
  /** Which areas this round covers. What automatic assignment will read. */
  covers?: string | null;
}

export async function listZones(db: Db) {
  return db.query(
    `SELECT z.id, z.name, z.covers, z.retired_at, z.sort_order,
            (SELECT COUNT(*)::int FROM customers c
             WHERE c.delivery_zone = z.name AND c.active) AS customer_count
     FROM delivery_zones z
     ORDER BY z.retired_at NULLS FIRST, z.sort_order, z.name`,
  );
}

/** The zone must exist and still be in use before a customer is put on it. */
export async function assertZoneUsable(db: Db, name: string): Promise<void> {
  const rows = await db.query<{ retired_at: string | null }>(
    `SELECT retired_at FROM delivery_zones WHERE name = $1`, [name],
  );
  if (rows.length === 0) throw new RuleViolation(`there is no delivery zone called "${name}"`);
  if (rows[0].retired_at != null) {
    throw new RuleViolation(`the zone "${name}" has been retired; bring it back to use it`);
  }
}

export async function createZone(
  db: Db, actor: Actor, input: ZoneInput,
): Promise<{ id: string }> {
  requireRole(actor, 'admin', 'user');
  const name = input.name?.trim();
  if (!name) throw new RuleViolation('a zone needs a name');

  return db.tx(async (t) => {
    const clash = await t.query<{ id: string }>(
      `SELECT id FROM delivery_zones WHERE lower(name) = lower($1)`, [name],
    );
    if (clash.length > 0) throw new RuleViolation(`there is already a zone called "${name}"`);

    const last = await t.one<{ n: number }>(
      `SELECT COALESCE(MAX(sort_order), 0) + 10 AS n FROM delivery_zones`,
    );
    const row = await t.one<{ id: string }>(
      `INSERT INTO delivery_zones (name, covers, sort_order) VALUES ($1,$2,$3) RETURNING id`,
      [name, input.covers?.trim() || null, Number(last.n)],
    );
    await audit(t, actor, 'create', 'DeliveryZone', row.id, name, input);
    return { id: row.id };
  });
}

/**
 * Rename a zone, or change what it covers.
 *
 * A rename carries across to every customer on that round AND to delivery
 * sheets already raised for it, in one transaction. Without that the
 * customers would still answer to the old name and quietly stop grouping.
 */
export async function updateZone(
  db: Db, actor: Actor, zoneId: string, input: Partial<ZoneInput>,
): Promise<void> {
  requireRole(actor, 'admin', 'user');
  await db.tx(async (t) => {
    const before = await t.one<{ name: string }>(
      `SELECT name FROM delivery_zones WHERE id = $1`, [zoneId],
    );
    const name = input.name?.trim();

    if (name && name !== before.name) {
      const clash = await t.query<{ id: string }>(
        `SELECT id FROM delivery_zones WHERE lower(name) = lower($1) AND id <> $2`,
        [name, zoneId],
      );
      if (clash.length > 0) throw new RuleViolation(`there is already a zone called "${name}"`);

      await t.query(`UPDATE delivery_zones SET name = $2 WHERE id = $1`, [zoneId, name]);
      await t.query(`UPDATE customers SET delivery_zone = $2 WHERE delivery_zone = $1`,
        [before.name, name]);
      // The sheet calls the same thing `zone`, and an OPEN round has to follow
      // the rename or the next order for that zone opens a second sheet
      // alongside it. Completed rounds are history and are left alone.
      await t.query(
        `UPDATE delivery_sheets SET zone = $2 WHERE zone = $1 AND status = 'Open'`,
        [before.name, name]);
    }
    if ('covers' in input) {
      await t.query(`UPDATE delivery_zones SET covers = $2 WHERE id = $1`,
        [zoneId, input.covers?.trim() || null]);
    }
    await audit(t, actor, 'update', 'DeliveryZone', zoneId, name ?? before.name, input);
  });
}

/**
 * Remove a zone - truly if nobody is on it, by retiring it if anybody is.
 * Same shape as removing a material or a category, for the same reason:
 * deleting a round that customers answer to would strand them.
 */
export async function deleteZone(
  db: Db, actor: Actor, zoneId: string,
): Promise<{ deleted: boolean; retired: boolean; name: string; customerCount: number }> {
  requireRole(actor, 'admin');
  const zone = await db.one<{ name: string }>(
    `SELECT name FROM delivery_zones WHERE id = $1`, [zoneId],
  );
  const used = await db.one<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM customers WHERE delivery_zone = $1`, [zone.name],
  );
  const customerCount = Number(used.n);

  return db.tx(async (t) => {
    if (customerCount === 0) {
      await t.query(`DELETE FROM delivery_zones WHERE id = $1`, [zoneId]);
      await audit(t, actor, 'delete', 'DeliveryZone', zoneId, zone.name, {});
      return { deleted: true, retired: false, name: zone.name, customerCount };
    }
    await t.query(
      `UPDATE delivery_zones SET retired_at = now() WHERE id = $1 AND retired_at IS NULL`,
      [zoneId],
    );
    await audit(t, actor, 'update', 'DeliveryZone', zoneId, zone.name, { retired: customerCount });
    return { deleted: false, retired: true, name: zone.name, customerCount };
  });
}

export async function restoreZone(db: Db, actor: Actor, zoneId: string): Promise<void> {
  requireRole(actor, 'admin');
  await db.tx(async (t) => {
    const z = await t.one<{ name: string }>(
      `SELECT name FROM delivery_zones WHERE id = $1`, [zoneId]);
    await t.query(`UPDATE delivery_zones SET retired_at = NULL WHERE id = $1`, [zoneId]);
    await audit(t, actor, 'update', 'DeliveryZone', zoneId, z.name, { restored: true });
  });
}
