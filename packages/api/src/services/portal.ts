/**
 * The customer's own profile on the portal (team feedback, 1 Oct 2026,
 * point 4): their phone, contact person, delivery instructions (gate code,
 * where to leave it), their main address and any extra delivery addresses,
 * and which emails they want.
 *
 * Deliberately narrower than the office's customer form. Prices, terms,
 * zone, invoice cycle and GCT exemption are the office's to set; a new
 * address the customer adds takes their main zone until the office says
 * otherwise, so an order to it still finds a round.
 */

import type { Db } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit } from './core.ts';
import { RuleViolation, composeAddress } from '@alka/shared';
import { accountPosition } from './customers.ts';
import { ORDER_EVENTS } from './orders.ts';

export async function getMyProfile(db: Db, customerId: string) {
  const c = await db.one<Record<string, unknown>>(
    `SELECT c.id, c.name, c.account_type, c.contact_person, c.phone, c.email, c.whatsapp,
            c.address_line1, c.address_line2, c.city, c.parish, c.delivery_address,
            c.delivery_instructions, c.delivery_zone, c.delivery_days, c.payment_terms,
            c.invoice_cycle, c.marketing_opt_out, c.order_emails, c.auto_statements, c.gct_exempt,
            c.cancel_emails, c.service_emails, c.auto_reminders,
            pt.name AS price_tier
     FROM customers c LEFT JOIN price_tiers pt ON pt.id = c.price_tier_id
     WHERE c.id = $1`, [customerId],
  );
  const addresses = await db.query(
    `SELECT id, label, address_line1, address_line2, city, parish, is_billing, is_delivery,
            contact_person, phone, delivery_instructions
     FROM customer_addresses WHERE customer_id = $1 AND active
     ORDER BY is_billing DESC, label`, [customerId],
  );
  return { ...c, addresses, position: await accountPosition(db, customerId) };
}

export interface MyProfileInput {
  contactPerson?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  addressLine1?: string | null; addressLine2?: string | null;
  city?: string | null; parish?: string | null;
  deliveryInstructions?: string | null;
  marketingOptOut?: boolean;
  orderEmails?: boolean;
  autoStatements?: boolean;
  /** "Order cancelled" and "Service announcements" (7 Oct 2026, point 4). */
  cancelEmails?: boolean;
  serviceEmails?: boolean;
}

export async function updateMyProfile(
  db: Db, actor: Actor, customerId: string, input: MyProfileInput,
): Promise<void> {
  const has = (k: keyof MyProfileInput) => Object.prototype.hasOwnProperty.call(input, k);
  const text = (v: unknown) => (typeof v === 'string' ? (v.trim() || null) : null);
  const cols: Record<string, unknown> = {};
  if (has('contactPerson')) cols.contact_person = text(input.contactPerson);
  if (has('phone')) {
    const p = text(input.phone);
    if (!p) throw new RuleViolation('we need a phone number to reach you on delivery day');
    cols.phone = p;
  }
  if (has('whatsapp')) cols.whatsapp = text(input.whatsapp);
  if (has('deliveryInstructions')) cols.delivery_instructions = text(input.deliveryInstructions);
  if (has('marketingOptOut')) cols.marketing_opt_out = !!input.marketingOptOut;
  if (has('orderEmails')) cols.order_emails = input.orderEmails !== false;
  if (has('autoStatements')) cols.auto_statements = input.autoStatements !== false;
  if (has('cancelEmails')) cols.cancel_emails = input.cancelEmails !== false;
  if (has('serviceEmails')) cols.service_emails = input.serviceEmails !== false;
  if (['addressLine1', 'addressLine2', 'city', 'parish'].some((k) => has(k as keyof MyProfileInput))) {
    if (!text(input.addressLine1)) throw new RuleViolation('the address needs at least its first line');
    cols.address_line1 = text(input.addressLine1);
    cols.address_line2 = text(input.addressLine2);
    cols.city = text(input.city);
    cols.parish = text(input.parish);
    cols.delivery_address = composeAddress(input);
  }
  const names = Object.keys(cols);
  if (names.length === 0) return;
  await db.tx(async (t) => {
    await t.query(
      `UPDATE customers SET ${names.map((n, i) => `${n} = $${i + 2}`).join(', ')}, updated_at = now()
       WHERE id = $1`, [customerId, ...Object.values(cols)],
    );
    await audit(t, actor, 'update', 'Customer', customerId, 'profile (portal)', { ...input, byCustomer: true });
  });
}

