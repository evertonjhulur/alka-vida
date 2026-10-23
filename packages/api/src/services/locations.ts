/**
 * Map pins and sorting a round's stops (Everton, 23 Oct 2026).
 *
 *  - Pins: every delivery address can carry a map pin. The driver saves one
 *    at the door with the phone's GPS (the one to trust); the office can
 *    place one or paste a Google Maps link. The plant's pin is a setting.
 *  - Sorting: "Sort the stops" on a round, from the plant and back, BEFORE
 *    the round starts. Starting the round locks the order.
 *      * Road map: openrouteservice's optimiser (free, OpenStreetMap roads),
 *        when ORS_API_KEY is set (Railway variable, or a line in
 *        "Alka Vida settings.txt"). Up to 50 stops a round.
 *      * Straight line: worked out here (shared/routeorder.ts), no internet,
 *        the fallback whenever the road map is off or does not answer.
 *    Stops without a pin go last, in their current order.
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, getSetting, requireRole } from './core.ts';
import {
  RuleViolation, haversineKm, inJamaica, orderStops, parseLatLng, tourKm, type LatLng,
} from '@alka/shared';

const ORS_URL = 'https://api.openrouteservice.org/optimization';
const ORS_MAX_JOBS = 50;

export type PinSource = 'Driver' | 'Office' | 'Link' | 'Customer';

/* ------------------------------------------------------------------ */
/* Pins                                                                */
/* ------------------------------------------------------------------ */

function checkPoint(p: { lat?: unknown; lng?: unknown }): LatLng {
  const lat = Number(p.lat);
  const lng = Number(p.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new RuleViolation('that is not a map position');
  const pt = { lat, lng };
  if (!inJamaica(pt)) throw new RuleViolation('that position is not in Jamaica - check the pin or the link');
  return pt;
}

/** A short maps.app.goo.gl link has no coordinates in it: follow it to the long one. */
async function followShortLink(url: string): Promise<string> {
  let at = url;
  for (let i = 0; i < 5; i++) {
    let host: string;
    try { host = new URL(at).hostname; } catch { return at; }
    if (!/(^|\.)goo\.gl$|^maps\.app\.goo\.gl$|(^|\.)g\.co$/.test(host)) return at;
    const r = await fetch(at, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(6000) });
    const next = r.headers.get('location');
    if (!next) return at;
    at = new URL(next, at).toString();
  }
  return at;
}

/** Coordinates from a pasted link or "lat, lng". */
export async function pointFromText(text: string): Promise<LatLng> {
  const raw = String(text ?? '').trim();
  if (!raw) throw new RuleViolation('paste a Google Maps link or the coordinates');
  let p = parseLatLng(raw);
  if (!p && /^https?:\/\//i.test(raw)) {
    try { p = parseLatLng(await followShortLink(raw)); } catch { /* fall through */ }
  }
  if (!p) {
    throw new RuleViolation('no map position found in that. In Google Maps, press and hold on the spot, then copy the numbers that appear (like 18.0123, -76.9456)');
  }
  return checkPoint(p);
}

export interface PinInput {
  /** Blank = the customer's main address. */
  addressId?: string | null;
  lat?: number; lng?: number;
  /** Instead of lat/lng: a Google Maps link or "lat, lng". */
  text?: string;
  accuracyM?: number | null;
  source?: PinSource;
}

async function writePin(
  t: Queryable, customerId: string, addressId: string | null, p: LatLng | null,
  accuracyM: number | null, source: PinSource | null, by: string | null,
): Promise<void> {
  const vals = p
    ? [p.lat, p.lng, accuracyM, source, by]
    : [null, null, null, null, null];
  if (addressId) {
    const a = await t.maybeOne<{ customer_id: string }>(`SELECT customer_id FROM customer_addresses WHERE id = $1`, [addressId]);
    if (!a || a.customer_id !== customerId) throw new RuleViolation('that address is not one of this customer\'s');
    await t.query(
      `UPDATE customer_addresses SET lat = $2, lng = $3, location_accuracy_m = $4, location_source = $5,
              location_set_by = $6, location_set_at = CASE WHEN $2::float8 IS NULL THEN NULL ELSE now() END
       WHERE id = $1`, [addressId, ...vals]);
  } else {
    await t.query(
      `UPDATE customers SET lat = $2, lng = $3, location_accuracy_m = $4, location_source = $5,
              location_set_by = $6, location_set_at = CASE WHEN $2::float8 IS NULL THEN NULL ELSE now() END
       WHERE id = $1`, [customerId, ...vals]);
  }
}

