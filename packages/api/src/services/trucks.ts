/**
 * Truck loading and returns (Everton, 10 Oct 2026, point 4). Moves stock, live.
 *
 *   warehouse ──load──▶ truck ──delivered──▶ customer
 *                         │
 *                         └──came back──▶ warehouse
 *
 * Dual accountability (Everton's follow-up, 10 Oct 2026): the OFFICE logs
 * the loading - what the round's orders come to per product, any extras,
 * who loaded the truck (employees) - and by saving it confirms it was
 * loaded. That moves the goods off finished-goods stock (the warehouse)
 * onto the truck. The DRIVER then only confirms the totals and starts the
 * route (confirmLoad), taking responsibility for them; from then on the
 * loading is locked. Deliveries on a loaded round then come off the truck -
 * markStop does NOT take them off the warehouse a second time. At the end,
 * the driver or the office confirms what came back, which goes back on the
 * warehouse. The round page shows loaded - delivered - returned per product,
 * and a difference is goods that are neither delivered nor back.
 *
 * Rules:
 *  - A round with no loading recorded behaves exactly as before: each
 *    delivery takes its goods off the warehouse (stockmoves.takeFinishedGoods).
 *  - Quantities are stored in BOTTLES; a cased product is entered and shown
 *    in cases (a cased product is never loaded loose, as it is never sold
 *    loose).
 *  - Loading and returns both work to a TARGET, like a stock count: confirming
 *    again moves only the difference, so a correction can never move stock
 *    twice.
 *  - The 5-gallon bottle sold on its own (is_bottle_charge) is not water off
 *    the shelf and is never loaded.
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, num, requireRole } from './core.ts';
import { RuleViolation } from '@alka/shared';
import { assignDriver, startRoute } from './routing.ts';

export interface LoadLineInput {
  productId: string;
  /** Extra on top of the orders, in cases (cased product) or bottles. */
  extraUnits?: number;
}
export interface ReturnLineInput {
  productId: string;
  /** Full goods back, in cases (cased product) or bottles. */
  returnedUnits: number;
}

/** Move finished goods by `bottles` (+ in, - out) and write the stock ledger. */
async function moveWarehouse(
  t: Queryable, productId: string, bottles: number,
  type: 'TruckLoad' | 'TruckReturn' | 'CustomerReturn', reference: string, note: string,
): Promise<void> {
  const qty = Math.round(bottles);
  if (qty === 0) return;
  const p = await t.one<{ name: string }>(`SELECT name FROM products WHERE id = $1`, [productId]);
  await t.query(
    `INSERT INTO finished_goods_stock (product_id, quantity_on_hand) VALUES ($1, $2)
     ON CONFLICT (product_id) DO UPDATE
       SET quantity_on_hand = finished_goods_stock.quantity_on_hand + EXCLUDED.quantity_on_hand`,
    [productId, qty],
  );
  await t.query(
    `INSERT INTO inventory_transactions
       (item_type, item_id, item_name, quantity, direction, reference, reference_type, notes)
     VALUES ('FinishedGoods',$1,$2,$3,$4,$5,$6,$7)`,
    [productId, p.name, Math.abs(qty), qty > 0 ? 'in' : 'out', reference, type, note],
  );
}
export { moveWarehouse };

/** "Round Mon 12 Oct, Portmore" - the reference written on the stock ledger. */
async function roundLabel(t: Queryable, sheetId: string): Promise<string> {
  const s = await t.one<{ zone: string; day: string }>(
    `SELECT zone, to_char(delivery_date, 'Dy DD Mon') AS day FROM delivery_sheets WHERE id = $1`, [sheetId],
  );
  return `Round ${s.day}, ${s.zone}`;
}

/** Is this round's stock on a truck (loaded, returns not yet confirmed)? */
export async function deliversFromTruck(t: Queryable, sheetId: string): Promise<boolean> {
  const l = await t.maybeOne<{ returned_at: string | null }>(
    `SELECT returned_at FROM round_loads WHERE delivery_sheet_id = $1`, [sheetId],
  );
  // Once the returns are in, the truck has been emptied back into the
  // warehouse; a stop recorded delivered after that comes off the warehouse.
  return !!l && !l.returned_at;
}

/**
 * Per product, what this round's orders still have to take out: each
 * undelivered stop's lines, less anything an earlier part delivery of the
 * same order handed over.
 */
