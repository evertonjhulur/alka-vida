/**
 * Customer records and merging (Section 6).
 */

import { ORDER_EVENTS } from './orders.ts';
import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, businessToday, num, requireRole } from './core.ts';
import { RuleViolation, composeAddress } from '@alka/shared';
import { assertZoneUsable } from './zones.ts';
import { productAvailableSql } from './brands.ts';
import { looksLikeEmail, splitAddresses } from './compose.ts';

/**
 * Merge two customer records.
 *
 * Every order, invoice, payment, delivery stop and quotation is reassigned to
 * the survivor. The merged-away record is DEACTIVATED, never deleted, so its
 * history stays intact and auditable - it simply can no longer be selected
 * for new orders.
 *
 * Also moved (Everton, 20 Nov 2026 - Rose Green into "Maureen Williams/Rose
 * Green": Maureen pays, both addresses on the one account, deliveries go
 * separately): their extra addresses, 5-gallon bottle moves (so the bottle
 * balance comes too), collections, reminders, website orders, sign-up
 * applications, email and message history, and any special prices or own
 * brands the survivor does not already have.
 *
 * With keepAddress (the default), the merged customer's main address becomes
 * a delivery address on the survivor, labelled with their name, carrying
 * their zone, route number, phone, map pin and delivery instructions; their
 * orders that went to that main address - standing orders included - now go
 * to it, so their deliveries carry on to the same door on their own round.
 */
