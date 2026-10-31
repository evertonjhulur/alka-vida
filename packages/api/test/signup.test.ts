/**
 * Customers open their own accounts, with Google or an email (31 Oct 2026):
 * no approval; Retail for a home, Corporate for a business; cash on
 * delivery; the zone they pick; never a second customer for a known email;
 * a known phone flagged for the office.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { setupFixture, type Fixture } from './helpers.ts';
import { signUp, googleSignIn, listSignups, markSignupReviewed, confirmEmail } from '../src/services/signup.ts';
import { setGoogleKeysForTests, verifyGoogleToken } from '../src/lib/google.ts';
import { login, loadSigningKey } from '../src/lib/auth.ts';

let f: Fixture;
const CLIENT = 'test-client.apps.googleusercontent.com';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function googleToken(claims: Record<string, unknown>, aud = CLIENT) {
  const head = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
  const body = b64({ iss: 'https://accounts.google.com', aud, exp: Math.floor(Date.now() / 1000) + 600, email_verified: true, ...claims });
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

const home = {
  accountType: 'Individual' as const, firstName: 'Jane', lastName: 'Brown', phone: '876-222-3344',
  addressLine1: '4 Palm Ave', city: 'Portmore', parish: 'St Catherine',
};

before(async () => {
  f = await setupFixture();
  await loadSigningKey(f.db);
  process.env.GOOGLE_CLIENT_ID = CLIENT;
  setGoogleKeysForTests(async () => [jwk as never]);
  await f.db.query(`INSERT INTO price_tiers (name) VALUES ('Retail')`);
  await f.db.query(`INSERT INTO delivery_zones (name, run_days) VALUES ('Spanish Town', ARRAY['Fri'])`);
  await f.db.query(`UPDATE system_settings SET value = '2000-01-01' WHERE key = 'alerts_since'`).catch(() => {});
});
after(async () => { setGoogleKeysForTests(null); delete process.env.GOOGLE_CLIENT_ID; await f.close(); });

describe('opening an account with an email', () => {
  test('made at once: Retail, cash on delivery, the zone and its day, signed in', async () => {
    const r = await signUp(f.db, { ...home, method: 'email', email: 'jane@example.com', password: 'water1234', zone: 'Spanish Town' });
    assert.equal(r.session.role, 'customer');
    assert.ok(r.session.customerId);
    assert.equal(r.existing, false);
    assert.equal(r.confirmSent, false, 'confirmation emails are off until switched on');
    const c = await f.db.one<{ name: string; tier: string; payment_terms: string; delivery_zone: string; delivery_days: string[]; signup_method: string; invoice_cycle: string }>(
      `SELECT c.name, t.name AS tier, c.payment_terms, c.delivery_zone, c.delivery_days, c.signup_method, c.invoice_cycle
       FROM customers c JOIN price_tiers t ON t.id = c.price_tier_id WHERE c.id = $1`, [r.customerId]);
    assert.deepEqual([c.name, c.tier, c.payment_terms, c.delivery_zone, c.delivery_days, c.signup_method, c.invoice_cycle],
      ['Jane Brown', 'Retail', 'Cash on delivery', 'Spanish Town', ['Fri'], 'Email', 'PerDelivery']);
    assert.ok(await login(f.db, 'jane@example.com', 'water1234'), 'the password works');
  });

  test('a business goes on Corporate, with the person as the contact', async () => {
    const r = await signUp(f.db, { ...home, accountType: 'Corporate', businessName: 'Brown Hardware', phone: '876-111-0000',
      method: 'email', email: 'office@brownhw.com', password: 'water1234', zone: '' });
    const c = await f.db.one<{ name: string; tier: string; contact_person: string; delivery_zone: string | null }>(
      `SELECT c.name, t.name AS tier, c.contact_person, c.delivery_zone FROM customers c
       JOIN price_tiers t ON t.id = c.price_tier_id WHERE c.id = $1`, [r.customerId]);
    assert.deepEqual([c.name, c.tier, c.contact_person, c.delivery_zone], ['Brown Hardware', 'Corporate', 'Jane Brown', null]);
  });

  test('never a second customer for an email already on file', async () => {
    await assert.rejects(signUp(f.db, { ...home, phone: '876-000-1111', method: 'email', email: 'jane@example.com', password: 'water1234' }),
      /already an Alka Vida login/);
    await assert.rejects(signUp(f.db, { ...home, phone: '876-000-1111', method: 'email', email: 'AP@bluemountain.jm', password: 'water1234' }),
      /already on one of our customer accounts/);
  });

  test('a phone already on file is let through and flagged', async () => {
    const r = await signUp(f.db, { ...home, firstName: 'Sam', phone: '(876) 555-1234', method: 'email', email: 'sam@example.com', password: 'water1234' });
    const dup = await f.db.one<{ possible_duplicates: string[] }>(`SELECT possible_duplicates FROM customers WHERE id = $1`, [r.customerId]);
    assert.deepEqual(dup.possible_duplicates, [f.customerId]);
  });

  test('a zone that is not on the list, or a short password, is refused', async () => {
    await assert.rejects(signUp(f.db, { ...home, method: 'email', email: 'x@example.com', password: 'water1234', zone: 'Mars' }), /delivery area/);
    await assert.rejects(signUp(f.db, { ...home, method: 'email', email: 'x@example.com', password: 'short' }), /at least 8/);
  });

  test('the confirm link, when switched on', async () => {
    // Off: nothing to confirm with, and a made-up token does nothing.
    assert.equal(await confirmEmail(f.db, 'nonsense'), false);
  });
});

describe('Continue with Google', () => {
  test('a token not made for us, or tampered with, is refused', async () => {
    await assert.rejects(verifyGoogleToken(googleToken({ sub: '1', email: 'a@gmail.com' }, 'someone-else')), /did not work/);
    const t = googleToken({ sub: '1', email: 'a@gmail.com' });
    const forged = t.split('.'); forged[1] = b64({ iss: 'https://accounts.google.com', aud: CLIENT, exp: 9e9, sub: '2', email: 'boss@x.com', email_verified: true });
    await assert.rejects(verifyGoogleToken(forged.join('.')), /did not work/);
    await assert.rejects(verifyGoogleToken(googleToken({ sub: '1', email: 'a@gmail.com', email_verified: false })), /not confirmed/);
  });

  test('an existing login (staff too) is signed straight in', async () => {
    const r = await googleSignIn(f.db, googleToken({ sub: 'g-office', email: 'Office@alkavida.jm' }));
    assert.equal(r.kind, 'signedIn');
    if (r.kind === 'signedIn') assert.equal(r.session.role, 'user');
    const u = await f.db.one<{ google_sub: string }>(`SELECT google_sub FROM users WHERE email = 'office@alkavida.jm'`);
    assert.equal(u.google_sub, 'g-office');
  });

  test('a customer on file without a login gets one, linked, and is signed in', async () => {
    const r = await googleSignIn(f.db, googleToken({ sub: 'g-pharm', email: 'acct@portmorerx.jm', given_name: 'Pat', family_name: 'Lee' }));
    assert.equal(r.kind, 'signedIn');
    if (r.kind === 'signedIn') assert.equal(r.session.customerId, f.otherCustomerId);
  });

  test('somebody new is asked for their details, then has an account', async () => {
    const tok = googleToken({ sub: 'g-new', email: 'new.person@gmail.com', given_name: 'New', family_name: 'Person' });
    const first = await googleSignIn(f.db, tok);
    assert.equal(first.kind, 'needsDetails');
    if (first.kind === 'needsDetails') assert.deepEqual(first.profile, { email: 'new.person@gmail.com', firstName: 'New', lastName: 'Person' });
    const r = await signUp(f.db, { ...home, firstName: 'New', lastName: 'Person', phone: '876-999-8888', method: 'google', credential: tok, zone: 'Spanish Town' });
    assert.equal(r.existing, false);
    const u = await f.db.one<{ google_sub: string; confirmed: boolean }>(
      `SELECT google_sub, email_confirmed_at IS NOT NULL AS confirmed FROM users WHERE id = $1`, [r.session.id]);
    assert.deepEqual([u.google_sub, u.confirmed], ['g-new', true]);
    const again = await googleSignIn(f.db, tok);
    assert.equal(again.kind, 'signedIn');
  });
});

describe('the office looks at new customers', () => {
  test('listed until marked looked at', async () => {
    const before = await listSignups(f.db, f.office);
    assert.ok(before.length >= 4);
    const sam = before.find((s) => s.email === 'sam@example.com')!;
    assert.equal(sam.duplicates?.[0]?.name, 'Blue Mountain Offices');
    await markSignupReviewed(f.db, f.office, sam.id);
    const after = await listSignups(f.db, f.office);
    assert.equal(after.length, before.length - 1);
    await assert.rejects(markSignupReviewed(f.db, f.office, sam.id), /already been looked at/);
    await assert.rejects(listSignups(f.db, f.driver));
  });
});
