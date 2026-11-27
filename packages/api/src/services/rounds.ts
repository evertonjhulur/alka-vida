/**
 * Several rounds a day (Everton, 27 Nov 2026): "I need to create multiple
 * rounds on the same day, for different drivers etc., reassigning customers
 * from rounds due to reasons."
 *
 * His rulings:
 *  - The office makes a round by hand: day, zone, driver, vehicle and an
 *    optional name ("Portmore 2"). A zone may have several rounds a day.
 *  - New orders follow the FIRST round for their zone and day that has not
 *    started (orders.placeOnDeliverySheet). Once all have started, the order
 *    waits under Deliveries with no round.
 *  - A round may carry other zones' stops once they are moved onto it by
 *    hand. Automatic placement stays by zone.
 *  - Stops can be moved even after a round has started; the driver then
 *    re-sorts the stops still to do (resort_needed_at).
 *  - The reason for a move is optional.
 *  - Rounds can be merged.
 *
 * Goods follow the rules of the loading (trucks.ts): a stop moved off a
 * truck whose load the driver confirmed leaves its water on that truck, to
 * be counted back at the end; a stop moved onto such a truck is a
 * last-minute addition the driver reconfirms. A loading logged but not yet
 * confirmed is the office's to change, so the office is told to.
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, businessToday, num, requireRole } from './core.ts';
import { RuleViolation } from '@alka/shared';
import { assertZoneUsable } from './zones.ts';
import { assignDriver } from './routing.ts';
import { shortDay } from './noround.ts';
import { goodsForStops, moveWarehouse, recordAddition, roundLabel } from './trucks.ts';
import { STOP_ZONES_SQL, labelOf } from './roundzones.ts';
export { STOP_ZONES_SQL, labelOf };

interface SheetRow {
  id: string; zone: string; name: string | null; day: string; status: string;
  started_at: string | null; assigned_driver_id: string | null;
}

async function lockSheet(t: Queryable, id: string): Promise<SheetRow> {
  const s = await t.maybeOne<SheetRow>(
    `SELECT id, zone, name, delivery_date::text AS day, status, started_at, assigned_driver_id
     FROM delivery_sheets WHERE id = $1 FOR UPDATE`, [id]);
  if (!s) throw new RuleViolation('that round no longer exists');
  return s;
}

const roundWords = (s: SheetRow) => `the ${labelOf(s)} round for ${shortDay(s.day)}`;

/* ------------------------------------------------------------------ */
/* A new round                                                         */
/* ------------------------------------------------------------------ */

export interface NewRoundInput {
  day?: string; zone?: string; name?: string | null; driverId?: string | null; vehicle?: string | null;
}

