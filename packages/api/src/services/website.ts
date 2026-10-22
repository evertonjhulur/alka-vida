/**
 * The public website at alkavidaja.com (Everton, 21 Oct 2026).
 *
 * Two things live here:
 *
 *  1. What the public pages show that comes from the system, so it is never
 *     typed twice: the products on sale and their listed prices, the delivery
 *     zones and their days, and the business phone/WhatsApp number. Change a
 *     price under Products & pricing and the website shows it on the next
 *     page load.
 *
 *     The price shown is each product's OWN list price - the one a walk-in
 *     and any customer without a price tier pays. Tier prices (Corporate,
 *     Distributor...) are never shown publicly; customers see their own
 *     prices once signed in.
 *
 *  2. Website orders: an order from somebody with no account ("quick order,
 *     then account"). It waits under Needs a decision. Booking it creates or
 *     picks the customer and makes a real order in one step; if they asked
 *     for an account, it also makes their login and emails the link.
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, contactEmail, getSetting, nextNumber, requireRole } from './core.ts';
import { ownProductSql } from './brands.ts';
import { createInvitation, UNUSABLE_PASSWORD } from './invitations.ts';
import { emailAccountApproved, PARISHES } from './registration.ts';
import { assertZoneUsable } from './zones.ts';
import { createOrder } from './orders.ts';
import { composeAddress, RuleViolation } from '@alka/shared';

/** The number on the website until one is set in Settings › Emails & ordering. */
export const DEFAULT_PHONE = '876-528-6112';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MAX = { name: 120, email: 254, phone: 30, line: 160, town: 80, notes: 500 } as const;
const MAX_LINES = 12;
const MAX_QTY = 500;

function clean(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
}

/* ------------------------------------------------------------------ */
/* What the public pages show                                          */
/* ------------------------------------------------------------------ */

export interface SiteProduct {
  id: string;
  name: string;
  size: string | null;
  /** 0 = sold by the bottle (the 5 gallon). */
  bottlesPerCase: number;
  /** Per case when cased, per bottle when not. 0 = not priced yet. */
  priceCents: number;
  unit: 'case' | 'bottle';
  returnable: boolean;
}

export interface SiteInfo {
  products: SiteProduct[];
  zones: Array<{ name: string; covers: string | null; days: string[] }>;
  phone: string;
  whatsapp: string;
  email: string;
}

/** Smallest bottle first; the 5 gallon last. */
function sizeRank(size: string | null): number {
  const s = (size ?? '').toLowerCase().replace(/\s+/g, '');
  const gal = s.match(/^([\d.]+)gal/);
  if (gal) return Number(gal[1]) * 3785;
  const l = s.match(/^([\d.]+)l$/);
  if (l) return Number(l[1]) * 1000;
  const ml = s.match(/^([\d.]+)ml$/);
  if (ml) return Number(ml[1]);
  return 1e9;
}

export async function siteInfo(db: Queryable): Promise<SiteInfo> {
  // Alka Vida's own products only: never a brand bottled for a customer,
  // never the bottle charge (it is explained in words), never retired ones.
  const rows = await db.query<{
    id: string; name: string; size: string | null; bottles_per_case: number;
    price_per_case_cents: string; price_per_bottle_cents: string; is_returnable: boolean;
  }>(
    `SELECT p.id, p.name, p.size, p.bottles_per_case, p.price_per_case_cents::text,
            p.price_per_bottle_cents::text, p.is_returnable
     FROM products p
     WHERE p.active AND NOT p.is_bottle_charge AND ${ownProductSql('p')}`,
  );
  const products: SiteProduct[] = rows.map((r) => {
    const cased = Number(r.bottles_per_case) > 0;
    return {
      id: r.id, name: r.name, size: r.size,
      bottlesPerCase: Number(r.bottles_per_case),
      priceCents: Number(cased ? r.price_per_case_cents : r.price_per_bottle_cents),
      unit: cased ? 'case' : 'bottle',
      returnable: r.is_returnable,
    };
  }).sort((a, b) => sizeRank(a.size) - sizeRank(b.size) || a.name.localeCompare(b.name));

  const zones = (await db.query<{ name: string; covers: string | null; run_days: string[] | null }>(
    `SELECT name, covers, run_days FROM delivery_zones
     WHERE retired_at IS NULL ORDER BY sort_order, name`,
  )).map((z) => ({ name: z.name, covers: z.covers, days: z.run_days ?? [] }));

  const whatsapp = (await getSetting(db, 'whatsapp_number', '')).trim();
  const phone = (await getSetting(db, 'business_phone', '')).trim() || DEFAULT_PHONE;
  return {
    products, zones, phone,
    whatsapp: whatsapp || phone,
    email: await contactEmail(db),
  };
}

