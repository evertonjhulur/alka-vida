/**
 * Address suggestions as you type, like Google Maps (31 Oct 2026).
 *
 * Everton's ruling: Google, for its coverage of Jamaican streets, businesses
 * and landmarks. Picking a suggestion drops the map pin (and fills an empty
 * address on the sign-up and quick-order forms).
 *
 * Switched on by GOOGLE_MAPS_API_KEY (a Railway variable, or a line in
 * "Alka Vida settings.txt"). The key never reaches the browser: the browser
 * asks us, and we ask Google's Places API (New).
 *
 * Cost control. Google bills per request beyond a free monthly allowance
 * (about 5,000 suggestion requests and 10,000 place lookups in 2026). Each
 * search is a "session" ending in one place lookup, which makes its later
 * suggestion requests free. On top of that:
 *  - the browser waits for a pause in typing and needs 3+ letters;
 *  - a daily ceiling (PLACES_DAILY_LIMIT, default 150 suggestion requests,
 *    so about 4,500 a month) after which suggestions rest until tomorrow
 *    and the map, pasted links and "use my location" still work;
 *  - each address (computer/phone) is held to a sensible rate.
 */

import { RuleViolation } from '@alka/shared';

const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const DETAILS_URL = 'https://places.googleapis.com/v1/places/';

/** Centre of the search bias: Kingston / Spanish Town. */
const BIAS = { latitude: 18.0, longitude: -76.85 };
const BIAS_RADIUS_M = 50000;

export function placesEnabled(): boolean {
  return !!process.env.GOOGLE_MAPS_API_KEY?.trim();
}

function dailyLimit(): number {
  const n = Number(process.env.PLACES_DAILY_LIMIT);
  return Number.isFinite(n) && n >= 0 ? n : 150;
}

/* Daily ceiling, by Jamaica's date. Counted in memory: a restart starts the
 * count again, which at worst allows one more day's worth. */
let day = '';
let suggestionsToday = 0;
let lookupsToday = 0;
const jamaicaDay = (now = new Date()) => new Date(now.getTime() - 5 * 3600 * 1000).toISOString().slice(0, 10);
function rollDay() {
  const d = jamaicaDay();
  if (d !== day) { day = d; suggestionsToday = 0; lookupsToday = 0; }
}

