/**
 * Bringing customers across from QuickBooks (Everton, 16 Oct 2026).
 *
 * "The intention is not to transition detailed order information for
 * customers but more so outstanding balances ... if no balance exist it is
 * safe to assume it is zero." The office uploads the merged file (Customer
 * Upload sheet, and the Open Items sheet when it is the Excel file); the
 * screen sends its rows here twice - first with `dryRun` to show what will
 * happen, row by row, then for real. Nothing is written on a dry run, and the
 * real run is one transaction: every customer goes in, or none do.
 *
 * Per row:
 *   * a customer already in the app under the same name is SKIPPED, never
 *     overwritten, so the upload can safely be run again;
 *   * Customer Type: Individual or Corporate as it says; Distributor is a
 *     business on the "Distributor" price list (their own special prices are
 *     set on the customer afterwards);
 *   * a zone not yet on the zone list is added to it, so check the preview
 *     for misspellings; delivery days are Mon-Sun, several allowed;
 *   * Bottled Brands link the third-party brands bottled for them (a brand
 *     not yet in the app is added as one bottled for a customer), and
 *     "Can Order Alka Vida Products: No" keeps our own products off their
 *     screens (services/brands.ts);
 *   * the opening balance: each open QuickBooks invoice is an opening
 *     invoice carrying its QuickBooks number, date and due date, so ageing,
 *     statements and reminders read true; an unapplied QuickBooks payment is
 *     an unattached payment - credit on the account. With no Open Items for
 *     the customer, or items that do not add up to the balance column, the
 *     balance comes in as one line dated the "as of" date.
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, nextNumber, requireRole } from './core.ts';
import { RuleViolation, PARISHES, composeAddress } from '@alka/shared';
import { insertPayment } from './payments.ts';
import { CO_PACK } from './brands.ts';

export interface ImportOpenItem {
  /** The QuickBooks number (blank for a payment). */
  reference?: string | null;
  /** 'Invoice' or 'Payment' (anything with a negative open balance is a credit). */
  type?: string | null;
  date?: string | null;
  dueDate?: string | null;
  /** The QuickBooks amount, for the note. */
  amountCents?: number | null;
  /** What is still open: positive owed, negative credit. */
  openCents: number;
}

export interface ImportRow {
  name: string;
  customerType?: string | null;
  contactPerson?: string | null;
  phone?: string | null;
  mobile?: string | null;
  email?: string | null;
  billingAddress?: string | null;
  deliveryAddress?: string | null;
  area?: string | null;
  parish?: string | null;
  deliveryZone?: string | null;
  deliveryDays?: string | null;
  openingBalanceCents?: number | null;
  bottledBrands?: string | null;
  canOrderOwnBrand?: string | boolean | null;
  openItems?: ImportOpenItem[] | null;
}

export interface ImportInput {
  rows: ImportRow[];
  /** The date the balances are as of (yyyy-mm-dd). */
  asOf: string;
  /** Turn automatic statements and reminders off for the customers brought in. */
  holdAutoEmails?: boolean;
  dryRun?: boolean;
}

export interface RowResult {
  row: number;
  name: string;
  action: 'create' | 'skip' | 'error';
  accountType: 'Individual' | 'Corporate' | null;
  priceList: string | null;
  zone: string | null;
  days: string[];
  brands: string[];
  buysOwnBrand: boolean;
  balanceCents: number;
  /** How the balance comes in: 'items' (one per open QuickBooks item), 'single', or 'none'. */
  balanceAs: 'items' | 'single' | 'none';
  itemCount: number;
  errors: string[];
  warnings: string[];
}

export interface ImportResult {
  dryRun: boolean;
  rows: RowResult[];
  toCreate: number;
  toSkip: number;
  withErrors: number;
  newZones: string[];
  newBrands: string[];
  totalBalanceCents: number;
  created: number;
}

const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** "Mon, Thu", "Monday and Thursday", "Mon/Thu" -> ['Mon','Thu']. */
export function parseDays(text: string | null | undefined): { days: string[]; bad: string[] } {
  const bad: string[] = [];
  const set = new Set<string>();
  for (const raw of clean(text).split(/[,;/&+]|\band\b|\s+/i)) {
    const tok = raw.trim().toLowerCase().replace(/\.$/, '');
    if (!tok) continue;
    const day = WEEK.find((d) => tok.startsWith(d.toLowerCase()) || (tok === 'thur' && d === 'Thu')
      || (tok === 'tues' && d === 'Tue'));
    if (day) set.add(day); else bad.push(raw.trim());
  }
  return { days: WEEK.filter((d) => set.has(d)), bad };
}

/** 'St. Andrew' / 'st andrew' -> 'St Andrew'; anything else -> null. */
function parishOf(text: string | null | undefined): string | null {
  const k = squash(clean(text));
  if (!k) return null;
  return PARISHES.find((p) => squash(p) === k) ?? null;
}