export async function createRound(
  db: Db, actor: Actor, input: NewRoundInput,
): Promise<{ id: string; label: string; warnings: string[] }> {
  requireRole(actor, 'admin', 'user');
  const day = String(input.day ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RuleViolation('choose the day of the round');
  if (day < businessToday()) {
    throw new RuleViolation('a round can only be made for today or a later day. For a day that has passed, '
      + 'record the sales with New sale › "It already went out on an earlier day"');
  }
  const zone = String(input.zone ?? '').trim();
  if (!zone) throw new RuleViolation('choose the zone of the round');
  await assertZoneUsable(db, zone);
  const vehicle = input.vehicle?.trim() || null;

  const made = await db.tx(async (t) => {
    // A second round for the same zone and day gets a name of its own unless
    // one was given, so the two are never confused ("Boulevard 2").
    const same = await t.one<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM delivery_sheets WHERE delivery_date = $1::date AND zone = $2`, [day, zone]);
    const name = input.name?.trim() || (Number(same.n) > 0 ? `${zone} ${Number(same.n) + 1}` : null);
    const row = await t.one<{ id: string }>(
      `INSERT INTO delivery_sheets (delivery_date, zone, name, vehicle, created_by_name)
       VALUES ($1::date, $2, $3, $4, $5) RETURNING id`, [day, zone, name, vehicle, actor.name]);
    await audit(t, actor, 'create', 'DeliverySheet', row.id, `${name ?? zone} ${day}`, {
      roundMadeByHand: true, zone, day, ...(name ? { name } : {}), ...(vehicle ? { vehicle } : {}),
    });
    return { id: row.id, label: name ?? zone };
  });

  const warnings: string[] = [];
  if (input.driverId) {
    try { await assignDriver(db, actor, made.id, input.driverId); }
    catch (e) { warnings.push(`The round was made, but the driver could not be put on it: ${(e as Error).message}`); }
  }
  return { ...made, warnings };
}

/** Rename a round or set its vehicle (open rounds only). */
export async function updateRound(
  db: Db, actor: Actor, sheetId: string, input: { name?: string | null; vehicle?: string | null },
): Promise<{ label: string }> {
  requireRole(actor, 'admin', 'user');
  return db.tx(async (t) => {
    const s = await lockSheet(t, sheetId);
    if (s.status !== 'Open') throw new RuleViolation('a settled round cannot be changed');
    const name = input.name === undefined ? s.name : (input.name?.trim() || null);
    const cur = await t.one<{ vehicle: string | null }>(`SELECT vehicle FROM delivery_sheets WHERE id = $1`, [sheetId]);
    const vehicle = input.vehicle === undefined ? cur.vehicle : (input.vehicle?.trim() || null);
    await t.query(`UPDATE delivery_sheets SET name = $2, vehicle = $3 WHERE id = $1`, [sheetId, name, vehicle]);
    await audit(t, actor, 'update', 'DeliverySheet', sheetId, `${labelOf(s)} ${s.day}`, {
      ...(name !== s.name ? { name: { from: s.name, to: name } } : {}),
      ...(vehicle !== cur.vehicle ? { vehicle: { from: cur.vehicle, to: vehicle } } : {}),
    });
    return { label: labelOf({ name, zone: s.zone }) };
  });
}

/** The other open rounds on the same day: where a stop can be moved to. */
export async function moveTargets(db: Queryable, sheetId: string) {
  const s = await db.maybeOne<{ day: string }>(
    `SELECT delivery_date::text AS day FROM delivery_sheets WHERE id = $1`, [sheetId]);
  if (!s) throw new RuleViolation('that round no longer exists');
  const rows = await db.query<{
    id: string; zone: string; name: string | null; driver_name: string | null; vehicle: string | null;
    started_at: string | null; stop_count: number; stop_zones: string[];
  }>(
    `SELECT d.id, d.zone, d.name, d.driver_name, d.vehicle, d.started_at,
            (SELECT COUNT(*)::int FROM delivery_stops x WHERE x.delivery_sheet_id = d.id) AS stop_count,
            ${STOP_ZONES_SQL} AS stop_zones
     FROM delivery_sheets d
     WHERE d.delivery_date = $1::date AND d.status = 'Open' AND d.id <> $2
     ORDER BY d.zone, d.created_at`, [s.day, sheetId]);
  return rows.map((r) => ({
    id: r.id, label: labelOf(r), zone: r.zone, driverName: r.driver_name, vehicle: r.vehicle,
    started: !!r.started_at, stopCount: num(r.stop_count), stopZones: r.stop_zones ?? [],
  }));
}

/* ------------------------------------------------------------------ */
/* Moving stops                                                        */
/* ------------------------------------------------------------------ */

/** Where a stop goes on the round it joins: last if it is out, else its usual place. */
async function nextSequence(t: Queryable, target: SheetRow, stopId: string, tail: { n: number }): Promise<number> {
  if (target.started_at) {
    if (tail.n === 0) {
      const m = await t.one<{ m: number }>(
        `SELECT COALESCE(MAX(sequence_no), 0)::int AS m FROM delivery_stops WHERE delivery_sheet_id = $1`, [target.id]);
      tail.n = num(m.m);
    }
    tail.n += 10;
    return tail.n;
  }
  const r = await t.one<{ seq: number }>(
    `SELECT COALESCE(NULLIF(ca.route_sequence, 0), c.route_sequence, 0)::int AS seq
     FROM delivery_stops s JOIN customers c ON c.id = s.customer_id
     LEFT JOIN customer_orders o ON o.id = s.order_id
     LEFT JOIN customer_addresses ca ON ca.id = o.address_id
     WHERE s.id = $1`, [stopId]);
  return num(r.seq);
}

/** A stop moved onto a round that is out: the driver sorts what is left. */
async function flagResort(t: Queryable, target: SheetRow, what: string): Promise<void> {
  if (!target.started_at) return;
  await t.query(
    `UPDATE delivery_sheets SET resort_needed_at = now(),
       resort_note = CASE WHEN resort_needed_at IS NULL OR resort_note IS NULL THEN $2 ELSE resort_note || '; ' || $2 END
     WHERE id = $1`, [target.id, what]);
}

interface LoadRow { driver_confirmed_at: string | null; returned_at: string | null }
const loadOf = (t: Queryable, sheetId: string) =>
  t.maybeOne<LoadRow>(`SELECT driver_confirmed_at, returned_at FROM round_loads WHERE delivery_sheet_id = $1`, [sheetId]);

export interface MoveInput { stopIds?: string[]; toSheetId?: string; reason?: string | null; loaderId?: string | null }

export async function moveStops(
  db: Db, actor: Actor, input: MoveInput,
): Promise<{ moved: string[]; to: string; warnings: string[]; additionId: string | null }> {
  requireRole(actor, 'admin', 'user');
  const stopIds = [...new Set((input.stopIds ?? []).map(String).filter(Boolean))];
  if (stopIds.length === 0) throw new RuleViolation('choose the stops to move');
  if (!input.toSheetId) throw new RuleViolation('choose the round to move them to');
  const reason = input.reason?.trim() || null;

  return db.tx(async (t) => {
    const target = await lockSheet(t, input.toSheetId!);
    if (target.status !== 'Open') throw new RuleViolation(`${roundWords(target)} has been settled`);
    const tLoad = await loadOf(t, target.id);
    if (tLoad?.returned_at) {
      throw new RuleViolation(`the truck for ${roundWords(target)} has already been counted back, so nothing more can go on it`);
    }

    const moved: string[] = [];
    const bySource = new Map<string, { sheet: SheetRow; refs: string[] }>();
    const tail = { n: 0 };
    for (const stopId of stopIds) {
      const st = await t.maybeOne<{
        id: string; sheet_id: string; order_id: string | null; order_ref: string | null; customer_name: string;
        stop_outcome: string; settled_at: string | null; invoice_id: string | null; payment_amount_cents: number;
      }>(
        `SELECT s.id, s.delivery_sheet_id AS sheet_id, s.order_id, s.order_ref, c.name AS customer_name,
                s.stop_outcome, s.settled_at, s.invoice_id, s.payment_amount_cents
         FROM delivery_stops s JOIN customers c ON c.id = s.customer_id WHERE s.id = $1 FOR UPDATE OF s`, [stopId]);
      if (!st) throw new RuleViolation('one of those stops no longer exists');
      const who = st.order_ref ?? st.customer_name;
      if (st.sheet_id === target.id) throw new RuleViolation(`${who} is already on ${roundWords(target)}`);
      if (!st.order_id) throw new RuleViolation(`${who} is not a delivery, so it cannot be moved`);
      if (st.stop_outcome !== 'Pending' || st.settled_at || st.invoice_id) {
        throw new RuleViolation(`${who} has already been recorded (${st.stop_outcome.toLowerCase()}), so it stays on its round`);
      }
      if (num(st.payment_amount_cents) > 0) {
        throw new RuleViolation(`money is recorded on ${who}'s stop, so it stays on its round until it is settled`);
      }
      let src = bySource.get(st.sheet_id);
      if (!src) {
        const sheet = await lockSheet(t, st.sheet_id);
        if (sheet.status !== 'Open') throw new RuleViolation(`${who}'s round has been settled`);
        if (sheet.day !== target.day) {
          throw new RuleViolation(`${who} is on a round for ${shortDay(sheet.day)}; pick a round on the same day. `
            + 'To deliver on another day, use Change the order on Orders');
        }
        src = { sheet, refs: [] };
        bySource.set(st.sheet_id, src);
      }
      const seq = await nextSequence(t, target, st.id, tail);
      await t.query(`UPDATE delivery_stops SET delivery_sheet_id = $2, sequence_no = $3 WHERE id = $1`,
        [st.id, target.id, seq]);
      src.refs.push(who);
      moved.push(who);
      await audit(t, actor, 'update', 'DeliveryStop', st.id, who, {
        movedFrom: `${labelOf(src.sheet)} ${src.sheet.day}`, movedTo: `${labelOf(target)} ${target.day}`,
        ...(reason ? { reason } : {}),
      });
    }

    // What the trucks say about it.
    const warnings: string[] = [];
    for (const { sheet, refs } of bySource.values()) {
      const l = await loadOf(t, sheet.id);
      if (!l || l.returned_at) continue;
      if (l.driver_confirmed_at) {
        warnings.push(`The water for ${refs.join(', ')} stays on the ${labelOf(sheet)} truck; it is counted back when that round comes in.`);
      } else {
        warnings.push(`The loading logged for the ${labelOf(sheet)} round still includes ${refs.join(', ')}. Change that loading before the driver confirms it.`);
      }
      await audit(t, actor, 'update', 'DeliverySheet', sheet.id, `${labelOf(sheet)} ${sheet.day}`, {
        stopsMovedOut: refs, to: labelOf(target), ...(reason ? { reason } : {}),
      });
    }
    let additionId: string | null = null;
    if (tLoad?.driver_confirmed_at) {
      const goods = await goodsForStops(t, stopIds);
      const from = [...new Set([...bySource.values()].map((s) => labelOf(s.sheet)))].join(', ');
      const add = await recordAddition(t, actor, target.id,
        goods.map((g) => ({ productId: g.product_id, bottles: num(g.bottles) })), {
          note: `For ${moved.join(', ')}, moved from ${from}${reason ? `: ${reason}` : ''}`,
          loaderId: input.loaderId ?? null, fromWarehouse: true,
          why: 'Stops moved onto this round after the driver confirmed the load',
        });
      if (add) {
        additionId = add.id;
        warnings.push(`Their water was added to the ${labelOf(target)} load; ${target.assigned_driver_id ? 'the driver' : 'its driver'} reconfirms it on My route.`);
      }
    } else if (tLoad) {
      warnings.push(`The loading logged for the ${labelOf(target)} round does not include them yet. Change that loading to add them.`);
    }
    await flagResort(t, target, `${moved.join(', ')} moved onto this round by ${actor.name}`);
    if (target.started_at) warnings.push(`${labelOf(target)} is out on the road, so its driver is asked to sort the stops left to do.`);
    await audit(t, actor, 'update', 'DeliverySheet', target.id, `${labelOf(target)} ${target.day}`, {
      stopsMovedIn: moved, ...(reason ? { reason } : {}),
    });
    return { moved, to: labelOf(target), warnings, additionId };
  });
}