export async function mergeCustomers(
  db: Db,
  actor: Actor,
  args: { survivorId: string; mergedId: string; reason?: string; keepAddress?: boolean },
): Promise<{ survivorId: string; moved: Record<string, number>; addressId: string | null }> {
  requireRole(actor, 'admin');
  if (args.survivorId === args.mergedId) {
    throw new RuleViolation('cannot merge a customer into itself');
  }

  return db.tx(async (t) => {
    const survivor = await t.maybeOne<{ name: string; active: boolean }>(
      `SELECT name, active FROM customers WHERE id = $1`, [args.survivorId],
    );
    const merged = await t.maybeOne<{
      name: string; active: boolean; merged_into_id: string | null;
      delivery_address: string | null; address_line1: string | null; address_line2: string | null;
      city: string | null; parish: string | null; delivery_zone: string | null; route_sequence: number | null;
      contact_person: string | null; phone: string | null; delivery_instructions: string | null;
      lat: number | null; lng: number | null; location_accuracy_m: number | null; location_source: string | null;
      location_set_at: string | null; location_set_by: string | null;
      geocoded_text: string | null; geocoded_at: string | null;
    }>(
      `SELECT name, active, merged_into_id, delivery_address, address_line1, address_line2, city, parish,
              delivery_zone, route_sequence, contact_person, phone, delivery_instructions,
              lat, lng, location_accuracy_m, location_source, location_set_at, location_set_by,
              geocoded_text, geocoded_at
       FROM customers WHERE id = $1`, [args.mergedId],
    );
    if (!survivor) throw new RuleViolation('survivor customer not found');
    if (!merged) throw new RuleViolation('customer to merge not found');
    if (!survivor.active) throw new RuleViolation('the survivor must be an active customer');
    if (merged.merged_into_id) throw new RuleViolation(`${merged.name} has already been merged into another customer`);

    const moved: Record<string, number> = {};

    // Their main address, kept as a delivery address on the survivor.
    let addressId: string | null = null;
    const line1 = (merged.address_line1 ?? '').trim() || (merged.delivery_address ?? '').trim();
    if (args.keepAddress !== false && line1) {
      const row = await t.one<{ id: string }>(
        `INSERT INTO customer_addresses
           (customer_id, label, address_line1, address_line2, city, parish, is_billing, is_delivery,
            delivery_zone, route_sequence, contact_person, phone, delivery_instructions,
            lat, lng, location_accuracy_m, location_source, location_set_at, location_set_by,
            geocoded_text, geocoded_at)
         VALUES ($1,$2,$3,$4,$5,$6,false,true,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         RETURNING id`,
        [args.survivorId, merged.name, line1,
         merged.address_line1 ? merged.address_line2 : null,
         merged.address_line1 ? merged.city : null,
         merged.address_line1 ? merged.parish : null,
         merged.delivery_zone, merged.route_sequence ?? 0,
         (merged.contact_person ?? '').trim() || merged.name, merged.phone, merged.delivery_instructions,
         merged.lat, merged.lng, merged.location_accuracy_m, merged.location_source,
         merged.location_set_at, merged.location_set_by, merged.geocoded_text, merged.geocoded_at],
      );
      addressId = row.id;
      const pointed = await t.query<{ id: string }>(
        `UPDATE customer_orders SET address_id = $2
         WHERE customer_id = $1 AND address_id IS NULL AND delivery_mode = 'Delivery' RETURNING id`,
        [args.mergedId, addressId],
      );
      moved.orders_to_their_address = pointed.length;
    }

    const reassign = async (table: string, column = 'customer_id') => {
      const rows = await t.query<{ id: string }>(
        `UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2 RETURNING id`,
        [args.survivorId, args.mergedId],
      );
      moved[table] = rows.length;
    };

    await reassign('customer_orders');
    await reassign('invoices');
    await reassign('payments');
    await reassign('delivery_stops');
    await reassign('quotations');
    await reassign('approval_requests');
    await reassign('customer_addresses');
    // Only one opening bottle balance per customer: when both had one, theirs
    // is added into the survivor's, so the combined account holds both.
    const openings = await t.query<{ id: string; customer_id: string; delivered: number; moved_on: string }>(
      `SELECT id, customer_id, delivered, moved_on::text AS moved_on FROM customer_bottle_moves
       WHERE opening AND customer_id IN ($1, $2)`, [args.survivorId, args.mergedId]);
    const theirs = openings.find((o) => o.customer_id === args.mergedId);
    const ours = openings.find((o) => o.customer_id === args.survivorId);
    if (theirs && ours) {
      await t.query(
        `UPDATE customer_bottle_moves
         SET delivered = delivered + $2,
             note = concat_ws(' · ', NULLIF(note, ''), $3::text)
         WHERE id = $1`,
        [ours.id, num(theirs.delivered),
         `+${num(theirs.delivered)} from ${merged.name}'s opening balance (merged ${businessToday()})`]);
      await t.query(`DELETE FROM customer_bottle_moves WHERE id = $1`, [theirs.id]);
      moved.opening_bottles_added = num(theirs.delivered);
    }
    await reassign('customer_bottle_moves');
    await reassign('round_collections');
    await reassign('order_reminders');
    await reassign('website_orders');
    await reassign('customer_applications');
    await reassign('auto_emails');
    // Message history: moved unless the survivor got the same message too.
    moved.broadcast_recipients = (await t.query<{ id: string }>(
      `UPDATE broadcast_recipients m SET customer_id = $1
       WHERE m.customer_id = $2
         AND NOT EXISTS (SELECT 1 FROM broadcast_recipients s
                         WHERE s.customer_id = $1 AND s.broadcast_id = m.broadcast_id)
       RETURNING m.id`, [args.survivorId, args.mergedId])).length;

    // Special prices and own brands: only where the survivor has none of its own.
    moved.customer_prices = (await t.query<{ id: string }>(
      `UPDATE customer_prices m SET customer_id = $1
       WHERE m.customer_id = $2
         AND NOT EXISTS (SELECT 1 FROM customer_prices s WHERE s.customer_id = $1 AND s.product_id = m.product_id)
       RETURNING m.id`, [args.survivorId, args.mergedId])).length;
    moved.customer_brands = (await t.query<{ brand_id: string }>(
      `UPDATE customer_brands m SET customer_id = $1
       WHERE m.customer_id = $2
         AND NOT EXISTS (SELECT 1 FROM customer_brands s WHERE s.customer_id = $1 AND s.brand_id = m.brand_id)
       RETURNING m.brand_id`, [args.survivorId, args.mergedId])).length;

    // Deactivated, not deleted. History stays; new orders cannot select it.
    await t.query(
      `UPDATE customers
       SET active = false, merged_into_id = $2, updated_at = now(),
           notes = COALESCE(notes,'') || $3
       WHERE id = $1`,
      [args.mergedId, args.survivorId,
       `\n[merged into ${survivor.name} on ${businessToday()}]`],
    );

    await audit(t, actor, 'update', 'Customer', args.mergedId, merged.name, {
      mergedInto: args.survivorId,
      survivorName: survivor.name,
      reason: args.reason ?? null,
      recordsMoved: moved,
      keptAddressAs: addressId,
      deleted: false,
    });

    return { survivorId: args.survivorId, moved, addressId };
  });
}

/**
 * Everything the office can set on a customer (Everton's revisions, 30 Sep
 * 2026: business or individual first, zone from the managed list, several
 * delivery days, GCT exemption, invoice cycle, automatic-email opt-outs).
 */
