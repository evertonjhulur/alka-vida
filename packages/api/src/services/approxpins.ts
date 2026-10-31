/**
 * Approximate pins from the typed address (31 Oct 2026).
 *
 * Everton: sorting relies on pins, and most customers came from QuickBooks
 * with none. So an address with no pin is looked up once with Google's
 * Geocoding API and given a rough pin, marked 'Approximate'. Good enough to
 * put stops in a sensible order; the driver's "Save this location" at the
 * gate replaces it with the exact spot.
 *
 * Rules:
 *  - only fills an address with NO pin (or one whose approximate pin came
 *    from address words that have since been edited); never touches a pin a
 *    person placed;
 *  - each address text is asked about once, found or not (geocoded_text);
 *  - an answer no better than the whole parish or country is not used;
 *  - a daily ceiling (GEOCODE_DAILY_LIMIT, default 300 = about 9,000 a month,
 *    inside Google's free allowance) and nothing at all without
 *    GOOGLE_MAPS_API_KEY.
 * Runs on its own when a round is sorted, and from Settings › Delivery zones
 * ("Find approximate pins") for everyone at once.
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, requireRole } from './core.ts';
import { inJamaica, type LatLng } from '@alka/shared';

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

export function approximatePinsEnabled(): boolean {
  return !!process.env.GOOGLE_MAPS_API_KEY?.trim();
}

function dailyLimit(): number {
  const n = Number(process.env.GEOCODE_DAILY_LIMIT);
  return Number.isFinite(n) && n >= 0 ? n : 300;
}
let day = '';
let usedToday = 0;
const jamaicaDay = () => new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
export function resetGeocodeCounter() { day = ''; usedToday = 0; }

/** How far off each kind of Google answer can be, roughly, in metres. */
const ACCURACY: Record<string, number> = {
  ROOFTOP: 30, RANGE_INTERPOLATED: 150, GEOMETRIC_CENTER: 600, APPROXIMATE: 2000,
};
/** Answers this vague are no use for ordering stops. */
const TOO_VAGUE = ['country', 'administrative_area_level_1'];

type Outcome =
  | { kind: 'found'; point: LatLng; accuracyM: number }
  | { kind: 'not-found' }
  | { kind: 'stop'; reason: string };

