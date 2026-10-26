/**
 * Products and prices from the QuickBooks list (Everton, 25 Oct 2026).
 *
 * The office uploads the "Products & Prices" workbook made from the QuickBooks
 * Product/Service list. Like the customer upload it is checked first (dry run,
 * row by row, nothing written), then brought in as ONE transaction.
 *
 * Products sheet, one row per product:
 *   - Brand: an existing brand by name; a brand not yet in the app is added -
 *     as one bottled for a customer when "Bottled For" names one, otherwise
 *     as our own. A client brand is linked to that customer (who must already
 *     be in the app: upload the customers first), and so is seen by them only.
 *   - List price: what a customer on no tier pays (for Alka Vida, Retail).
 *     Cased products are priced per case, the 5-gallon per bottle.
 *   - Retail / Corporate / Wholesale / Distributor: that tier's price; blank
 *     leaves the tier without a price for the product (the list price then
 *     applies). The tiers must already exist.
 *   - Bottle Charge = Yes: the 5-gallon bottle sold on its own; it updates the
 *     app's one bottle-charge product rather than adding a second.
 *   - A product already in the app under the same name is updated, so the
 *     file can be uploaded again after a correction.
 * Special Prices sheet: Customer Name, Product Name, Price - the customer's
 * own price for that product (ALD, Sunra, Treasure Isle).
 * All prices exclude GCT, as in QuickBooks.
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, num, requireRole } from './core.ts';
import { RuleViolation } from '@alka/shared';
import { CO_PACK } from './brands.ts';
import { bottleChargeProduct } from './orders.ts';

export interface ProductRow {
  name: string;
  brand?: string | null;
  bottledFor?: string | null;
  size?: string | null;
  bottlesPerCase?: number | string | null;
  returnable?: string | boolean | null;
  bottleCharge?: string | boolean | null;
  /** In cents. */
  listPriceCents?: number | null;
  /** Tier name -> price in cents (null/undefined = no price on that tier). */
  tierPrices?: Record<string, number | null | undefined>;
}
export interface SpecialRow { customer: string; product: string; priceCents: number | null }
export interface ProductImportInput { products: ProductRow[]; specials?: SpecialRow[]; dryRun?: boolean }

export interface ProductRowResult {
  row: number; name: string; action: 'create' | 'update' | 'error';
  brand: string | null; ownBrand: boolean; bottledFor: string | null;
  size: string | null;
  cased: boolean; bottlesPerCase: number; returnable: boolean; bottleCharge: boolean;
  listPriceCents: number; tierPrices: Record<string, number>;
  errors: string[]; warnings: string[];
}
export interface SpecialRowResult {
  row: number; customer: string; product: string; priceCents: number; action: 'set' | 'error'; errors: string[];
}
export interface ProductImportResult {
  dryRun: boolean;
  products: ProductRowResult[];
  specials: SpecialRowResult[];
  tiers: string[];
  newBrands: string[];
  toCreate: number; toUpdate: number; withErrors: number;
  done: number;
}

const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
const key = (s: string) => clean(s).toLowerCase();
const yes = (v: unknown) => ['yes', 'y', 'true', '1'].includes(key(String(v ?? '')));