function yesNo(v: string | boolean | null | undefined): boolean | null {
  if (typeof v === 'boolean') return v;
  const t = clean(v).toLowerCase();
  if (!t) return null;
  if (['yes', 'y', 'true', '1'].includes(t)) return true;
  if (['no', 'n', 'false', '0'].includes(t)) return false;
  return null;
}

function isoDate(v: string | null | undefined): string | null {
  const t = clean(v);
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // QuickBooks: dd/mm/yyyy
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

const money = (c: number) => `J$${(c / 100).toLocaleString('en-JM', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface Plan {
  r: RowResult;
  src: ImportRow;
  phone: string;
  email: string;
  line1: string | null;
  city: string | null;
  parish: string | null;
  billing: string | null;
  tierId: string | null;
  items: ImportOpenItem[];
}

async function plan(t: Queryable, input: ImportInput) {
  const existing = new Set((await t.query<{ name: string }>(
    `SELECT name FROM customers WHERE active`)).map((c) => squash(c.name)));
  const zones = await t.query<{ name: string; retired_at: string | null }>(
    `SELECT name, retired_at FROM delivery_zones`);
  const brands = await t.query<{ name: string; type: string }>(`SELECT name, type FROM brands`);
  const tier = await t.maybeOne<{ id: string; name: string }>(
    `SELECT id, name FROM price_tiers WHERE lower(name) = 'distributor'`);

  const newZones = new Map<string, string>();
  const newBrands = new Map<string, string>();
  const seen = new Set<string>();
  const plans: Plan[] = [];

  input.rows.forEach((src, i) => {
    const name = clean(src.name);
    const r: RowResult = {
      row: i + 2, name, action: 'create', accountType: null, priceList: null, zone: null,
      days: [], brands: [], buysOwnBrand: true, balanceCents: 0, balanceAs: 'none', itemCount: 0,
      errors: [], warnings: [],
    };
    const p: Plan = { r, src, phone: '', email: '', line1: null, city: null, parish: null,
      billing: null, tierId: null, items: [] };
    plans.push(p);

    if (!name) { r.errors.push('no customer name'); r.action = 'error'; return; }
    const key = squash(name);
    if (seen.has(key)) { r.errors.push('this name is in the file twice'); r.action = 'error'; return; }
    seen.add(key);
    if (existing.has(key)) {
      r.action = 'skip';
      r.warnings.push('already in the app - left as it is');
      return;
    }

    // Customer type
    const type = clean(src.customerType).toLowerCase();
    if (type === 'individual') r.accountType = 'Individual';
    else if (type === 'corporate' || type === 'business') r.accountType = 'Corporate';
    else if (type === 'distributor') {
      r.accountType = 'Corporate';
      if (tier) { r.priceList = tier.name; p.tierId = tier.id; }
      else r.warnings.push('Distributor, but there is no "Distributor" price list yet - add one in Products & pricing, or set their prices on the customer');
    } else if (!type) {
      r.accountType = 'Individual';
      r.warnings.push('no Customer Type - brought in as Individual');
    } else {
      r.errors.push(`Customer Type "${clean(src.customerType)}" is not Individual, Corporate or Distributor`);
    }

    // Contact
    const phones = [...new Set([clean(src.phone), clean(src.mobile)].flatMap((x) => x.split(/\s*,\s*/)).filter(Boolean))];
    p.phone = phones.join(', ');
    p.email = clean(src.email);
    if (!p.phone && !p.email) r.warnings.push('no phone number or email address');
    if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) {
      r.warnings.push(`"${p.email}" does not look like an email address`);
    }

    // Address: the delivery address is the customer's own; a different
    // billing address is kept as an extra address used for billing.
    const deliver = clean(src.deliveryAddress) || clean(src.billingAddress);
    p.line1 = deliver || null;
    const area = clean(src.area);
    p.city = area && !squash(deliver).includes(squash(area)) ? area : null;
    p.parish = parishOf(src.parish);
    if (clean(src.parish) && !p.parish) r.warnings.push(`"${clean(src.parish)}" is not a parish - left out`);
    const bill = clean(src.billingAddress);
    if (bill && deliver && squash(bill) !== squash(deliver)) p.billing = bill;

    // Zone and days
    const zoneName = clean(src.deliveryZone);
    if (zoneName) {
      const z = zones.find((x) => x.name.toLowerCase() === zoneName.toLowerCase());
      if (z?.retired_at) r.errors.push(`the zone "${z.name}" has been retired`);
      else if (z) r.zone = z.name;
      else {
        const k = zoneName.toLowerCase();
        if (!newZones.has(k)) newZones.set(k, zoneName);
        r.zone = newZones.get(k)!;
        r.warnings.push(`zone "${r.zone}" is not on the zone list yet - it will be added`);
      }
    } else if (p.line1) {
      r.warnings.push('no delivery zone');
    }
    const days = parseDays(src.deliveryDays);
    r.days = days.days;
    if (days.bad.length) r.errors.push(`delivery day "${days.bad.join(', ')}" not understood - use Mon, Tue … Sun`);

    // Bottled brands
    for (const raw of clean(src.bottledBrands).split(/\s*[;,]\s*/).filter(Boolean)) {
      const b = brands.find((x) => x.name.toLowerCase() === raw.toLowerCase());
      if (b && b.type !== CO_PACK) {
        r.errors.push(`${b.name} is our own brand, not one bottled for a customer`);
        continue;
      }
      const brandName = b?.name ?? newBrands.get(raw.toLowerCase()) ?? raw;
      if (!b && !newBrands.has(raw.toLowerCase())) newBrands.set(raw.toLowerCase(), raw);
      if (!b) r.warnings.push(`brand "${brandName}" is not in the app yet - it will be added as bottled for them`);
      if (!r.brands.includes(brandName)) r.brands.push(brandName);
    }
    const own = yesNo(src.canOrderOwnBrand);
    if (clean(src.canOrderOwnBrand as string) && own === null) {
      r.errors.push(`Can Order Alka Vida Products "${clean(src.canOrderOwnBrand as string)}" should be Yes or No`);
    }
    r.buysOwnBrand = own ?? true;
    if (!r.buysOwnBrand && r.brands.length === 0) {
      r.warnings.push('cannot order Alka Vida products and has no bottled brands - they will have nothing to order');
    }

    // Opening balance
    const bal = Math.round(Number(src.openingBalanceCents ?? 0)) || 0;
    r.balanceCents = bal;
    const items = (src.openItems ?? []).filter((x) => Math.round(Number(x.openCents)) !== 0);
    const itemsTotal = items.reduce((s, x) => s + Math.round(Number(x.openCents)), 0);
    if (bal === 0) {
      // Nothing owed either way: invoices and credits that cancel out are left behind.
      if (items.length) r.warnings.push('open items cancel out to zero - nothing brought in');
    } else if (items.length && itemsTotal === bal) {
      p.items = items.map((x) => ({ ...x, openCents: Math.round(Number(x.openCents)) }));
      r.balanceAs = 'items';
    } else if (bal !== 0) {
      if (items.length) {
        r.warnings.push(`the Open Items add up to ${money(itemsTotal)}, not the ${money(bal)} balance - brought in as one balance line`);
      }
      p.items = [{ reference: null, type: bal < 0 ? 'Payment' : 'Invoice', date: input.asOf, dueDate: input.asOf, openCents: bal }];
      r.balanceAs = 'single';
    }
    r.itemCount = p.items.length;
    if (bal < 0) r.warnings.push(`credit of ${money(-bal)} - comes in as credit on their account`);

    if (r.errors.length) r.action = 'error';
  });

  return { plans, newZones: [...newZones.values()], newBrands: [...newBrands.values()] };
}

export async function importCustomers(db: Db, actor: Actor, input: ImportInput): Promise<ImportResult> {
  requireRole(actor, 'admin', 'user');
  if (!Array.isArray(input.rows) || input.rows.length === 0) throw new RuleViolation('the file has no customers in it');
  if (input.rows.length > 5000) throw new RuleViolation('that is more than 5,000 rows - split the file');
  const asOf = isoDate(input.asOf);
  if (!asOf) throw new RuleViolation('choose the date the balances are as of');
  const opts = { ...input, asOf };

  const summary = (plans: Plan[], newZones: string[], newBrands: string[], created: number): ImportResult => ({
    dryRun: !!input.dryRun,
    rows: plans.map((p) => p.r),
    toCreate: plans.filter((p) => p.r.action === 'create').length,
    toSkip: plans.filter((p) => p.r.action === 'skip').length,
    withErrors: plans.filter((p) => p.r.action === 'error').length,
    newZones, newBrands,
    totalBalanceCents: plans.filter((p) => p.r.action === 'create').reduce((s, p) => s + p.r.balanceCents, 0),
    created,
  });

  if (input.dryRun) {
    const { plans, newZones, newBrands } = await plan(db, opts);
    return summary(plans, newZones, newBrands, 0);
  }

  return db.tx(async (t) => {
    const { plans, newZones, newBrands } = await plan(t, opts);
    const bad = plans.filter((p) => p.r.action === 'error');
    if (bad.length) {
      throw new RuleViolation(
        `${bad.length} row${bad.length === 1 ? ' has' : 's have'} a problem (first: row ${bad[0].r.row}, ${bad[0].r.name || 'no name'} - ${bad[0].r.errors[0]}). ` +
        'Fix the file and upload it again; nothing was brought in',
      );
    }

    for (const name of newZones) {
      const last = await t.one<{ n: number }>(`SELECT COALESCE(MAX(sort_order), 0) + 10 AS n FROM delivery_zones`);
      const z = await t.one<{ id: string }>(
        `INSERT INTO delivery_zones (name, sort_order) VALUES ($1,$2) RETURNING id`, [name, Number(last.n)]);
      await audit(t, actor, 'create', 'DeliveryZone', z.id, name, { from: 'customer upload' });
    }
    const brandIds = new Map<string, string>();
    for (const name of newBrands) {
      const b = await t.one<{ id: string }>(
        `INSERT INTO brands (name, type, label_source) VALUES ($1,$2,'Customer-supplied') RETURNING id`, [name, CO_PACK]);
      await audit(t, actor, 'create', 'Brand', b.id, name, { type: CO_PACK, from: 'customer upload' });
    }
    for (const b of await t.query<{ id: string; name: string }>(`SELECT id, name FROM brands`)) {
      brandIds.set(b.name.toLowerCase(), b.id);
    }

    let created = 0;
    for (const p of plans) {
      if (p.r.action !== 'create') continue;
      const { r, src } = p;
      const hold = !!input.holdAutoEmails;
      const c = await t.one<{ id: string }>(
        `INSERT INTO customers
           (name, account_type, contact_person, phone, email, address_line1, city, parish, delivery_address,
            delivery_zone, delivery_days, default_delivery_day, price_tier_id, buys_own_brand,
            auto_statements, auto_reminders, imported_at, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12,$13,$14,$15,$16,now(),$17)
         RETURNING id`,
        [r.name, r.accountType, clean(src.contactPerson) || null, p.phone, p.email,
         p.line1, p.city, p.parish,
         // A parish already written into the address line is kept on the
         // record but not repeated in the line the driver reads.
         composeAddress({ addressLine1: p.line1, city: p.city,
           parish: p.parish && !squash(p.line1 ?? '').includes(squash(p.parish)) ? p.parish : null }),
         r.zone, r.days, r.days[0] ?? null, p.tierId, r.buysOwnBrand, !hold, !hold,
         `Brought across from QuickBooks on ${new Date().toISOString().slice(0, 10)}`],
      );
      await audit(t, actor, 'create', 'Customer', c.id, r.name, { from: 'customer upload', asOf });

      if (p.billing) {
        await t.query(
          `INSERT INTO customer_addresses (customer_id, label, address_line1, is_billing, is_delivery)
           VALUES ($1,'Billing',$2,true,false)`, [c.id, p.billing]);
      }
      for (const name of r.brands) {
        await t.query(
          `INSERT INTO customer_brands (customer_id, brand_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [c.id, brandIds.get(name.toLowerCase())]);
      }

      for (const item of p.items) {
        const date = isoDate(item.date) ?? asOf;
        const ref = clean(item.reference) || null;
        if (item.openCents > 0) {
          let number = ref ? `OB-${ref}` : await nextNumber(t, 'invoice_number_seq', 'OB');
          if (ref && await t.maybeOne(`SELECT 1 FROM invoices WHERE invoice_number = $1`, [number])) {
            number = await nextNumber(t, 'invoice_number_seq', 'OB');
          }
          const was = item.amountCents && Math.round(Number(item.amountCents)) !== item.openCents
            ? ` (invoice total ${money(Math.round(Number(item.amountCents)))}, ${money(item.openCents)} still open)` : '';
          const inv = await t.one<{ id: string }>(
            `INSERT INTO invoices
               (invoice_number, invoice_date, due_date, sent_date, customer_id, lifecycle,
                subtotal_cents, gct_cents, grand_total_cents, is_opening_balance, opening_reference, notes)
             VALUES ($1,$2,$3,$2,$4,'Sent',$5,0,$5,true,$6,$7) RETURNING id`,
            [number, date, isoDate(item.dueDate) ?? date, c.id, item.openCents, ref,
             ref ? `Opening balance brought across from QuickBooks invoice ${ref}${was}.`
                 : `Opening balance brought across from QuickBooks, as at ${asOf}.`],
          );
          await audit(t, actor, 'create', 'Invoice', inv.id, number,
            { openingBalance: true, quickbooks: ref, amountCents: item.openCents });
        } else {
          await insertPayment(t, actor, {
            customerId: c.id, amountCents: -item.openCents, method: 'Other',
            paymentDate: date, kind: 'Opening credit',
            reference: 'QuickBooks opening credit',
            notes: `Unapplied QuickBooks payment brought across as credit on account (as at ${asOf}).`,
          });
        }
      }
      created++;
    }
    return summary(plans, newZones, newBrands, created);
  });
}
