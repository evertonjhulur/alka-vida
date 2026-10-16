/**
 * Brands, and who may buy what (Everton, 16 Oct 2026; migration 027).
 *
 * Alka Vida's own products (an Owned brand, or no brand at all) are for
 * every customer who buys them. Products bottled for someone else - a
 * Third-Party Co-Pack brand - are never sold to anybody but the customer
 * they are bottled for: Alka Lyfe (Alka Lyfe, Sky Drops), Melkleen (Cool
 * Cool), Living Hope (Living Water). A customer can be linked to any number
 * of those brands, and a customer who buys only their own bottled brands
 * (buys_own_brand = false) does not see Alka Vida's products either.
 *
 * The rule lives here once, as SQL (productAvailableSql) for the lists the
 * order screens and the portal read, and as a check (assertAvailable) that
 * resolveLines runs on every order, quote and counter sale - so a product a
 * customer cannot see can never be slipped onto their order by hand either.
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, requireRole, num } from './core.ts';
import { RuleViolation } from '@alka/shared';

export type BrandType = 'Owned' | 'Third-Party Co-Pack';
export const CO_PACK: BrandType = 'Third-Party Co-Pack';

/**
 * A WHERE fragment: product `p` may be sold to the customer whose id is the
 * SQL expression `customer` (a parameter like `$1`, or a column).
 *
 * The bottle charge (the 5-gallon bottle itself, charged for empties short)
 * is a charge, not something chosen, so it is never held back.
 */
export function productAvailableSql(p: string, customer: string): string {
  return `(
    ${p}.is_bottle_charge
    OR (
      NOT EXISTS (SELECT 1 FROM brands ob WHERE ob.id = ${p}.brand_id AND ob.type = '${CO_PACK}')
      AND COALESCE((SELECT oc.buys_own_brand FROM customers oc WHERE oc.id = ${customer}), true)
    )
    OR EXISTS (
      SELECT 1 FROM customer_brands cb JOIN brands cbb ON cbb.id = cb.brand_id
      WHERE cb.customer_id = ${customer} AND cb.brand_id = ${p}.brand_id
        AND cbb.type = '${CO_PACK}' AND cbb.active
    )
  )`;
}

/** A WHERE fragment for a sale with no customer (a walk-in): own products only. */
export function ownProductSql(p: string): string {
  return `(${p}.is_bottle_charge OR NOT EXISTS (
    SELECT 1 FROM brands ob WHERE ob.id = ${p}.brand_id AND ob.type = '${CO_PACK}'))`;
}

/**
 * Refuse any product this customer may not buy. `alreadyOnIt` are products
 * already on the order being edited: a line taken before a brand was
 * unlinked can still be changed rather than locking the order.
 */
export async function assertAvailable(
  t: Queryable, customerId: string, productIds: readonly string[],
  alreadyOnIt: readonly string[] = [],
): Promise<void> {
  const ids = [...new Set(productIds)].filter((id) => !alreadyOnIt.includes(id));
  if (ids.length === 0) return;
  const blocked = await t.query<{ name: string; brand: string | null; co_pack: boolean }>(
    `SELECT p.name, b.name AS brand, (b.type = '${CO_PACK}') AS co_pack
     FROM products p LEFT JOIN brands b ON b.id = p.brand_id
     WHERE p.id = ANY($2::uuid[]) AND NOT ${productAvailableSql('p', '$1')}`,
    [customerId, ids],
  );
  if (blocked.length === 0) return;
  const c = await t.maybeOne<{ name: string }>(`SELECT name FROM customers WHERE id = $1`, [customerId]);
  const who = c?.name ?? 'this customer';
  const first = blocked[0];
  if (first.co_pack) {
    throw new RuleViolation(
      `${first.name} is ${first.brand ?? 'a brand'} bottled for another customer, so it cannot be sold to ${who}. ` +
      `Link the brand to ${who} on their Details › Products & prices if it is bottled for them`,
    );
  }
  throw new RuleViolation(
    `${who} buys only their own bottled brands, so ${first.name} is not available to them. ` +
    `Tick "Can order Alka Vida products" on their Details › Products & prices to change that`,
  );
}

/* ------------------------------------------------------------------ */
/* The brand list (Products & pricing)                                 */
/* ------------------------------------------------------------------ */

export async function listBrands(db: Db | Queryable) {
  const rows = await db.query<{
    id: string; name: string; type: BrandType; active: boolean;
    label_source: string | null; contact_info: string | null;
    product_count: number; customers: Array<{ id: string; name: string }> | null;
  }>(
    `SELECT b.id, b.name, b.type, b.active, b.label_source, b.contact_info,
            (SELECT COUNT(*)::int FROM products p WHERE p.brand_id = b.id AND p.active) AS product_count,
            (SELECT json_agg(json_build_object('id', c.id, 'name', c.name) ORDER BY c.name)
             FROM customer_brands cb JOIN customers c ON c.id = cb.customer_id
             WHERE cb.brand_id = b.id AND c.active) AS customers
     FROM brands b
     ORDER BY b.active DESC, (b.type = 'Owned') DESC, b.name`,
  );
  return rows.map((r) => ({ ...r, product_count: num(r.product_count), customers: r.customers ?? [] }));
}

export interface BrandInput {
  name?: string;
  type?: BrandType;
  active?: boolean;
  labelSource?: 'Company-purchased' | 'Customer-supplied' | null;
}

