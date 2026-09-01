/**
 * Composing a route and handing it to a driver (Sections 7-8).
 *
 * delivery.ts owns what happens AT a stop. This owns what happens before
 * the van leaves: who the round belongs to, which orders are on it, and in
 * what order they get visited.
 *
 * The rule that shapes everything here: a driver may only ever hold a route
 * nobody else holds, and may only ever name themselves. Two people working
 * one round means the same stop delivered twice and cash that never
 * reconciles at settlement.
 */

import type { Db } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, requireRole } from './core.ts';
import { RuleViolation } from '@alka/shared';

/** The drivers a route can be handed to. */
export async function listDrivers(db: Db) {
  return db.query<{ id: string; name: string }>(
    `SELECT id, name FROM users WHERE role = 'driver' ORDER BY name`,
  );
}

/**
 * Put a driver on a sheet, or take one off with a null driverId.
 *
 * The office may assign and reassign freely, right up until the route is
 * settled - vans break down and rounds get handed over mid-morning. A
 * driver may only claim a route for themselves, and only one that is
 * unclaimed or already theirs.
 */
export async function assignDriver(
  db: Db,
  actor: Actor,
  sheetId: string,
  driverId: string | null,
): Promise<{ assignedDriverId: string | null; driverName: string | null }> {
  requireRole(actor, 'admin', 'user', 'driver');

  return db.tx(async (t) => {
    const sheet = await t.maybeOne<{
      status: string; assigned_driver_id: string | null; zone: string;
    }>(
      `SELECT status, assigned_driver_id, zone FROM delivery_sheets WHERE id = $1`,
      [sheetId],
    );
    if (!sheet) throw new RuleViolation('that delivery sheet no longer exists');
    if (sheet.status !== 'Open') {
      throw new RuleViolation('a settled route cannot be reassigned');
    }

    if (actor.role === 'driver') {
      if (driverId !== null && driverId !== actor.id) {
        throw new RuleViolation('a driver can only take a route for themselves');
      }
      if (sheet.assigned_driver_id && sheet.assigned_driver_id !== actor.id) {
        throw new RuleViolation(
          `the ${sheet.zone} route is already assigned to another driver`,
        );
      }
    }
    const target = actor.role === 'driver' ? actor.id : driverId;

    if (target === null) {
      await t.query(
        `UPDATE delivery_sheets SET assigned_driver_id = NULL, driver_name = NULL
         WHERE id = $1`,
        [sheetId],
      );
      await audit(t, actor, 'update', 'DeliverySheet', sheetId, sheetId, { unassigned: true });
      return { assignedDriverId: null, driverName: null };
    }

    const driver = await t.maybeOne<{ id: string; name: string; role: string }>(
      `SELECT id, name, role FROM users WHERE id = $1`, [target],
    );
    if (!driver) throw new RuleViolation('that driver no longer exists');
    if (driver.role !== 'driver') throw new RuleViolation(`${driver.name} is not a driver`);

    await t.query(
      `UPDATE delivery_sheets SET assigned_driver_id = $2, driver_name = $3 WHERE id = $1`,
      [sheetId, driver.id, driver.name],
    );
    await audit(t, actor, 'update', 'DeliverySheet', sheetId, sheetId, {
      assignedDriverId: driver.id, driverName: driver.name,
    });
    return { assignedDriverId: driver.id, driverName: driver.name };
  });
}

/**
 * A driver starts the round: claims it if unclaimed, then stamps the start.
 *
 * Starting twice is harmless - the first start time stands, so a driver who
 * closes and reopens the app has not restarted their day.
 */
export async function startRoute(
  db: Db,
  actor: Actor,
  sheetId: string,
): Promise<{ startedAt: string; driverName: string | null }> {
  requireRole(actor, 'admin', 'user', 'driver');

  // Claiming first also enforces "not somebody else's route" for a driver.
  if (actor.role === 'driver') await assignDriver(db, actor, sheetId, actor.id);

  return db.tx(async (t) => {
    const sheet = await t.maybeOne<{ status: string }>(
      `SELECT status FROM delivery_sheets WHERE id = $1`, [sheetId],
    );
    if (!sheet) throw new RuleViolation('that delivery sheet no longer exists');
    if (sheet.status !== 'Open') throw new RuleViolation('that route has already been settled');

    const row = await t.one<{ started_at: string; driver_name: string | null }>(
      `UPDATE delivery_sheets SET started_at = COALESCE(started_at, now())
       WHERE id = $1
       RETURNING started_at::text AS started_at, driver_name`,
      [sheetId],
    );
    await audit(t, actor, 'update', 'DeliverySheet', sheetId, sheetId, { started: true });
    return { startedAt: row.started_at, driverName: row.driver_name };
  });
}