/* Per-address rate: 90 suggestion requests and 20 lookups in 10 minutes. */
const WINDOW_MS = 10 * 60 * 1000;
const recent = new Map<string, number[]>();
export function placesTooMany(key: string, limit: number, now = Date.now()): boolean {
  const kept = (recent.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (kept.length >= limit) { recent.set(key, kept); return true; }
  kept.push(now);
  recent.set(key, kept);
  if (recent.size > 5000) recent.clear();
  return false;
}

/** For tests. */
export function resetPlacesCounters() { day = ''; suggestionsToday = 0; lookupsToday = 0; recent.clear(); }

const cleanSession = (s: unknown) => {
  const v = String(s ?? '').trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : undefined;
};

export interface Suggestion { id: string; main: string; secondary: string }
export interface SuggestResult { suggestions: Suggestion[]; note: string | null }

export async function suggestPlaces(input: { q?: unknown; session?: unknown }): Promise<SuggestResult> {
  const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!key) return { suggestions: [], note: 'Address suggestions are not switched on.' };
  const q = String(input.q ?? '').trim().slice(0, 120);
  if (q.length < 3) return { suggestions: [], note: null };
  rollDay();
  if (suggestionsToday >= dailyLimit()) {
    return { suggestions: [], note: 'Address suggestions are resting until tomorrow. Find the spot on the map instead.' };
  }
  suggestionsToday++;

  const res = await fetch(AUTOCOMPLETE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': key,
      'x-goog-fieldmask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.text',
    },
    body: JSON.stringify({
      input: q,
      sessionToken: cleanSession(input.session),
      includedRegionCodes: ['jm'],
      locationBias: { circle: { center: BIAS, radius: BIAS_RADIUS_M } },
      languageCode: 'en',
    }),
    signal: AbortSignal.timeout(6000),
  }).catch(() => null);
  if (!res) return { suggestions: [], note: 'Could not reach Google for suggestions. Find the spot on the map instead.' };
  if (!res.ok) {
    console.error(`  Address suggestions: Google answered ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
    return { suggestions: [], note: 'Address suggestions are not working just now. Find the spot on the map instead.' };
  }
  const body = await res.json() as {
    suggestions?: Array<{ placePrediction?: {
      placeId?: string;
      text?: { text?: string };
      structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
    } }>;
  };
  const suggestions: Suggestion[] = [];
  for (const s of body.suggestions ?? []) {
    const p = s.placePrediction;
    if (!p?.placeId) continue;
    const main = p.structuredFormat?.mainText?.text ?? p.text?.text ?? '';
    const secondary = (p.structuredFormat?.secondaryText?.text ?? '').replace(/,?\s*Jamaica$/i, '');
    if (main) suggestions.push({ id: p.placeId, main, secondary });
    if (suggestions.length >= 6) break;
  }
  return { suggestions, note: null };
}

export interface PlaceFound {
  lat: number; lng: number;
  /** Google's one-line address. */
  address: string;
  /** Best guesses for our address boxes; blank when Google has none. */
  line1: string; town: string; parish: string;
}

const PARISH_WORDS: Array<[RegExp, string]> = [
  [/kingston/i, 'Kingston'], [/andrew/i, 'St Andrew'], [/catherine/i, 'St Catherine'],
  [/thomas/i, 'St Thomas'], [/portland/i, 'Portland'], [/mary/i, 'St Mary'], [/ann/i, 'St Ann'],
  [/trelawny/i, 'Trelawny'], [/james/i, 'St James'], [/hanover/i, 'Hanover'],
  [/westmoreland/i, 'Westmoreland'], [/elizabeth/i, 'St Elizabeth'], [/manchester/i, 'Manchester'],
  [/clarendon/i, 'Clarendon'],
];
/** "Saint Andrew Parish" → "St Andrew". Kingston is checked last. */
export function parishFrom(text: string): string {
  const t = text.replace(/\bparish\b/i, '');
  for (const [re, name] of [...PARISH_WORDS.slice(1), PARISH_WORDS[0]]) if (re.test(t)) return name;
  return '';
}

export async function lookUpPlace(placeId: unknown, session: unknown): Promise<PlaceFound> {
  const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!key) throw new RuleViolation('address suggestions are not switched on');
  const id = String(placeId ?? '').trim();
  if (!/^[A-Za-z0-9_-]{10,300}$/.test(id)) throw new RuleViolation('that place could not be found');
  rollDay();
  if (lookupsToday >= dailyLimit() * 2) throw new RuleViolation('address suggestions are resting until tomorrow - find the spot on the map instead');
  lookupsToday++;

  const s = cleanSession(session);
  const url = `${DETAILS_URL}${encodeURIComponent(id)}${s ? `?sessionToken=${encodeURIComponent(s)}` : ''}`;
  // Essentials fields only (the cheapest lookup): no name, phone or hours.
  const res = await fetch(url, {
    headers: { 'x-goog-api-key': key, 'x-goog-fieldmask': 'location,formattedAddress,addressComponents' },
    signal: AbortSignal.timeout(6000),
  }).catch(() => null);
  if (!res) throw new RuleViolation('could not reach Google - find the spot on the map instead');
  if (!res.ok) {
    console.error(`  Address lookup: Google answered ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
    throw new RuleViolation('that place could not be looked up - find the spot on the map instead');
  }
  const p = await res.json() as {
    location?: { latitude?: number; longitude?: number };
    formattedAddress?: string;
    addressComponents?: Array<{ longText?: string; types?: string[] }>;
  };
  const lat = Number(p.location?.latitude); const lng = Number(p.location?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new RuleViolation('Google has no map position for that place');
  const part = (...types: string[]) => {
    for (const t of types) {
      const c = (p.addressComponents ?? []).find((x) => x.types?.includes(t));
      if (c?.longText) return c.longText;
    }
    return '';
  };
  const line1 = [part('street_number'), part('route')].filter(Boolean).join(' ');
  const town = part('locality', 'sublocality', 'sublocality_level_1', 'neighborhood', 'postal_town', 'administrative_area_level_2');
  const parish = parishFrom(part('administrative_area_level_1'));
  return {
    lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6,
    address: (p.formattedAddress ?? '').replace(/,?\s*Jamaica$/i, ''),
    line1, town: town === parish ? '' : town, parish,
  };
}