/** The office places or clears a pin (or pastes a link). */
export async function setCustomerPin(
  db: Db, actor: Actor, customerId: string, input: PinInput & { clear?: boolean },
): Promise<{ lat: number | null; lng: number | null }> {
  requireRole(actor, 'admin', 'user');
  const addressId = input.addressId || null;
  let p: LatLng | null = null;
  let source: PinSource | null = null;
  if (!input.clear) {
    if (input.text) { p = await pointFromText(input.text); source = 'Link'; }
    else { p = checkPoint(input); source = input.source === 'Driver' ? 'Driver' : 'Office'; }
  }
  const acc = input.accuracyM == null ? null : Math.max(0, Math.round(Number(input.accuracyM) || 0));
  await db.tx(async (t) => {
    await writePin(t, customerId, addressId, p, acc, source, actor.name);
    await audit(t, actor, 'update', 'Customer', customerId, 'map pin',
      { addressId, pin: p, source, cleared: !!input.clear });
  });
  return { lat: p?.lat ?? null, lng: p?.lng ?? null };
}

/**
 * The driver saves where they are standing as this stop's pin. It lands on
 * the address the order goes to (an extra address, or the main one).
 * A driver may only pin stops on a round that is theirs.
 */
export async function setStopPin(
  db: Db, actor: Actor, stopId: string, input: { lat?: number; lng?: number; accuracyM?: number | null },
): Promise<{ addressId: string | null }> {
  requireRole(actor, 'admin', 'user', 'driver');
  const p = checkPoint(input);
  const s = await db.maybeOne<{ customer_id: string; address_id: string | null; assigned_driver_id: string | null }>(
    `SELECT s.customer_id, o.address_id, d.assigned_driver_id
     FROM delivery_stops s JOIN delivery_sheets d ON d.id = s.delivery_sheet_id
     LEFT JOIN customer_orders o ON o.id = s.order_id
     WHERE s.id = $1`, [stopId]);
  if (!s) throw new RuleViolation('that stop no longer exists');
  if (actor.role === 'driver' && s.assigned_driver_id && s.assigned_driver_id !== actor.id) {
    throw new RuleViolation('this stop is on another driver\'s round');
  }
  const acc = input.accuracyM == null ? null : Math.max(0, Math.round(Number(input.accuracyM) || 0));
  if (acc != null && acc > 200) {
    throw new RuleViolation(`the phone only knows where it is to within ${acc} m. Step outside, wait a moment and try again`);
  }
  await db.tx(async (t) => {
    await writePin(t, s.customer_id, s.address_id, p, acc, 'Driver', actor.name);
    await audit(t, actor, 'update', 'Customer', s.customer_id, 'map pin saved at the stop',
      { stopId, addressId: s.address_id, pin: p, accuracyM: acc });
  });
  return { addressId: s.address_id };
}

/** Every delivery address of a customer with its pin, for the customer page. */
export async function customerPins(db: Queryable, customerId: string) {
  const main = await db.maybeOne<Record<string, unknown>>(
    `SELECT NULL::uuid AS address_id, 'Main address' AS label,
            concat_ws(', ', NULLIF(address_line1, ''), NULLIF(address_line2, ''), NULLIF(city, ''), NULLIF(parish, '')) AS address,
            delivery_address, lat, lng, location_accuracy_m, location_source, location_set_at, location_set_by
     FROM customers WHERE id = $1`, [customerId]);
  const extra = await db.query<Record<string, unknown>>(
    `SELECT id AS address_id, label,
            concat_ws(', ', NULLIF(address_line1, ''), NULLIF(address_line2, ''), NULLIF(city, ''), NULLIF(parish, '')) AS address,
            NULL AS delivery_address, lat, lng, location_accuracy_m, location_source, location_set_at, location_set_by
     FROM customer_addresses WHERE customer_id = $1 AND active AND is_delivery
     ORDER BY created_at`, [customerId]);
  return [...(main ? [{ ...main, address: main.address || main.delivery_address }] : []), ...extra];
}

/* ------------------------------------------------------------------ */
/* The plant                                                           */
/* ------------------------------------------------------------------ */