async function plan(t: Queryable, input: ProductImportInput) {
  const tiers = await t.query<{ id: string; name: string }>(`SELECT id, name FROM price_tiers ORDER BY name`);
  const brands = await t.query<{ id: string; name: string; type: string }>(`SELECT id, name, type FROM brands`);
  const customers = await t.query<{ id: string; name: string }>(
    `SELECT id, name FROM customers WHERE merged_into_id IS NULL ORDER BY active DESC`);
  const existing = await t.query<{ id: string; name: string; is_bottle_charge: boolean }>(
    `SELECT id, name, is_bottle_charge FROM products`);
  const customerOf = (n: string) => customers.find((c) => key(c.name) === key(n));
  const newBrands = new Map<string, { name: string; ownBrand: boolean; client: string | null }>();

  const seen = new Set<string>();
  const products: ProductRowResult[] = (input.products ?? []).map((src, i) => {
    const name = clean(src.name);
    const r: ProductRowResult = {
      row: i + 2, name, action: 'create', brand: null, ownBrand: true, bottledFor: null,
      size: clean(src.size) || null, cased: false, bottlesPerCase: 0, returnable: false, bottleCharge: yes(src.bottleCharge),
      listPriceCents: 0, tierPrices: {}, errors: [], warnings: [],
    };
    if (!name) { r.errors.push('no product name'); r.action = 'error'; return r; }
    if (seen.has(key(name))) { r.errors.push('this product is in the file twice'); r.action = 'error'; return r; }
    seen.add(key(name));
    if (existing.some((p) => key(p.name) === key(name)) || (r.bottleCharge && existing.some((p) => p.is_bottle_charge))) {
      r.action = 'update';
    }

    // Brand and who it is bottled for.
    const brandName = clean(src.brand);
    const client = clean(src.bottledFor);
    if (client) {
      const c = customerOf(client);
      if (!c) r.errors.push(`"${client}" is not a customer in the app - upload the customers first`);
      else r.bottledFor = c.name;
    }
    if (brandName) {
      const b = brands.find((x) => key(x.name) === key(brandName));
      if (b) {
        r.brand = b.name;
        r.ownBrand = b.type !== CO_PACK;
        if (client && r.ownBrand) r.errors.push(`${b.name} is our own brand; "Bottled For" should be blank`);
        if (!client && !r.ownBrand) r.warnings.push(`${b.name} is bottled for a customer but no customer is named - only customers already linked to it will see it`);
      } else {
        r.brand = brandName;
        r.ownBrand = !client;
        if (!newBrands.has(key(brandName))) newBrands.set(key(brandName), { name: brandName, ownBrand: !client, client: r.bottledFor });
        r.warnings.push(`brand "${brandName}" is not in the app yet - it will be added${client ? ` as bottled for ${client}` : ' as our own'}`);
      }
    } else if (!r.bottleCharge) {
      r.warnings.push('no brand');
    }

    // Size and packing.
    const bpc = Math.round(Number(src.bottlesPerCase ?? 0));
    if (!Number.isFinite(bpc) || bpc < 0) r.errors.push('Bottles per Case should be a whole number (0 for the 5-gallon)');
    r.bottlesPerCase = Number.isFinite(bpc) && bpc > 0 ? bpc : 0;
    r.cased = r.bottlesPerCase > 0;
    r.returnable = yes(src.returnable);
    if (r.returnable && r.cased) r.errors.push('a returnable 5-gallon product is sold by the bottle: Bottles per Case should be 0');
    if (r.bottleCharge && (r.cased || r.returnable)) r.errors.push('the bottle charge is one bottle, not returnable');

    // Prices.
    const list = Math.round(Number(src.listPriceCents ?? 0));
    if (!Number.isFinite(list) || list < 0) r.errors.push('List Price is not a number');
    r.listPriceCents = Number.isFinite(list) && list > 0 ? list : 0;
    if (!r.listPriceCents) r.warnings.push('no list price');
    for (const [tierName, cents] of Object.entries(src.tierPrices ?? {})) {
      if (cents === null || cents === undefined || (cents as unknown) === '') continue;
      const tier = tiers.find((x) => key(x.name) === key(tierName));
      if (!tier) { r.errors.push(`there is no "${tierName}" price tier in the app`); continue; }
      const c = Math.round(Number(cents));
      if (!Number.isFinite(c) || c < 0) { r.errors.push(`${tierName} price is not a number`); continue; }
      r.tierPrices[tier.name] = c;
    }
    if (r.bottleCharge && Object.keys(r.tierPrices).length) r.warnings.push('tier prices are not used for the bottle charge');
    if (r.errors.length) r.action = 'error';
    return r;
  });

  const inFile = new Map(products.filter((p) => p.action !== 'error').map((p) => [key(p.name), p]));
  const specials: SpecialRowResult[] = (input.specials ?? []).map((src, i) => {
    const r: SpecialRowResult = {
      row: i + 2, customer: clean(src.customer), product: clean(src.product),
      priceCents: Math.round(Number(src.priceCents ?? 0)), action: 'set', errors: [],
    };
    const c = customerOf(r.customer);
    if (!r.customer) r.errors.push('no customer name');
    else if (!c) r.errors.push(`"${r.customer}" is not a customer in the app`);
    else r.customer = c.name;
    if (!inFile.has(key(r.product)) && !existing.some((p) => key(p.name) === key(r.product))) {
      r.errors.push(`"${r.product}" is not a product in the file or the app`);
    }
    if (!Number.isFinite(r.priceCents) || r.priceCents <= 0) r.errors.push('the price is missing or not a number');
    if (r.errors.length) r.action = 'error';
    return r;
  });

  return { products, specials, tiers, newBrands: [...newBrands.values()], customerOf };
}