export interface CustomerInput {
  accountType?: 'Corporate' | 'Individual' | null;
  name?: string; phone?: string; email?: string;
  /** Copy addresses for emails (send screen, 28 Oct 2026), comma-separated. */
  ccEmails?: string | null;
  contactPerson?: string | null;
  /** Legacy single line; composed from the parts when parts are given. */
  deliveryAddress?: string | null;
  addressLine1?: string | null; addressLine2?: string | null;
  city?: string | null; parish?: string | null;
  brandId?: string | null; paymentTerms?: string | null;
  priceTierId?: string | null;
  defaultDeliveryDay?: string | null;
  deliveryDays?: string[] | null;
  deliveryZone?: string | null; routeSequence?: number;
  userId?: string | null; notes?: string | null;
  gctExempt?: boolean; gctExemptRef?: string | null;
  invoiceCycle?: 'PerDelivery' | 'Weekly' | 'Monthly';
  autoStatements?: boolean; autoReminders?: boolean;
  /** Gate code, where to leave it... shown to the driver under the order. */
  deliveryInstructions?: string | null;
  whatsapp?: string | null;
  marketingOptOut?: boolean;
  orderEmails?: boolean;
  cancelEmails?: boolean;
  serviceEmails?: boolean;
  /** A walk-in pays in full at the counter (7 Oct 2026, point 12). */
  isWalkIn?: boolean;
}

const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * The screens offer zones from the managed list, so a new choice is always a
 * real one. A retired zone is refused; a name that predates the list (or an
 * import) is let through rather than blocking the rest of the record.
 */
async function assertZoneNotRetired(t: Queryable, name: string): Promise<void> {
  const z = await t.maybeOne<{ retired_at: string | null }>(
    `SELECT retired_at FROM delivery_zones WHERE name = $1`, [name],
  );
  if (z?.retired_at) throw new RuleViolation(`the zone "${name}" has been retired; bring it back to use it`);
}

function cleanDays(days: readonly string[] | null | undefined): string[] {
  const set = new Set((days ?? []).filter((d) => WEEK.includes(d)));
  return WEEK.filter((d) => set.has(d));
}

/** Column -> value for every field the caller actually sent. */
function customerColumns(input: CustomerInput): Record<string, unknown> {
  const cols: Record<string, unknown> = {};
  const has = (k: keyof CustomerInput) => Object.prototype.hasOwnProperty.call(input, k);
  const text = (v: unknown) => (typeof v === 'string' ? (v.trim() || null) : (v ?? null));

  if (has('accountType') && input.accountType) {
    if (!['Corporate', 'Individual'].includes(input.accountType)) {
      throw new RuleViolation('a customer is either a business or an individual');
    }
    cols.account_type = input.accountType;
  }
  if (has('name') && input.name != null) {
    if (!input.name.trim()) throw new RuleViolation('a customer needs a name');
    cols.name = input.name.trim();
  }
  if (has('phone') && input.phone != null) cols.phone = input.phone.trim();
  // An email address is always trimmed (invariant 15).
  if (has('email') && input.email != null) cols.email = input.email.trim();
  if (has('ccEmails')) {
    const list = splitAddresses(input.ccEmails);
    const bad = list.find((a) => !looksLikeEmail(a));
    if (bad) throw new RuleViolation(`"${bad}" is not an email address (copy addresses)`);
    cols.cc_emails = list.length ? list.join(', ') : null;
  }
  if (has('contactPerson')) cols.contact_person = text(input.contactPerson);
  if (has('brandId')) cols.brand_id = input.brandId ?? null;
  if (has('paymentTerms')) cols.payment_terms = text(input.paymentTerms);
  if (has('priceTierId')) cols.price_tier_id = input.priceTierId || null;
  if (has('deliveryZone')) cols.delivery_zone = text(input.deliveryZone);
  if (has('routeSequence')) cols.route_sequence = Number(input.routeSequence) || 0;
  if (has('userId')) cols.user_id = input.userId ?? null;
  if (has('notes')) cols.notes = text(input.notes);
  if (has('gctExempt')) cols.gct_exempt = !!input.gctExempt;
  if (has('gctExemptRef')) cols.gct_exempt_ref = text(input.gctExemptRef);
  if (has('autoStatements')) cols.auto_statements = input.autoStatements !== false;
  if (has('autoReminders')) cols.auto_reminders = input.autoReminders !== false;
  if (has('deliveryInstructions')) cols.delivery_instructions = text(input.deliveryInstructions);
  if (has('whatsapp')) cols.whatsapp = text(input.whatsapp);
  if (has('marketingOptOut')) cols.marketing_opt_out = !!input.marketingOptOut;
  if (has('orderEmails')) cols.order_emails = input.orderEmails !== false;
  if (has('cancelEmails')) cols.cancel_emails = input.cancelEmails !== false;
  if (has('serviceEmails')) cols.service_emails = input.serviceEmails !== false;
  if (has('isWalkIn')) cols.is_walk_in = !!input.isWalkIn;
  if (has('invoiceCycle') && input.invoiceCycle) {
    if (!['PerDelivery', 'Weekly', 'Monthly'].includes(input.invoiceCycle)) {
      throw new RuleViolation('invoice cycle must be per delivery, weekly or monthly');
    }
    cols.invoice_cycle = input.invoiceCycle;
  }

  // Several days a week; the first also fills the old single-day column.
  if (has('deliveryDays')) {
    const days = cleanDays(input.deliveryDays);
    cols.delivery_days = days;
    cols.default_delivery_day = days[0] ?? null;
  } else if (has('defaultDeliveryDay')) {
    const d = input.defaultDeliveryDay && WEEK.includes(input.defaultDeliveryDay)
      ? input.defaultDeliveryDay : null;
    cols.default_delivery_day = d;
    cols.delivery_days = d ? [d] : [];
  }

  // The parts win when any is sent, and the one-line address is composed
  // from them so the stop and the PDF keep reading one string.
  const partKeys: Array<keyof CustomerInput> = ['addressLine1', 'addressLine2', 'city', 'parish'];
  if (partKeys.some(has)) {
    cols.address_line1 = text(input.addressLine1);
    cols.address_line2 = text(input.addressLine2);
    cols.city = text(input.city);
    cols.parish = text(input.parish);
    cols.delivery_address = composeAddress(input);
  } else if (has('deliveryAddress')) {
    cols.delivery_address = text(input.deliveryAddress);
  }
  return cols;
}

