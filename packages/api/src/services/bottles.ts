/**
 * The 5-gallon jug cycle, as the plant runs it (Everton, 29 Oct and 3 Nov 2026).
 *
 *   empties at the plant ──production (wash + fill)──▶ full, in stock
 *        ▲                                                  │ delivered / collected
 *        └───────────── empties back ◀──── out with customers
 *
 * There are no clean empty jugs: once a jug is washed it is filled. Empties
 * are the returns plus new jugs bought (on a PO, or by hand without one), and
 * every 5-gallon production run draws on them. A jug lost on the road or
 * scrapped at the plant is a BUSINESS loss - never charged to the customer.
 *
 * Each figure has ONE home, so this screen and Stock can never disagree:
 *
 *   empties at the plant = the raw material ticked "This is the returnable
 *                          5-gallon jug" (5 Gal (19L) Bottle): its stock IS
 *                          the empties, counted on Stock > Count like any
 *                          other material
 *   full, in stock       = finished goods of the returnable products
 *   out with customers   = the customer accounts: OUR bottles on loan, from
 *                          the opening balances of 23 Oct 2026 onwards
 *   lost or scrapped     = losses on the customer accounts + jugs scrapped
 *
 * The old pool boxes (clean / with customer / awaiting wash) are retired and
 * the wash stage is gone (migration 037).
 *
 * Cost (3 Nov 2026): a jug's price is recorded once, on its purchase. Empties
 * move as a COUNT only - the jug material keeps no open FIFO layers - so
 * filling a jug adds no jug cost to the water.
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, requireRole, num, businessToday } from './core.ts';
import { RuleViolation } from '@alka/shared';

export interface JugMaterial { id: string; name: string; onHand: number }

/** The raw material that IS the returnable 5-gallon jug, if one is ticked. */
export async function jugMaterial(t: Queryable): Promise<JugMaterial | null> {
  const r = await t.maybeOne<{ id: string; name: string; quantity_on_hand: string }>(
    `SELECT id, name, quantity_on_hand FROM raw_materials WHERE is_returnable_jug LIMIT 1`,
  );
  return r ? { id: r.id, name: r.name, onHand: num(r.quantity_on_hand) } : null;
}

export type EmptiesMove = 'BottleReturn' | 'ProductionBatch' | 'JugsBought' | 'JugsScrapped'
  | 'PurchaseOrder' | 'Adjustment' | 'Sale';

/**
 * Move the empties at the plant by `quantity` (positive in, negative out) and
 * write it to the stock ledger under the jug material, so Stock's history
 * explains the figure. The count may go below zero (3 Nov 2026): the plant
 * sometimes fills jugs from empties a driver brings back mid-round before
 * the round is settled, and a negative figure is the prompt to count.
 */
export async function moveEmpties(
  t: Queryable,
  quantity: number,
  kind: EmptiesMove,
  reference: string,
  notes: string,
  opts: { day?: string | null; costCents?: number | null } = {},
): Promise<boolean> {
  const q = Math.round(Number(quantity) || 0);
  if (q === 0) return false;
  const jug = await jugMaterial(t);
  if (!jug) return false;
  await t.query(
    `UPDATE raw_materials SET quantity_on_hand = quantity_on_hand + $2 WHERE id = $1`,
    [jug.id, q],
  );
  const cost = opts.costCents == null ? null : Math.round(opts.costCents);
  const d = opts.day as unknown;
  const day = d == null || d === '' ? null
    : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  await t.query(
    `INSERT INTO inventory_transactions
       (item_type, item_id, item_name, quantity, direction, reference, reference_type,
        unit_cost_cents, total_cost_cents, notes, txn_date)
     VALUES ('RawMaterial',$1,$2,$3,$4,$5,$6,$7,$8,$9,
             COALESCE(($10::text || 'T12:00:00-05:00')::timestamptz, now()))`,
    [jug.id, jug.name, Math.abs(q), q > 0 ? 'in' : 'out', reference, kind,
     cost == null ? null : Math.round(cost / Math.abs(q)), cost, notes, day],
  );
  return true;
}

