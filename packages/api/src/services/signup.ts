/**
 * Customers open their own accounts (Everton, 31 Oct 2026).
 *
 * "The approval step is adding a layer of cumbersome for only a few
 * customers. Most customers will be logged at retail prices and anybody that
 * needs to be changed can be adjusted by the office." So a sign-up makes the
 * customer AND the login at once, and signs them in:
 *
 *  - a home on the Retail price list, a business on Corporate (only the
 *    5 gallon differs) - the tier is assigned, no price is changed;
 *  - cash on delivery (pay on delivery or by bank transfer), billed per
 *    delivery: credit and weekly/monthly invoicing are the office's to give;
 *  - the delivery zone they picked, with its days, or none ("not sure") for
 *    the office to place;
 *  - with Google, or with an email and a password.
 *
 * An email already on a customer is never made into a second customer: Google
 * (which has proved the address is theirs) signs them into it; an email and
 * password is turned away. A phone already on a customer is let through but
 * flagged. The office sees every new one under Needs a decision and marks it
 * looked at.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, getSetting, requireRole, siteUrl } from './core.ts';
import { checkApplicant, publicPin, type AccountType } from './registration.ts';
import { UNUSABLE_PASSWORD } from './invitations.ts';
import { mailConfigured, sendMail } from './documents.ts';
import { customerEmail } from './emailkit.ts';
import { hashPassword, signToken, SESSION_TTL_SECONDS, type Session } from '../lib/auth.ts';
import { verifyGoogleToken, type GoogleProfile } from '../lib/google.ts';
import { composeAddress, RuleViolation } from '@alka/shared';

const MIN_PASSWORD = 8;
/** "Keep me signed in" for a customer: 30 days. Staff stay on the usual 12 hours. */
export const REMEMBER_TTL_SECONDS = 30 * 24 * 3600;
const PHONE = '876-528-6112';

export type SessionOut = { token: string; session: Omit<Session, 'exp'>; ttl: number };

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

async function sessionFor(db: Queryable, userId: string, remember = false): Promise<SessionOut> {
  const u = await db.one<{ id: string; name: string; role: Session['role'] }>(
    `SELECT id, name, role FROM users WHERE id = $1`, [userId]);
  const c = await db.maybeOne<{ id: string }>(
    `SELECT id FROM customers WHERE user_id = $1 AND active LIMIT 1`, [userId]);
  await db.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [userId]);
  const session = { id: u.id, name: u.name, role: u.role, customerId: c?.id ?? null };
  const ttl = remember && u.role === 'customer' ? REMEMBER_TTL_SECONDS : SESSION_TTL_SECONDS;
  return { token: signToken(session, ttl), session, ttl };
}

/** Customers on file with this email who could be this person (not walk-ins, not merged away). */
async function customersWithEmail(db: Queryable, email: string) {
  return db.query<{ id: string; name: string; user_id: string | null }>(
    `SELECT id, name, user_id FROM customers
     WHERE active AND NOT is_walk_in AND lower(trim(email)) = lower(trim($1))`, [email]);
}

/* ------------------------------------------------------------------ */
/* Continue with Google                                                */
/* ------------------------------------------------------------------ */

export type GoogleResult =
  | ({ kind: 'signedIn' } & SessionOut)
  | { kind: 'needsDetails'; profile: { email: string; firstName: string; lastName: string } };

/**
 * The person Google vouches for: signed into their login if they have one
 * (staff included), into the customer that already has their email if there
 * is exactly one, or asked for their delivery details to open an account.
 */
export async function googleSignIn(db: Db, credential: string, remember = false): Promise<GoogleResult> {
  const g = await verifyGoogleToken(credential);
  return signInAs(db, g, remember);
}

