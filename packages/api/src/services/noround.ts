/**
 * Delivery orders with no round (Everton, 25 Nov 2026).
 *
 * "The situation can occur where an order is taken off and not reassigned a
 * round in time for the check and then forgotten, so it would be best if an
 * alert is created the moment a delivery order has no round. It doesnt need
 * to be an email alert but more so subtle alert next to delivery rounds and
 * on the number changed on the panel in today. This would automatically
 * change once the orders are assigned."
 *
 * So nothing is stored as an "alert": the list is worked out live, every
 * time it is asked for, and an order leaves it the moment it is on a round.
 *
 * A delivery order needs a round when it is still to be delivered (Pending,
 * or Part delivered with the rest to come) and is not waiting on an open
 * round. Left out, because they never belong on one or are not yet the
 * office's to place: collections and counter sales, orders waiting for an
 * admin's approval of their day, and deliveries recorded after the fact.
 *
 * Also counted: customers who opened their own account and said "Not sure"
 * of their zone, until somebody sets it (his answer the same day: office
 * staff may set it too). Setting it puts their waiting orders on their
 * zone's round and emails them their delivery day.
 */
import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, businessToday, requireRole } from './core.ts';
import { RuleViolation } from '@alka/shared';
import { assertZoneUsable } from './zones.ts';
import { placeOnDeliverySheet } from './orders.ts';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Tue 24 Nov" */
export function shortDay(iso: string | null | undefined): string {
  const s = String(iso ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const d = new Date(`${s}T12:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** A timestamp as ISO text, however the driver hands it back. */
const isoOf = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? ''));

const MISSED: Record<string, string> = {
  'Customer Not Home': 'not home', Refused: 'refused', Rescheduled: 'rescheduled',
  Other: 'not delivered', 'Payment Only': 'paid, nothing delivered',
};

/** The test, as SQL over `o` (customer_orders): this delivery order has no round. */
export const NEEDS_ROUND_SQL = `(
  o.delivery_mode = 'Delivery'
  AND o.status IN ('Pending','Partially Delivered')
  AND NOT o.needs_review
  AND NOT COALESCE(o.recorded_late, false)
  AND NOT EXISTS (
    SELECT 1 FROM delivery_stops ns JOIN delivery_sheets nd ON nd.id = ns.delivery_sheet_id
     WHERE ns.order_id = o.id AND ns.stop_outcome = 'Pending' AND nd.status = 'Open')
)`;

export interface NoRoundOrder {
  id: string; orderNumber: string; customerId: string; customerName: string;
  status: string; day: string | null; zone: string | null;
  /** Why it has no round, in the office's words. */
  reason: string;
  /** What the reason is, for the screens: no zone, came off, missed, or not placed. */
  kind: 'no-zone' | 'off-round' | 'missed' | 'rest' | 'not-placed';
  /** Its delivery date has passed: a new day is needed. */
  late: boolean;
  since: string;
}

export interface NoZoneCustomer {
  id: string; name: string; phone: string | null; address: string | null; signedUpAt: string;
}

export interface NoRound {
  orders: NoRoundOrder[];
  customers: NoZoneCustomer[];
  /** Orders plus customers: the badge on Delivery rounds and the Today panel. */
  count: number;
}

/** Everything that needs a round (or a zone) right now. */
export async function noRound(db: Queryable, opts: { customerId?: string } = {}): Promise<NoRound> {
  const today = businessToday();
  const rows = await db.query<{
    id: string; order_number: string; customer_id: string; customer_name: string; status: string;
    day: string | null; zone: string | null; off_note: string | null; off_at: string | null;
    created_at: string; last_outcome: string | null; last_zone: string | null; last_day: string | null;
    last_at: string | null;
  }>(
    `SELECT o.id, o.order_number, o.customer_id, c.name AS customer_name, o.status,
            o.requested_delivery_date::text AS day,
            COALESCE(a.delivery_zone, c.delivery_zone) AS zone,
            o.off_round_note AS off_note, o.off_round_at AS off_at, o.created_at,
            ls.stop_outcome AS last_outcome, ld.zone AS last_zone, ld.delivery_date::text AS last_day,
            COALESCE(ls.settled_at, ld.created_at) AS last_at
     FROM customer_orders o
     JOIN customers c ON c.id = o.customer_id
     LEFT JOIN customer_addresses a ON a.id = o.address_id
     LEFT JOIN LATERAL (
       SELECT s2.* FROM delivery_stops s2 JOIN delivery_sheets d2 ON d2.id = s2.delivery_sheet_id
        WHERE s2.order_id = o.id ORDER BY d2.delivery_date DESC, d2.created_at DESC LIMIT 1
     ) ls ON true
     LEFT JOIN delivery_sheets ld ON ld.id = ls.delivery_sheet_id
     WHERE ${NEEDS_ROUND_SQL}
       AND ($1::uuid IS NULL OR o.customer_id = $1::uuid)
     ORDER BY COALESCE(o.requested_delivery_date, o.order_date), o.created_at`,
    [opts.customerId ?? null],
  );
  const orders = rows.map((r): NoRoundOrder => {
    const day = r.day;
    const late = !!day && day < today;
    let kind: NoRoundOrder['kind']; let reason: string; let since = r.created_at;
    if (!r.zone) {
      kind = 'no-zone'; reason = 'No delivery zone on file';
    } else if (r.last_outcome && MISSED[r.last_outcome]) {
      kind = 'missed'; since = r.last_at ?? since;
      reason = `Missed on the ${r.last_zone} round, ${shortDay(r.last_day)} (${MISSED[r.last_outcome]})`;
    } else if (r.off_note) {
      kind = 'off-round'; reason = r.off_note; since = r.off_at ?? since;
    } else if (r.status === 'Partially Delivered') {
      kind = 'rest'; reason = 'Part delivered: the rest still needs a round';
    } else {
      kind = 'not-placed'; reason = 'Not placed on a round';
    }
    return {
      id: r.id, orderNumber: r.order_number, customerId: r.customer_id, customerName: r.customer_name,
      status: r.status, day, zone: r.zone, reason, kind, late, since: isoOf(since),
    };
  });

  const customers = opts.customerId ? [] : (await db.query<{
    id: string; name: string; phone: string | null; delivery_address: string | null; signed_up_at: string;
  }>(
    `SELECT id, name, phone, delivery_address, signed_up_at FROM customers
     WHERE active AND signed_up_at IS NOT NULL AND delivery_zone IS NULL
     ORDER BY signed_up_at`,
  )).map((c) => ({ id: c.id, name: c.name, phone: c.phone, address: c.delivery_address, signedUpAt: isoOf(c.signed_up_at) }));

  // A customer with no zone and an order is one thing to fix, not two: the
  // order already says "No delivery zone on file".
  const withOrders = new Set(orders.filter((o) => o.kind === 'no-zone').map((o) => o.customerId));
  return { orders, customers, count: orders.length + customers.filter((c) => !withOrders.has(c.id)).length };
}

/** Just the number, for the menu badge. */
export async function noRoundCount(db: Queryable): Promise<number> {
  return (await noRound(db)).count;
}

/* ------------------------------------------------------------------ */
/* Putting it on its round                                             */
/* ------------------------------------------------------------------ */

export interface PutOnRoundInput {
  /** The day to deliver; needed when its date has passed. Default: its date. */
  date?: string | null;
  /** For a customer with no zone: the zone to set on them first. */
  zone?: string | null;
}

/**
 * Put one waiting delivery order on its zone's round for its day (creating
 * that round if it does not exist yet). If the customer has no zone, the
 * office picks one and it is saved on the customer; if the date has passed,
 * a new day is needed.
 */
export async function putOnRound(
  db: Db, actor: Actor, orderId: string, input: PutOnRoundInput = {},
): Promise<{ orderNumber: string; zone: string; day: string }> {
  requireRole(actor, 'admin', 'user');
  const zoneSet = input.zone?.trim() || null;
  let customerForEmail: string | null = null;
  const out = await db.tx(async (t) => {
    const o = await t.maybeOne<{
      order_number: string; customer_id: string; delivery_mode: string; status: string;
      needs_review: boolean; day: string | null; address_id: string | null; zone: string | null;
      address_zone: string | null;
    }>(
      `SELECT o.order_number, o.customer_id, o.delivery_mode, o.status, o.needs_review,
              o.requested_delivery_date::text AS day, o.address_id, c.delivery_zone AS zone,
              a.delivery_zone AS address_zone
       FROM customer_orders o JOIN customers c ON c.id = o.customer_id
       LEFT JOIN customer_addresses a ON a.id = o.address_id
       WHERE o.id = $1 FOR UPDATE OF o`, [orderId]);
    if (!o) throw new RuleViolation('that order no longer exists');
    if (o.delivery_mode !== 'Delivery') throw new RuleViolation(`${o.order_number} is not a delivery, so it needs no round`);
    if (o.status !== 'Pending' && o.status !== 'Partially Delivered') {
      throw new RuleViolation(`${o.order_number} is ${o.status.toLowerCase()}, so it needs no round`);
    }
    if (o.needs_review) {
      throw new RuleViolation(`${o.order_number} is waiting for an admin to approve its day under Needs a decision`);
    }

    let zone = o.address_zone ?? o.zone;
    if (!zone) {
      if (!zoneSet) throw new RuleViolation(`pick a delivery zone for ${o.order_number}'s customer first`);
      const r = await setZone(t, actor, o.customer_id, zoneSet, { placeOrders: false });
      if (r.firstZone) customerForEmail = o.customer_id;
      zone = zoneSet;
    }

    const today = businessToday();
    const day = input.date?.slice(0, 10) || o.day || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RuleViolation('that is not a date');
    if (day < today) throw new RuleViolation(`${o.order_number} was for ${shortDay(day)}, which has passed: pick a new day`);
    if (day !== o.day) {
      await t.query(`UPDATE customer_orders SET requested_delivery_date = $2::date WHERE id = $1`, [orderId, day]);
    }
    const placed = await placeOnDeliverySheet(t, orderId, o.customer_id, day, o.address_id);
    if (!placed.sheetId) throw new RuleViolation(placed.warnings.join(' ') || `${o.order_number} could not be put on a round`);
    await audit(t, actor, 'update', 'CustomerOrder', orderId, o.order_number, {
      putOnRound: { zone, day, ...(day !== o.day ? { movedFrom: o.day } : {}) },
    });
    return { orderNumber: o.order_number, zone, day };
  });
  if (customerForEmail) await zoneSetEmail(db, customerForEmail);
  return out;
}