export async function createCustomer(
  db: Db,
  actor: Actor,
  input: CustomerInput,
): Promise<{ id: string; warnings: string[] }> {
  requireRole(actor, 'admin', 'user');
  if (!input.name?.trim()) throw new RuleViolation('a customer needs a name');
  if (!input.phone?.trim()) throw new RuleViolation('a customer needs a phone number');
  // A walk-in put on file at the counter for a receipt (New order, 11 Oct
  // 2026) may have no email address; every other customer needs one.
  if (!input.email?.trim() && !input.isWalkIn) throw new RuleViolation('a customer needs an email address');
  if (input.deliveryZone) await assertZoneNotRetired(db, input.deliveryZone.trim());

  const cols = customerColumns(input);
  // A customer typed in at the counter with only the three essentials still
  // gets a legacy single-line address if one was given that way.
  const names = Object.keys(cols);
  const values = Object.values(cols);

  return db.tx(async (t) => {
    const row = await t.one<{ id: string }>(
      `INSERT INTO customers (${names.join(', ')})
       VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})
       RETURNING id`,
      values,
    );
    // A walk-in put on file pays what every walk-in pays: the shared Cash
    // Walk-In record's price list (Everton, 19 Nov 2026 - walk-ins stay on the
    // held Retail prices with the rest until changed). Without this they had
    // no list, which is the J$600 list price.
    if (input.isWalkIn && !cols.price_tier_id) {
      await t.query(
        `UPDATE customers SET price_tier_id = (
           SELECT price_tier_id FROM customers
           WHERE is_walk_in AND active AND id <> $1 AND price_tier_id IS NOT NULL
           ORDER BY (lower(name) = 'cash walk-in') DESC, created_at LIMIT 1)
         WHERE id = $1`, [row.id]);
    }
    await audit(t, actor, 'create', 'Customer', row.id, String(cols.name), {});

    const warnings: string[] = [];
    if (!cols.delivery_zone) {
      warnings.push('No delivery zone set - delivery orders for this customer cannot be auto-routed.');
    }
    return { id: row.id, warnings };
  });
}

