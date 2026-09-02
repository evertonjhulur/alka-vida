/**
 * Authentication. Maps directly onto the four User.role values (Section 10).
 *
 * Password hashing uses scrypt from node:crypto - deliberately no native
 * dependency, so the system installs anywhere Node runs.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import type { Db } from '../db/index.ts';
import type { Role } from '@alka/shared';
import type { Actor } from '../services/core.ts';

const scrypt = promisify(scryptCb) as (
  password: string, salt: Buffer, keylen: number,
) => Promise<Buffer>;

const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEYLEN);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const derived = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  // Constant-time comparison, so a wrong password cannot be probed by timing.
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

export interface Session extends Actor {
  /** Set for a portal login, so a customer only ever sees their own records. */
  customerId: string | null;
  exp: number;
}

/**
 * The key every token is signed with, loaded once at startup.
 *
 * Deliberately NOT a constant. A constant lets a token outlive the database
 * it was minted against: wiping .data reseeds the users with new ids, and a
 * browser still holding the old token keeps passing signature verification
 * as somebody who no longer exists. Keeping the key in the database means
 * wiping the data wipes the key with it.
 */
let signingKey: string | null = null;

/**
 * Load the signing key, generating and storing one on first run.
 *
 * JWT_SECRET wins when it is set - that is the production path, and it lets
 * several servers share one database. Otherwise the key is per-install and
 * random, so nobody can forge a token by reading this source.
 *
 * Must be called at startup, after migrations. Signing or verifying before
 * that throws, rather than falling back to anything guessable.
 */
export async function loadSigningKey(db: Db): Promise<void> {
  const configured = process.env.JWT_SECRET;
  if (configured && configured.length >= 16) {
    signingKey = configured;
    return;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set to at least 16 characters in production');
  }

  // ON CONFLICT DO NOTHING, then read back: two servers racing on one
  // database both end up on whichever key won, never on two different ones.
  await db.query(
    `INSERT INTO system_settings (key, value) VALUES ('jwt_signing_key', $1)
     ON CONFLICT (key) DO NOTHING`,
    [randomBytes(32).toString('hex')],
  );
  const row = await db.one<{ value: string }>(
    `SELECT value FROM system_settings WHERE key = 'jwt_signing_key'`,
  );
  signingKey = row.value;
}

function secret(): string {
  if (!signingKey) {
    throw new Error('signing key not loaded - call loadSigningKey(db) at startup');
  }
  return signingKey;
}

/**
 * Is the person this token names still here, and still allowed in?
 *
 * A valid signature only proves the token was minted by this system, not
 * that its subject survived. Every write ends by inserting an audit_log row
 * whose user_id references users(id), so a token naming a user who is gone
 * takes the whole transaction down on a foreign key at the last possible
 * moment - after document numbers have already been burned off their
 * sequences. Checking here turns that into an ordinary 401.
 *
 * `active` is checked here too, not only at login. Withdrawing access is the
 * entire point of being able to deactivate somebody, and if it were checked
 * at login alone a driver dismissed at nine in the morning would keep
 * working access until their token expired that evening. Checked per
 * request, the next thing they touch is refused.
 */
export async function userAccess(
  db: Db, userId: string,
): Promise<'ok' | 'gone' | 'disabled'> {
  const row = await db.maybeOne<{ active: boolean }>(
    `SELECT active FROM users WHERE id = $1`, [userId],
  );
  if (row == null) return 'gone';
  return row.active ? 'ok' : 'disabled';
}

const b64url = (b: Buffer) => b.toString('base64url');

export function signToken(session: Omit<Session, 'exp'>, ttlSeconds = 12 * 3600): string {
  const payload = { ...session, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = createHmac('sha256', secret()).update(`${header}.${body}`).digest();
  return `${header}.${body}.${b64url(sig)}`;
}

export function verifyToken(token: string): Session | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = b64url(
    createHmac('sha256', secret()).update(`${header}.${body}`).digest(),
  );
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as Session;
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function login(
  db: Db,
  email: string,
  password: string,
): Promise<{ token: string; session: Omit<Session, 'exp'> } | null> {
  const user = await db.maybeOne<{
    id: string; name: string; role: Role; password_hash: string; active: boolean;
  }>(
    `SELECT id, name, role, password_hash, active FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
  if (!user || !user.active) return null;
  if (!(await verifyPassword(password, user.password_hash))) return null;

  const customer = await db.maybeOne<{ id: string }>(
    `SELECT id FROM customers WHERE user_id = $1 AND active LIMIT 1`, [user.id],
  );

  // So an administrator reviewing access can tell a live account from one
  // nobody has touched since it was created.
  await db.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);

  const session = {
    id: user.id, name: user.name, role: user.role,
    customerId: customer?.id ?? null,
  };
  return { token: signToken(session), session };
}
