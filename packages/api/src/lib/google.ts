/**
 * "Continue with Google" (31 Oct 2026).
 *
 * The browser shows Google's own button; Google hands it a signed ID token
 * (a JWT) naming the person. Here that token is checked: signed by one of
 * Google's published keys, issued by Google, made for OUR client id, not
 * expired, and for an email address Google has confirmed. Only then is the
 * email believed. No secret is needed - just the public client id in
 * GOOGLE_CLIENT_ID.
 */

import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';

export interface GoogleProfile {
  sub: string; email: string; firstName: string; lastName: string; name: string;
}

export function googleClientId(): string | null {
  return process.env.GOOGLE_CLIENT_ID?.trim() || null;
}

type Jwk = JsonWebKey & { kid?: string };
type KeySource = () => Promise<Jwk[]>;

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
let cache: { keys: Jwk[]; until: number } | null = null;

/** Google's current signing keys, kept as long as Google says they may be. */
async function googleKeys(): Promise<Jwk[]> {
  if (cache && cache.until > Date.now()) return cache.keys;
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error(`Google's sign-in keys could not be fetched (${res.status})`);
  const body = (await res.json()) as { keys: Jwk[] };
  const age = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1] ?? 3600);
  cache = { keys: body.keys, until: Date.now() + Math.min(age, 24 * 3600) * 1000 };
  return body.keys;
}

let keySource: KeySource = googleKeys;
/** Tests sign their own tokens. */
export function setGoogleKeysForTests(source: KeySource | null): void {
  keySource = source ?? googleKeys;
  cache = null;
}

export class GoogleTokenError extends Error {
  constructor(message: string) { super(message); this.name = 'RuleViolation'; }
}

const part = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Record<string, unknown>;

/** The person a Google ID token names, or a refusal. */
export async function verifyGoogleToken(credential: string, clientId = googleClientId()): Promise<GoogleProfile> {
  const refuse = () => new GoogleTokenError('Google sign-in did not work. Please try again, or use your email and password.');
  if (!clientId) throw new GoogleTokenError('Google sign-in is not set up yet. Use your email and password.');
  const bits = String(credential ?? '').split('.');
  if (bits.length !== 3) throw refuse();
  let header: Record<string, unknown>; let claims: Record<string, unknown>;
  try { header = part(bits[0]); claims = part(bits[1]); } catch { throw refuse(); }
  if (header.alg !== 'RS256') throw refuse();

  const keys = await keySource();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw refuse();
  const ok = verify('RSA-SHA256', Buffer.from(`${bits[0]}.${bits[1]}`),
    createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(bits[2], 'base64url'));
  if (!ok) throw refuse();

  const now = Math.floor(Date.now() / 1000);
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(String(claims.iss))) throw refuse();
  if (claims.aud !== clientId) throw refuse();
  if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw refuse();
  const email = String(claims.email ?? '').trim();
  if (!email.includes('@') || (claims.email_verified !== true && claims.email_verified !== 'true')) {
    throw new GoogleTokenError('Google has not confirmed this email address yet, so it cannot be used to sign in.');
  }
  const firstName = String(claims.given_name ?? '').trim();
  const lastName = String(claims.family_name ?? '').trim();
  return {
    sub: String(claims.sub), email, firstName, lastName,
    name: String(claims.name ?? '').trim() || [firstName, lastName].filter(Boolean).join(' '),
  };
}
