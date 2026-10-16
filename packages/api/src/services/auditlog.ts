/**
 * The audit log, as a screen (Everton, 15 Oct 2026: "where to view the audit
 * trail of activities in the system?").
 *
 * Every write in the system already ends in an audit_log row (services/core
 * audit()): who, when, what was done and to what, and the details. This only
 * reads it back, newest first, filtered. Admin only: it shows everybody's
 * activity, money included.
 */

import type { Db } from '../db/index.ts';
import type { Actor } from './core.ts';
import { requireRole } from './core.ts';

export interface AuditQuery {
  from?: string | null;
  to?: string | null;
  userId?: string | null;
  /** Entity types, e.g. CustomerOrder, Payment. Empty is every type. */
  types?: string[];
  /** create, update, delete, deliver, receive, pay, finalize, adjust. Empty is all. */
  actions?: string[];
  /** Words in the label (an order or invoice number, a name) or the details. */
  q?: string | null;
  /** Only rows older than this moment: the "Show more" cursor. */
  before?: string | null;
  limit?: number;
}

const ACTIONS = ['create', 'update', 'delete', 'deliver', 'receive', 'pay', 'finalize', 'adjust'];

export async function listAuditLog(db: Db, actor: Actor, q: AuditQuery = {}) {
  requireRole(actor, 'admin');
  const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 500);
  const types = (q.types ?? []).map((t) => String(t).trim()).filter(Boolean);
  const actions = (q.actions ?? []).filter((a) => ACTIONS.includes(a));
  const needle = (q.q ?? '').trim();
  const rows = await db.query<Record<string, unknown>>(
    `SELECT a.id, a.ts::text AS ts, a.user_id, COALESCE(a.user_name, u.name, u.email, 'System') AS user_name,
            a.action, a.entity_type, a.entity_id, a.entity_label, a.details
     FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
     WHERE ($1::date IS NULL OR business_date(a.ts) >= $1::date)
       AND ($2::date IS NULL OR business_date(a.ts) <= $2::date)
       AND ($3::uuid IS NULL OR a.user_id = $3::uuid)
       AND (cardinality($4::text[]) = 0 OR a.entity_type = ANY($4::text[]))
       AND (cardinality($5::text[]) = 0 OR a.action = ANY($5::text[]))
       AND ($6::text = '' OR a.entity_label ILIKE '%' || $6 || '%' OR a.details::text ILIKE '%' || $6 || '%'
            OR a.user_name ILIKE '%' || $6 || '%')
       AND ($7::timestamptz IS NULL OR a.ts < $7::timestamptz)
     ORDER BY a.ts DESC, a.id DESC
     LIMIT $8`,
    [q.from || null, q.to || null, q.userId || null, types, actions, needle, q.before || null, limit + 1],
  );
  const more = rows.length > limit;
  return { rows: rows.slice(0, limit), more };
}

/** What can be filtered on: the people and kinds of thing that appear in the log. */
export async function auditLogFilters(db: Db, actor: Actor) {
  requireRole(actor, 'admin');
  const types = await db.query<{ entity_type: string; n: number }>(
    `SELECT entity_type, COUNT(*)::int AS n FROM audit_log GROUP BY entity_type ORDER BY entity_type`,
  );
  const people = await db.query<{ id: string; name: string }>(
    `SELECT DISTINCT u.id, COALESCE(u.name, u.email) AS name
     FROM audit_log a JOIN users u ON u.id = a.user_id ORDER BY name`,
  );
  return { types: types.map((t) => t.entity_type), people, actions: ACTIONS };
}