export async function plantLocation(db: Queryable): Promise<LatLng | null> {
  const lat = Number(await getSetting(db, 'plant_lat', ''));
  const lng = Number(await getSetting(db, 'plant_lng', ''));
  return (await getSetting(db, 'plant_lat', '')) && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

export async function setPlantLocation(db: Db, actor: Actor, input: { lat?: number; lng?: number; text?: string }): Promise<LatLng> {
  requireRole(actor, 'admin');
  const p = input.text ? await pointFromText(input.text) : checkPoint(input);
  await db.tx(async (t) => {
    for (const [k, v] of [['plant_lat', p.lat], ['plant_lng', p.lng]] as const) {
      await t.query(`INSERT INTO system_settings (key, value) VALUES ($1, $2)
                     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, String(v)]);
    }
    await audit(t, actor, 'update', 'Setting', null, 'plant location', { pin: p });
  });
  return p;
}

export function roadSortAvailable(): boolean {
  return !!process.env.ORS_API_KEY?.trim();
}

export async function routingSettings(db: Queryable) {
  return { plant: await plantLocation(db), roadSort: roadSortAvailable() };
}

/* ------------------------------------------------------------------ */
/* Sorting a round                                                     */
/* ------------------------------------------------------------------ */

interface SortStop { id: string; name: string; sequence_no: number; lat: number | null; lng: number | null }

async function loadSheetForSort(db: Queryable, actor: Actor, sheetId: string) {
  const sheet = await db.maybeOne<{ status: string; started_at: string | null; assigned_driver_id: string | null; zone: string }>(
    `SELECT status, started_at, assigned_driver_id, zone FROM delivery_sheets WHERE id = $1`, [sheetId]);
  if (!sheet) throw new RuleViolation('that delivery round no longer exists');
  if (actor.role === 'driver' && sheet.assigned_driver_id !== actor.id) {
    throw new RuleViolation('only the driver who has this round can sort it');
  }
  if (sheet.status !== 'Open' || sheet.started_at) {
    throw new RuleViolation('this round has started, so its order is locked. The driver can still move a stop to the end or skip it');
  }
  const stops = await db.query<SortStop>(
    `SELECT s.id, c.name, s.sequence_no,
            CASE WHEN o.address_id IS NOT NULL THEN ca.lat ELSE c.lat END AS lat,
            CASE WHEN o.address_id IS NOT NULL THEN ca.lng ELSE c.lng END AS lng
     FROM delivery_stops s JOIN customers c ON c.id = s.customer_id
     LEFT JOIN customer_orders o ON o.id = s.order_id
     LEFT JOIN customer_addresses ca ON ca.id = o.address_id
     WHERE s.delivery_sheet_id = $1
     ORDER BY s.sequence_no, c.name`, [sheetId]);
  return { sheet, stops };
}

/** openrouteservice's optimiser: the order and the drive, or null when it cannot help. */
async function roadOrder(plant: LatLng, pts: LatLng[]): Promise<{ order: number[]; durationS: number | null; distanceM: number | null } | null> {
  const key = process.env.ORS_API_KEY?.trim();
  if (!key || pts.length === 0 || pts.length > ORS_MAX_JOBS) return null;
  const res = await fetch(ORS_URL, {
    method: 'POST',
    headers: { Authorization: key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      jobs: pts.map((p, i) => ({ id: i + 1, location: [p.lng, p.lat] })),
      vehicles: [{ id: 1, profile: 'driving-car', start: [plant.lng, plant.lat], end: [plant.lng, plant.lat] }],
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const j = await res.json() as {
    routes?: Array<{ steps: Array<{ type: string; job?: number }>; duration?: number; distance?: number }>;
    unassigned?: unknown[];
  };
  const route = j.routes?.[0];
  if (!route) return null;
  const order = route.steps.filter((s) => s.type === 'job' && s.job).map((s) => (s.job as number) - 1);
  if (order.length !== pts.length) return null; // something left unassigned: do not half-trust it
  return { order, durationS: route.duration ?? null, distanceM: route.distance ?? null };
}

export interface SortProposal {
  method: 'Road' | 'Straight';
  /** Why the road map was not used, when it was asked for. */
  note: string | null;
  plant: LatLng;
  /** Stop ids, in the proposed order (pinned ones sorted, then unpinned). */
  order: string[];
  stops: Array<{ id: string; name: string; lat: number | null; lng: number | null; was: number; now: number }>;
  /** Straight-line km from the plant and back, for comparing like with like. */
  currentKm: number;
  sortedKm: number;
  /** From the road map, when it was used. */
  roadDurationS: number | null;
  roadDistanceM: number | null;
  missing: number;
}

export async function proposeSort(
  db: Db, actor: Actor, sheetId: string, want: 'Road' | 'Straight' = 'Road',
): Promise<SortProposal> {
  requireRole(actor, 'admin', 'user', 'driver');
  const plant = await plantLocation(db);
  if (!plant) throw new RuleViolation('set the plant\'s location first (Settings › Delivery zones), so rounds start and finish there');
  const { stops } = await loadSheetForSort(db, actor, sheetId);

  const pinned = stops.filter((s) => s.lat != null && s.lng != null);
  const unpinned = stops.filter((s) => s.lat == null || s.lng == null);
  const pts = pinned.map((s) => ({ lat: Number(s.lat), lng: Number(s.lng) }));

  let method: 'Road' | 'Straight' = 'Straight';
  let note: string | null = null;
  let order: number[] | null = null;
  let roadDurationS: number | null = null;
  let roadDistanceM: number | null = null;
  if (want === 'Road') {
    if (!roadSortAvailable()) note = 'Road-map sorting is not switched on, so this is sorted by straight-line distance.';
    else if (pts.length > ORS_MAX_JOBS) note = `More than ${ORS_MAX_JOBS} stops is too many for the road map, so this is sorted by straight-line distance.`;
    else {
      try {
        const r = await roadOrder(plant, pts);
        if (r) { order = r.order; method = 'Road'; roadDurationS = r.durationS; roadDistanceM = r.distanceM; }
        else note = 'The road map did not answer, so this is sorted by straight-line distance.';
      } catch {
        note = 'The road map could not be reached (no internet?), so this is sorted by straight-line distance.';
      }
    }
  }
  if (!order) order = orderStops(plant, pts);

  const sorted = [...order.map((i) => pinned[i]), ...unpinned];
  const pinnedNow = stops.filter((s) => s.lat != null).map((s) => ({ lat: Number(s.lat), lng: Number(s.lng) }));
  const round1 = (x: number) => Math.round(x * 10) / 10;
  return {
    method, note, plant,
    order: sorted.map((s) => s.id),
    stops: sorted.map((s, i) => ({
      id: s.id, name: s.name, lat: s.lat == null ? null : Number(s.lat), lng: s.lng == null ? null : Number(s.lng),
      was: stops.findIndex((x) => x.id === s.id) + 1, now: i + 1,
    })),
    currentKm: round1(tourKm(plant, pinnedNow)),
    sortedKm: round1(tourKm(plant, order.map((i) => pts[i]))),
    roadDurationS, roadDistanceM,
    missing: unpinned.length,
  };
}

/**
 * Put the round in this order. "Save as usual" also makes it the zone's
 * usual order for these customers (their route sequence), so the next round
 * starts out this way.
 */
export async function applySort(
  db: Db, actor: Actor, sheetId: string, input: { order?: string[]; saveAsUsual?: boolean },
): Promise<{ ok: true }> {
  requireRole(actor, 'admin', 'user', 'driver');
  const { stops } = await loadSheetForSort(db, actor, sheetId);
  const order = Array.isArray(input.order) ? input.order.map(String) : [];
  const ids = new Set(stops.map((s) => s.id));
  if (order.length !== stops.length || order.some((id) => !ids.has(id)) || new Set(order).size !== order.length) {
    throw new RuleViolation('the round changed while you were sorting it - sort it again');
  }
  const usual = input.saveAsUsual === true && actor.role !== 'driver';
  await db.tx(async (t) => {
    for (let i = 0; i < order.length; i++) {
      await t.query(`UPDATE delivery_stops SET sequence_no = $2 WHERE id = $1`, [order[i], (i + 1) * 10]);
      if (usual) {
        const s = await t.one<{ customer_id: string; address_id: string | null }>(
          `SELECT s.customer_id, o.address_id FROM delivery_stops s LEFT JOIN customer_orders o ON o.id = s.order_id WHERE s.id = $1`,
          [order[i]]);
        if (s.address_id) await t.query(`UPDATE customer_addresses SET route_sequence = $2 WHERE id = $1`, [s.address_id, (i + 1) * 10]);
        else await t.query(`UPDATE customers SET route_sequence = $2 WHERE id = $1`, [s.customer_id, (i + 1) * 10]);
      }
    }
    await audit(t, actor, 'update', 'DeliverySheet', sheetId, 'stops sorted', { order, savedAsUsual: usual });
  });
  return { ok: true };
}

/** Straight-line distance, for showing next to a stop ("4.2 km from the last"). */
export const kmBetween = haversineKm;