/** Several at once (the batch action): each on its own date; the rest say why not. */
export async function putOnRounds(
  db: Db, actor: Actor, orderIds: string[], input: PutOnRoundInput = {},
): Promise<{ placed: Array<{ orderNumber: string; zone: string; day: string }>; skipped: Array<{ id: string; why: string }> }> {
  requireRole(actor, 'admin', 'user');
  const placed: Array<{ orderNumber: string; zone: string; day: string }> = [];
  const skipped: Array<{ id: string; why: string }> = [];
  for (const id of orderIds) {
    try {
      placed.push(await putOnRound(db, actor, id, input));
    } catch (err) {
      skipped.push({ id, why: err instanceof Error ? err.message : String(err) });
    }
  }
  return { placed, skipped };
}

/* ------------------------------------------------------------------ */
/* Setting a customer's zone                                           */
/* ------------------------------------------------------------------ */

/**
 * Set a customer's delivery zone, from the Today panel or Needs a decision
 * (office staff or admin). Their waiting delivery orders with no round go on
 * that zone's round for their day; a customer who opened their own account
 * is emailed their delivery day (the sign-up page promised "We'll place you
 * and let you know").
 */
export async function setCustomerZone(
  db: Db, actor: Actor, customerId: string, zone: string,
): Promise<{ placed: string[]; notPlaced: Array<{ orderNumber: string; why: string }>; emailed: boolean }> {
  requireRole(actor, 'admin', 'user');
  const z = zone?.trim();
  if (!z) throw new RuleViolation('pick a delivery zone');
  const r = await db.tx((t) => setZone(t, actor, customerId, z, { placeOrders: true }));
  const emailed = r.firstZone ? (await zoneSetEmail(db, customerId)) : false;
  return { placed: r.placed, notPlaced: r.notPlaced, emailed };
}

