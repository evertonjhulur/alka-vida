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
import { audit, requireRole, num, businessToday } from './core.ts';
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
 * Every 5-gallon movement against a customer: bottles on delivery rounds, plus
 * those that went out or came back at the counter or on a collection
 * (customer_bottle_moves). Before 1 Oct 2026 only the rounds counted, so a
 * customer who collected or bought at the counter never showed as holding
 * any bottles.
 *
 * `opening` is the customer's opening balance of OUR bottles (28 Oct 2026):
 * what they already had when the app started, from the delivery sheet. It
 * counts towards what they hold like a delivery, but is kept apart so it is
 * never shown as one.
 */
const CUSTOMER_MOVES = `
  SELECT s.customer_id, sh.delivery_date AS day,
         s.bottles_delivered_full AS delivered, s.bottles_empties_picked_up AS returned,
         s.bottles_lost_damaged AS lost, 0 AS sold, 0 AS opening
  FROM delivery_stops s JOIN delivery_sheets sh ON sh.id = s.delivery_sheet_id
  WHERE s.stop_outcome = 'Delivered'
  UNION ALL
  SELECT m.customer_id, m.moved_on,
         CASE WHEN m.opening THEN 0 ELSE m.delivered END, m.returned, m.lost, m.sold,
         CASE WHEN m.opening THEN m.delivered ELSE 0 END
  FROM customer_bottle_moves m`;

/**
 * Bottles a customer has BOUGHT (7 Oct 2026, point 13): they handed over
 * fewer empties than the full bottles they took, and paid for the
 * difference. Those bottles are theirs from then on - they count as their
 * empties next time, and nothing is refunded - so they come off what the
 * customer holds of ours, and leave the pool as sold.
 */
export async function recordBottlesSold(
  t: Queryable, actor: Actor | null, args: {
    customerId: string; quantity: number; reference: string; orderId?: string | null; day?: string | null;
  },
): Promise<void> {
  const n = Math.max(0, Math.round(Number(args.quantity) || 0));
  if (n === 0) return;
  await t.query(
    `INSERT INTO customer_bottle_moves (customer_id, moved_on, sold, order_id, reference)
     VALUES ($1, COALESCE($2::date, business_today()), $3, $4, $5)`,
    [args.customerId, args.day ?? null, n, args.orderId ?? null, args.reference],
  );
  const pool = await defaultPool(t);
  if (!pool) return;
  await t.query(
    `UPDATE five_gal_bottle_pool
     SET filled_with_customer = GREATEST(filled_with_customer - $2, 0), sold = sold + $2
     WHERE id = $1`, [pool.id, n],
  );
  const c = await t.maybeOne<{ name: string }>(`SELECT name FROM customers WHERE id = $1`, [args.customerId]);
  await logMovement(t, actor, pool, n, 'out', 'Adjustment', args.reference,
    `${n} bottle${n === 1 ? '' : 's'} sold to ${c?.name ?? 'the customer'} - theirs now, no refund`);
}

/**
 * How many bottles each customer is holding, derived from what was delivered
 * to them against what they handed back. This is the exchange side of the
 * pool: it says who to chase for empties.
 */