async function signInAs(db: Db, g: GoogleProfile, remember: boolean): Promise<GoogleResult> {
  const user = await db.maybeOne<{ id: string; active: boolean }>(
    `SELECT id, active FROM users WHERE google_sub = $1
     UNION ALL
     SELECT id, active FROM users WHERE google_sub IS NULL AND lower(email) = lower($2)
     LIMIT 1`, [g.sub, g.email]);
  if (user) {
    if (!user.active) throw new RuleViolation('This login has been deactivated. Speak to the office.');
    await db.query(
      `UPDATE users SET google_sub = COALESCE(google_sub, $2), email_confirmed_at = COALESCE(email_confirmed_at, now())
       WHERE id = $1`, [user.id, g.sub]);
    return { kind: 'signedIn', ...(await sessionFor(db, user.id, remember)) };
  }

  // A customer the office already has, with this email and no login yet:
  // Google has proved the address is theirs, so this IS their login.
  const known = (await customersWithEmail(db, g.email)).filter((c) => !c.user_id);
  if (known.length > 1) {
    throw new RuleViolation(`This email is on more than one of our customer accounts. Call us on ${PHONE} and we'll set up your login.`);
  }
  if (known.length === 1) {
    const userId = await db.tx(async (t) => {
      const u = await t.one<{ id: string }>(
        `INSERT INTO users (email, name, password_hash, role, google_sub, email_confirmed_at)
         VALUES ($1,$2,$3,'customer',$4,now()) RETURNING id`,
        [g.email, g.name || known[0].name, UNUSABLE_PASSWORD, g.sub]);
      await t.query(`UPDATE customers SET user_id = $2 WHERE id = $1`, [known[0].id, u.id]);
      await audit(t, { id: u.id, name: g.name || known[0].name, role: 'customer' },
        'update', 'Customer', known[0].id, known[0].name, { login: 'made with Google sign-in' });
      return u.id;
    });
    return { kind: 'signedIn', ...(await sessionFor(db, userId, remember)) };
  }
  return { kind: 'needsDetails', profile: { email: g.email, firstName: g.firstName, lastName: g.lastName } };
}

/* ------------------------------------------------------------------ */
/* Creating an account                                                 */
/* ------------------------------------------------------------------ */

export interface SignupInput {
  method: 'google' | 'email';
  /** Google's ID token, for method 'google'. */
  credential?: string;
  /** For method 'email'. */
  email?: string;
  password?: string;
  accountType: AccountType;
  businessName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  parish?: string | null;
  /** The delivery zone's name; blank = "not sure, place me". */
  zone?: string | null;
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  remember?: boolean;
}

export type SignupResult = SessionOut & { customerId: string | null; existing: boolean; confirmSent: boolean };

/** The last seven digits: 876-528-6112, (876) 5286112 and 5286112 are one phone. */
const phoneKey = (p: string) => p.replace(/\D/g, '').slice(-7);

