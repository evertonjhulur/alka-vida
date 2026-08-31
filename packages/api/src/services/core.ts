/** Cross-cutting service helpers: actors, audit, numbering, idempotency. */

import type { Queryable } from '../db/index.ts';
import type { Role } from '@alka/shared';
import { ForbiddenError } from '@alka/shared';

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

/** numeric() columns come back from pg as strings; normalise to number. */
export function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'number' ? v : Number(v);
}