/* ------------------------------------------------------------------ */
/* Website orders                                                      */
/* ------------------------------------------------------------------ */

export interface WebsiteOrderInput {
  firstName?: string; lastName?: string; businessName?: string | null;
  phone?: string; email?: string | null;
  fulfilment?: 'Deliver' | 'Collect';
  addressLine1?: string | null; addressLine2?: string | null;
  city?: string | null; parish?: string | null;
  preferredDay?: string | null;
  payMethod?: 'Cash' | 'Bank Transfer';
  lines?: Array<{ productId: string; qty: number }>;
  noEmpties?: boolean;
  wantsAccount?: boolean;
  notes?: string | null;
  /** A field people never see; a robot filling every box fills this too. */
  website?: string;
}

export async function submitWebsiteOrder(
  db: Db, input: WebsiteOrderInput,
): Promise<{ reference: string; name: string }> {
  if (clean(input.website)) {
    // Looks accepted, stores nothing.
    return { reference: 'WEB-000000', name: 'there' };
  }

  const firstName = clean(input.firstName);
  const lastName = clean(input.lastName);
  const businessName = clean(input.businessName);
  const phone = clean(input.phone);
  const email = clean(input.email);
  const notes = clean(input.notes);
  if (!firstName) throw new RuleViolation('your first name is needed');
  if (!lastName) throw new RuleViolation('your last name is needed');
  if (!phone) throw new RuleViolation('a phone number is needed, so we can confirm your order');
  if (email && !email.includes('@')) throw new RuleViolation('that email address does not look right');
  const wantsAccount = input.wantsAccount === true;
  if (wantsAccount && !email) {
    throw new RuleViolation('an email address is needed to open an account (or untick "Open an account")');
  }

  const fulfilment = input.fulfilment === 'Collect' ? 'Collect' : 'Deliver';
  const address = {
    addressLine1: clean(input.addressLine1), addressLine2: clean(input.addressLine2),
    city: clean(input.city), parish: clean(input.parish),
  };
  if (fulfilment === 'Deliver') {
    if (!address.addressLine1) throw new RuleViolation('the street address for delivery is needed');
    if (!address.city) throw new RuleViolation('the town for delivery is needed');
    if (!address.parish) throw new RuleViolation('choose the parish for delivery');
  }
  if (address.parish && !PARISHES.includes(address.parish)) throw new RuleViolation('choose the parish from the list');
  const day = clean(input.preferredDay);
  if (day && !(WEEKDAYS as readonly string[]).includes(day)) throw new RuleViolation('choose a delivery day from the list');
  const payMethod = input.payMethod === 'Bank Transfer' ? 'Bank Transfer' : 'Cash';

  const tooLong = ([
    ['first name', firstName, MAX.name], ['last name', lastName, MAX.name],
    ['business name', businessName, MAX.name], ['email address', email, MAX.email],
    ['phone number', phone, MAX.phone], ['street address', address.addressLine1, MAX.line],
    ['building or landmark', address.addressLine2, MAX.line], ['town', address.city, MAX.town],
    ['note', notes, MAX.notes],
  ] as Array<[string, string | null, number]>).find(([, v, max]) => (v ?? '').length > max);
  if (tooLong) throw new RuleViolation(`the ${tooLong[0]} is too long (${tooLong[2]} characters at most)`);

  // The lines: our own, active products only, at the price the site showed.
  const asked = Array.isArray(input.lines) ? input.lines : [];
  const wanted = asked
    .map((l) => ({ productId: String(l?.productId ?? ''), qty: Math.round(Number(l?.qty) || 0) }))
    .filter((l) => l.productId && l.qty > 0);
  if (wanted.length === 0) throw new RuleViolation('choose at least one item');
  if (wanted.length > MAX_LINES) throw new RuleViolation(`${MAX_LINES} items at most - call us for a bigger order`);
  if (wanted.some((l) => l.qty > MAX_QTY)) throw new RuleViolation(`${MAX_QTY} at most of any one item - call us for a bigger order`);

  const site = await siteInfo(db);
  const byId = new Map(site.products.map((p) => [p.id, p]));
  const lines = wanted.map((l) => {
    const p = byId.get(l.productId);
    if (!p) throw new RuleViolation('one of the items is no longer on sale - refresh the page and try again');
    return { productId: p.id, name: p.name, size: p.size, qty: l.qty, unit: p.unit, priceCents: p.priceCents };
  });

  const row = await db.tx(async (t) => {
    const reference = await nextNumber(t, 'website_order_seq', 'WEB');
    await t.query(
      `INSERT INTO website_orders
         (reference, first_name, last_name, business_name, phone, email, fulfilment,
          address_line1, address_line2, city, parish, preferred_day, pay_method,
          lines, no_empties, wants_account, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17)`,
      [reference, firstName, lastName, businessName, phone, email, fulfilment,
       address.addressLine1, address.addressLine2, address.city, address.parish, day, payMethod,
       JSON.stringify(lines), input.noEmpties === true, wantsAccount, notes],
    );
    return { reference };
  });
  return { reference: row.reference, name: firstName };
}