export async function signUp(db: Db, input: SignupInput): Promise<SignupResult> {
  const method = input.method === 'google' ? 'Google' : input.method === 'email' ? 'Email' : null;
  if (!method) throw new RuleViolation('choose Google or email to sign up');

  let google: GoogleProfile | null = null;
  let email: string;
  if (method === 'Google') {
    google = await verifyGoogleToken(String(input.credential ?? ''));
    // Already ours (a login, or a customer with this email): just sign in.
    const known = await signInAs(db, google, !!input.remember);
    if (known.kind === 'signedIn') {
      return { ...known, customerId: known.session.customerId ?? null, existing: true, confirmSent: false };
    }
    email = google.email;
    // Their email is on a customer that already has a login under another
    // address: still never a second customer.
    if ((await customersWithEmail(db, email)).length > 0) {
      throw new RuleViolation(`This email is already on one of our customer accounts. Call us on ${PHONE} and we'll sort out your login.`);
    }
  } else {
    email = String(input.email ?? '').trim();
    if (!email.includes('@')) throw new RuleViolation('a valid email address is needed');
    if (!input.password || input.password.length < MIN_PASSWORD) {
      throw new RuleViolation(`choose a password of at least ${MIN_PASSWORD} characters`);
    }
    const user = await db.maybeOne(`SELECT 1 FROM users WHERE lower(email) = lower($1)`, [email]);
    if (user) throw new RuleViolation('There is already an Alka Vida login for this email. Sign in instead, or use Forgot password.');
    if ((await customersWithEmail(db, email)).length > 0) {
      throw new RuleViolation(`This email is already on one of our customer accounts. Use "Continue with Google" with it, or call us on ${PHONE} and we'll send you a link to set your password.`);
    }
  }

  // Both kinds give a person's name: for a business it is who we speak to.
  const firstName = String(input.firstName ?? '').trim();
  const lastName = String(input.lastName ?? '').trim();
  if (!firstName) throw new RuleViolation('a first name is needed');
  if (!lastName) throw new RuleViolation('a last name is needed');
  const person = `${firstName} ${lastName}`;
  const a = checkApplicant({
    accountType: input.accountType, businessName: input.businessName,
    contactPerson: input.accountType === 'Corporate' ? person : null,
    firstName, lastName, email, phone: input.phone,
    addressLine1: input.addressLine1, addressLine2: input.addressLine2, city: input.city, parish: input.parish,
  });
  const pin = publicPin(input);

  const zoneName = String(input.zone ?? '').trim();
  const zone = zoneName
    ? await db.maybeOne<{ name: string; run_days: string[] | null }>(
      `SELECT name, run_days FROM delivery_zones WHERE name = $1 AND retired_at IS NULL`, [zoneName])
    : null;
  if (zoneName && !zone) throw new RuleViolation('choose your delivery area from the list');
  const days = zone?.run_days ?? [];

  const tier = await db.maybeOne<{ id: string }>(
    `SELECT id FROM price_tiers WHERE lower(name) = lower($1)`, [a.accountType === 'Corporate' ? 'Corporate' : 'Retail']);

  const key = phoneKey(a.phone);
  const samePhone = key.length === 7
    ? (await db.query<{ id: string }>(
      `SELECT id FROM customers WHERE active AND NOT is_walk_in
         AND right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 7) = $1`, [key])).map((r) => r.id)
    : [];

  const passwordHash = method === 'Email' ? await hashPassword(String(input.password)) : UNUSABLE_PASSWORD;
  const created = await db.tx(async (t) => {
    const u = await t.one<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role, google_sub, email_confirmed_at)
       VALUES ($1,$2,$3,'customer',$4,$5) RETURNING id`,
      [email, person, passwordHash, google?.sub ?? null, google ? new Date().toISOString() : null]);
    const c = await t.one<{ id: string }>(
      `INSERT INTO customers
         (name, phone, email, delivery_address, address_line1, address_line2, city, parish,
          contact_person, account_type, price_tier_id, delivery_zone, delivery_days, default_delivery_day,
          payment_terms, invoice_cycle, user_id,
          lat, lng, location_accuracy_m, location_source, location_set_at, location_set_by,
          signed_up_at, signup_method, possible_duplicates)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'Cash on delivery','PerDelivery',$15,
               $16,$17,$18,$19,$20,$21, now(), $22, $23::uuid[])
       RETURNING id`,
      [a.name, a.phone, email, composeAddress(a.address), a.address.addressLine1, a.address.addressLine2,
       a.address.city, a.address.parish, a.accountType === 'Corporate' ? person : null, a.accountType,
       tier?.id ?? null, zone?.name ?? null, days, days[0] ?? null, u.id,
       pin?.lat ?? null, pin?.lng ?? null, pin?.accuracyM ?? null,
       pin ? 'Customer' : null, pin ? new Date().toISOString() : null, pin ? person : null,
       method, samePhone]);
    await audit(t, { id: u.id, name: person, role: 'customer' }, 'create', 'Customer', c.id, a.name,
      { signedUp: method, accountType: a.accountType, zone: zone?.name ?? null, possibleDuplicates: samePhone.length });
    return { userId: u.id, customerId: c.id };
  });

  const confirmSent = method === 'Email' ? await sendConfirmEmail(db, created.userId, created.customerId, email, firstName) : false;
  return { ...(await sessionFor(db, created.userId, !!input.remember)), customerId: created.customerId, existing: false, confirmSent };
}

/* ------------------------------------------------------------------ */
/* Confirming the email of an email-and-password sign-up               */
/* ------------------------------------------------------------------ */

/**
 * Only while Settings › Emails & ordering has it switched on: off during the
 * live internal testing, when no automatic email goes to a customer
 * (29 Oct 2026), and on once customers are told about accounts. The account
 * works whether or not they ever click it.
 */
async function sendConfirmEmail(db: Db, userId: string, customerId: string, to: string, firstName: string): Promise<boolean> {
  if ((await getSetting(db, 'signup_confirm_emails', 'false')) !== 'true' || !mailConfigured()) return false;
  const token = randomBytes(32).toString('base64url');
  await db.query(`UPDATE users SET email_confirm_hash = $2 WHERE id = $1`, [userId, hashToken(token)]);
  const link = `${siteUrl()}/#/confirm-email?token=${token}`;
  try {
    const mail = await customerEmail(db, customerId, null, {
      preheader: 'Confirm your email for Alka Vida',
      heading: 'Confirm your email',
      greeting: `Good day ${firstName},`,
      intro: 'Welcome to Alka Vida. Your account is ready. Please confirm this is your email address, so your receipts and invoices reach you.',
      button: { label: 'Confirm my email', url: link },
      outro: `If the button does not work, copy this into your browser:\n${link}`,
    });
    await sendMail({ to, subject: 'Confirm your email for Alka Vida', text: mail.text, html: mail.html });
    await db.query(
      `INSERT INTO auto_emails (kind, customer_id, sent_to, period_key, detail, ok)
       VALUES ('ConfirmEmail',$1,$2,NULL,'sign-up',true)`, [customerId, to]);
    return true;
  } catch (err) {
    await db.query(
      `INSERT INTO auto_emails (kind, customer_id, sent_to, period_key, detail, ok)
       VALUES ('ConfirmEmail',$1,$2,NULL,$3,false)`, [customerId, to, err instanceof Error ? err.message : 'failed'],
    ).catch(() => {});
    return false;
  }
}

