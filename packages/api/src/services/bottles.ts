/**
 * The 5-gallon returnable bottle exchange pool (Section 2, FiveGalBottlePool).
 *
 * A bottle is an asset that keeps circulating, so the pool is a closed loop
 * with four states:
 *
 *   clean_ready ──delivery──▶ filled_with_customer ──empties picked up──▶ returned_dirty
 *        ▲                             │                                        │
 *        └──────────── wash ───────────┼────────────────────────────────────────┘
 *                                      │
 *                                      └──reported lost or damaged──▶ lost_damaged
 *
 * Two rules hold throughout:
 *
 *  - A loss is a BUSINESS loss. It is never charged to the customer and never
 *    produces an invoice line.
 *  - Every movement writes an InventoryTransaction, so the pool has a real
 *    history rather than just four running totals that can silently drift.
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, requireRole, num } from './core.ts';
import { RuleViolation } from '@alka/shared';

export interface Pool {
  id: string;
  label: string;
  cleanReady: number;
  filledWithCustomer: number;
  returnedDirty: number;
  lostDamaged: number;
  /** Bottles still owned and circulating - excludes those written off. */
  inCirculation: number;
}

function toPool(r: Record<string, unknown>): Pool {
  const clean = num(r.clean_ready);
  const filled = num(r.filled_with_customer);
  const dirty = num(r.returned_dirty);
  return {
    id: r.id as string,
    label: r.label as string,
    cleanReady: clean,
    filledWithCustomer: filled,
    returnedDirty: dirty,
    lostDamaged: num(r.lost_damaged),
    inCirculation: clean + filled + dirty,
  };
}

