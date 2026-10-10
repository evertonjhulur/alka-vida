/**
 * Security before real data (tester's findings, 10 Oct 2026, points 17-19):
 * headers on every response, the sign-in cookie and its cross-site
 * protection, and the public odds and ends (health, robots, favicon, 404s).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPgliteDb, type Db } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { seed } from '../src/db/seed.ts';
import { buildServer } from '../src/server.ts';

let db: Db;
let app: Awaited<ReturnType<typeof buildServer>>;

before(async () => {
  db = await createPgliteDb();
  await migrate(db, { quiet: true });
  await seed(db, { quiet: true });
  app = await buildServer(db);
  await app.ready();
});
after(async () => { await app.close(); await db.close(); });

const signIn = async (email: string, password: string, headers: Record<string, string> = {}) => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, headers });
  assert.equal(res.statusCode, 200, res.body);
  return { res, cookie: res.cookies.find((c) => c.name === 'av_session')! };
};

describe('Point 17: security headers on every response', () => {
  test('on the API, public pages and errors alike', async () => {
    for (const url of ['/api/health', '/api/nope', '/robots.txt', '/']) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.headers['x-frame-options'], 'DENY', url);
      assert.equal(res.headers['x-content-type-options'], 'nosniff', url);
      // The policy is for pages and API answers; a text file or PDF needs none.
      if (url === '/robots.txt') continue;
      const csp = String(res.headers['content-security-policy']);
      assert.match(csp, /default-src 'self'/, url);
      assert.match(csp, /frame-ancestors 'none'/, url);
      assert.match(csp, /script-src 'self'(;|$)/, `${url}: no inline script`);
      assert.match(csp, /fonts\.googleapis\.com/, url);
      assert.match(csp, /img-src 'self' data: blob:/, url);
      assert.equal(res.headers['x-frame-options'], 'DENY', url);
      assert.equal(res.headers['x-content-type-options'], 'nosniff', url);
      assert.equal(res.headers['referrer-policy'], 'strict-origin-when-cross-origin', url);
      assert.equal(res.headers['strict-transport-security'], undefined, `${url}: no HSTS over plain http`);
    }
  });

  test('HSTS when served over https (Railway)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: { 'x-forwarded-proto': 'https' } });
    assert.match(String(res.headers['strict-transport-security']), /max-age=31536000/);
  });
});

describe('Point 18: sign-in is an httpOnly cookie', () => {
  test('httpOnly and SameSite; Secure only over https; the token is not in the body', async () => {
    const { res, cookie } = await signIn('admin@alkavida.jm', 'admin1234');
    assert.equal(res.json().token, undefined);
    assert.equal(res.json().session.role, 'admin');
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, 'Strict');
    assert.ok(!cookie.secure, 'plain http://localhost: not Secure, or the browser would never send it back');
    const https = await signIn('admin@alkavida.jm', 'admin1234', { 'x-forwarded-proto': 'https' });
    assert.equal(https.cookie.secure, true);
  });

  test('every role works with the cookie alone', async () => {
    for (const [email, password, url] of [
      ['admin@alkavida.jm', 'admin1234', '/api/customers'],
      ['office@alkavida.jm', 'office1234', '/api/orders'],
      ['driver@alkavida.jm', 'driver1234', '/api/delivery-sheets'],
      ['ap@bluemountain.jm', 'portal1234', '/api/auth/me'],
    ]) {
      const { cookie } = await signIn(email, password);
      const res = await app.inject({ method: 'GET', url, cookies: { av_session: cookie.value } });
      assert.equal(res.statusCode, 200, `${email} ${url}: ${res.body}`);
    }
  });

  test('a change made with the cookie needs the app\'s header, and must come from this site', async () => {
    const { cookie } = await signIn('admin@alkavida.jm', 'admin1234');
    const body = { name: 'CSRF Test Co', phone: '8765550101', email: 'csrf@example.com' };
    const forged = await app.inject({ method: 'POST', url: '/api/customers', cookies: { av_session: cookie.value }, payload: body });
    assert.equal(forged.statusCode, 403, 'no app header: refused');
    const otherSite = await app.inject({
      method: 'POST', url: '/api/customers', cookies: { av_session: cookie.value }, payload: body,
      headers: { 'x-alka-request': '1', origin: 'https://evil.example', host: 'alkaweb-production.up.railway.app' },
    });
    assert.equal(otherSite.statusCode, 403, 'another site: refused');
    const ok = await app.inject({
      method: 'POST', url: '/api/customers', cookies: { av_session: cookie.value }, payload: body,
      headers: { 'x-alka-request': '1', origin: 'https://alkaweb-production.up.railway.app', host: 'alkaweb-production.up.railway.app' },
    });
    assert.equal(ok.statusCode, 200, ok.body);
  });

  test('signing out clears the cookie; an expired or forged one is cleared and refused', async () => {
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout' });
    const cleared = out.cookies.find((c) => c.name === 'av_session')!;
    assert.equal(cleared.value, '');
    assert.equal(cleared.maxAge, 0);
    const bad = await app.inject({ method: 'GET', url: '/api/customers', cookies: { av_session: 'not.a.token' } });
    assert.equal(bad.statusCode, 401);
    assert.match(bad.json().error, /sign in again/);
    assert.equal(bad.cookies.find((c) => c.name === 'av_session')?.maxAge, 0);
  });
});

describe('Point 19: health, robots, favicon and 404s', () => {
  test('health needs no sign-in', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
  });

  test('unknown /api addresses are 404 for everyone', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/no-such-thing' });
    assert.equal(res.statusCode, 404);
    assert.ok(res.json().error);
  });

  test('an unknown invitation token is a 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/invitations/not-a-real-token' });
    assert.equal(res.statusCode, 404);
  });

  test('robots.txt asks every crawler to stay out; the favicon is the logo', async () => {
    const robots = await app.inject({ method: 'GET', url: '/robots.txt' });
    assert.equal(robots.statusCode, 200);
    assert.match(robots.body, /User-agent: \*\nDisallow: \//);
    const icon = await app.inject({ method: 'GET', url: '/favicon.ico' });
    assert.equal(icon.statusCode, 200);
    assert.equal(icon.headers['content-type'], 'image/png');
  });

  test('the logo is built in, so /api/logo answers even with no file beside the launcher', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/logo' });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /image\/png/);
  });

  test('an unknown static file is a 404, not the app shell', async () => {
    const res = await app.inject({ method: 'GET', url: '/no-such-file.png' });
    assert.equal(res.statusCode, 404);
    assert.doesNotMatch(res.body, /<div id="root">/);
  });
});