export async function geocode(text: string): Promise<Outcome> {
  const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!key) return { kind: 'stop', reason: 'Address suggestions are not switched on (no Google Maps key).' };
  if (day !== jamaicaDay()) { day = jamaicaDay(); usedToday = 0; }
  if (usedToday >= dailyLimit()) return { kind: 'stop', reason: 'Today\'s allowance of address look-ups is used up; the rest are done tomorrow.' };
  usedToday++;
  const url = `${GEOCODE_URL}?address=${encodeURIComponent(text)}&components=country:JM&region=jm&key=${encodeURIComponent(key)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!res || !res.ok) return { kind: 'stop', reason: 'Google could not be reached to look up addresses.' };
  const body = await res.json() as {
    status?: string; error_message?: string;
    results?: Array<{ types?: string[]; geometry?: { location?: { lat?: number; lng?: number }; location_type?: string } }>;
  };
  if (body.status === 'ZERO_RESULTS') return { kind: 'not-found' };
  if (body.status !== 'OK') {
    console.error(`  Address look-up: Google answered ${body.status} ${body.error_message ?? ''}`);
    return {
      kind: 'stop',
      reason: body.status === 'REQUEST_DENIED'
        ? 'Google turned the look-up down. Check that "Geocoding API" is enabled for the Google Maps key.'
        : 'Google could not look up addresses just now.',
    };
  }
  const r = body.results?.[0];
  const lat = Number(r?.geometry?.location?.lat); const lng = Number(r?.geometry?.location?.lng);
  if (!r || !Number.isFinite(lat) || !Number.isFinite(lng)) return { kind: 'not-found' };
  if ((r.types ?? []).some((t) => TOO_VAGUE.includes(t))) return { kind: 'not-found' };
  const point = { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
  if (!inJamaica(point)) return { kind: 'not-found' };
  return { kind: 'found', point, accuracyM: ACCURACY[r.geometry?.location_type ?? ''] ?? 2000 };
}

interface Target { kind: 'main' | 'extra'; id: string; customer_id: string; text: string }

/** The address words for each target, main address or extra delivery address. */
const MAIN_TEXT = `COALESCE(NULLIF(concat_ws(', ', NULLIF(c.address_line1, ''), NULLIF(c.address_line2, ''), NULLIF(c.city, ''), NULLIF(c.parish, '')), ''), NULLIF(c.delivery_address, ''))`;
const EXTRA_TEXT = `NULLIF(concat_ws(', ', NULLIF(ca.address_line1, ''), NULLIF(ca.address_line2, ''), NULLIF(ca.city, ''), NULLIF(ca.parish, '')), '')`;
/** Needs one: no pin, or an approximate pin from words since edited; and these words not yet tried. */
const NEEDS = (alias: string, text: string) =>
  `(${alias}.lat IS NULL OR (${alias}.location_source = 'Approximate' AND ${alias}.geocoded_text IS DISTINCT FROM ${text}))
   AND ${text} IS NOT NULL AND ${alias}.geocoded_text IS DISTINCT FROM ${text}`;

async function targetsForSheet(db: Queryable, sheetId: string): Promise<Target[]> {
  return db.query<Target>(
    `SELECT DISTINCT * FROM (
       SELECT 'main' AS kind, c.id, c.id AS customer_id, ${MAIN_TEXT} AS text
       FROM delivery_stops s JOIN customers c ON c.id = s.customer_id
       LEFT JOIN customer_orders o ON o.id = s.order_id
       WHERE s.delivery_sheet_id = $1 AND o.address_id IS NULL AND ${NEEDS('c', MAIN_TEXT)}
       UNION ALL
       SELECT 'extra', ca.id, ca.customer_id, ${EXTRA_TEXT}
       FROM delivery_stops s JOIN customer_orders o ON o.id = s.order_id
       JOIN customer_addresses ca ON ca.id = o.address_id
       WHERE s.delivery_sheet_id = $1 AND ${NEEDS('ca', EXTRA_TEXT)}
     ) x`, [sheetId]);
}

async function targetsForAll(db: Queryable, max: number): Promise<{ list: Target[]; total: number }> {
  const sql = `
    SELECT 'main' AS kind, c.id, c.id AS customer_id, ${MAIN_TEXT} AS text, c.name AS sort_name
    FROM customers c WHERE c.active AND ${NEEDS('c', MAIN_TEXT)}
    UNION ALL
    SELECT 'extra', ca.id, ca.customer_id, ${EXTRA_TEXT}, c.name
    FROM customer_addresses ca JOIN customers c ON c.id = ca.customer_id
    WHERE c.active AND ca.active AND ca.is_delivery AND ${NEEDS('ca', EXTRA_TEXT)}`;
  const total = Number((await db.one<{ n: string }>(`SELECT count(*) AS n FROM (${sql}) x`)).n);
  const list = await db.query<Target>(`SELECT kind, id, customer_id, text FROM (${sql}) x ORDER BY sort_name LIMIT $1`, [max]);
  return { list, total };
}

export interface ApproxResult { placed: number; notFound: number; left: number; stopped: string | null }

async function run(db: Db, actor: Actor, list: Target[], total: number, why: string): Promise<ApproxResult> {
  let placed = 0; let notFound = 0; let stopped: string | null = null;
  for (const t of list) {
    const o = await geocode(t.text);
    if (o.kind === 'stop') { stopped = o.reason; break; }
    const table = t.kind === 'main' ? 'customers' : 'customer_addresses';
    if (o.kind === 'found') {
      // Only where nobody has placed a pin in the meantime.
      const r = await db.query(
        `UPDATE ${table} SET lat = $2, lng = $3, location_accuracy_m = $4, location_source = 'Approximate',
                location_set_by = 'Google, from the address', location_set_at = now(),
                geocoded_text = $5, geocoded_at = now()
         WHERE id = $1 AND (lat IS NULL OR location_source = 'Approximate') RETURNING id`,
        [t.id, o.point.lat, o.point.lng, o.accuracyM, t.text]);
      if (r.length) placed++;
    } else {
      notFound++;
      await db.query(`UPDATE ${table} SET geocoded_text = $2, geocoded_at = now() WHERE id = $1`, [t.id, t.text]);
    }
  }
  if (placed || notFound) {
    await audit(db, actor, 'update', 'Customer', null, `approximate map pins (${why})`, { placed, notFound });
  }
  const done = placed + notFound;
  return { placed, notFound, left: Math.max(0, total - done), stopped };
}

/** Before a round is sorted: rough pins for its stops that have none. */
export async function approximatePinsForSheet(db: Db, actor: Actor, sheetId: string): Promise<ApproxResult | null> {
  if (!approximatePinsEnabled()) return null;
  const list = (await targetsForSheet(db, sheetId)).slice(0, 60);
  if (!list.length) return null;
  return run(db, actor, list, list.length, 'sorting a round');
}

/** Settings › Delivery zones: everyone without a pin, up to `max` per click. */
export async function approximatePinsForAll(db: Db, actor: Actor, max = 100): Promise<ApproxResult> {
  requireRole(actor, 'admin');
  if (!approximatePinsEnabled()) {
    return { placed: 0, notFound: 0, left: 0, stopped: 'Add the Google Maps key (GOOGLE_MAPS_API_KEY) first.' };
  }
  const { list, total } = await targetsForAll(db, Math.min(Math.max(1, max), 200));
  return run(db, actor, list, total, 'all customers');
}

/** How many addresses still have no pin, and how many pins are approximate. */
export async function pinCounts(db: Queryable) {
  const r = await db.one<{ none: string; approx: string }>(
    `SELECT
       (SELECT count(*) FROM customers WHERE active AND lat IS NULL)
       + (SELECT count(*) FROM customer_addresses ca JOIN customers c ON c.id = ca.customer_id
          WHERE c.active AND ca.active AND ca.is_delivery AND ca.lat IS NULL) AS none,
       (SELECT count(*) FROM customers WHERE active AND location_source = 'Approximate')
       + (SELECT count(*) FROM customer_addresses ca JOIN customers c ON c.id = ca.customer_id
          WHERE c.active AND ca.active AND ca.is_delivery AND ca.location_source = 'Approximate') AS approx`);
  return { noPin: Number(r.none), approximate: Number(r.approx), enabled: approximatePinsEnabled() };
}