export async function importProducts(db: Db, actor: Actor, input: ProductImportInput): Promise<ProductImportResult> {
  requireRole(actor, 'admin');
  if (!Array.isArray(input.products) || input.products.length === 0) {
    throw new RuleViolation('the file has no products in it');
  }
  const summary = (p: Awaited<ReturnType<typeof plan>>, done: number): ProductImportResult => ({
    dryRun: !!input.dryRun,
    products: p.products,
    specials: p.specials,
    tiers: p.tiers.map((x) => x.name),
    newBrands: p.newBrands.map((b) => b.name),
    toCreate: p.products.filter((r) => r.action === 'create').length,
    toUpdate: p.products.filter((r) => r.action === 'update').length,
    withErrors: p.products.filter((r) => r.action === 'error').length + p.specials.filter((r) => r.action === 'error').length,
    done,
  });

  if (input.dryRun) return summary(await plan(db, input), 0);

  return db.tx(async (t) => {
    const p = await plan(t, input);
    const bad = [...p.products.filter((r) => r.action === 'error'), ...p.specials.filter((r) => r.action === 'error')];
    if (bad.length) {
      const first = bad[0] as { row: number; errors: string[] };
      throw new RuleViolation(`${bad.length} row(s) have a problem (first: row ${first.row} - ${first.errors[0]}). `
        + 'Fix the file and upload it again; nothing was brought in');
    }

    for (const b of p.newBrands) {
      const made = await t.one<{ id: string }>(
        `INSERT INTO brands (name, type, label_source) VALUES ($1,$2,$3) RETURNING id`,
        [b.name, b.ownBrand ? 'Owned' : CO_PACK, b.ownBrand ? 'Company-purchased' : 'Customer-supplied']);
      await audit(t, actor, 'create', 'Brand', made.id, b.name, { from: 'product upload' });
    }
    const brandId = new Map((await t.query<{ id: string; name: string }>(`SELECT id, name FROM brands`))
      .map((b) => [key(b.name), b.id]));
    const tierId = new Map(p.tiers.map((x) => [x.name, x.id]));

    let done = 0;
    for (const r of p.products) {
      const bId = r.brand ? brandId.get(key(r.brand)) ?? null : null;
      const caseCents = r.cased ? r.listPriceCents : 0;
      const bottleCents = r.cased ? 0 : r.listPriceCents;
      let id: string;
      if (r.bottleCharge) {
        id = (await bottleChargeProduct(t)).id;
        await t.query(
          `UPDATE products SET name = $2, size = COALESCE(size, '5gal'), price_per_bottle_cents = $3, active = true,
                  brand_id = COALESCE($4, brand_id) WHERE id = $1`,
          [id, r.name, bottleCents, bId]);
      } else {
        const was = await t.maybeOne<{ id: string }>(
          `SELECT id FROM products WHERE lower(name) = lower($1) AND NOT is_bottle_charge`, [r.name]);
        if (was) {
          id = was.id;
          await t.query(
            `UPDATE products SET brand_id = $2, size = $3, bottles_per_case = $4, price_per_case_cents = $5,
                    price_per_bottle_cents = $6, is_returnable = $7, active = true WHERE id = $1`,
            [id, bId, r.size, r.bottlesPerCase, caseCents, bottleCents, r.returnable]);
        } else {
          id = (await t.one<{ id: string }>(
            `INSERT INTO products (name, brand_id, size, bottles_per_case, price_per_case_cents,
                                   price_per_bottle_cents, is_returnable)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [r.name, bId, r.size, r.bottlesPerCase,
             caseCents, bottleCents, r.returnable])).id;
        }
        // The tiers: exactly what the file says for this product.
        await t.query(`DELETE FROM price_lists WHERE product_id = $1`, [id]);
        for (const [tierName, cents] of Object.entries(r.tierPrices)) {
          await t.query(
            `INSERT INTO price_lists (price_tier_id, product_id, price_per_case_cents, price_per_bottle_cents)
             VALUES ($1,$2,$3,$4)`,
            [tierId.get(tierName), id, r.cased ? cents : 0, r.cased ? 0 : cents]);
        }
      }
      // A client's brand is theirs to see.
      if (r.bottledFor && bId) {
        const c = p.customerOf(r.bottledFor)!;
        await t.query(
          `INSERT INTO customer_brands (customer_id, brand_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [c.id, bId]);
      }
      await audit(t, actor, r.action === 'create' ? 'create' : 'update', 'Product', id, r.name, {
        from: 'product upload', listPriceCents: r.listPriceCents, tierPrices: r.tierPrices,
      });
      done++;
    }

    for (const s of p.specials) {
      const c = p.customerOf(s.customer)!;
      const prod = await t.one<{ id: string; bottles_per_case: number }>(
        `SELECT id, bottles_per_case FROM products WHERE lower(name) = lower($1) ORDER BY active DESC LIMIT 1`, [s.product]);
      const cased = num(prod.bottles_per_case) > 0;
      await t.query(
        `INSERT INTO customer_prices (customer_id, product_id, price_per_case_cents, price_per_bottle_cents, updated_at)
         VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (customer_id, product_id) DO UPDATE
           SET price_per_case_cents = EXCLUDED.price_per_case_cents,
               price_per_bottle_cents = EXCLUDED.price_per_bottle_cents, updated_at = now()`,
        [c.id, prod.id, cased ? s.priceCents : 0, cased ? 0 : s.priceCents]);
      await audit(t, actor, 'update', 'Customer', c.id, c.name, {
        from: 'product upload', specialPrice: { product: s.product, cents: s.priceCents },
      });
      done++;
    }
    return summary(p, done);
  });
}