async function orderedOnRound(t: Queryable, sheetId: string) {
  return t.query<{ product_id: string; bottles: number }>(
    `SELECT oli.product_id,
            SUM(GREATEST(oli.total_bottles - COALESCE(d.bottles, 0), 0))::int AS bottles
     FROM delivery_stops st
     JOIN order_line_items oli ON oli.order_id = st.order_id
     JOIN products p ON p.id = oli.product_id
     LEFT JOIN (
       SELECT sl.order_line_id, SUM(sl.total_bottles) AS bottles
       FROM delivery_stop_lines sl JOIN delivery_stops x ON x.id = sl.stop_id
       WHERE x.stop_outcome = 'Delivered'
       GROUP BY sl.order_line_id
     ) d ON d.order_line_id = oli.id
     WHERE st.delivery_sheet_id = $1 AND st.stop_outcome = 'Pending' AND st.order_id IS NOT NULL
       AND NOT p.is_bottle_charge
     GROUP BY oli.product_id`,
    [sheetId],
  );
}

/** Products that can go on a truck, with how they are counted. */
async function loadableProducts(t: Queryable) {
  return t.query<{ id: string; name: string; bottles_per_case: number; active: boolean }>(
    `SELECT id, name, bottles_per_case, active FROM products WHERE NOT is_bottle_charge ORDER BY name`,
  );
}

const unitsToBottles = (bpc: number, units: number) => Math.max(0, Math.round(Number(units) || 0)) * (bpc > 0 ? bpc : 1);

/**
 * What the loading screen shows: per product, from the round's orders, and
 * what is already loaded if the loading was confirmed. Plus the people who
 * can be named as loaders.
 */
export async function loadingSummary(db: Queryable, sheetId: string) {
  const sheet = await db.maybeOne<{ id: string; status: string; started_at: string | null }>(
    `SELECT id, status, started_at FROM delivery_sheets WHERE id = $1`, [sheetId],
  );
  if (!sheet) throw new RuleViolation('that round no longer exists');
  const products = await loadableProducts(db);
  const ordered = new Map((await orderedOnRound(db, sheetId)).map((r) => [r.product_id, num(r.bottles)]));
  const load = await getLoad(db, sheetId);
  const loaders = await db.query<{ id: string; name: string; job_title: string | null }>(
    `SELECT id, name, job_title FROM employees WHERE active ORDER BY name`,
  );
  const lines = products
    .filter((p) => (ordered.get(p.id) ?? 0) > 0 || load?.lines.some((l) => l.productId === p.id))
    .map((p) => ({
      productId: p.id, name: p.name, bottlesPerCase: num(p.bottles_per_case),
      orderedBottles: ordered.get(p.id) ?? 0,
    }));
  return {
    sheetId, status: sheet.status, startedAt: sheet.started_at,
    lines,
    products: products.filter((p) => p.active)
      .map((p) => ({ productId: p.id, name: p.name, bottlesPerCase: num(p.bottles_per_case) })),
    loaders,
    load,
  };
}

export async function getLoad(db: Queryable, sheetId: string) {
  const l = await db.maybeOne<{
    loaded_at: string; loaded_by_name: string | null; loader_ids: string[]; loader_names: string[];
    updated_at: string; returned_at: string | null; returned_by_name: string | null;
    empties_back: number | null; return_notes: string | null;
    driver_confirmed_at: string | null; driver_confirmed_name: string | null;
  }>(`SELECT * FROM round_loads WHERE delivery_sheet_id = $1`, [sheetId]);
  if (!l) return null;
  const lines = await db.query<{
    product_id: string; name: string; bottles_per_case: number;
    ordered_bottles: number; extra_bottles: number; loaded_bottles: number; returned_bottles: number | null;
    added_bottles: number;
  }>(
    `SELECT ll.product_id, p.name, p.bottles_per_case, ll.ordered_bottles, ll.extra_bottles,
            ll.loaded_bottles, ll.returned_bottles, ll.added_bottles
     FROM round_load_lines ll JOIN products p ON p.id = ll.product_id
     WHERE ll.delivery_sheet_id = $1 ORDER BY p.name`, [sheetId],
  );
  return {
    loadedAt: l.loaded_at, loadedByName: l.loaded_by_name, updatedAt: l.updated_at,
    driverConfirmedAt: l.driver_confirmed_at, driverConfirmedName: l.driver_confirmed_name,
    loaderIds: l.loader_ids ?? [], loaderNames: l.loader_names ?? [],
    returnedAt: l.returned_at, returnedByName: l.returned_by_name,
    emptiesBack: l.empties_back === null ? null : num(l.empties_back), returnNotes: l.return_notes,
    lines: lines.map((r) => ({
      productId: r.product_id, name: r.name, bottlesPerCase: num(r.bottles_per_case),
      orderedBottles: num(r.ordered_bottles), extraBottles: num(r.extra_bottles),
      // Everything put on the truck: the confirmed loading plus additions.
      loadedBottles: num(r.loaded_bottles) + num(r.added_bottles),
      addedBottles: num(r.added_bottles),
      returnedBottles: r.returned_bottles === null ? null : num(r.returned_bottles),
    })),
    additions: await listAdditions(db, sheetId),
  };
}