/** Called after a zone goes on a customer by any route (also Details): place their orders, tell them. */
export async function afterZoneSet(db: Db, actor: Actor, customerId: string, wasEmpty: boolean): Promise<string[]> {
  const placed = await db.tx(async (t) => (await placeWaiting(t, actor, customerId)).placed);
  if (wasEmpty) await zoneSetEmail(db, customerId);
  return placed;
}

async function setZone(
  t: Queryable, actor: Actor, customerId: string, zone: string, opts: { placeOrders: boolean },
): Promise<{ firstZone: boolean; placed: string[]; notPlaced: Array<{ orderNumber: string; why: string }> }> {
  const c = await t.maybeOne<{ name: string; delivery_zone: string | null; active: boolean }>(
    `SELECT name, delivery_zone, active FROM customers WHERE id = $1 FOR UPDATE`, [customerId]);
  if (!c || !c.active) throw new RuleViolation('customer not found');
  if (c.delivery_zone !== zone) {
    await assertZoneUsable(t, zone);
    await t.query(`UPDATE customers SET delivery_zone = $2, updated_at = now() WHERE id = $1`, [customerId, zone]);
    await audit(t, actor, 'update', 'Customer', customerId, c.name, { deliveryZone: zone, from: c.delivery_zone });
  }
  const r = opts.placeOrders ? await placeWaiting(t, actor, customerId) : { placed: [], notPlaced: [] };
  return { firstZone: !c.delivery_zone, ...r };
}

