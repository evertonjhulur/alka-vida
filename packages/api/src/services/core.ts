/** Cross-cutting service helpers: actors, audit, numbering, idempotency. */

import type { Queryable } from '../db/index.ts';
import type { Role } from '@alka/shared';
import { ForbiddenError, RuleViolation } from '@alka/shared';

export interface Actor {
  id: string;
  name: string;
  role: Role;
}

export type AuditAction =
  | 'create' | 'update' | 'delete' | 'deliver' | 'receive' | 'pay' | 'finalize' | 'adjust';

/** Write an audit entry. Called for every money-moving operation. */
export async function audit(
  t: Queryable,
  actor: Actor | null,
  action: AuditAction,
  entityType: string,
  entityId: string | null,
  entityLabel: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await t.query(
    `INSERT INTO audit_log (user_id, user_name, action, entity_type, entity_id, entity_label, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [
      actor?.id ?? null,
      actor?.name ?? 'system',
      action,
      entityType,
      entityId,
      entityLabel,
      JSON.stringify(details),
    ],
  );
}

/** The business timezone. Jamaica does not observe daylight saving. */
export const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE ?? 'America/Jamaica';

/**
 * Today's date in the business timezone, as YYYY-MM-DD.
 *
 * NOT `new Date().toISOString().slice(0, 10)`. That is the UTC date, which
 * from 7pm Jamaica time until midnight is already tomorrow - so an order
 * taken at half past seven in the evening was routed onto tomorrow's
 * delivery sheet. The SQL side of this is business_today() in migration 004.
 */
export function businessToday(): string {
  // en-CA formats as YYYY-MM-DD, which is what every date column expects.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** Throw unless the actor holds one of the given roles. */
export function requireRole(actor: Actor, ...roles: Role[]): void {
  if (!roles.includes(actor.role)) {
    throw new ForbiddenError(
      `this action requires role ${roles.join(' or ')}; ${actor.name} is ${actor.role}`,
    );
  }
}

/** Mint the next document number, e.g. INV-001042. */
export async function nextNumber(t: Queryable, sequence: string, prefix: string): Promise<string> {
  const row = await t.one<{ n: string }>(`SELECT nextval($1)::text AS n`, [sequence]);
  return `${prefix}-${String(row.n).padStart(6, '0')}`;
}

/**
 * Duplicate-submission guard (Section 6).
 *
 * A slow response plus a repeated click must not create two real records for
 * one transaction. The first caller inserts the key and runs the operation;
 * a concurrent or repeated caller with the same key gets the original result
 * back instead of performing the work a second time.
 *
 * Must be called INSIDE a transaction so the key and the work commit together.
 */
export async function withIdempotency<T extends { id: string }>(
  t: Queryable,
  key: string | null | undefined,
  operation: string,
  work: () => Promise<T>,
): Promise<{ result: T | null; replayed: boolean; resultId: string | null }> {
  if (!key) {
    const result = await work();
    return { result, replayed: false, resultId: result.id };
  }

  const claimed = await t.query<{ key: string }>(
    `INSERT INTO idempotency_keys (key, operation) VALUES ($1, $2)
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
    [key, operation],
  );

  if (claimed.length === 0) {
    // Someone already ran this exact operation. Return what they produced.
    const prior = await t.maybeOne<{ result_id: string | null; operation: string }>(
      `SELECT result_id, operation FROM idempotency_keys WHERE key = $1`,
      [key],
    );
    return { result: null, replayed: true, resultId: prior?.result_id ?? null };
  }

  const result = await work();
  await t.query(`UPDATE idempotency_keys SET result_id = $2 WHERE key = $1`, [key, result.id]);
  return { result, replayed: false, resultId: result.id };
}

/**
 * The address people open the app at, for links in emails.
 *
 * PORTAL_URL when it is set; on Railway, the public domain Railway gives the
 * service (RAILWAY_PUBLIC_DOMAIN, set automatically); otherwise this computer.
 */
export function siteUrl(): string {
  const set = process.env.PORTAL_URL?.trim();
  if (set) return set.replace(/\/+$/, '');
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railway) return `https://${railway.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  return `http://localhost:${process.env.PORT ?? 3001}`;
}

/** The time of day in the business timezone, as HH:MM (24-hour). */
export function businessTimeNow(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: BUSINESS_TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(at);
}

/** The address customers write to (orders@alkavidaja.com), on every email and document. */
export async function contactEmail(t: Queryable): Promise<string> {
  return (await getSetting(t, 'contact_email', 'orders@alkavidaja.com')).trim() || 'orders@alkavidaja.com';
}

/**
 * The bank details and note printed at the foot of every invoice and
 * statement PDF (Everton, 10 Oct 2026). Not on quotes or credit notes.
 * Edited in Settings › Invoices & payments.
 */
export const DEFAULT_DOCUMENT_FOOTER = [
  'Invoice payable to 1506 Investments Limited.',
  'Electronic Transfers:',
  'Bank: JMMB',
  'Account Holder: 1506 Investments Limited',
  'Account: 000300249266',
  'Branch: Knutsford Boulevard branch',
  '11 Knutsford Boulevard',
  'Kingston 5, Jamaica',
  'Note to customer',
  '1506 Investments Limited will not assume liability for goods damaged after receipt.',
].join('\n');

export async function documentFooter(t: Queryable): Promise<string> {
  return (await getSetting(t, 'document_footer', DEFAULT_DOCUMENT_FOOTER)).replace(/\r\n/g, '\n').trim();
}

/** "We take card payments" (10 Oct 2026). Off until Everton turns it on. */
export async function takesCard(t: Queryable): Promise<boolean> {
  return (await getSetting(t, 'take_card_payments', 'false')) === 'true';
}

/**
 * Refuse a NEW payment by card while card payments are switched off. Never
 * called from markStop (invariant 3) or from settlement, reversal or
 * reassignment: a card payment already recorded stays exactly as it was.
 */
export async function assertMethodAllowed(t: Queryable, method: string | null | undefined): Promise<void> {
  if (method === 'Card' && !(await takesCard(t))) {
    throw new RuleViolation('we are not taking card payments at the moment. Choose another way they paid.');
  }
}

/** One value from system_settings, or the fallback when it is not there. */
export async function getSetting(t: Queryable, key: string, fallback = ''): Promise<string> {
  const row = await t.maybeOne<{ value: string }>(
    `SELECT value FROM system_settings WHERE key = $1`, [key],
  );
  return row?.value ?? fallback;
}

/** Days to pay from payment terms: "Net 30" -> 30, "Cash on delivery" -> 0. */
export function termsDays(terms: string | null | undefined): number {
  const m = /(\d+)/.exec(terms ?? '');
  return m ? Number(m[1]) : 0;
}

/** numeric() columns come back from pg as strings; normalise to number. */
export function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'number' ? v : Number(v);
}