/* ------------------------------------------- additions after confirmation */

export async function listAdditions(db: Queryable, sheetId: string) {
  const rows = await db.query<{
    id: string; lines: Array<{ productId: string; bottles: number }>; note: string | null;
    added_at: string; added_by_name: string | null; loader_names: string[];
    driver_confirmed_at: string | null; driver_confirmed_name: string | null;
  }>(
    `SELECT id, lines, note, added_at, added_by_name, loader_names, driver_confirmed_at, driver_confirmed_name
     FROM round_load_additions WHERE delivery_sheet_id = $1 AND cancelled_at IS NULL ORDER BY added_at`, [sheetId],
  );
  const products = new Map((await db.query<{ id: string; name: string; bottles_per_case: number }>(
    `SELECT id, name, bottles_per_case FROM products`,
  )).map((p) => [p.id, p]));
  return rows.map((r) => ({
    id: r.id, note: r.note, addedAt: r.added_at, addedByName: r.added_by_name, loaderNames: r.loader_names ?? [],
    driverConfirmedAt: r.driver_confirmed_at, driverConfirmedName: r.driver_confirmed_name,
    lines: (r.lines ?? []).map((l) => ({
      productId: l.productId, name: products.get(l.productId)?.name ?? 'Product',
      bottlesPerCase: num(products.get(l.productId)?.bottles_per_case ?? 0), bottles: num(l.bottles),
    })),
  }));
}

/**
 * A last-minute addition to a load the driver has already confirmed (add
 * only). The office logs it with who loaded it; the stock moves warehouse ->
 * truck at once, and the driver reconfirms it (confirmAddition).
 */
export async function addToLoad(
  db: Db, actor: Actor, sheetId: string,
  input: { extras?: LoadLineInput[]; loaderIds?: string[]; note?: string | null },
): Promise<{ id: string; addedBottles: number }> {
  requireRole(actor, 'admin', 'user');
  const loaderIds = [...new Set((input.loaderIds ?? []).filter(Boolean))];
  if (loaderIds.length === 0) throw new RuleViolation('say who loaded it');
  return db.tx(async (t) => {
    const sheet = await t.maybeOne<{ status: string }>(
      `SELECT status FROM delivery_sheets WHERE id = $1 FOR UPDATE`, [sheetId],
    );
    if (!sheet) throw new RuleViolation('that round no longer exists');
    if (sheet.status !== 'Open') throw new RuleViolation('this round is settled');
    const load = await t.maybeOne<{ driver_confirmed_at: string | null; returned_at: string | null }>(
      `SELECT driver_confirmed_at, returned_at FROM round_loads WHERE delivery_sheet_id = $1`, [sheetId],
    );
    if (!load) throw new RuleViolation('log the loading first');
    if (!load.driver_confirmed_at) {
      throw new RuleViolation('the driver has not confirmed the load yet, so just change the loading itself');
    }
    if (load.returned_at) throw new RuleViolation('the truck has been counted back for this round');
    const people = await t.query<{ id: string; name: string }>(
      `SELECT id, name FROM employees WHERE id = ANY($1::uuid[]) AND active`, [loaderIds],
    );
    if (people.length !== loaderIds.length) throw new RuleViolation('choose the loaders from the employee list');

    const products = new Map((await loadableProducts(t)).map((p) => [p.id, p]));
    const add = new Map<string, number>();
    for (const e of input.extras ?? []) {
      const p = products.get(e.productId);
      if (!p) throw new RuleViolation('that product cannot go on a truck');
      const b = unitsToBottles(num(p.bottles_per_case), num(e.extraUnits));
      if (b > 0) add.set(e.productId, (add.get(e.productId) ?? 0) + b);
    }
    if (add.size === 0) throw new RuleViolation('say what is being added');

    const lines = [...add].map(([productId, bottles]) => ({ productId, bottles }));
    const row = await t.one<{ id: string }>(
      `INSERT INTO round_load_additions (delivery_sheet_id, lines, note, added_by, added_by_name, loader_ids, loader_names)
       VALUES ($1,$2::jsonb,$3,$4,$5,$6::uuid[],$7::text[]) RETURNING id`,
      [sheetId, JSON.stringify(lines), input.note?.trim() || null, actor.id, actor.name,
       people.map((p) => p.id), people.map((p) => p.name)],
    );
    const label = await roundLabel(t, sheetId);
    for (const l of lines) {
      await t.query(
        `INSERT INTO round_load_lines (delivery_sheet_id, product_id, loaded_bottles, added_bottles)
         VALUES ($1,$2,0,$3)
         ON CONFLICT (delivery_sheet_id, product_id) DO UPDATE
           SET added_bottles = round_load_lines.added_bottles + EXCLUDED.added_bottles`,
        [sheetId, l.productId, l.bottles],
      );
      await moveWarehouse(t, l.productId, -l.bottles, 'TruckLoad', label, 'Added to the load after the driver confirmed it');
    }
    await audit(t, actor, 'update', 'DeliverySheet', sheetId, label, {
      loadAddition: row.id, lines, loaders: people.map((p) => p.name), waitsForDriver: true,
    });
    return { id: row.id, addedBottles: lines.reduce((s, l) => s + l.bottles, 0) };
  });
}

