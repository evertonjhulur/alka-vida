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

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET must be set to at least 16 characters in production');
    }
    return 'dev-only-insecure-secret-change-me';
  }
  return s;
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

  const session = {
    id: user.id, name: user.name, role: user.role,
    customerId: customer?.id ?? null,
  };
  return { token: signToken(session), session };
}