export async function listPools(db: Queryable): Promise<Pool[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT * FROM five_gal_bottle_pool ORDER BY label`,
  );
  return rows.map(toPool);
}

/** Record one pool movement in the stock ledger. */
async function logMovement(
  t: Queryable,
  actor: Actor | null,
  pool: { id: string; label: string },
  quantity: number,
  direction: 'in' | 'out' | 'transfer',
  referenceType: 'CustomerOrder' | 'BottleReturn' | 'BottleWash' | 'Adjustment',
  reference: string,
  notes: string,
): Promise<void> {
  if (quantity === 0) return;
  await t.query(
    `INSERT INTO inventory_transactions
       (item_type, item_id, item_name, quantity, direction,
        reference, reference_type, notes)
     VALUES ('BottlePool',$1,$2,$3,$4,$5,$6,$7)`,
    [pool.id, pool.label, Math.abs(quantity), direction, reference, referenceType, notes],
  );
}

async function defaultPool(t: Queryable): Promise<{ id: string; label: string } | null> {
  return t.maybeOne<{ id: string; label: string }>(
    `SELECT id, label FROM five_gal_bottle_pool ORDER BY label LIMIT 1`,
  );
}

/**
 * Apply the bottle movements recorded at a delivery stop.
 *
 *   full bottles delivered : clean_ready        -> filled_with_customer
 *   empties picked up      : filled_with_customer -> returned_dirty
 *   lost or damaged        : filled_with_customer -> lost_damaged
 */
export async function applyDeliveryMovement(
  t: Queryable,
  actor: Actor | null,
  args: {
    delivered?: number;
    emptiesPickedUp?: number;
    lostDamaged?: number;
    reference: string;
    customerName?: string;
  },
): Promise<void> {
  const out = args.delivered ?? 0;
  const back = args.emptiesPickedUp ?? 0;
  const lost = args.lostDamaged ?? 0;
  if (out === 0 && back === 0 && lost === 0) return;

  const pool = await defaultPool(t);
  if (!pool) return;

  await t.query(
    `UPDATE five_gal_bottle_pool
     SET clean_ready = GREATEST(clean_ready - $2, 0),
         filled_with_customer = GREATEST(filled_with_customer + $2 - $3 - $4, 0),
         returned_dirty = returned_dirty + $3,
         lost_damaged = lost_damaged + $4
     WHERE id = $1`,
    [pool.id, out, back, lost],
  );

  const who = args.customerName ? ` to ${args.customerName}` : '';
  await logMovement(t, actor, pool, out, 'out', 'CustomerOrder', args.reference,
    `${out} full bottles delivered${who}`);
  await logMovement(t, actor, pool, back, 'in', 'BottleReturn', args.reference,
    `${back} empties collected${who}`);
  // Written off as a business loss - never billed to the customer.
  await logMovement(t, actor, pool, lost, 'out', 'Adjustment', args.reference,
    `${lost} bottles reported lost or damaged - business loss, not charged to the customer`);
}

/**
 * Wash returned bottles back into circulation: returned_dirty -> clean_ready.
 *
 * Bottles found unusable during washing are written off instead, which is the
 * only way a bottle leaves the pool other than a loss reported on the road.
 */
export async function washBottles(
  db: Db,
  actor: Actor,
  args: { poolId?: string; quantity: number; scrapped?: number; notes?: string },
): Promise<Pool> {
  requireRole(actor, 'admin', 'user');
  const scrapped = args.scrapped ?? 0;
  if (args.quantity < 0 || scrapped < 0) {
    throw new RuleViolation('bottle quantities cannot be negative');
  }
  if (args.quantity === 0 && scrapped === 0) {
    throw new RuleViolation('enter how many bottles were washed or scrapped');
  }

  return db.tx(async (t) => {
    const pool = args.poolId
      ? await t.one<{ id: string; label: string; returned_dirty: number }>(
          `SELECT id, label, returned_dirty FROM five_gal_bottle_pool
           WHERE id = $1 FOR UPDATE`, [args.poolId])
      : await t.one<{ id: string; label: string; returned_dirty: number }>(
          `SELECT id, label, returned_dirty FROM five_gal_bottle_pool
           ORDER BY label LIMIT 1 FOR UPDATE`);

    const dirty = num(pool.returned_dirty);
    if (args.quantity + scrapped > dirty) {
      throw new RuleViolation(
        `only ${dirty} bottles are waiting to be washed, but ` +
        `${args.quantity + scrapped} were entered`,
      );
    }

    await t.query(
      `UPDATE five_gal_bottle_pool
       SET returned_dirty = returned_dirty - $2 - $3,
           clean_ready = clean_ready + $2,
           lost_damaged = lost_damaged + $3
       WHERE id = $1`,
      [pool.id, args.quantity, scrapped],
    );

    await logMovement(t, actor, pool, args.quantity, 'transfer', 'BottleWash',
      `Wash by ${actor.name}`,
      args.notes ?? `${args.quantity} bottles washed and returned to clean stock`);
    await logMovement(t, actor, pool, scrapped, 'out', 'BottleWash',
      `Wash by ${actor.name}`,
      `${scrapped} bottles scrapped at washing - business loss`);

    await audit(t, actor, 'adjust', 'BottlePool', pool.id, pool.label, {
      washed: args.quantity, scrapped, notes: args.notes ?? null,
    });

    const updated = await t.one<Record<string, unknown>>(
      `SELECT * FROM five_gal_bottle_pool WHERE id = $1`, [pool.id],
    );
    return toPool(updated);
  });
}

/**
 * Correct the pool counts directly. Admin only, reason required - this is a
 * stock count for an asset that moves constantly, so who changed what and why
 * has to be recoverable.
 */
export async function adjustPool(
  db: Db,
  actor: Actor,
  args: {
    poolId?: string;
    cleanReady?: number;
    filledWithCustomer?: number;
    returnedDirty?: number;
    lostDamaged?: number;
    reason: string;
  },
): Promise<Pool> {
  requireRole(actor, 'admin');
  if (!args.reason?.trim()) {
    throw new RuleViolation('a reason is required when correcting the bottle pool');
  }

  return db.tx(async (t) => {
    const pool = args.poolId
      ? await t.one<Record<string, unknown>>(
          `SELECT * FROM five_gal_bottle_pool WHERE id = $1 FOR UPDATE`, [args.poolId])
      : await t.one<Record<string, unknown>>(
          `SELECT * FROM five_gal_bottle_pool ORDER BY label LIMIT 1 FOR UPDATE`);

    const before = toPool(pool);
    const next = {
      cleanReady: args.cleanReady ?? before.cleanReady,
      filledWithCustomer: args.filledWithCustomer ?? before.filledWithCustomer,
      returnedDirty: args.returnedDirty ?? before.returnedDirty,
      lostDamaged: args.lostDamaged ?? before.lostDamaged,
    };
    for (const [k, v] of Object.entries(next)) {
      if (v < 0) throw new RuleViolation(`${k} cannot be negative`);
    }

    await t.query(
      `UPDATE five_gal_bottle_pool
       SET clean_ready = $2, filled_with_customer = $3,
           returned_dirty = $4, lost_damaged = $5
       WHERE id = $1`,
      [before.id, next.cleanReady, next.filledWithCustomer,
       next.returnedDirty, next.lostDamaged],
    );

    const delta = (next.cleanReady + next.filledWithCustomer + next.returnedDirty)
      - before.inCirculation;
    await logMovement(t, actor, before, delta, delta >= 0 ? 'in' : 'out',
      'Adjustment', `Correction by ${actor.name}`, args.reason);

    await audit(t, actor, 'adjust', 'BottlePool', before.id, before.label, {
      reason: args.reason, before, after: next,
    });

    const updated = await t.one<Record<string, unknown>>(
      `SELECT * FROM five_gal_bottle_pool WHERE id = $1`, [before.id],
    );
    return toPool(updated);
  });
}

/**
 * How many bottles each customer is holding, derived from what was delivered
 * to them against what they handed back. This is the exchange side of the
 * pool: it says who to chase for empties.
 */
export async function customerHoldings(db: Db) {
  return db.query(
    `SELECT c.id AS customer_id, c.name, c.phone, c.delivery_zone,
            COALESCE(SUM(s.bottles_delivered_full), 0)::int      AS delivered,
            COALESCE(SUM(s.bottles_empties_picked_up), 0)::int   AS returned,
            COALESCE(SUM(s.bottles_lost_damaged), 0)::int        AS lost,
            (COALESCE(SUM(s.bottles_delivered_full), 0)
             - COALESCE(SUM(s.bottles_empties_picked_up), 0)
             - COALESCE(SUM(s.bottles_lost_damaged), 0))::int    AS holding
     FROM customers c
     JOIN delivery_stops s ON s.customer_id = c.id
     WHERE s.stop_outcome = 'Delivered'
     GROUP BY c.id, c.name, c.phone, c.delivery_zone
     HAVING COALESCE(SUM(s.bottles_delivered_full), 0) > 0
     ORDER BY holding DESC, c.name`,
  );
}

/**
 * The pool's own movement history.
 *
 * `txn_day` is the business date the screen shows. It was missing, so every
 * row of the movement history printed its date as a dash - the screen read
 * `txn_day`, the same name the stock ledger uses, and this query only
 * returned the raw timestamp.
 */
export async function poolHistory(db: Db, limit = 100) {
  return db.query(
    `SELECT id, quantity, direction, reference, reference_type, txn_date,
            business_date(txn_date)::text AS txn_day, notes
     FROM inventory_transactions
     WHERE item_type = 'BottlePool'
     ORDER BY txn_date DESC
     LIMIT $1`,
    [limit],
  );
}

/**
 * One customer's 5-gallon bottle account, shaped like the money statement:
 * what they were holding at the start, what moved in the period, and what
 * they are holding now.
 *
 * A returnable bottle is a real asset out on loan. The money statement says
 * what a customer owes; this says how many of your bottles they have. Both
 * belong on the same piece of paper, because the conversation about one is
 * usually the conversation about the other.
 *
 * Dates come from the delivery SHEET, not the stop: a stop has no date of its
 * own, it belongs to the round that carried it.
 */
export async function bottleAccount(
  db: Db,
  customerId: string,
  opts: { from?: string | null; to?: string | null } = {},
): Promise<{
  openingHolding: number;
  delivered: number;
  returned: number;
  lost: number;
  closingHolding: number;
}> {
  const from = opts.from ?? null;
  const to = opts.to ?? null;

  const row = await db.one<{
    opening: string; delivered: string; returned: string; lost: string; closing: string;
  }>(
    `SELECT
       -- everything BEFORE the window, so the period reads as a movement
       COALESCE(SUM(
         CASE WHEN $2::date IS NULL OR sh.delivery_date < $2::date
              THEN s.bottles_delivered_full - s.bottles_empties_picked_up
                   - s.bottles_lost_damaged ELSE 0 END), 0)::text AS opening,
       COALESCE(SUM(CASE WHEN inWindow THEN s.bottles_delivered_full ELSE 0 END), 0)::text
         AS delivered,
       COALESCE(SUM(CASE WHEN inWindow THEN s.bottles_empties_picked_up ELSE 0 END), 0)::text
         AS returned,
       COALESCE(SUM(CASE WHEN inWindow THEN s.bottles_lost_damaged ELSE 0 END), 0)::text
         AS lost,
       -- what they hold now, counting everything up to the end of the window
       COALESCE(SUM(
         CASE WHEN $3::date IS NULL OR sh.delivery_date <= $3::date
              THEN s.bottles_delivered_full - s.bottles_empties_picked_up
                   - s.bottles_lost_damaged ELSE 0 END), 0)::text AS closing
     FROM delivery_stops s
     JOIN delivery_sheets sh ON sh.id = s.delivery_sheet_id
     CROSS JOIN LATERAL (
       SELECT ($2::date IS NULL OR sh.delivery_date >= $2::date)
          AND ($3::date IS NULL OR sh.delivery_date <= $3::date) AS inWindow
     ) w
     WHERE s.customer_id = $1 AND s.stop_outcome = 'Delivered'`,
    [customerId, from, to],
  );

  return {
    openingHolding: num(row.opening),
    delivered: num(row.delivered),
    returned: num(row.returned),
    lost: num(row.lost),
    closingHolding: num(row.closing),
  };
}

/**
 * Record bottles that went out on a delivery where nobody wrote them down.
 *
 * This deliberately works on a SETTLED round, which almost nothing else does.
 * The lock on a settled route exists to protect money - corrections there go
 * through payment reversal, reassignment or invoice editing - and bottles are
 * not money. A returnable is an asset on loan; getting its count right does
 * not move a cent of anybody's balance.
 *
 * It exists because the driver's screen had no bottles-delivered field at
 * all: the column was there, the API accepted a value, and nothing ever sent
 * one, so every returnable delivery recorded zero going out. That is fixed
 * going forward, but the deliveries already made need correcting, and doing
 * that by hand in the database leaves no trace of who did it or why.
 *
 * The stop AND the pool move together. The original delivery moved neither,
 * so correcting one without the other would just relocate the error.
 */
export async function correctStopBottles(
  db: Db,
  actor: Actor,
  stopId: string,
  args: { delivered: number; reason: string },
): Promise<{ was: number; now: number; poolMoved: number }> {
  requireRole(actor, 'admin');
  if (!args.reason?.trim()) {
    throw new RuleViolation('a reason is required when correcting a delivery record');
  }
  if (!Number.isFinite(args.delivered) || args.delivered < 0) {
    throw new RuleViolation('bottles delivered cannot be negative');
  }

  return db.tx(async (t) => {
    const stop = await t.one<{
      bottles_delivered_full: number; stop_outcome: string; customer_id: string;
    }>(
      `SELECT bottles_delivered_full, stop_outcome, customer_id
       FROM delivery_stops WHERE id = $1 FOR UPDATE`,
      [stopId],
    );
    if (stop.stop_outcome !== 'Delivered') {
      throw new RuleViolation('only a delivered stop can have its bottle count corrected');
    }

    const was = num(stop.bottles_delivered_full);
    const delta = args.delivered - was;
    if (delta === 0) return { was, now: was, poolMoved: 0 };

    await t.query(
      `UPDATE delivery_stops SET bottles_delivered_full = $2 WHERE id = $1`,
      [stopId, args.delivered],
    );

    const customer = await t.maybeOne<{ name: string }>(
      `SELECT name FROM customers WHERE id = $1`, [stop.customer_id],
    );

    // Only the difference moves: the pool must not be charged twice if this
    // is run again.
    if (delta > 0) {
      await applyDeliveryMovement(t, actor, {
        delivered: delta,
        reference: `Correction ${stopId}`,
        customerName: customer?.name,
      });
    } else {
      const pool = await defaultPool(t);
      if (pool) {
        await t.query(
          `UPDATE five_gal_bottle_pool
           SET clean_ready = clean_ready + $2,
               filled_with_customer = GREATEST(filled_with_customer - $2, 0)
           WHERE id = $1`,
          [pool.id, Math.abs(delta)],
        );
      }
    }

    await audit(t, actor, 'adjust', 'DeliveryStop', stopId, `bottles ${was} -> ${args.delivered}`, {
      bottlesWas: was, bottlesNow: args.delivered, poolMoved: delta,
      reason: args.reason.trim(),
      settledRoute: true,
    });

    return { was, now: args.delivered, poolMoved: delta };
  });
}