export async function updateCustomer(
  db: Db,
  actor: Actor,
  customerId: string,
  input: CustomerInput,
): Promise<{ warnings: string[] }> {
  requireRole(actor, 'admin', 'user');

  return db.tx(async (t) => {
    const before = await t.maybeOne<{ name: string; active: boolean; delivery_zone: string | null }>(
      `SELECT name, active, delivery_zone FROM customers WHERE id = $1`, [customerId],
    );
    if (!before) throw new RuleViolation('customer not found');
    if (!before.active) {
      throw new RuleViolation('this customer was merged away and can no longer be edited');
    }

    const cols = customerColumns(input);
    // A new zone must be a real, live one; keeping an old spelling is allowed.
    const zone = cols.delivery_zone as string | null | undefined;
    if (zone && zone !== before.delivery_zone) await assertZoneNotRetired(t, zone);

    const names = Object.keys(cols);
    if (names.length > 0) {
      await t.query(
        `UPDATE customers
         SET ${names.map((n, i) => `${n} = $${i + 2}`).join(', ')}, updated_at = now()
         WHERE id = $1`,
        [customerId, ...Object.values(cols)],
      );
    }

    await audit(t, actor, 'update', 'Customer', customerId,
      (cols.name as string) ?? before.name, input as Record<string, unknown>);

    const after = await t.one<{ delivery_zone: string | null }>(
      `SELECT delivery_zone FROM customers WHERE id = $1`, [customerId],
    );
    const warnings: string[] = [];
    if (!after.delivery_zone) {
      warnings.push('No delivery zone set - delivery orders cannot be auto-routed.');
    }
    return { warnings };
  });
}

/* ---------------------------------------------------------------- *
 * Extra addresses (Everton, 30 Sep 2026: "Both kinds").             *
 * ---------------------------------------------------------------- */

export interface AddressInput {
  label?: string;
  addressLine1?: string | null; addressLine2?: string | null;
  city?: string | null; parish?: string | null;
  isBilling?: boolean; isDelivery?: boolean;
  deliveryZone?: string | null; routeSequence?: number;
  contactPerson?: string | null; phone?: string | null;
  deliveryInstructions?: string | null;
}

export async function listAddresses(db: Db | Queryable, customerId: string) {
  return db.query(
    `SELECT * FROM customer_addresses WHERE customer_id = $1 AND active
     ORDER BY is_billing DESC, label`, [customerId],
  );
}