export interface MyAddressInput {
  label?: string;
  addressLine1?: string | null; addressLine2?: string | null;
  city?: string | null; parish?: string | null;
  contactPerson?: string | null; phone?: string | null;
  deliveryInstructions?: string | null;
}

export async function saveMyAddress(
  db: Db, actor: Actor, customerId: string, addressId: string | null, input: MyAddressInput,
): Promise<{ id: string }> {
  const label = input.label?.trim();
  if (!label) throw new RuleViolation('give the address a name, e.g. "Office" or "Home"');
  if (!input.addressLine1?.trim()) throw new RuleViolation('the address needs at least its first line');
  return db.tx(async (t) => {
    const vals = [
      label, input.addressLine1?.trim() || null, input.addressLine2?.trim() || null,
      input.city?.trim() || null, input.parish?.trim() || null,
      input.contactPerson?.trim() || null, input.phone?.trim() || null,
      input.deliveryInstructions?.trim() || null,
    ];
    let id = addressId;
    if (id) {
      const mine = await t.maybeOne(
        `SELECT 1 FROM customer_addresses WHERE id = $1 AND customer_id = $2 AND active`, [id, customerId],
      );
      if (!mine) throw new RuleViolation('that address could not be found on your account');
      await t.query(
        `UPDATE customer_addresses SET label = $3, address_line1 = $4, address_line2 = $5, city = $6,
           parish = $7, contact_person = $8, phone = $9, delivery_instructions = $10
         WHERE id = $1 AND customer_id = $2`, [id, customerId, ...vals],
      );
    } else {
      // Their main zone until the office places it, so it still finds a round.
      const row = await t.one<{ id: string }>(
        `INSERT INTO customer_addresses
           (customer_id, label, address_line1, address_line2, city, parish, contact_person, phone,
            delivery_instructions, is_delivery, is_billing, delivery_zone, route_sequence)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,true,false,c.delivery_zone,c.route_sequence
         FROM customers c WHERE c.id = $1
         RETURNING id`, [customerId, ...vals],
      );
      id = row.id;
    }
    await audit(t, actor, addressId ? 'update' : 'create', 'CustomerAddress', id, label,
      { ...input, byCustomer: true });
    return { id: id! };
  });
}

export async function removeMyAddress(db: Db, actor: Actor, customerId: string, addressId: string): Promise<void> {
  await db.tx(async (t) => {
    const r = await t.query(
      `UPDATE customer_addresses SET active = false, is_billing = false
       WHERE id = $1 AND customer_id = $2 RETURNING id`, [addressId, customerId],
    );
    if (r.length === 0) throw new RuleViolation('that address could not be found on your account');
    await audit(t, actor, 'delete', 'CustomerAddress', addressId, addressId, { byCustomer: true });
  });
}

/* ------------------------------------------------------------------ */
/* Order History details (Everton, 15 Oct 2026)                        */
/* ------------------------------------------------------------------ */

const lineSql = `
  SELECT p.name AS product_name, p.bottles_per_case, p.is_bottle_charge,
         oli.cases, oli.loose_bottles, oli.price_per_case_cents, oli.price_per_bottle_cents,
         oli.delivered_cases, oli.delivered_loose,
         (oli.cases * oli.price_per_case_cents + oli.loose_bottles * oli.price_per_bottle_cents)::bigint AS line_total_cents
  FROM order_line_items oli JOIN products p ON p.id = oli.product_id
  WHERE oli.order_id = $1
  ORDER BY p.is_bottle_charge, p.name`;