function checkType(type: unknown): asserts type is BrandType {
  if (type !== 'Owned' && type !== CO_PACK) {
    throw new RuleViolation('a brand is either our own or bottled for a customer');
  }
}

async function assertNameFree(t: Queryable, name: string, exceptId: string | null): Promise<void> {
  const clash = await t.maybeOne<{ id: string }>(
    `SELECT id FROM brands WHERE lower(name) = lower($1) AND ($2::uuid IS NULL OR id <> $2)`,
    [name, exceptId],
  );
  if (clash) throw new RuleViolation(`there is already a brand called "${name}"`);
}

export async function createBrand(db: Db, actor: Actor, input: BrandInput): Promise<{ id: string }> {
  requireRole(actor, 'admin', 'user');
  const name = input.name?.trim();
  if (!name) throw new RuleViolation('a brand needs a name');
  const type = input.type ?? CO_PACK;
  checkType(type);
  return db.tx(async (t) => {
    await assertNameFree(t, name, null);
    const row = await t.one<{ id: string }>(
      `INSERT INTO brands (name, type, label_source) VALUES ($1,$2,$3) RETURNING id`,
      [name, type, input.labelSource ?? (type === CO_PACK ? 'Customer-supplied' : 'Company-purchased')],
    );
    await audit(t, actor, 'create', 'Brand', row.id, name, { type });
    return row;
  });
}

export async function updateBrand(db: Db, actor: Actor, brandId: string, input: BrandInput): Promise<void> {
  requireRole(actor, 'admin', 'user');
  await db.tx(async (t) => {
    const before = await t.maybeOne<{ name: string }>(`SELECT name FROM brands WHERE id = $1`, [brandId]);
    if (!before) throw new RuleViolation('brand not found');
    const name = input.name === undefined ? null : input.name.trim();
    if (name === '') throw new RuleViolation('a brand needs a name');
    if (name) await assertNameFree(t, name, brandId);
    if (input.type !== undefined) checkType(input.type);
    await t.query(
      `UPDATE brands SET name = COALESCE($2, name), type = COALESCE($3, type),
                         active = COALESCE($4, active),
                         label_source = CASE WHEN $5::boolean THEN $6 ELSE label_source END
       WHERE id = $1`,
      [brandId, name, input.type ?? null, input.active ?? null,
       input.labelSource !== undefined, input.labelSource ?? null],
    );
    await audit(t, actor, 'update', 'Brand', brandId, name ?? before.name, input as Record<string, unknown>);
  });
}

/* ------------------------------------------------------------------ */
/* One customer's brands (Details › Products & prices)                 */
/* ------------------------------------------------------------------ */

export async function customerBrands(db: Db | Queryable, customerId: string) {
  const c = await db.maybeOne<{ buys_own_brand: boolean }>(
    `SELECT buys_own_brand FROM customers WHERE id = $1`, [customerId],
  );
  if (!c) throw new RuleViolation('customer not found');
  const brands = await db.query<{ id: string; name: string; active: boolean }>(
    `SELECT b.id, b.name, b.active FROM customer_brands cb JOIN brands b ON b.id = cb.brand_id
     WHERE cb.customer_id = $1 ORDER BY b.name`, [customerId],
  );
  return { buysOwnBrand: c.buys_own_brand !== false, brands };
}

/**
 * Set which bottled brands this customer may buy, and whether they buy Alka
 * Vida's own products as well. Replaces the whole set.
 */
export async function setCustomerBrands(
  db: Db | Queryable, actor: Actor, customerId: string,
  input: { brandIds?: readonly string[]; buysOwnBrand?: boolean },
): Promise<void> {
  requireRole(actor, 'admin', 'user');
  const work = async (t: Queryable) => {
    const c = await t.maybeOne<{ name: string }>(`SELECT name FROM customers WHERE id = $1`, [customerId]);
    if (!c) throw new RuleViolation('customer not found');
    const details: Record<string, unknown> = {};
    if (input.brandIds) {
      const ids = [...new Set(input.brandIds)];
      const found = await t.query<{ id: string; name: string; type: string }>(
        `SELECT id, name, type FROM brands WHERE id = ANY($1::uuid[])`, [ids],
      );
      if (found.length !== ids.length) throw new RuleViolation('one of those brands no longer exists');
      const own = found.find((b) => b.type !== CO_PACK);
      if (own) {
        throw new RuleViolation(`${own.name} is our own brand - it is for every customer, so it is not linked to one`);
      }
      await t.query(`DELETE FROM customer_brands WHERE customer_id = $1 AND NOT (brand_id = ANY($2::uuid[]))`,
        [customerId, ids]);
      for (const id of ids) {
        await t.query(
          `INSERT INTO customer_brands (customer_id, brand_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [customerId, id],
        );
      }
      details.bottledBrands = found.map((b) => b.name).sort();
    }
    if (input.buysOwnBrand !== undefined) {
      await t.query(`UPDATE customers SET buys_own_brand = $2, updated_at = now() WHERE id = $1`,
        [customerId, !!input.buysOwnBrand]);
      details.buysOwnBrand = !!input.buysOwnBrand;
    }
    await audit(t, actor, 'update', 'Customer', customerId, c.name, details);
  };
  // Inside an import the caller's transaction is used as it is.
  if ('tx' in db) await (db as Db).tx(work);
  else await work(db);
}