export async function saveAddress(
  db: Db, actor: Actor, customerId: string, addressId: string | null, input: AddressInput,
): Promise<{ id: string }> {
  requireRole(actor, 'admin', 'user');
  const label = input.label?.trim();
  if (!label) throw new RuleViolation('give the address a name, e.g. "Head office" or "Warehouse"');
  if (!input.addressLine1?.trim()) throw new RuleViolation('the address needs at least its first line');
  const isDelivery = input.isDelivery !== false;
  const isBilling = !!input.isBilling;
  if (!isDelivery && !isBilling) {
    throw new RuleViolation('an address is for billing, for delivery, or both');
  }
  const zone = input.deliveryZone?.trim() || null;
  if (zone && isDelivery) await assertZoneUsable(db, zone);

  return db.tx(async (t) => {
    // Only one billing address: marking a new one moves the flag.
    if (isBilling) {
      await t.query(
        `UPDATE customer_addresses SET is_billing = false
         WHERE customer_id = $1 AND ($2::uuid IS NULL OR id <> $2::uuid)`,
        [customerId, addressId],
      );
    }
    const vals = [
      label, input.addressLine1?.trim() || null, input.addressLine2?.trim() || null,
      input.city?.trim() || null, input.parish?.trim() || null, isBilling, isDelivery,
      isDelivery ? zone : null, Number(input.routeSequence) || 0,
      input.contactPerson?.trim() || null, input.phone?.trim() || null,
      input.deliveryInstructions?.trim() || null,
    ];
    let id = addressId;
    if (id) {
      await t.query(
        `UPDATE customer_addresses SET label = $3, address_line1 = $4, address_line2 = $5,
           city = $6, parish = $7, is_billing = $8, is_delivery = $9, delivery_zone = $10,
           route_sequence = $11, contact_person = $12, phone = $13, delivery_instructions = $14
         WHERE id = $1 AND customer_id = $2`,
        [id, customerId, ...vals],
      );
    } else {
      const row = await t.one<{ id: string }>(
        `INSERT INTO customer_addresses
           (customer_id, label, address_line1, address_line2, city, parish, is_billing,
            is_delivery, delivery_zone, route_sequence, contact_person, phone, delivery_instructions)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [customerId, ...vals],
      );
      id = row.id;
    }
    await audit(t, actor, addressId ? 'update' : 'create', 'CustomerAddress', id, label,
      input as Record<string, unknown>);
    return { id: id! };
  });
}

/** Removed from use; orders that went there keep pointing at it. */
export async function removeAddress(
  db: Db, actor: Actor, customerId: string, addressId: string,
): Promise<void> {
  requireRole(actor, 'admin', 'user');
  await db.tx(async (t) => {
    await t.query(
      `UPDATE customer_addresses SET active = false, is_billing = false
       WHERE id = $1 AND customer_id = $2`, [addressId, customerId],
    );
    await audit(t, actor, 'delete', 'CustomerAddress', addressId, addressId, {});
  });
}

/**
 * The address invoices and statements are sent to: the one marked billing,
 * otherwise the main address.
 */
export async function billingAddress(
  t: Queryable, customerId: string,
): Promise<{ label: string | null; line: string | null; contact: string | null }> {
  const b = await t.maybeOne<{
    label: string; address_line1: string | null; address_line2: string | null;
    city: string | null; parish: string | null; contact_person: string | null;
  }>(
    `SELECT label, address_line1, address_line2, city, parish, contact_person
     FROM customer_addresses WHERE customer_id = $1 AND active AND is_billing LIMIT 1`,
    [customerId],
  );
  if (b) {
    return {
      label: b.label,
      line: composeAddress({ addressLine1: b.address_line1, addressLine2: b.address_line2,
        city: b.city, parish: b.parish }),
      contact: b.contact_person,
    };
  }
  const c = await t.one<{ delivery_address: string | null }>(
    `SELECT delivery_address FROM customers WHERE id = $1`, [customerId],
  );
  return { label: null, line: c.delivery_address, contact: null };
}

/* ---------------------------------------------------------------- *
 * Special prices (Everton, 30 Sep 2026): a customer's own price for  *
 * chosen products, over whatever price list they are on.            *
 * ---------------------------------------------------------------- */

export async function listSpecialPrices(db: Db, customerId: string) {
  return db.query(
    `SELECT cp.product_id, cp.price_per_case_cents, cp.price_per_bottle_cents,
            cp.updated_at, p.name, p.bottles_per_case,
            COALESCE(pl.price_per_case_cents, p.price_per_case_cents) AS usual_case_cents,
            COALESCE(pl.price_per_bottle_cents, p.price_per_bottle_cents) AS usual_bottle_cents
     FROM customer_prices cp
     JOIN products p ON p.id = cp.product_id
     JOIN customers c ON c.id = cp.customer_id
     LEFT JOIN price_lists pl ON pl.product_id = p.id AND pl.price_tier_id = c.price_tier_id
     WHERE cp.customer_id = $1
     ORDER BY p.name`, [customerId],
  );
}

/** Set (priceCents > = 0) or clear (null) one product's special price. */
export async function setSpecialPrice(
  db: Db, actor: Actor, customerId: string, productId: string, priceCents: number | null,
): Promise<void> {
  requireRole(actor, 'admin', 'user');
  await db.tx(async (t) => {
    const p = await t.one<{ bottles_per_case: number; name: string }>(
      `SELECT bottles_per_case, name FROM products WHERE id = $1`, [productId],
    );
    if (priceCents === null) {
      await t.query(`DELETE FROM customer_prices WHERE customer_id = $1 AND product_id = $2`,
        [customerId, productId]);
    } else {
      if (!Number.isSafeInteger(priceCents) || priceCents < 0) {
        throw new RuleViolation('a price must be zero or more');
      }
      const cased = num(p.bottles_per_case) > 0;
      // Below their normal price is a standing discount, and discounts need
      // an administrator (Everton, 19 Nov 2026).
      if (actor.role !== 'admin') {
        const usual = await t.one<{ c: number; b: number; who: string }>(
          `SELECT COALESCE(pl.price_per_case_cents, pr.price_per_case_cents) AS c,
                  COALESCE(pl.price_per_bottle_cents, pr.price_per_bottle_cents) AS b, c.name AS who
           FROM customers c JOIN products pr ON pr.id = $2
           LEFT JOIN price_lists pl ON pl.price_tier_id = c.price_tier_id AND pl.product_id = pr.id
           WHERE c.id = $1`, [customerId, productId]);
        const normal = num(cased ? usual.c : usual.b);
        if (priceCents < normal) {
          throw new RuleViolation(`${p.name} is ${(normal / 100).toFixed(2)} for ${usual.who} on their price list. `
            + 'Only an administrator can set a special price below that.');
        }
      }
      await t.query(
        `INSERT INTO customer_prices (customer_id, product_id, price_per_case_cents, price_per_bottle_cents)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (customer_id, product_id) DO UPDATE
           SET price_per_case_cents = EXCLUDED.price_per_case_cents,
               price_per_bottle_cents = EXCLUDED.price_per_bottle_cents, updated_at = now()`,
        [customerId, productId, cased ? priceCents : 0, cased ? 0 : priceCents],
      );
    }
    await audit(t, actor, 'update', 'Customer', customerId, p.name,
      { specialPrice: { productId, priceCents } });
  });
}

/**
 * What THIS customer pays for each product: special price, else their list,
 * else the product's own price. The one query order entry, the portal and
 * quotes all read, so the screen always matches what gets saved.
 */
export async function customerPrices(db: Db | Queryable, customerId: string) {
  return db.query(
    `SELECT p.id AS product_id, p.name, p.size, p.bottles_per_case, p.is_returnable, p.is_bottle_charge,
            p.is_charge, p.charge_unit,
            COALESCE(cp.price_per_case_cents, pl.price_per_case_cents, p.price_per_case_cents)
              AS price_per_case_cents,
            COALESCE(cp.price_per_bottle_cents, pl.price_per_bottle_cents, p.price_per_bottle_cents)
              AS price_per_bottle_cents,
            pt.name AS price_tier,
            (cp.id IS NOT NULL) AS special_price
     FROM products p
     LEFT JOIN customers c ON c.id = $1
     LEFT JOIN price_tiers pt ON pt.id = c.price_tier_id
     LEFT JOIN price_lists pl ON pl.product_id = p.id AND pl.price_tier_id = c.price_tier_id
     LEFT JOIN customer_prices cp ON cp.product_id = p.id AND cp.customer_id = c.id
     WHERE p.active AND ${productAvailableSql('p', '$1')}
     ORDER BY p.name`,
    [customerId],
  );
}

export async function getCustomer(db: Db, customerId: string) {
  return db.maybeOne(
    `SELECT c.*, pt.name AS price_tier
     FROM customers c LEFT JOIN price_tiers pt ON pt.id = c.price_tier_id
     WHERE c.id = $1`, [customerId],
  );
}

/** Only active customers may be selected for new orders. */
export async function listSelectableCustomers(db: Db) {
  return db.query(
    `SELECT c.id, c.name, c.phone, c.email, c.delivery_zone, c.route_sequence, c.is_walk_in,
            c.delivery_address, pt.name AS price_tier,
            b.balance_cents, c.account_type, c.delivery_days, c.invoice_cycle,
            c.gct_exempt, c.payment_terms, z.run_days AS zone_run_days
     FROM customers c
     LEFT JOIN price_tiers pt ON pt.id = c.price_tier_id
     LEFT JOIN customer_balances b ON b.customer_id = c.id
     LEFT JOIN delivery_zones z ON z.name = c.delivery_zone
     WHERE c.active
     ORDER BY c.name`,
  );
}

/**
 * Everything about one customer on a single screen: who they are, what they
 * owe, what they have ordered, what has been invoiced, what they have paid,
 * and how many of your bottles they are holding.
 *
 * One call rather than six. The alternative is a screen that draws itself in
 * pieces, and a customer record is read while somebody is on the phone.
 */
export async function customerHistory(db: Db, customerId: string) {
  const customer = await db.one<Record<string, unknown>>(
    `SELECT c.*, t.name AS price_tier_name, u.email AS portal_email
     FROM customers c
     LEFT JOIN price_tiers t ON t.id = c.price_tier_id
     LEFT JOIN users u ON u.id = c.user_id
     WHERE c.id = $1`,
    [customerId],
  );

  const orders = await db.query(
    `SELECT id, order_number, order_date::text AS order_date,
            requested_delivery_date::text AS requested_delivery_date,
            fulfilled_on::text AS fulfilled_on, customer_po, needs_review,
            status, delivery_mode, source, grand_total_cents::text AS grand_total_cents,
            (SELECT string_agg(CASE WHEN oli.cases > 0 THEN oli.cases || ' cs ' ELSE oli.loose_bottles || ' x ' END
                               || p.name, ', ' ORDER BY p.name)
               FROM order_line_items oli JOIN products p ON p.id = oli.product_id
              WHERE oli.order_id = o.id) AS lines_summary,
            ${ORDER_EVENTS} AS events,
            -- On a round the driver has started, i.e. out for delivery (15 Oct 2026).
            EXISTS (SELECT 1 FROM delivery_stops s JOIN delivery_sheets d ON d.id = s.delivery_sheet_id
                     WHERE s.order_id = o.id AND d.status = 'Open' AND d.started_at IS NOT NULL
                       AND s.stop_outcome = 'Pending') AS sheet_started,
            o.ready_at,
            (SELECT max(rl.loaded_at) FROM delivery_stops s JOIN round_loads rl ON rl.delivery_sheet_id = s.delivery_sheet_id
               JOIN delivery_sheets d ON d.id = s.delivery_sheet_id
              WHERE s.order_id = o.id AND d.status = 'Open' AND s.stop_outcome = 'Pending') AS load_logged_at
     FROM customer_orders o WHERE customer_id = $1
     ORDER BY order_date DESC, order_number DESC LIMIT 60`,
    [customerId],
  );

  const invoices = await db.query(
    `SELECT invoice_id, invoice_number,
            invoice_date::text AS invoice_date,
            due_date::text AS due_date, status,
            grand_total_cents::text AS grand_total_cents,
            balance_cents::text AS balance_cents, is_credit_note
     FROM invoice_ledger WHERE customer_id = $1
     ORDER BY invoice_date DESC, invoice_number DESC LIMIT 25`,
    [customerId],
  );

  const payments = await db.query(
    `SELECT p.id, business_date(p.payment_date)::text AS payment_date,
            p.amount_cents::text AS amount_cents, p.method, p.reference,
            p.is_reversal, p.status, i.invoice_number, p.invoice_id,
            EXISTS (SELECT 1 FROM payments r WHERE r.reverses_payment_id = p.id) AS reversed
     FROM payments p
     LEFT JOIN invoices i ON i.id = p.invoice_id
     WHERE p.customer_id = $1 AND p.status = 'Confirmed'
     ORDER BY p.payment_date DESC LIMIT 25`,
    [customerId],
  );

  /*
   * From customer_balances - everything invoiced less every confirmed payment
   * - and NOT from summing invoice_ledger.
   *
   * A payment left on the account belongs to no invoice, so it never appears
   * in the invoice ledger. Summing that ledger said a customer who had paid
   * $275 over owed exactly zero, while her statement said she was $275 in
   * credit. Two screens disagreeing about one customer's position is worse
   * than either of them being slightly wrong.
   */
  const balance = await db.one<{ balance_cents: string }>(
    `SELECT COALESCE(balance_cents, 0)::text AS balance_cents
     FROM customer_balances WHERE customer_id = $1`,
    [customerId],
  );

  const position = await accountPosition(db, customerId);
  // Paid with orders still to be delivered: kept for those orders' invoices,
  // so not credit to spend on anything else (New order, 11 Oct 2026).
  const kept = await db.one<{ c: string }>(
    `SELECT COALESCE(SUM(p.amount_cents), 0)::text AS c FROM payments p
     JOIN customer_orders o ON o.id = p.order_id
     WHERE p.customer_id = $1 AND p.invoice_id IS NULL AND p.status = 'Confirmed'
       AND NOT p.is_reversal AND o.status NOT IN ('Delivered', 'Cancelled')
       AND NOT EXISTS (SELECT 1 FROM payments r WHERE r.reverses_payment_id = p.id)`, [customerId],
  );
  return {
    customer, orders, invoices, payments, balanceCents: num(balance.balance_cents),
    keptForOrdersCents: num(kept.c),
    overdueCents: position.overdueCents, overdueInvoices: position.overdueInvoices,
  };
}

/**
 * What a customer owes and how much of it is late (team feedback, point 5):
 * shown on the portal home and the office customer record alike. Overdue is
 * whatever is still owed on invoices past their due date.
 */
export async function accountPosition(db: Db | Queryable, customerId: string): Promise<{
  balanceCents: number; overdueCents: number; overdueInvoices: number;
  nextDueDate: string | null; nextDueCents: number;
}> {
  const b = await db.maybeOne<{ balance_cents: string }>(
    `SELECT COALESCE(balance_cents, 0)::text AS balance_cents
     FROM customer_balances WHERE customer_id = $1`, [customerId],
  );
  const o = await db.one<{ cents: string; n: number }>(
    `SELECT COALESCE(SUM(balance_cents), 0)::text AS cents, COUNT(*)::int AS n
     FROM invoice_ledger
     WHERE customer_id = $1 AND NOT is_credit_note AND status <> 'Cancelled'
       AND balance_cents > 0 AND due_date IS NOT NULL AND due_date < business_today()`,
    [customerId],
  );
  const next = await db.maybeOne<{ due: string; cents: string }>(
    `SELECT due_date::text AS due, SUM(balance_cents)::text AS cents
     FROM invoice_ledger
     WHERE customer_id = $1 AND NOT is_credit_note AND status <> 'Cancelled'
       AND balance_cents > 0 AND due_date >= business_today()
     GROUP BY due_date ORDER BY due_date LIMIT 1`,
    [customerId],
  );
  return {
    balanceCents: num(b?.balance_cents),
    overdueCents: num(o.cents), overdueInvoices: num(o.n),
    nextDueDate: next?.due ?? null, nextDueCents: num(next?.cents),
  };
}
