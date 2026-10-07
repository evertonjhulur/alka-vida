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