/** Their waiting delivery orders with no round, onto their zone's round for their day. */
async function placeWaiting(
  t: Queryable, actor: Actor, customerId: string,
): Promise<{ placed: string[]; notPlaced: Array<{ orderNumber: string; why: string }> }> {
  const today = businessToday();
  const waiting = (await noRound(t, { customerId })).orders;
  const placed: string[] = []; const notPlaced: Array<{ orderNumber: string; why: string }> = [];
  for (const o of waiting) {
    if (!o.zone) continue; // another address of theirs with no zone of its own
    if (o.late || !o.day) {
      notPlaced.push({ orderNumber: o.orderNumber, why: o.day ? `its day (${shortDay(o.day)}) has passed: pick a new one` : 'it has no delivery day' });
      continue;
    }
    if (o.day < today) continue;
    const addr = await t.one<{ address_id: string | null }>(`SELECT address_id FROM customer_orders WHERE id = $1`, [o.id]);
    const p = await placeOnDeliverySheet(t, o.id, customerId, o.day, addr.address_id);
    if (p.sheetId) {
      placed.push(o.orderNumber);
      await audit(t, actor, 'update', 'CustomerOrder', o.id, o.orderNumber, { putOnRound: { zone: o.zone, day: o.day, afterZoneSet: true } });
    } else {
      notPlaced.push({ orderNumber: o.orderNumber, why: p.warnings.join(' ') });
    }
  }
  return { placed, notPlaced };
}

/** "Your delivery day is…" to a customer who opened their own account (25 Nov 2026). */
async function zoneSetEmail(db: Db, customerId: string): Promise<boolean> {
  const c = await db.maybeOne<{ signed_up_at: string | null }>(
    `SELECT signed_up_at FROM customers WHERE id = $1`, [customerId]);
  if (!c?.signed_up_at) return false;
  const { sendZoneSetEmail } = await import('./messaging.ts');
  try {
    return (await sendZoneSetEmail(db, customerId)).sent;
  } catch (err) {
    console.error(`  Delivery-day email did not go: ${(err as Error).message}`);
    return false;
  }
}