/** The link in that email. True once confirmed; false for a link that is not (or no longer) valid. */
export async function confirmEmail(db: Db, token: string): Promise<boolean> {
  if (!token) return false;
  const r = await db.query<{ id: string }>(
    `UPDATE users SET email_confirmed_at = now(), email_confirm_hash = NULL
     WHERE email_confirm_hash = $1 RETURNING id`, [hashToken(token)]);
  return r.length > 0;
}

/* ------------------------------------------------------------------ */
/* The office: new customers to look at                                */
/* ------------------------------------------------------------------ */

export async function listSignups(db: Db, actor: Actor) {
  requireRole(actor, 'admin', 'user');
  return db.query<{
    id: string; name: string; account_type: string; contact_person: string | null; email: string | null;
    phone: string | null; delivery_address: string | null; delivery_zone: string | null; delivery_days: string[];
    tier_name: string | null; signup_method: string; signed_up_at: string; email_confirmed: boolean;
    lat: number | null; lng: number | null; duplicates: Array<{ id: string; name: string; phone: string | null }> | null;
  }>(
    `SELECT c.id, c.name, c.account_type, c.contact_person, c.email, c.phone, c.delivery_address,
            c.delivery_zone, c.delivery_days, t.name AS tier_name, c.signup_method, c.signed_up_at,
            (u.email_confirmed_at IS NOT NULL) AS email_confirmed, c.lat, c.lng,
            (SELECT json_agg(json_build_object('id', d.id, 'name', d.name, 'phone', d.phone))
               FROM customers d WHERE d.id = ANY(c.possible_duplicates)) AS duplicates
     FROM customers c
     LEFT JOIN price_tiers t ON t.id = c.price_tier_id
     LEFT JOIN users u ON u.id = c.user_id
     WHERE c.signed_up_at IS NOT NULL AND c.signup_reviewed_at IS NULL AND c.active
     ORDER BY c.signed_up_at`);
}

export async function markSignupReviewed(db: Db, actor: Actor, customerId: string): Promise<void> {
  requireRole(actor, 'admin', 'user');
  await db.tx(async (t) => {
    const c = await t.maybeOne<{ name: string }>(
      `UPDATE customers SET signup_reviewed_at = now(), signup_reviewed_by = $2
       WHERE id = $1 AND signed_up_at IS NOT NULL AND signup_reviewed_at IS NULL RETURNING name`, [customerId, actor.id]);
    if (!c) throw new RuleViolation('this new customer has already been looked at');
    await audit(t, actor, 'update', 'Customer', customerId, c.name, { newSignupLookedAt: true });
  });
}
