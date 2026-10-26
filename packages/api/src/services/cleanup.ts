/**
 * Starting fresh for go-live (Everton, 25 Oct 2026).
 *
 * "All transactions in the system now shall be removed." What survives:
 *   - Settings and wording (system_settings), the price tier NAMES, the
 *     Owned brand(s), the material categories and sizes lists;
 *   - the customers he ticks, with their customer information only (details,
 *     addresses, pins, days, terms, portal login) - their zone is blanked
 *     because the zones list goes, and with every transaction gone their
 *     balance and bottle holding start at nothing;
 *   - the logins he ticks, plus the administrator doing it (someone must be
 *     able to sign in), plus the portal login of every kept customer.
 * Everything else goes: orders, quotes, invoices, credit notes, payments,
 * rounds, loads, collections, approvals, products and all pricing, client
 * brands, suppliers, raw materials, recipes, purchase orders, production,
 * stock and the stock ledger, bottle pool counts and history, employees and
 * labour, delivery zones, news, lists and messages, notifications, the
 * automatic-email log and the audit log (which starts again with one entry
 * saying this was done).
 *
 * Numbering: the next invoice carries on from QuickBooks (his ruling: the
 * first app invoice follows QuickBooks' last number); orders, quotes,
 * receipts and purchase orders restart at 001000.
 *
 * One transaction: all of it happens, or none of it does. He types CLEAR.
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, num, requireRole } from './core.ts';
import { RuleViolation } from '@alka/shared';

/** Tables emptied outright. Every table that references one is in the list too. */
const EMPTIED = [
  'approval_requests', 'audit_log', 'auto_emails', 'bom_line_items', 'broadcast_recipients', 'broadcasts',
  'customer_applications', 'customer_bottle_moves', 'customer_lists', 'customer_orders', 'customer_prices',
  'delivery_sheets', 'delivery_stop_allocations', 'delivery_stop_lines', 'delivery_stops', 'delivery_zones',
  'employees', 'finished_goods_stock', 'idempotency_keys', 'inventory_audits', 'inventory_transactions',
  'invoice_line_items', 'invoice_orders', 'invoices', 'labour_entries', 'material_batches', 'news_images',
  'news_posts', 'order_line_items', 'order_reminders', 'payments', 'po_line_items', 'price_lists',
  'production_batch_line_items', 'production_batches', 'products', 'purchase_orders', 'push_subscriptions',
  'quotation_line_items', 'quotations', 'raw_materials', 'round_collections', 'round_load_additions',
  'round_load_lines', 'round_loads', 'staff_alerts_sent', 'staff_notifications', 'supplier_materials',
  'supplier_price_breaks', 'suppliers', 'user_invitations', 'website_orders',
] as const;

/** What the screen counts before anything happens. */
const COUNTED: Array<[string, string]> = [
  ['Orders (including standing orders)', 'customer_orders'],
  ['Quotes', 'quotations'],
  ['Invoices and credit notes', 'invoices'],
  ['Payments', 'payments'],
  ['Delivery rounds', 'delivery_sheets'],
  ['Products', 'products'],
  ['Customer special prices', 'customer_prices'],
  ['Suppliers', 'suppliers'],
  ['Raw materials', 'raw_materials'],
  ['Purchase orders', 'purchase_orders'],
  ['Production batches', 'production_batches'],
  ['Stock ledger entries', 'inventory_transactions'],
  ['Bottle history entries', 'customer_bottle_moves'],
  ['Employees', 'employees'],
  ['Delivery zones', 'delivery_zones'],
  ['News & offers posts', 'news_posts'],
  ['Messages sent', 'broadcasts'],
  ['Sign-up requests', 'customer_applications'],
  ['Activity log entries', 'audit_log'],
];

export interface CleanupPreview {
  counts: Array<{ label: string; count: number }>;
  customers: Array<{ id: string; name: string; active: boolean; hasLogin: boolean; walkIn: boolean }>;
  logins: Array<{ id: string; name: string; email: string; role: string; active: boolean; customerName: string | null; you: boolean }>;
  clientBrands: string[];
  lastInvoiceNumber: string | null;
}