export async function listWebsiteOrders(db: Db, actor: Actor, status?: string) {
  requireRole(actor, 'admin', 'user');
  return db.query(
    `SELECT w.*, c.name AS customer_name, o.order_number, u.name AS decided_by_name,
            (SELECT json_agg(json_build_object('id', m.id, 'name', m.name, 'phone', m.phone, 'email', m.email))
             FROM (SELECT id, name, phone, email FROM customers x
                   WHERE x.active AND NOT x.is_walk_in AND (
                     (w.email IS NOT NULL AND lower(x.email) = lower(w.email))
                     OR (length(regexp_replace(w.phone, '\\D', '', 'g')) >= 7
                         AND regexp_replace(x.phone, '\\D', '', 'g') LIKE '%' || right(regexp_replace(w.phone, '\\D', '', 'g'), 7))
                   ) LIMIT 3) m) AS possible_matches
     FROM website_orders w
     LEFT JOIN customers c ON c.id = w.customer_id
     LEFT JOIN customer_orders o ON o.id = w.order_id
     LEFT JOIN users u ON u.id = w.decided_by
     WHERE ($1::text IS NULL OR w.status = $1)
     ORDER BY w.status = 'Pending' DESC, w.created_at DESC
     LIMIT 200`,
    [status ?? null],
  );
}

export interface BookTerms {
  /** Book it for a customer already on file instead of making a new one. */
  existingCustomerId?: string | null;
  priceTierId?: string | null;
  deliveryZone?: string | null;
  /** YYYY-MM-DD. */
  deliveryDate?: string | null;
}

/**
 * Turn a website order into a real order. A new customer is made from what
 * they typed (unless an existing one is chosen); if they asked for an
 * account and gave an email, a login is made and the set-password link
 * emailed, exactly as for an approved account request.
 */