/** Where an order goes, in words: the chosen delivery address, else the main one. */
async function orderAddress(db: Db, addressId: string | null, customerId: string): Promise<{ label: string | null; line: string | null }> {
  if (addressId) {
    const a = await db.maybeOne<{ label: string; address_line1: string | null; address_line2: string | null; city: string | null; parish: string | null }>(
      `SELECT label, address_line1, address_line2, city, parish FROM customer_addresses WHERE id = $1 AND customer_id = $2`,
      [addressId, customerId],
    );
    if (a) return { label: a.label, line: composeAddress({ addressLine1: a.address_line1, addressLine2: a.address_line2, city: a.city, parish: a.parish }) };
  }
  const c = await db.one<{ delivery_address: string | null }>(`SELECT delivery_address FROM customers WHERE id = $1`, [customerId]);
  return { label: null, line: c.delivery_address };
}

/**
 * One of the customer's own orders, everything the details page shows: what
 * was ordered at what price, where and when it goes, the totals, and the
 * invoice it went on once delivered. Somebody else's order reads the same as
 * one that is not there.
 */
export async function myOrderDetail(db: Db, customerId: string, orderId: string) {
  const o = await db.maybeOne<Record<string, unknown> & { customer_id: string; address_id: string | null }>(
    `SELECT o.id, o.order_number, o.customer_id, o.order_date::text AS order_date,
            o.requested_delivery_date::text AS requested_delivery_date, o.status, o.delivery_mode,
            o.notes, o.customer_po, o.needs_review, o.address_id, o.source,
            o.subtotal_cents, o.discount_amount_cents, o.gct_cents, o.grand_total_cents, o.gct_exempt,
            o.is_recurring, o.recurrence_pattern, o.parent_recurring_id, o.empties_expected,
            o.fulfilled_on::text AS fulfilled_on, ${ORDER_EVENTS} AS events,
            EXISTS (SELECT 1 FROM delivery_stops s JOIN delivery_sheets d ON d.id = s.delivery_sheet_id
                     WHERE s.order_id = o.id AND d.status = 'Open' AND d.started_at IS NOT NULL
                       AND s.stop_outcome = 'Pending') AS sheet_started
     FROM customer_orders o WHERE o.id = $1`, [orderId],
  );
  if (!o || o.customer_id !== customerId) throw new RuleViolation('that order could not be found on your account');
  const lines = await db.query(lineSql, [orderId]);
  const invoices = await db.query(
    `SELECT l.invoice_id, l.invoice_number, l.invoice_date::text AS invoice_date,
            l.grand_total_cents, l.balance_cents, l.status
     FROM invoice_orders io JOIN invoice_ledger l ON l.invoice_id = io.invoice_id
     WHERE io.order_id = $1 AND NOT l.is_credit_note ORDER BY l.invoice_date`, [orderId],
  );
  const address = o.delivery_mode === 'Delivery' ? await orderAddress(db, o.address_id, customerId) : { label: null, line: null };
  return { ...o, lines, invoices, address };
}

/**
 * One of the customer's own standing orders: how often, the next one, what
 * each one carries (from the order it was made from), and the orders it has
 * raised so far.
 */
export async function myScheduleDetail(db: Db, customerId: string, scheduleId: string) {
  const s = await db.maybeOne<Record<string, unknown> & { customer_id: string; address_id: string | null; delivery_mode: string }>(
    `SELECT o.id, o.order_number, o.customer_id, o.recurrence_pattern AS pattern,
            o.next_delivery_date::text AS next_delivery_date, o.recurrence_paused AS paused,
            o.recurrence_ends_on::text AS ends_on, o.delivery_mode, o.address_id, o.notes,
            o.order_date::text AS order_date, o.subtotal_cents, o.gct_cents, o.grand_total_cents
     FROM customer_orders o
     WHERE o.id = $1 AND o.is_recurring AND o.parent_recurring_id IS NULL`, [scheduleId],
  );
  if (!s || s.customer_id !== customerId) throw new RuleViolation('that standing order could not be found on your account');
  const lines = await db.query(lineSql, [scheduleId]);
  const raised = await db.query(
    `SELECT id, order_number, requested_delivery_date::text AS requested_delivery_date, status, grand_total_cents
     FROM customer_orders WHERE parent_recurring_id = $1 OR id = $1
     ORDER BY requested_delivery_date DESC NULLS LAST, order_number DESC LIMIT 12`, [scheduleId],
  );
  const address = s.delivery_mode === 'Delivery' ? await orderAddress(db, s.address_id, customerId) : { label: null, line: null };
  return { ...s, lines, raised, address };
}