/* ------------------------------------------------------------------ */
/* Merging two rounds                                                  */
/* ------------------------------------------------------------------ */

/** A round's loading goes back on the warehouse shelf (as deleteRound does). */
async function loadBackOnShelf(t: Queryable, sheetId: string, label: string, why: string) {
  const lines = await t.query<{ product_id: string; bottles: number }>(
    `SELECT product_id, (loaded_bottles + added_bottles)::int AS bottles FROM round_load_lines
     WHERE delivery_sheet_id = $1 AND loaded_bottles + added_bottles > 0`, [sheetId]);
  for (const l of lines) await moveWarehouse(t, l.product_id, num(l.bottles), 'TruckReturn', label, why);
  return lines;
}

export async function mergeRound(
  db: Db, actor: Actor, fromId: string, input: { intoSheetId?: string; reason?: string | null },
): Promise<{ into: string; moved: string[]; warnings: string[] }> {
  requireRole(actor, 'admin', 'user');
  if (!input.intoSheetId) throw new RuleViolation('choose the round to merge it into');
  if (input.intoSheetId === fromId) throw new RuleViolation('choose a different round to merge it into');
  const reason = input.reason?.trim() || null;

  return db.tx(async (t) => {
    // Lock in a fixed order so two merges at once cannot deadlock.
    const [a, b] = [fromId, input.intoSheetId!].sort();
    const locked = new Map([[a, await lockSheet(t, a)], [b, await lockSheet(t, b)]]);
    const from = locked.get(fromId)!;
    const into = locked.get(input.intoSheetId!)!;
    if (from.status !== 'Open') throw new RuleViolation('a settled round cannot be merged');
    if (into.status !== 'Open') throw new RuleViolation(`${roundWords(into)} has been settled`);
    if (from.day !== into.day) throw new RuleViolation('only rounds on the same day can be merged');
    if (from.started_at) {
      throw new RuleViolation(`${roundWords(from)} has started, so it cannot be merged. Move its stops one by one instead`);
    }
    const worked = await t.one<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM delivery_stops WHERE delivery_sheet_id = $1
         AND (stop_outcome <> 'Pending' OR invoice_id IS NOT NULL OR settled_at IS NOT NULL OR payment_amount_cents > 0)`, [from.id]);
    if (num(worked.n) > 0) throw new RuleViolation('stops are already recorded on this round, so it cannot be merged');
    const money = await t.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM payments WHERE delivery_sheet_id = $1`, [from.id]);
    if (num(money.n) > 0) throw new RuleViolation('money is recorded on this round, so it cannot be merged');
    const coll = await t.one<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM round_collections WHERE delivery_sheet_id = $1 AND status <> 'Pending'`, [from.id]);
    if (num(coll.n) > 0) throw new RuleViolation('a collection is recorded on this round, so it cannot be merged');
    const intoLoad = await loadOf(t, into.id);
    if (intoLoad?.returned_at) {
      throw new RuleViolation(`the truck for ${roundWords(into)} has already been counted back, so nothing more can go on it`);
    }
    const fromLoad = await loadOf(t, from.id);

    // The stops and any collections still to do move across.
    const stops = await t.query<{ id: string; who: string }>(
      `SELECT s.id, COALESCE(s.order_ref, c.name) AS who FROM delivery_stops s JOIN customers c ON c.id = s.customer_id
       WHERE s.delivery_sheet_id = $1 ORDER BY s.sequence_no, c.name`, [from.id]);
    const goods = await goodsForStops(t, stops.map((s) => s.id));
    const tail = { n: 0 };
    for (const s of stops) {
      await t.query(`UPDATE delivery_stops SET delivery_sheet_id = $2, sequence_no = $3 WHERE id = $1`,
        [s.id, into.id, await nextSequence(t, into, s.id, tail)]);
    }
    await t.query(`UPDATE round_collections SET delivery_sheet_id = $2 WHERE delivery_sheet_id = $1 AND status = 'Pending'`,
      [from.id, into.id]);
    const moved = stops.map((s) => s.who);

    const warnings: string[] = [];
    const fromLabel = await roundLabel(t, from.id);
    if (fromLoad) {
      // Its loading is on a truck, off the shelf: it travels with the stops.
      const lines = await t.query<{ product_id: string; ordered: number; extra: number; loaded: number }>(
        `SELECT product_id, ordered_bottles AS ordered, extra_bottles AS extra,
                (loaded_bottles + added_bottles)::int AS loaded
         FROM round_load_lines WHERE delivery_sheet_id = $1 AND loaded_bottles + added_bottles > 0`, [from.id]);
      if (!intoLoad && into.started_at) {
        // Out on the road with no loading: its deliveries come off the shelf,
        // so the merged loading goes back on the shelf rather than onto a truck
        // nobody counted out.
        await loadBackOnShelf(t, from.id, fromLabel, `Merged into ${labelOf(into)} by ${actor.name}; loading put back`);
        warnings.push(`${labelOf(into)} went out without a loading, so the ${labelOf(from)} loading went back on the warehouse shelf.`);
      } else if (!intoLoad) {
        const l = await t.one<{ loaded_by: string | null; loaded_by_name: string | null; loader_ids: string[]; loader_names: string[] }>(
          `SELECT loaded_by, loaded_by_name, loader_ids, loader_names FROM round_loads WHERE delivery_sheet_id = $1`, [from.id]);
        await t.query(
          `INSERT INTO round_loads (delivery_sheet_id, loaded_by, loaded_by_name, loader_ids, loader_names)
           VALUES ($1,$2,$3,$4::uuid[],$5::text[])`,
          [into.id, l.loaded_by, l.loaded_by_name, l.loader_ids ?? [], l.loader_names ?? []]);
        for (const x of lines) {
          await t.query(
            `INSERT INTO round_load_lines (delivery_sheet_id, product_id, ordered_bottles, extra_bottles, loaded_bottles)
             VALUES ($1,$2,$3,$4,$5)`, [into.id, x.product_id, num(x.ordered), num(x.extra), num(x.loaded)]);
        }
        warnings.push(`The ${labelOf(from)} loading is now the ${labelOf(into)} loading; its driver confirms it as usual.`);
      } else if (!intoLoad.driver_confirmed_at) {
        for (const x of lines) {
          await t.query(
            `INSERT INTO round_load_lines (delivery_sheet_id, product_id, ordered_bottles, extra_bottles, loaded_bottles)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (delivery_sheet_id, product_id) DO UPDATE
               SET ordered_bottles = round_load_lines.ordered_bottles + EXCLUDED.ordered_bottles,
                   extra_bottles = round_load_lines.extra_bottles + EXCLUDED.extra_bottles,
                   loaded_bottles = round_load_lines.loaded_bottles + EXCLUDED.loaded_bottles`,
            [into.id, x.product_id, num(x.ordered), num(x.extra), num(x.loaded)]);
        }
        await t.query(`UPDATE round_loads SET updated_at = now() WHERE delivery_sheet_id = $1`, [into.id]);
        warnings.push(`The ${labelOf(from)} loading was added to the ${labelOf(into)} loading; its driver confirms the combined load.`);
      } else {
        await recordAddition(t, actor, into.id, lines.map((x) => ({ productId: x.product_id, bottles: num(x.loaded) })), {
          note: `The ${labelOf(from)} round merged into this one${reason ? `: ${reason}` : ''}`,
          fromWarehouse: false, why: 'Merged round',
        });
        warnings.push(`The ${labelOf(from)} loading was added to the ${labelOf(into)} load; its driver reconfirms it on My route.`);
      }
    } else if (intoLoad?.driver_confirmed_at) {
      const add = await recordAddition(t, actor, into.id, goods.map((g) => ({ productId: g.product_id, bottles: num(g.bottles) })), {
        note: `The ${labelOf(from)} round merged into this one${reason ? `: ${reason}` : ''}`,
        fromWarehouse: true, why: 'Stops from a merged round, added after the driver confirmed the load',
      });
      if (add) warnings.push(`Their water was added to the ${labelOf(into)} load; its driver reconfirms it on My route.`);
    } else if (intoLoad && goods.length) {
      warnings.push(`The loading logged for the ${labelOf(into)} round does not include the merged stops yet. Change that loading to add them.`);
    }

    await flagResort(t, into, `the ${labelOf(from)} round merged in by ${actor.name}`);
    if (into.started_at && moved.length) warnings.push(`${labelOf(into)} is out on the road, so its driver is asked to sort the stops left to do.`);
    await t.query(`DELETE FROM delivery_sheets WHERE id = $1`, [from.id]);
    await audit(t, actor, 'delete', 'DeliverySheet', from.id, `${labelOf(from)} ${from.day}`, {
      mergedInto: `${labelOf(into)} ${into.day}`, stops: moved, ...(reason ? { reason } : {}),
    });
    await audit(t, actor, 'update', 'DeliverySheet', into.id, `${labelOf(into)} ${into.day}`, {
      merged: `${labelOf(from)} ${from.day}`, stops: moved, ...(reason ? { reason } : {}),
    });
    return { into: labelOf(into), moved, warnings };
  });
}