export interface PoolFigures {
  /** The jug material, or null when none is ticked on Raw materials. */
  jug: { id: string; name: string } | null;
  /** Empties at the plant (= Stock's jug material). */
  empties: number;
  /** Full jugs in stock (= Stock's finished goods of the returnable products). */
  full: number;
  fullProducts: Array<{ productId: string; name: string; bottles: number }>;
  /** Our bottles on loan, from the customer accounts. */
  withCustomers: number;
  /** Lost on the road (customer accounts). */
  lostOnRoad: number;
  /** Scrapped at the plant (production runs and by hand). */
  scrapped: number;
  /** Bought outright by customers - theirs now. */
  sold: number;
  /** Empties + full + with customers: jugs of ours in the cycle. */
  inCycle: number;
}

/** The four figures of the cycle, each read from its one home. */
export async function poolFigures(db: Queryable): Promise<PoolFigures> {
  const jug = await jugMaterial(db);
  const full = await db.query<{ id: string; name: string; bottles: number }>(
    `SELECT p.id, p.name, COALESCE(f.quantity_on_hand, 0)::int AS bottles
     FROM products p LEFT JOIN finished_goods_stock f ON f.product_id = p.id
     WHERE p.is_returnable AND NOT p.is_bottle_charge
       AND (p.active OR COALESCE(f.quantity_on_hand, 0) <> 0)
     ORDER BY p.name`,
  );
  const acc = await db.one<{ holding: number; lost: number; sold: number }>(
    `SELECT COALESCE(SUM(m.opening + m.delivered - m.returned - m.lost - m.sold), 0)::int AS holding,
            COALESCE(SUM(m.lost), 0)::int AS lost,
            COALESCE(SUM(m.sold), 0)::int AS sold
     FROM (${CUSTOMER_MOVES}) m`,
  );
  const scrapped = jug ? await db.one<{ n: number }>(
    `SELECT COALESCE(SUM(quantity), 0)::int AS n FROM inventory_transactions
     WHERE item_type = 'RawMaterial' AND item_id = $1 AND reference_type = 'JugsScrapped'
       AND direction = 'out'`, [jug.id]) : { n: 0 };
  const empties = jug ? jug.onHand : 0;
  const fullN = full.reduce((s, r) => s + num(r.bottles), 0);
  return {
    jug: jug ? { id: jug.id, name: jug.name } : null,
    empties,
    full: fullN,
    fullProducts: full.map((r) => ({ productId: r.id, name: r.name, bottles: num(r.bottles) })),
    withCustomers: num(acc.holding),
    lostOnRoad: num(acc.lost),
    scrapped: num(scrapped.n),
    sold: num(acc.sold),
    inCycle: empties + fullN + num(acc.holding),
  };
}

/**
 * The jug movements at a delivery stop, counter sale or collection. Only the
 * EMPTIES move a stored figure here: full jugs leave finished goods where the
 * sale is recorded (stockmoves.takeFinishedGoods or the truck load), and
 * what the customer holds is read from their account. A loss is a business
 * loss and never produces an invoice line.
 */
export async function applyDeliveryMovement(
  t: Queryable,
  _actor: Actor | null,
  args: {
    delivered?: number;
    emptiesPickedUp?: number;
    lostDamaged?: number;
    reference: string;
    customerName?: string;
    day?: string | null;
  },
): Promise<void> {
  const back = Math.max(0, Math.round(args.emptiesPickedUp ?? 0));
  if (back === 0) return;
  const who = args.customerName ? ` from ${args.customerName}` : '';
  await moveEmpties(t, back, 'BottleReturn', args.reference,
    `${back} empt${back === 1 ? 'y' : 'ies'} back${who}`, { day: args.day ?? null });
}

/**
 * New jugs bought WITHOUT a purchase order (bottles running low, a new
 * customer): they go straight into the empties, and their cost is recorded
 * here once. Jugs bought on a PO arrive by receiving the PO instead.
 */