export async function cleanupPreview(db: Queryable, actor: Actor): Promise<CleanupPreview> {
  requireRole(actor, 'admin');
  const counts: CleanupPreview['counts'] = [];
  for (const [label, table] of COUNTED) {
    const r = await db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table}`);
    counts.push({ label, count: num(r.n) });
  }
  const customers = await db.query<{ id: string; name: string; active: boolean; has_login: boolean; is_walk_in: boolean }>(
    `SELECT c.id, c.name, c.active, c.is_walk_in, (c.user_id IS NOT NULL) AS has_login
     FROM customers c WHERE c.merged_into_id IS NULL ORDER BY c.active DESC, lower(c.name)`,
  );
  const logins = await db.query<{ id: string; name: string; email: string; role: string; active: boolean; customer_name: string | null }>(
    `SELECT u.id, u.name, u.email, u.role, u.active, c.name AS customer_name
     FROM users u LEFT JOIN customers c ON c.user_id = u.id
     ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'user' THEN 1 WHEN 'driver' THEN 2 ELSE 3 END, lower(u.name)`,
  );
  const brands = await db.query<{ name: string }>(`SELECT name FROM brands WHERE type <> 'Owned' ORDER BY name`);
  const last = await db.maybeOne<{ n: string }>(`SELECT invoice_number AS n FROM invoices ORDER BY created_at DESC LIMIT 1`);
  return {
    counts,
    customers: customers.map((c) => ({ id: c.id, name: c.name, active: c.active, hasLogin: c.has_login, walkIn: c.is_walk_in })),
    logins: logins.map((u) => ({
      id: u.id, name: u.name, email: u.email, role: u.role, active: u.active,
      customerName: u.customer_name, you: u.id === actor.id,
    })),
    clientBrands: brands.map((b) => b.name),
    lastInvoiceNumber: last?.n ?? null,
  };
}

export interface CleanupInput {
  keepCustomerIds?: string[];
  keepUserIds?: string[];
  /** The number the first new invoice carries, e.g. 16393 for INV-016393. */
  nextInvoiceNumber: number;
  /** Must be the word CLEAR. */
  confirm: string;
}

export interface CleanupResult {
  customersKept: number;
  customersRemoved: number;
  loginsKept: number;
  loginsRemoved: number;
  nextInvoiceNumber: string;
}

export async function startFresh(db: Db, actor: Actor, input: CleanupInput): Promise<CleanupResult> {
  requireRole(actor, 'admin');
  if (String(input.confirm ?? '').trim().toUpperCase() !== 'CLEAR') {
    throw new RuleViolation('type CLEAR to confirm');
  }
  const next = Math.round(Number(input.nextInvoiceNumber));
  if (!Number.isFinite(next) || next < 1 || next > 999999) {
    throw new RuleViolation('give the number the first new invoice should carry (for example 16393)');
  }
  const keepCustomers = [...new Set((input.keepCustomerIds ?? []).filter(Boolean))];
  const keepUsersAsked = [...new Set((input.keepUserIds ?? []).filter(Boolean))];

  return db.tx(async (t) => {
    // Who stays: the ticked customers and the shared walk-in record.
    const keptCustomers = await t.query<{ id: string; user_id: string | null }>(
      `SELECT id, user_id FROM customers
       WHERE (id = ANY($1::uuid[]) OR is_walk_in) AND merged_into_id IS NULL`, [keepCustomers],
    );
    const keptCustomerIds = keptCustomers.map((c) => c.id);
    // Logins: the ticked ones, the administrator doing this, and kept customers' own.
    const keepUsers = new Set<string>([actor.id, ...keepUsersAsked]);
    for (const c of keptCustomers) if (c.user_id) keepUsers.add(c.user_id);
    const keepUserIds = [...keepUsers];

    const before = await t.one<{ c: number; u: number }>(
      `SELECT (SELECT COUNT(*) FROM customers)::int AS c, (SELECT COUNT(*) FROM users)::int AS u`,
    );

    // Every transaction and every list that goes, in one statement.
    await t.query(`TRUNCATE ${EMPTIED.join(', ')}`);

    // Client brands go (the product upload brings them back); the Owned brand stays.
    await t.query(`UPDATE customers SET brand_id = NULL
                   WHERE brand_id IN (SELECT id FROM brands WHERE type <> 'Owned')`);
    await t.query(`DELETE FROM customer_brands`);
    await t.query(`DELETE FROM five_gal_bottle_pool WHERE brand_id IN (SELECT id FROM brands WHERE type <> 'Owned')`);
    await t.query(`DELETE FROM brands WHERE type <> 'Owned'`);
    // The bottle pool counts start again; he enters the holdings later.
    await t.query(`UPDATE five_gal_bottle_pool
                   SET clean_ready = 0, filled_with_customer = 0, returned_dirty = 0, lost_damaged = 0, sold = 0`);

    // Customers: the rest go; the kept ones lose their zone (the list is gone).
    await t.query(`UPDATE customers SET merged_into_id = NULL WHERE id = ANY($1::uuid[])`, [keptCustomerIds]);
    await t.query(`UPDATE customers SET merged_into_id = NULL WHERE merged_into_id IS NOT NULL`);
    await t.query(`DELETE FROM customers WHERE NOT (id = ANY($1::uuid[]))`, [keptCustomerIds]);
    await t.query(`UPDATE customers SET delivery_zone = NULL`);
    await t.query(`UPDATE customer_addresses SET delivery_zone = NULL`);

    // Logins: with every record that pointed at them gone, the rest can go.
    await t.query(`DELETE FROM users WHERE NOT (id = ANY($1::uuid[]))`, [keepUserIds]);
    await t.query(`UPDATE users SET active = true WHERE id = $1`, [actor.id]);

    // Numbering. Invoices carry on from QuickBooks; the rest restart at 001000.
    await t.query(`SELECT setval('invoice_number_seq', $1::bigint, false)`, [next]);
    for (const seq of ['order_number_seq', 'quote_number_seq', 'po_number_seq', 'receipt_number_seq']) {
      await t.query(`SELECT setval('${seq}', 1000, false)`);
    }
    await t.query(`SELECT setval('website_order_seq', 1, false)`);

    const after = await t.one<{ c: number; u: number }>(
      `SELECT (SELECT COUNT(*) FROM customers)::int AS c, (SELECT COUNT(*) FROM users)::int AS u`,
    );
    const result: CleanupResult = {
      customersKept: num(after.c),
      customersRemoved: num(before.c) - num(after.c),
      loginsKept: num(after.u),
      loginsRemoved: num(before.u) - num(after.u),
      nextInvoiceNumber: `INV-${String(next).padStart(6, '0')}`,
    };
    // The new activity log starts with this.
    await audit(t, actor, 'delete', 'System', actor.id, 'Start fresh for go-live', { ...result });
    return result;
  });
}