async function additionFor(t: Queryable, id: string) {
  const a = await t.maybeOne<{
    delivery_sheet_id: string; lines: Array<{ productId: string; bottles: number }>;
    driver_confirmed_at: string | null; cancelled_at: string | null;
    sheet_status: string; assigned_driver_id: string | null; returned_at: string | null;
  }>(
    `SELECT a.delivery_sheet_id, a.lines, a.driver_confirmed_at, a.cancelled_at,
            ds.status AS sheet_status, ds.assigned_driver_id, rl.returned_at
     FROM round_load_additions a
     JOIN delivery_sheets ds ON ds.id = a.delivery_sheet_id
     JOIN round_loads rl ON rl.delivery_sheet_id = a.delivery_sheet_id
     WHERE a.id = $1 FOR UPDATE OF a`, [id],
  );
  if (!a || a.cancelled_at) throw new RuleViolation('that addition no longer exists');
  if (a.sheet_status !== 'Open') throw new RuleViolation('this round is settled');
  return a;
}

/** The driver reconfirms an addition: it is on the truck, and theirs. */
export async function confirmAddition(db: Db, actor: Actor, id: string): Promise<void> {
  requireRole(actor, 'driver');
  await db.tx(async (t) => {
    const a = await additionFor(t, id);
    if (a.assigned_driver_id && a.assigned_driver_id !== actor.id) throw new RuleViolation('this is not your round');
    if (a.driver_confirmed_at) return;
    await t.query(
      `UPDATE round_load_additions SET driver_confirmed_at = now(), driver_confirmed_by = $2, driver_confirmed_name = $3
       WHERE id = $1`, [id, actor.id, actor.name],
    );
    await audit(t, actor, 'update', 'DeliverySheet', a.delivery_sheet_id, await roundLabel(t, a.delivery_sheet_id), {
      driverConfirmedAddition: id, lines: a.lines,
    });
  });
}

/** The office takes back an addition the driver has not confirmed: the stock returns. */
export async function cancelAddition(db: Db, actor: Actor, id: string): Promise<void> {
  requireRole(actor, 'admin', 'user');
  await db.tx(async (t) => {
    const a = await additionFor(t, id);
    if (a.driver_confirmed_at) throw new RuleViolation('the driver has confirmed this addition, so it stands. Count any difference back at the end.');
    if (a.returned_at) throw new RuleViolation('the truck has been counted back for this round');
    const label = await roundLabel(t, a.delivery_sheet_id);
    for (const l of a.lines ?? []) {
      await t.query(
        `UPDATE round_load_lines SET added_bottles = GREATEST(added_bottles - $3, 0)
         WHERE delivery_sheet_id = $1 AND product_id = $2`, [a.delivery_sheet_id, l.productId, num(l.bottles)],
      );
      await moveWarehouse(t, l.productId, num(l.bottles), 'TruckLoad', label, 'Addition to the load cancelled before the driver confirmed it');
    }
    await t.query(`UPDATE round_load_additions SET cancelled_at = now(), cancelled_by_name = $2 WHERE id = $1`, [id, actor.name]);
    await audit(t, actor, 'update', 'DeliverySheet', a.delivery_sheet_id, label, { cancelledAddition: id });
  });
}

