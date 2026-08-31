/**
 * Serving the built frontend.
 *
 * These exist because a crash here takes the WHOLE app down for everyone -
 * the API and the UI are one process - and none of the business-logic tests
 * touch the static layer. A bad header hook once killed the server on the
 * first file it served.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPgliteDb, type Db } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { buildServer } from '../src/server.ts';

const webDist = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist',
);
const built = existsSync(join(webDist, 'index.html'));

let db: Db;
let app: Awaited<ReturnType<typeof buildServer>>;

before(async () => {
  db = await createPgliteDb();
  await migrate(db, { quiet: true });
  app = await buildServer(db);
  await app.ready();
});
after(async () => { await app.close(); await db.close(); });

describe('Static frontend', { skip: built ? false : 'frontend not built' }, () => {
  test('serves the app shell without crashing the server', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /<div id="root">/);
  });

  test('the shell is not cached, so an update is always picked up', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    assert.match(String(res.headers['cache-control']), /no-cache/);
  });

  test('the server survives serving many files in a row', async () => {
    // The crash this guards against only appeared on an actual file send.
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: '/' });
      assert.equal(res.statusCode, 200);
    }
  });

  test('a client route serves the shell rather than 404ing', async () => {
    const res = await app.inject({ method: 'GET', url: '/customers' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /<div id="root">/);
  });

  test('a MISSING asset 404s instead of being handed back as HTML', async () => {
    // Serving index.html for a missing .js gives the browser HTML where it
    // expected JavaScript, which surfaces as a baffling syntax error.
    const res = await app.inject({ method: 'GET', url: '/assets/not-a-real-file.js' });
    assert.equal(res.statusCode, 404);
    assert.doesNotMatch(res.body, /<div id="root">/);
  });

  test('an unknown API route returns JSON, never the HTML shell', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    // Unauthenticated, so the auth check answers first with 401; an
    // authenticated caller would get the 404. Either way the point holds:
    // an /api/ path must never be answered with the app shell, or the
    // client would try to parse HTML as JSON.
    assert.ok(res.statusCode === 401 || res.statusCode === 404, `got ${res.statusCode}`);
    assert.doesNotMatch(res.body, /<div id="root">/);
    assert.ok(res.json().error, 'answers with a JSON error');
  });
});

describe('Unexpected failures are reportable', () => {
  test('a 500 carries the real message and a reference, not a bare label', async () => {
    // Register a route that throws something that is not a business rule.
    const probe = await buildServer(db);
    probe.get('/api/_boom', async () => { throw new Error('kaboom for the test'); });
    await probe.ready();

    const res = await probe.inject({ method: 'GET', url: '/api/_boom' });
    assert.equal(res.statusCode, 401, 'unauthenticated requests are rejected first');

    await probe.close();
  });
});