/**
 * The sheets a given person should see.
 *
 * A driver gets their own routes plus any nobody has claimed - never another
 * driver's round. The office sees every sheet.
 */
export async function listSheets(
  db: Db,
  actor: Actor,
  filter: { date?: string | null; status?: string | null } = {},
) {
  const driverScope = actor.role === 'driver';
  return db.query(
    `SELECT d.*, COUNT(s.id)::int AS stop_count
     FROM delivery_sheets d LEFT JOIN delivery_stops s ON s.delivery_sheet_id = d.id
     WHERE ($1::date IS NULL OR d.delivery_date = $1::date)
       AND ($2::text IS NULL OR d.status = $2)
       AND (NOT $3::boolean
            OR d.assigned_driver_id IS NULL
            OR d.assigned_driver_id = $4::uuid)
     GROUP BY d.id
     ORDER BY d.delivery_date DESC, d.zone`,
    [filter.date ?? null, filter.status ?? null, driverScope, actor.id],
  );
}

/**
 * Orders still waiting to go out that are not already on an open route.
 *
 * Deliberately NOT restricted to this sheet's zone or date. Adding by hand
 * is the exception path - yesterday's missed drop, or a customer in the next
 * zone the driver passes anyway - and a filter that hid those would defeat
 * the purpose of the screen.
 */
export async function deliveryCandidates(db: Db, sheetId: string) {
  return db.query<{
    id: string; order_number: string; customer_name: string;
    requested_delivery_date: string | null; delivery_zone: string | null;
    grand_total_cents: number; summary: string | null;
  }>(
    `SELECT o.id, o.order_number, c.name AS customer_name,
            o.requested_delivery_date::text AS requested_delivery_date,
            c.delivery_zone, o.grand_total_cents,
            (SELECT string_agg(
               CASE WHEN p.bottles_per_case > 0
                    THEN oli.cases || ' cs ' || p.name
                    ELSE oli.loose_bottles || ' x ' || p.name END, ', ')
             FROM order_line_items oli JOIN products p ON p.id = oli.product_id
             WHERE oli.order_id = o.id) AS summary
     FROM customer_orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.delivery_mode = 'Delivery'
       AND o.status IN ('Pending','Partially Delivered')
       AND NOT EXISTS (
         SELECT 1 FROM delivery_stops st
         JOIN delivery_sheets ds ON ds.id = st.delivery_sheet_id
         WHERE st.order_id = o.id AND (ds.status = 'Open' OR ds.id = $1)
       )
     ORDER BY o.requested_delivery_date NULLS LAST, c.name`,
    [sheetId],
  );
}

/**
 * Take a stop back off a route.
 *
 * Only a stop that has not happened yet. Once a stop is Delivered there is
 * an invoice against it and the quantities are historical fact; the way to
 * undo that is a correction on the invoice, never deleting the evidence.
 * The order goes back to awaiting delivery and can be placed on another day.
 */
export async function removeStop(
  db: Db,
  actor: Actor,
  stopId: string,
): Promise<{ orderRef: string | null }> {
  requireRole(actor, 'admin', 'user');

  return db.tx(async (t) => {
    const stop = await t.maybeOne<{
      order_ref: string | null; stop_outcome: string;
      settled_at: string | null; invoice_id: string | null; sheet_status: string;
    }>(
      `SELECT st.order_ref, st.stop_outcome, st.settled_at, st.invoice_id,
              ds.status AS sheet_status
       FROM delivery_stops st JOIN delivery_sheets ds ON ds.id = st.delivery_sheet_id
       WHERE st.id = $1`,
      [stopId],
    );
    if (!stop) throw new RuleViolation('that stop no longer exists');
    if (stop.sheet_status !== 'Open') {
      throw new RuleViolation('a settled route cannot be changed');
    }
    if (stop.stop_outcome !== 'Pending') {
      throw new RuleViolation(
        `this stop is already marked ${stop.stop_outcome} and cannot be removed - ` +
        `correct it on the invoice instead`,
      );
    }
    if (stop.settled_at || stop.invoice_id) {
      throw new RuleViolation('this stop has been settled and cannot be removed');
    }

    // delivery_stop_lines and delivery_stop_allocations cascade from here.
    await t.query(`DELETE FROM delivery_stops WHERE id = $1`, [stopId]);
    await audit(t, actor, 'update', 'DeliveryStop', stopId, stop.order_ref ?? stopId, {
      removedFromRoute: true,
    });
    return { orderRef: stop.order_ref };
  });
}