/** Additions still waiting for the driver, for settlement's check. */
export async function unconfirmedAdditions(t: Queryable, sheetId: string): Promise<number> {
  const r = await t.one<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM round_load_additions
     WHERE delivery_sheet_id = $1 AND cancelled_at IS NULL AND driver_confirmed_at IS NULL`, [sheetId],
  );
  return num(r.n);
}

/**
 * The office logs the loading and, by saving it, confirms it was loaded.
 * Office staff only: the driver's part is confirmLoad.
 *
 * Can be saved again - to fix a miscount or add something - until the
 * driver confirms it; each time only the difference moves.
 */
export async function loadRound(
  db: Db, actor: Actor, sheetId: string,
  input: { extras?: LoadLineInput[]; loaderIds?: string[] },
): Promise<{ loadedBottles: number }> {
  requireRole(actor, 'admin', 'user');
  const loaderIds = [...new Set((input.loaderIds ?? []).filter(Boolean))];
  if (loaderIds.length === 0) throw new RuleViolation('say who loaded the truck');

  const total = await db.tx(async (t) => {
    const sheet = await t.maybeOne<{ status: string }>(
      `SELECT status FROM delivery_sheets WHERE id = $1 FOR UPDATE`, [sheetId],
    );
    if (!sheet) throw new RuleViolation('that round no longer exists');
    if (sheet.status !== 'Open') throw new RuleViolation('this round is settled');
    const worked = await t.maybeOne(
      `SELECT 1 FROM delivery_stops WHERE delivery_sheet_id = $1 AND stop_outcome <> 'Pending' AND NOT payment_only`,
      [sheetId],
    );
    const before = await t.maybeOne<{ returned_at: string | null; driver_confirmed_name: string | null }>(
      `SELECT returned_at, driver_confirmed_name FROM round_loads WHERE delivery_sheet_id = $1`, [sheetId],
    );
    // The driver has taken responsibility for these totals: they stand.
    if (before?.driver_confirmed_name) {
      throw new RuleViolation(`${before.driver_confirmed_name} has already confirmed this load, so it can no longer be changed. `
        + 'What comes back is counted at the end.');
    }
    // Once a stop is worked, goods have left - from the truck, or from the
    // warehouse if nothing was loaded - and a loading now would count them twice.
    if (worked) {
      throw new RuleViolation(before
        ? 'the round is under way, so the loading can no longer be changed. What comes back is counted at the end.'
        : 'the round is already under way without a loading, so its deliveries came off the warehouse stock. '
          + 'Record the loading before the first stop next time.');
    }
    if (before?.returned_at) throw new RuleViolation('the returns are already in for this round');

    const people = await t.query<{ id: string; name: string }>(
      `SELECT id, name FROM employees WHERE id = ANY($1::uuid[]) AND active`, [loaderIds],
    );
    if (people.length !== loaderIds.length) throw new RuleViolation('choose the loaders from the employee list');

    const products = new Map((await loadableProducts(t)).map((p) => [p.id, p]));
    const ordered = new Map((await orderedOnRound(t, sheetId)).map((r) => [r.product_id, num(r.bottles)]));
    const extras = new Map<string, number>();
    for (const e of input.extras ?? []) {
      const p = products.get(e.productId);
      if (!p) throw new RuleViolation('that product cannot go on a truck');
      const b = unitsToBottles(num(p.bottles_per_case), num(e.extraUnits));
      if (b > 0) extras.set(e.productId, (extras.get(e.productId) ?? 0) + b);
    }

    const prev = new Map((await t.query<{ product_id: string; loaded_bottles: number }>(
      `SELECT product_id, loaded_bottles FROM round_load_lines WHERE delivery_sheet_id = $1`, [sheetId],
    )).map((r) => [r.product_id, num(r.loaded_bottles)]));

    await t.query(
      `INSERT INTO round_loads (delivery_sheet_id, loaded_by, loaded_by_name, loader_ids, loader_names)
       VALUES ($1,$2,$3,$4::uuid[],$5::text[])
       ON CONFLICT (delivery_sheet_id) DO UPDATE
         SET loader_ids = EXCLUDED.loader_ids, loader_names = EXCLUDED.loader_names, updated_at = now(),
             loaded_by = EXCLUDED.loaded_by, loaded_by_name = EXCLUDED.loaded_by_name`,
      [sheetId, actor.id, actor.name, people.map((p) => p.id), people.map((p) => p.name)],
    );
    await t.query(`DELETE FROM round_load_lines WHERE delivery_sheet_id = $1`, [sheetId]);

    const label = await roundLabel(t, sheetId);
    const ids = new Set([...ordered.keys(), ...extras.keys(), ...prev.keys()]);
    let total = 0;
    for (const id of ids) {
      const o = ordered.get(id) ?? 0;
      const x = extras.get(id) ?? 0;
      const loaded = o + x;
      if (loaded > 0) {
        await t.query(
          `INSERT INTO round_load_lines (delivery_sheet_id, product_id, ordered_bottles, extra_bottles, loaded_bottles)
           VALUES ($1,$2,$3,$4,$5)`, [sheetId, id, o, x, loaded],
        );
      }
      total += loaded;
      // Only the difference from what was already loaded moves.
      const delta = loaded - (prev.get(id) ?? 0);
      await moveWarehouse(t, id, -delta, 'TruckLoad', label,
        delta > 0 ? 'Loaded on the truck' : 'Taken back off the truck before setting off');
    }

    await audit(t, actor, 'update', 'DeliverySheet', sheetId, label, {
      loaded: [...ids].map((id) => ({ productId: id, ordered: ordered.get(id) ?? 0, extra: extras.get(id) ?? 0 })),
      loaders: people.map((p) => p.name), reloaded: !!before,
    });
    return total;
  });

  return { loadedBottles: total };
}

/**
 * The driver confirms the loaded totals and starts the route, taking
 * responsibility for what is on the truck. Only the driver whose round it
 * is (claiming it first if nobody has). Refused until the office has
 * logged the loading.
 */
export async function confirmLoad(
  db: Db, actor: Actor, sheetId: string,
): Promise<{ startedAt: string; confirmedAt: string }> {
  requireRole(actor, 'driver');
  // Refused on somebody else's round before anything is recorded.
  await assignDriver(db, actor, sheetId, actor.id);
  const confirmedAt = await db.tx(async (t) => {
    const sheet = await t.maybeOne<{ status: string }>(
      `SELECT status FROM delivery_sheets WHERE id = $1 FOR UPDATE`, [sheetId],
    );
    if (!sheet) throw new RuleViolation('that round no longer exists');
    if (sheet.status !== 'Open') throw new RuleViolation('this round is settled');
    const load = await t.maybeOne<{ driver_confirmed_at: string | null }>(
      `SELECT driver_confirmed_at::text AS driver_confirmed_at FROM round_loads WHERE delivery_sheet_id = $1`, [sheetId],
    );
    if (!load) {
      throw new RuleViolation('the office has not logged the loading for this round yet. Ask them to, then confirm it here.');
    }
    if (load.driver_confirmed_at) return load.driver_confirmed_at;
    const row = await t.one<{ at: string }>(
      `UPDATE round_loads SET driver_confirmed_at = now(), driver_confirmed_by = $2, driver_confirmed_name = $3
       WHERE delivery_sheet_id = $1 RETURNING driver_confirmed_at::text AS at`,
      [sheetId, actor.id, actor.name],
    );
    const lines = await t.query<{ product_id: string; loaded_bottles: number }>(
      `SELECT product_id, loaded_bottles FROM round_load_lines WHERE delivery_sheet_id = $1`, [sheetId],
    );
    await audit(t, actor, 'update', 'DeliverySheet', sheetId, await roundLabel(t, sheetId), {
      driverConfirmedLoad: lines.map((l) => ({ productId: l.product_id, bottles: num(l.loaded_bottles) })),
    });
    return row.at;
  });
  const { startedAt } = await startRoute(db, actor, sheetId);
  return { startedAt, confirmedAt };
}

/**
 * Per product on a loaded round: loaded, delivered (stops recorded
 * Delivered on THIS round), back, and the difference - goods neither
 * delivered nor back. Until the returns are in, "expected back" is what
 * should still be on the truck.
 */
export async function truckPosition(db: Queryable, sheetId: string) {
  const load = await getLoad(db, sheetId);
  if (!load) return null;
  const delivered = new Map((await db.query<{ product_id: string; bottles: number }>(
    `SELECT sl.product_id, SUM(sl.total_bottles)::int AS bottles
     FROM delivery_stop_lines sl JOIN delivery_stops st ON st.id = sl.stop_id
     JOIN products p ON p.id = sl.product_id
     WHERE st.delivery_sheet_id = $1 AND st.stop_outcome = 'Delivered' AND NOT p.is_bottle_charge
     GROUP BY sl.product_id`, [sheetId],
  )).map((r) => [r.product_id, num(r.bottles)]));
  const lines = load.lines.map((l) => ({ ...l, deliveredBottles: delivered.get(l.productId) ?? 0 }));
  // Delivered on this round but never loaded: shows as a shortfall too.
  for (const [productId, bottles] of delivered) {
    if (lines.some((l) => l.productId === productId)) continue;
    const p = await db.one<{ name: string; bottles_per_case: number }>(
      `SELECT name, bottles_per_case FROM products WHERE id = $1`, [productId],
    );
    lines.push({
      productId, name: p.name, bottlesPerCase: num(p.bottles_per_case), orderedBottles: 0, extraBottles: 0,
      loadedBottles: 0, addedBottles: 0, returnedBottles: load.returnedAt ? 0 : null, deliveredBottles: bottles,
    });
  }
  return {
    ...load,
    lines: lines.map((l) => {
      const expectedBack = l.loadedBottles - l.deliveredBottles;
      return {
        ...l, expectedBackBottles: expectedBack,
        differenceBottles: l.returnedBottles === null ? null : expectedBack - l.returnedBottles,
      };
    }),
  };
}

/**
 * What came back on the truck: full goods per product, and the 5-gallon
 * empties counted off it. Full goods go back on the warehouse. Empties are a
 * count against what the stops recorded: each stop already moved its empties
 * into the bottle pool when it was recorded, and collected empties move when
 * the round is settled.
 */
export async function confirmReturns(
  db: Db, actor: Actor, sheetId: string,
  input: { lines: ReturnLineInput[]; emptiesBack?: number | null; notes?: string | null },
): Promise<NonNullable<Awaited<ReturnType<typeof truckPosition>>>> {
  requireRole(actor, 'admin', 'user', 'driver');
  await db.tx(async (t) => {
    const sheet = await t.maybeOne<{ status: string; assigned_driver_id: string | null }>(
      `SELECT status, assigned_driver_id FROM delivery_sheets WHERE id = $1 FOR UPDATE`, [sheetId],
    );
    if (!sheet) throw new RuleViolation('that round no longer exists');
    if (sheet.status !== 'Open') throw new RuleViolation('this round is settled');
    if (actor.role === 'driver' && sheet.assigned_driver_id && sheet.assigned_driver_id !== actor.id) {
      throw new RuleViolation('this is not your round');
    }
    const load = await t.maybeOne(`SELECT 1 FROM round_loads WHERE delivery_sheet_id = $1`, [sheetId]);
    if (!load) throw new RuleViolation('no loading was recorded for this round, so there is nothing to count back');

    const products = new Map((await loadableProducts(t)).map((p) => [p.id, p]));
    const prev = new Map((await t.query<{ product_id: string; returned_bottles: number | null; loaded_bottles: number }>(
      `SELECT product_id, returned_bottles, loaded_bottles FROM round_load_lines WHERE delivery_sheet_id = $1`, [sheetId],
    )).map((r) => [r.product_id, r]));
    const label = await roundLabel(t, sheetId);
    const given = new Map<string, number>();
    for (const l of input.lines ?? []) {
      const p = products.get(l.productId);
      if (!p) throw new RuleViolation('that product cannot come back on a truck');
      given.set(l.productId, unitsToBottles(num(p.bottles_per_case), num(l.returnedUnits)));
    }
    for (const [productId, bottles] of given) {
      if (!prev.has(productId)) {
        await t.query(
          `INSERT INTO round_load_lines (delivery_sheet_id, product_id, loaded_bottles) VALUES ($1,$2,0)`,
          [sheetId, productId],
        );
      }
      const before = num(prev.get(productId)?.returned_bottles ?? 0);
      await t.query(
        `UPDATE round_load_lines SET returned_bottles = $3 WHERE delivery_sheet_id = $1 AND product_id = $2`,
        [sheetId, productId, bottles],
      );
      await moveWarehouse(t, productId, bottles - before, 'TruckReturn', label,
        bottles - before > 0 ? 'Back off the truck' : 'Correction to what came back off the truck');
    }
    // A product loaded but not mentioned came back as nothing.
    for (const [productId, r] of prev) {
      if (given.has(productId)) continue;
      const before = num(r.returned_bottles ?? 0);
      await t.query(
        `UPDATE round_load_lines SET returned_bottles = 0 WHERE delivery_sheet_id = $1 AND product_id = $2`,
        [sheetId, productId],
      );
      await moveWarehouse(t, productId, -before, 'TruckReturn', label, 'Correction to what came back off the truck');
    }
    const empties = input.emptiesBack === null || input.emptiesBack === undefined || (input.emptiesBack as unknown) === ''
      ? null : Math.max(0, Math.round(Number(input.emptiesBack) || 0));
    await t.query(
      `UPDATE round_loads SET returned_at = now(), returned_by_name = $2, empties_back = $3, return_notes = $4
       WHERE delivery_sheet_id = $1`,
      [sheetId, actor.name, empties, input.notes?.trim() || null],
    );
    await audit(t, actor, 'update', 'DeliverySheet', sheetId, label, {
      returns: [...given].map(([productId, bottles]) => ({ productId, bottles })), emptiesBack: empties,
    });
  });
  return (await truckPosition(db, sheetId))!;
}

/**
 * Loadings by day and loader (point 4's report). Each loading credits every
 * person named as a loader with the whole load - they loaded it together.
 */
export async function loadingsReport(db: Queryable, from: string, to: string) {
  const rows = await db.query<{
    sheet_id: string; day: string; zone: string; driver_name: string | null; loaded_at: string;
    loaded_by_name: string | null; loader_names: string[]; returned_at: string | null;
    driver_confirmed_name: string | null; driver_confirmed_at: string | null;
    product: string; bottles_per_case: number; loaded_bottles: number; returned_bottles: number | null; added_bottles: number;
    delivered_bottles: number;
  }>(
    `SELECT ds.id AS sheet_id, ds.delivery_date::text AS day, ds.zone, ds.driver_name, rl.loaded_at,
            rl.loaded_by_name, rl.loader_names, rl.returned_at, rl.driver_confirmed_name, rl.driver_confirmed_at,
            p.name AS product, p.bottles_per_case, ll.loaded_bottles, ll.returned_bottles, ll.added_bottles,
            COALESCE((SELECT SUM(sl.total_bottles) FROM delivery_stop_lines sl
                      JOIN delivery_stops st ON st.id = sl.stop_id
                      WHERE st.delivery_sheet_id = ds.id AND st.stop_outcome = 'Delivered'
                        AND sl.product_id = ll.product_id), 0)::int AS delivered_bottles
     FROM round_loads rl
     JOIN delivery_sheets ds ON ds.id = rl.delivery_sheet_id
     JOIN round_load_lines ll ON ll.delivery_sheet_id = rl.delivery_sheet_id
     JOIN products p ON p.id = ll.product_id
     WHERE business_date(rl.loaded_at) BETWEEN $1::date AND $2::date
     ORDER BY rl.loaded_at, ds.zone, p.name`,
    [from, to],
  );
  const loads = new Map<string, {
    sheetId: string; day: string; zone: string; driverName: string | null; loadedAt: string;
    loadedByName: string | null; loaders: string[]; returned: boolean;
    driverConfirmedName: string | null; driverConfirmedAt: string | null;
    /** loaded = the confirmed loading; added = later additions (credited to their own loaders below). */
    lines: Array<{ product: string; bottlesPerCase: number; loaded: number; added: number; delivered: number; returned: number | null; difference: number | null }>;
    additions: Awaited<ReturnType<typeof listAdditions>>;
  }>();
  for (const r of rows) {
    const key = r.sheet_id;
    if (!loads.has(key)) {
      loads.set(key, {
        sheetId: r.sheet_id, day: r.day, zone: r.zone, driverName: r.driver_name, loadedAt: r.loaded_at,
        loadedByName: r.loaded_by_name, loaders: r.loader_names ?? [], returned: !!r.returned_at, lines: [],
        additions: await listAdditions(db, r.sheet_id),
        driverConfirmedName: r.driver_confirmed_name, driverConfirmedAt: r.driver_confirmed_at,
      });
    }
    const returned = r.returned_bottles === null ? null : num(r.returned_bottles);
    loads.get(key)!.lines.push({
      product: r.product, bottlesPerCase: num(r.bottles_per_case), loaded: num(r.loaded_bottles),
      added: num(r.added_bottles), delivered: num(r.delivered_bottles), returned,
      difference: returned === null ? null
        : num(r.loaded_bottles) + num(r.added_bottles) - num(r.delivered_bottles) - returned,
    });
  }
  return [...loads.values()];
}
