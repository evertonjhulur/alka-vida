/**
 * Address suggestions as you type (31 Oct 2026). Google is never called:
 * fetch is replaced with a stand-in that answers like the Places API (New).
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createPgliteDb, type Db } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { buildServer } from '../src/server.ts';
import { parishFrom, resetPlacesCounters } from '../src/services/places.ts';

let db: Db;
let app: Awaited<ReturnType<typeof buildServer>>;
const realFetch = globalThis.fetch;
const calls: Array<{ url: string; init?: RequestInit }> = [];

before(async () => {
  db = await createPgliteDb();
  await migrate(db, { quiet: true });
  app = await buildServer(db);
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (!u.startsWith('https://places.googleapis.com/')) return realFetch(url, init);
    calls.push({ url: u, init });
    if (u.endsWith(':autocomplete')) {
      return new Response(JSON.stringify({ suggestions: [
        { placePrediction: { placeId: 'ChIJ_sovereign_123', text: { text: 'Sovereign Centre, Hope Road, Kingston, Jamaica' },
          structuredFormat: { mainText: { text: 'Sovereign Centre' }, secondaryText: { text: 'Hope Road, Kingston, Jamaica' } } } },
        { queryPrediction: { text: { text: 'sovereign' } } },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      location: { latitude: 18.0234567, longitude: -76.7812345 },
      formattedAddress: '106 Hope Rd, Kingston 6, Jamaica',
      addressComponents: [
        { longText: '106', types: ['street_number'] },
        { longText: 'Hope Road', types: ['route'] },
        { longText: 'Kingston 6', types: ['locality', 'political'] },
        { longText: 'Saint Andrew Parish', types: ['administrative_area_level_1', 'political'] },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});
after(async () => { globalThis.fetch = realFetch; delete process.env.GOOGLE_MAPS_API_KEY; await app.close(); await db.close?.(); });
beforeEach(() => { resetPlacesCounters(); calls.length = 0; delete process.env.PLACES_DAILY_LIMIT; });

describe('address suggestions', () => {
  test('off without a key: the screens hide the search box', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    const r = await app.inject({ method: 'GET', url: '/api/public/places/config' });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { enabled: false });
    const s = await app.inject({ method: 'GET', url: '/api/public/places/suggest?q=hope' });
    assert.deepEqual(s.json().suggestions, []);
    assert.equal(calls.length, 0);
  });

  test('suggests Jamaican places with no sign-in, key kept on the server', async () => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-key';
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/public/places/config' })).json(), { enabled: true });
    const r = await app.inject({ method: 'GET', url: '/api/public/places/suggest?q=sovereign&session=abcd1234efgh' });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { suggestions: [{ id: 'ChIJ_sovereign_123', main: 'Sovereign Centre', secondary: 'Hope Road, Kingston' }], note: null });
    const sent = JSON.parse(String(calls[0].init?.body));
    assert.deepEqual(sent.includedRegionCodes, ['jm']);
    assert.equal(sent.sessionToken, 'abcd1234efgh');
    assert.equal((calls[0].init?.headers as Record<string, string>)['x-goog-api-key'], 'test-key');
    assert.doesNotMatch(r.body, /test-key/);
  });

  test('fewer than 3 letters asks Google nothing', async () => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-key';
    const r = await app.inject({ method: 'GET', url: '/api/public/places/suggest?q=ho' });
    assert.deepEqual(r.json(), { suggestions: [], note: null });
    assert.equal(calls.length, 0);
  });

  test('picking one gives the pin and the address boxes', async () => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-key';
    const r = await app.inject({ method: 'GET', url: '/api/public/places/lookup?id=ChIJ_sovereign_123&session=abcd1234efgh' });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), {
      lat: 18.023457, lng: -76.781234, address: '106 Hope Rd, Kingston 6',
      line1: '106 Hope Road', town: 'Kingston 6', parish: 'St Andrew',
    });
    assert.match(calls[0].url, /places\/ChIJ_sovereign_123\?sessionToken=abcd1234efgh$/);
    // Essentials fields only - the cheapest lookup.
    assert.equal((calls[0].init?.headers as Record<string, string>)['x-goog-fieldmask'], 'location,formattedAddress,addressComponents');
  });

  test('a made-up place id is turned away without asking Google', async () => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-key';
    const r = await app.inject({ method: 'GET', url: '/api/public/places/lookup?id=../../etc' });
    assert.equal(r.statusCode >= 400 && r.statusCode < 500, true);
    assert.equal(calls.length, 0);
  });

  test('the daily ceiling rests suggestions until tomorrow', async () => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-key';
    process.env.PLACES_DAILY_LIMIT = '2';
    for (let i = 0; i < 2; i++) await app.inject({ method: 'GET', url: `/api/public/places/suggest?q=hope${i}` });
    const r = await app.inject({ method: 'GET', url: '/api/public/places/suggest?q=hope road' });
    assert.deepEqual(r.json().suggestions, []);
    assert.match(r.json().note, /resting until tomorrow/);
    assert.equal(calls.length, 2);
  });

  test('parish names from Google map to ours', () => {
    assert.equal(parishFrom('Saint Andrew Parish'), 'St Andrew');
    assert.equal(parishFrom('Kingston Parish'), 'Kingston');
    assert.equal(parishFrom('Saint Catherine Parish'), 'St Catherine');
    assert.equal(parishFrom('St. Ann Parish'), 'St Ann');
    assert.equal(parishFrom('Manchester Parish'), 'Manchester');
    assert.equal(parishFrom(''), '');
  });
});