export async function bookWebsiteOrder(
  db: Db, actor: Actor, id: string, terms: BookTerms = {},
): Promise<{ customerId: string; orderId: string; orderNumber: string; invitation: { link: string } | null; emailed: boolean }> {
  // Like approving an account request: it can make a customer and a login.
  requireRole(actor, 'admin');
  const w = await db.maybeOne<{
    status: string; reference: string; first_name: string; last_name: string; business_name: string | null;
    phone: string; email: string | null; fulfilment: string; address_line1: string | null;
    address_line2: string | null; city: string | null; parish: string | null; pay_method: string;
    lines: Array<{ productId: string; qty: number; unit: string }>; no_empties: boolean;
    wants_account: boolean; notes: string | null;
  }>(`SELECT * FROM website_orders WHERE id = $1`, [id]);
  if (!w) throw new RuleViolation('website order not found');
  if (w.status !== 'Pending') throw new RuleViolation(`this website order has already been ${w.status.toLowerCase()}`);

  const zone = clean(terms.deliveryZone);
  if (zone) await assertZoneUsable(db, zone);
  const date = clean(terms.deliveryDate);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RuleViolation('choose a date for the order');

  const person = `${w.first_name} ${w.last_name}`;
  const name = w.business_name ?? person;
  let customerId = clean(terms.existingCustomerId);
  let userId: string | null = null;
  const makeLogin = !customerId && w.wants_account && !!w.email;

  if (customerId) {
    const c = await db.maybeOne<{ active: boolean }>(`SELECT active FROM customers WHERE id = $1`, [customerId]);
    if (!c || !c.active) throw new RuleViolation('that customer is not on file any more');
  } else {
    if (makeLogin) {
      const taken = await db.query(`SELECT 1 FROM users WHERE lower(email) = lower($1)`, [w.email]);
      if (taken.length) {
        throw new RuleViolation(`${w.email} already has a login - choose that customer under "Book for" instead`);
      }
    }
    const made = await db.tx(async (t) => {
      const address = { addressLine1: w.address_line1, addressLine2: w.address_line2, city: w.city, parish: w.parish };
      const c = await t.one<{ id: string }>(
        `INSERT INTO customers
           (name, phone, email, delivery_address, address_line1, address_line2, city, parish,
            contact_person, account_type, price_tier_id, delivery_zone, payment_terms, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'Cash on delivery',$13)
         RETURNING id`,
        [name, w.phone, w.email ?? '', composeAddress(address), w.address_line1, w.address_line2,
         w.city, w.parish, w.business_name ? person : null, w.business_name ? 'Corporate' : 'Individual',
         terms.priceTierId ?? null, zone, `Came from the website (${w.reference}).`],
      );
      let uid: string | null = null;
      if (makeLogin) {
        uid = (await t.one<{ id: string }>(
          `INSERT INTO users (email, name, password_hash, role) VALUES ($1,$2,$3,'customer') RETURNING id`,
          [w.email, name, UNUSABLE_PASSWORD],
        )).id;
        await t.query(`UPDATE customers SET user_id = $2 WHERE id = $1`, [c.id, uid]);
      }
      await audit(t, actor, 'create', 'Customer', c.id, name, { fromWebsiteOrder: w.reference });
      return { customerId: c.id, userId: uid };
    });
    customerId = made.customerId;
    userId = made.userId;
  }

  const paying = w.pay_method === 'Bank Transfer' ? 'pay by bank transfer' : 'pay cash';
  const order = await createOrder(db, actor, {
    customerId,
    lines: w.lines.map((l) => (l.unit === 'case'
      ? { productId: l.productId, cases: Number(l.qty) }
      : { productId: l.productId, looseBottles: Number(l.qty) })),
    deliveryMode: w.fulfilment === 'Collect' ? 'Pickup' : 'Delivery',
    requestedDeliveryDate: date,
    source: 'Admin',
    payWhen: 'On delivery',
    emptiesExpected: w.no_empties ? 0 : null,
    notes: [`Website order ${w.reference}: will ${paying}.`, w.notes].filter(Boolean).join(' '),
  });

  await db.query(
    `UPDATE website_orders SET status = 'Booked', decided_at = now(), decided_by = $2,
            customer_id = $3, order_id = $4
     WHERE id = $1`,
    [id, actor.id, customerId, order.id],
  );

  let invitation: { link: string } | null = null;
  let emailed = false;
  if (userId && w.email) {
    const inv = await createInvitation(db, actor, userId);
    invitation = { link: inv.link };
    emailed = (await emailAccountApproved(db, customerId, w.email, name, inv.link)).sent;
  }
  return { customerId, orderId: order.id, orderNumber: order.orderNumber, invitation, emailed };
}

export async function declineWebsiteOrder(db: Db, actor: Actor, id: string, reason?: string | null): Promise<void> {
  requireRole(actor, 'admin');
  const w = await db.maybeOne<{ status: string; reference: string }>(
    `SELECT status, reference FROM website_orders WHERE id = $1`, [id]);
  if (!w) throw new RuleViolation('website order not found');
  if (w.status !== 'Pending') throw new RuleViolation(`this website order has already been ${w.status.toLowerCase()}`);
  await db.tx(async (t) => {
    await t.query(
      `UPDATE website_orders SET status = 'Declined', decided_at = now(), decided_by = $2, decline_reason = $3
       WHERE id = $1`, [id, actor.id, clean(reason)]);
    await audit(t, actor, 'update', 'WebsiteOrder', id, w.reference, { declined: true, reason: clean(reason) });
  });
}