export async function recordJugsBought(
  db: Db,
  actor: Actor,
  args: {
    quantity: number; unitCostCents?: number | null; supplierId?: string | null;
    boughtOn?: string | null; notes?: string | null;
  },
): Promise<PoolFigures> {
  requireRole(actor, 'admin', 'user');
  const qty = Math.round(Number(args.quantity));
  if (!Number.isFinite(qty) || qty <= 0) throw new RuleViolation('enter how many new jugs were bought');
  const unit = args.unitCostCents == null || (args.unitCostCents as unknown) === ''
    ? null : Math.round(Number(args.unitCostCents));
  if (unit != null && (!Number.isFinite(unit) || unit < 0)) throw new RuleViolation('a cost cannot be negative');
  const day = (args.boughtOn ?? '').trim() || null;
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RuleViolation('the day they were bought is not a date');
  if (day && day > businessToday()) throw new RuleViolation('they cannot have been bought in the future');

  return db.tx(async (t) => {
    const jug = await jugMaterial(t);
    if (!jug) {
      throw new RuleViolation('no raw material is ticked as the returnable 5-gallon jug - tick it on Raw materials first');
    }
    const supplier = args.supplierId
      ? await t.maybeOne<{ name: string }>(`SELECT name FROM suppliers WHERE id = $1`, [args.supplierId])
      : null;
    // The cost record: a layer received and closed at once, so the jug's
    // price is kept against the purchase but never charged into a run.
    if (unit != null) {
      await t.query(
        `INSERT INTO material_batches
           (raw_material_id, supplier_id, unit_cost_cents, quantity_received, quantity_remaining,
            status, received_date)
         VALUES ($1,$2,$3,$4,0,'Consumed',
                 COALESCE(($5::text || 'T12:00:00-05:00')::timestamptz, now()))`,
        [jug.id, args.supplierId || null, unit, qty, day],
      );
    }
    const note = [
      `${qty} new jug${qty === 1 ? '' : 's'} bought without a purchase order`,
      supplier ? `from ${supplier.name}` : null,
      args.notes?.trim() || null,
    ].filter(Boolean).join(', ');
    await moveEmpties(t, qty, 'JugsBought', `Bought by ${actor.name}`, note,
      { day, costCents: unit == null ? null : unit * qty });
    await audit(t, actor, 'create', 'RawMaterial', jug.id, jug.name, {
      jugsBought: qty, unitCostCents: unit, supplierId: args.supplierId ?? null, boughtOn: day,
      notes: args.notes ?? null,
    });
    return poolFigures(t);
  });
}

/** Jugs found unusable at the plant outside a production run. */
export async function scrapJugs(
  db: Db, actor: Actor, args: { quantity: number; reason: string },
): Promise<PoolFigures> {
  requireRole(actor, 'admin', 'user');
  const qty = Math.round(Number(args.quantity));
  if (!Number.isFinite(qty) || qty <= 0) throw new RuleViolation('enter how many jugs were scrapped');
  if (!args.reason?.trim()) throw new RuleViolation('say why the jugs were scrapped');
  return db.tx(async (t) => {
    const jug = await jugMaterial(t);
    if (!jug) throw new RuleViolation('no raw material is ticked as the returnable 5-gallon jug');
    await moveEmpties(t, -qty, 'JugsScrapped', `Scrapped by ${actor.name}`,
      `${qty} jug${qty === 1 ? '' : 's'} scrapped - business loss: ${args.reason.trim()}`);
    await audit(t, actor, 'adjust', 'RawMaterial', jug.id, jug.name, { jugsScrapped: qty, reason: args.reason.trim() });
    return poolFigures(t);
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
  // What the customer holds of ours is read from their account, so this
  // row is the whole of it: no separate pool figure to move.
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
 * The empties' movement history: the jug material's lines on the stock
 * ledger (returns, runs, jugs bought, scrapped, counts). Movements recorded
 * under the retired pool (before 3 Nov 2026) are not shown.
 */
export async function poolHistory(db: Db, limit = 100) {
  const jug = await jugMaterial(db);
  if (!jug) return [];
  return db.query(
    `SELECT id, quantity, direction, reference, reference_type, txn_date,
            business_date(txn_date)::text AS txn_day, notes
     FROM inventory_transactions
     WHERE item_type = 'RawMaterial' AND item_id = $1
     ORDER BY txn_date DESC
     LIMIT $2`,
    [jug.id, limit],
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

    // Only the difference moves, so running it again changes nothing.
    if (delta > 0) {
      await applyDeliveryMovement(t, actor, {
        delivered: delta,
        reference: `Correction ${stopId}`,
        customerName: customer?.name,
      });
    }
    // (What the customer holds is read from the stop itself, so correcting
    // the stop is the whole correction; full jugs already left stock when
    // the delivery was recorded.)

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
  // Full jugs go back on the shelf where the undo restores the stock
  // (undodelivery.ts); lost and sold live on the customer account, which
  // the undo deletes with the stop. Only the empties are a stored figure.
  const back = Math.max(0, Math.round(args.emptiesPickedUp ?? 0));
  if (back === 0) return;
  await moveEmpties(t, -back, 'Adjustment', args.reference,
    `${back} empt${back === 1 ? 'y' : 'ies'} taken back off: delivery recorded in error, undone`);
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