export async function customerHoldings(db: Db) {
  return db.query(
    `SELECT c.id AS customer_id, c.name, c.phone, c.delivery_zone,
            COALESCE(SUM(s.delivered), 0)::int   AS delivered,
            COALESCE(SUM(s.returned), 0)::int    AS returned,
            COALESCE(SUM(s.lost), 0)::int        AS lost,
            COALESCE(SUM(s.sold), 0)::int        AS sold,
            COALESCE(SUM(s.opening), 0)::int     AS opening,
            (COALESCE(SUM(s.opening), 0)
             + COALESCE(SUM(s.delivered), 0)
             - COALESCE(SUM(s.returned), 0)
             - COALESCE(SUM(s.lost), 0)
             - COALESCE(SUM(s.sold), 0))::int    AS holding,
            MAX(s.day)::text AS last_moved
     FROM customers c
     JOIN (${CUSTOMER_MOVES}) s ON s.customer_id = c.id
     GROUP BY c.id, c.name, c.phone, c.delivery_zone
     HAVING COALESCE(SUM(s.delivered), 0) > 0 OR COALESCE(SUM(s.returned), 0) > 0
         OR COALESCE(SUM(s.opening), 0) > 0
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
  /** Bought outright: theirs, so not part of what they hold of ours. */
  sold: number;
  closingHolding: number;
  /** The opening balance entered for them (28 Oct 2026), if any: part of openingHolding when it falls in or before the window. */
  openingEntered: { quantity: number; asOf: string } | null;
}> {
  const from = opts.from ?? null;
  const to = opts.to ?? null;

  const row = await db.one<{
    opening: string; delivered: string; returned: string; lost: string; sold: string; closing: string;
  }>(
    `SELECT
       -- everything BEFORE the window, so the period reads as a movement
       (COALESCE(SUM(
         CASE WHEN $2::date IS NOT NULL AND m.day < $2::date
              THEN m.opening + m.delivered - m.returned - m.lost - m.sold ELSE 0 END), 0)
       -- an opening balance dated inside the window is brought forward too:
       -- it is what they had, not something delivered in the period
        + COALESCE(SUM(CASE WHEN w.inWindow THEN m.opening ELSE 0 END), 0))::text AS opening,
       COALESCE(SUM(CASE WHEN w.inWindow THEN m.delivered ELSE 0 END), 0)::text AS delivered,
       COALESCE(SUM(CASE WHEN w.inWindow THEN m.returned ELSE 0 END), 0)::text AS returned,
       COALESCE(SUM(CASE WHEN w.inWindow THEN m.lost ELSE 0 END), 0)::text AS lost,
       COALESCE(SUM(CASE WHEN w.inWindow THEN m.sold ELSE 0 END), 0)::text AS sold,
       -- what they hold now, counting everything up to the end of the window
       COALESCE(SUM(
         CASE WHEN $3::date IS NULL OR m.day <= $3::date
              THEN m.opening + m.delivered - m.returned - m.lost - m.sold ELSE 0 END), 0)::text AS closing
     FROM (${CUSTOMER_MOVES}) m
     CROSS JOIN LATERAL (
       SELECT ($2::date IS NULL OR m.day >= $2::date)
          AND ($3::date IS NULL OR m.day <= $3::date) AS inWindow
     ) w
     WHERE m.customer_id = $1`,
    [customerId, from, to],
  );

  const entered = await db.maybeOne<{ delivered: number; moved_on: string }>(
    `SELECT delivered, moved_on::text AS moved_on FROM customer_bottle_moves
     WHERE customer_id = $1 AND opening`, [customerId]);

  return {
    openingHolding: num(row.opening),
    delivered: num(row.delivered),
    returned: num(row.returned),
    lost: num(row.lost),
    sold: num(row.sold),
    closingHolding: num(row.closing),
    openingEntered: entered ? { quantity: num(entered.delivered), asOf: entered.moved_on } : null,
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

/**
 * Put back the pool movements of a delivery that was recorded in error
 * (25 Oct 2026, "Undo - delivered in error"): the exact opposite of
 * applyDeliveryMovement, plus bottles bought outright.
 */
export async function reverseDeliveryMovement(
  t: Queryable,
  actor: Actor | null,
  args: { delivered?: number; emptiesPickedUp?: number; lostDamaged?: number; sold?: number; reference: string },
): Promise<void> {
  const out = Math.max(0, args.delivered ?? 0);
  const back = Math.max(0, args.emptiesPickedUp ?? 0);
  const lost = Math.max(0, args.lostDamaged ?? 0);
  const sold = Math.max(0, args.sold ?? 0);
  if (out + back + lost + sold === 0) return;
  const pool = await defaultPool(t);
  if (!pool) return;
  await t.query(
    `UPDATE five_gal_bottle_pool
     SET clean_ready = clean_ready + $2,
         filled_with_customer = GREATEST(filled_with_customer - $2 + $3 + $4 + $5, 0),
         returned_dirty = GREATEST(returned_dirty - $3, 0),
         lost_damaged = GREATEST(lost_damaged - $4, 0),
         sold = GREATEST(sold - $5, 0)
     WHERE id = $1`,
    [pool.id, out, back, lost, sold],
  );
  await logMovement(t, actor, pool, out, 'in', 'Adjustment', args.reference,
    `${out} full bottles back: delivery recorded in error, undone`);
  await logMovement(t, actor, pool, back, 'out', 'Adjustment', args.reference,
    `${back} empties taken back off: delivery recorded in error, undone`);
  await logMovement(t, actor, pool, lost + sold, 'in', 'Adjustment', args.reference,
    `${lost + sold} bottles written back: delivery recorded in error, undone`);
}

/* ------------------------------------------------------------------ */
/* Opening balances of our bottles (Everton, 28 Oct 2026)              */
/* ------------------------------------------------------------------ */

/*
 * "I now need to update bottles owned by us on the customer accounts."
 *
 * Start fresh set every customer's bottle holding to nothing, so the app only
 * knew about bottles delivered since go-live. The bottles of ours a customer
 * already had (worked out from the 2026 delivery sheet, as at Fri 23 Oct 2026)
 * go in as an opening balance: ONE row per customer in customer_bottle_moves,
 * marked `opening` and dated the day the count is as at. Entering it again
 * replaces it; 0 removes it.
 *
 * The pool's own totals are NOT moved. An opening balance says which customer
 * has bottles that are already out; it does not put new bottles into
 * circulation. The Bottle pool screen compares the two ("Not traced to a
 * customer" / "Difference to check"), which is where a pool count that is
 * out of step shows.
 *
 * Bottles the customer owns are never entered: the app counts OUR bottles
 * with customers. Administrators only, and every change is in the audit log.
 */

export interface OpeningResult {
  customerId: string; name: string; was: number; now: number; asOf: string;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function wholeBottles(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  if (String(v ?? '').trim() === '' || !Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

async function writeOpening(
  t: Queryable, actor: Actor, c: { id: string; name: string },
  quantity: number, asOf: string, reason: string, from: string,
): Promise<OpeningResult> {
  const prev = await t.maybeOne<{ delivered: number; moved_on: string }>(
    `SELECT delivered, moved_on::text AS moved_on FROM customer_bottle_moves
     WHERE customer_id = $1 AND opening FOR UPDATE`, [c.id]);
  const was = prev ? num(prev.delivered) : 0;
  if (!prev && quantity === 0) return { customerId: c.id, name: c.name, was, now: 0, asOf };
  if (prev && was === quantity && prev.moved_on === asOf) {
    return { customerId: c.id, name: c.name, was, now: quantity, asOf };
  }
  await t.query(`DELETE FROM customer_bottle_moves WHERE customer_id = $1 AND opening`, [c.id]);
  if (quantity > 0) {
    await t.query(
      `INSERT INTO customer_bottle_moves (customer_id, moved_on, delivered, opening, reference, note)
       VALUES ($1, $2::date, $3, true, 'Opening balance', $4)`,
      [c.id, asOf, quantity, reason],
    );
  }
  await audit(t, actor, 'adjust', 'Customer', c.id, c.name, {
    openingBottlesWas: was, openingBottlesNow: quantity, asOf,
    asOfWas: prev?.moved_on ?? null, reason, from,
  });
  return { customerId: c.id, name: c.name, was, now: quantity, asOf };
}

/** One customer's opening balance of our bottles, from their Bottles tab. */
export async function setOpeningBottles(
  db: Db, actor: Actor, customerId: string,
  args: { quantity: unknown; asOf?: string | null; reason?: string | null },
): Promise<OpeningResult> {
  requireRole(actor, 'admin');
  const quantity = wholeBottles(args.quantity);
  if (quantity === null) throw new RuleViolation('enter the number of our bottles as a whole number, 0 or more');
  const asOf = (args.asOf ?? '').trim() || businessToday();
  if (!ISO_DAY.test(asOf)) throw new RuleViolation('the "as at" date is not a date');
  if (asOf > businessToday()) throw new RuleViolation('an opening balance cannot be dated in the future');
  const reason = (args.reason ?? '').trim();
  if (!reason) throw new RuleViolation('a reason is required when setting an opening bottle balance');
  return db.tx(async (t) => {
    const c = await t.maybeOne<{ id: string; name: string }>(`SELECT id, name FROM customers WHERE id = $1`, [customerId]);
    if (!c) throw new RuleViolation('customer not found');
    return writeOpening(t, actor, c, quantity, asOf, reason, 'customer page');
  });
}

export interface OpeningUploadRow { customer: string; quantity: unknown }
export interface OpeningUploadInput { rows: OpeningUploadRow[]; asOf: string; reason?: string | null; dryRun?: boolean }
export interface OpeningUploadRowResult {
  row: number; customer: string; customerId: string | null; matchedName: string | null;
  inactive: boolean; was: number; now: number;
  action: 'set' | 'change' | 'remove' | 'same' | 'error'; errors: string[];
}

/**
 * The opening balances for many customers at once, from the workbook made
 * from the bottle-ownership review. Checked first (nothing written), then
 * brought in as ONE transaction, like the customer and product uploads.
 * Customers are matched by name exactly as in the app (case and spacing
 * aside); a name that is not there, or is there twice, stops the upload.
 */
export async function uploadOpeningBottles(db: Db, actor: Actor, input: OpeningUploadInput) {
  requireRole(actor, 'admin');
  const asOf = String(input.asOf ?? '').trim();
  if (!ISO_DAY.test(asOf)) throw new RuleViolation('choose the date the counts are as at');
  if (asOf > businessToday()) throw new RuleViolation('opening balances cannot be dated in the future');
  const reason = (input.reason ?? '').trim() || `Opening balance of our 5-gallon bottles as at ${asOf}`;
  const rows = Array.isArray(input.rows) ? input.rows : [];
  if (rows.length === 0) throw new RuleViolation('the file has no customers in it');

  const key = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const all = await db.query<{ id: string; name: string; active: boolean }>(`SELECT id, name, active FROM customers`);
  const byName = new Map<string, Array<{ id: string; name: string; active: boolean }>>();
  for (const c of all) byName.set(key(c.name), [...(byName.get(key(c.name)) ?? []), c]);
  const current = new Map((await db.query<{ customer_id: string; delivered: number }>(
    `SELECT customer_id, delivered FROM customer_bottle_moves WHERE opening`)).map((r) => [r.customer_id, num(r.delivered)]));

  const seen = new Set<string>();
  const results: OpeningUploadRowResult[] = rows.map((r, i) => {
    const errors: string[] = [];
    const name = String(r.customer ?? '').replace(/\s+/g, ' ').trim();
    const qty = wholeBottles(r.quantity);
    if (!name) errors.push('no customer name');
    if (qty === null) errors.push('the number of bottles must be a whole number, 0 or more');
    const hits = name ? (byName.get(key(name)) ?? []) : [];
    if (name && hits.length === 0) errors.push('no customer with this name in the app');
    if (hits.length > 1) errors.push('two customers in the app have this name - set this one on the customer page instead');
    const c = hits.length === 1 ? hits[0] : null;
    if (c && seen.has(c.id)) errors.push('this customer is in the file twice');
    if (c) seen.add(c.id);
    const was = c ? (current.get(c.id) ?? 0) : 0;
    const now = qty ?? 0;
    const action: OpeningUploadRowResult['action'] = errors.length ? 'error'
      : was === now ? 'same' : now === 0 ? 'remove' : was === 0 ? 'set' : 'change';
    return {
      row: i + 1, customer: name, customerId: c?.id ?? null, matchedName: c?.name ?? null,
      inactive: c ? !c.active : false, was, now, action, errors,
    };
  });

  const withErrors = results.filter((r) => r.action === 'error').length;
  const summary = {
    dryRun: input.dryRun !== false, asOf, rows: results, withErrors,
    toSet: results.filter((r) => r.action === 'set' || r.action === 'change').length,
    toRemove: results.filter((r) => r.action === 'remove').length,
    bottles: results.filter((r) => r.action !== 'error').reduce((a, r) => a + r.now, 0),
    done: 0,
  };
  if (summary.dryRun) return summary;
  if (withErrors > 0) throw new RuleViolation(`${withErrors} row${withErrors === 1 ? ' has' : 's have'} a problem - nothing was brought in`);

  await db.tx(async (t) => {
    for (const r of results) {
      await writeOpening(t, actor, { id: r.customerId!, name: r.matchedName! }, r.now, asOf, reason, 'opening bottles upload');
    }
  });
  return { ...summary, done: results.length };
}
