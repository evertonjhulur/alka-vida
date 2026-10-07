/**
 * Products, price tiers and the tiered price list (Section 2).
 *
 * A price tier is a named rate card - Retail, Wholesale, Distributor,
 * Corporate. `price_lists` holds one rate per (tier x product), and a customer
 * points at one tier.
 *
 * A tier does NOT need a rate for every product. Where a rate is missing the
 * product's own list price applies, which is what lets case tiers and
 * 5-gallon tiers cover different parts of the range without inventing rates
 * nobody sells at.
 *
 * Changing a rate here only affects FUTURE orders. Order lines lock in their
 * price when the order is created, so a repricing never rewrites what a
 * customer was already quoted or billed.
 */

import type { Db } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, requireRole, num } from './core.ts';
import type { Cents } from '@alka/shared';
import { RuleViolation } from '@alka/shared';

/* ------------------------------------------------------------------ */
/* Products                                                            */
/* ------------------------------------------------------------------ */

export interface ProductInput {
  name: string;
  size?: string | null;
  /** 0 means sold individually (the 5-gallon), never by the case. */
  bottlesPerCase: number;
  pricePerCaseCents?: Cents;
  pricePerBottleCents?: Cents;
  brandId?: string | null;
  isReturnable?: boolean;
}

export async function createProduct(
  db: Db, actor: Actor, input: ProductInput,
): Promise<{ id: string }> {
  requireRole(actor, 'admin', 'user');
  validateProduct(input);

  return db.tx(async (t) => {
    const row = await t.one<{ id: string }>(
      `INSERT INTO products
         (name, size, bottles_per_case, price_per_case_cents,
          price_per_bottle_cents, brand_id, is_returnable)
       VALUES ($1,$2,$3,COALESCE($4,0),COALESCE($5,0),$6,COALESCE($7,false))
       RETURNING id`,
      [input.name.trim(), input.size ?? null, input.bottlesPerCase,
       input.pricePerCaseCents ?? null, input.pricePerBottleCents ?? null,
       input.brandId ?? null, input.isReturnable ?? null],
    );
    await audit(t, actor, 'create', 'Product', row.id, input.name, {
      bottlesPerCase: input.bottlesPerCase,
    });
    return { id: row.id };
  });
}

export async function updateProduct(
  db: Db, actor: Actor, productId: string, input: Partial<ProductInput> & { active?: boolean },
): Promise<void> {
  requireRole(actor, 'admin', 'user');

  return db.tx(async (t) => {
    const before = await t.maybeOne<{ name: string; bottles_per_case: number }>(
      `SELECT name, bottles_per_case FROM products WHERE id = $1`, [productId],
    );
    if (!before) throw new RuleViolation('product not found');

    // Changing whether something is cased would silently invalidate the
    // quantities on every existing order and invoice for it.
    if (input.bottlesPerCase !== undefined
        && input.bottlesPerCase !== num(before.bottles_per_case)) {
      const used = await t.one<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM order_line_items WHERE product_id = $1`, [productId],
      );
      if (num(used.c) > 0) {
        throw new RuleViolation(
          'this product has already been sold, so its case size cannot be changed. ' +
          'Retire it and add a new product instead',
        );
      }
    }

    await t.query(
      `UPDATE products
       SET name = COALESCE($2,name), size = COALESCE($3,size),
           bottles_per_case = COALESCE($4,bottles_per_case),
           price_per_case_cents = COALESCE($5,price_per_case_cents),
           price_per_bottle_cents = COALESCE($6,price_per_bottle_cents),
           is_returnable = COALESCE($7,is_returnable),
           active = COALESCE($8,active)
       WHERE id = $1`,
      [productId, input.name ?? null, input.size ?? null,
       input.bottlesPerCase ?? null, input.pricePerCaseCents ?? null,
       input.pricePerBottleCents ?? null, input.isReturnable ?? null,
       input.active ?? null],
    );
    await audit(t, actor, 'update', 'Product', productId, input.name ?? before.name, input);
  });
}

function validateProduct(input: ProductInput): void {
  if (!input.name?.trim()) throw new RuleViolation('a product needs a name');
  if (!Number.isInteger(input.bottlesPerCase) || input.bottlesPerCase < 0) {
    throw new RuleViolation('bottles per case must be 0 or a whole number');
  }
  // Guard the case-vs-bottle rule at its source: a product priced in the
  // wrong unit can never be sold, because line totals use the other field.
  if (input.bottlesPerCase > 0 && !input.pricePerCaseCents) {
    throw new RuleViolation('a cased product needs a price per case');
  }
  if (input.bottlesPerCase === 0 && !input.pricePerBottleCents) {
    throw new RuleViolation('a product sold individually needs a price per bottle');
  }
}

/* ------------------------------------------------------------------ */
/* Price tiers                                                         */
/* ------------------------------------------------------------------ */

export async function createPriceTier(
  db: Db, actor: Actor, name: string,
): Promise<{ id: string }> {
  requireRole(actor, 'admin', 'user');
  if (!name?.trim()) throw new RuleViolation('a price tier needs a name');

  return db.tx(async (t) => {
    const existing = await t.maybeOne(
      `SELECT id FROM price_tiers WHERE lower(name) = lower($1)`, [name.trim()],
    );
    if (existing) throw new RuleViolation(`a price tier called "${name.trim()}" already exists`);

    const row = await t.one<{ id: string }>(
      `INSERT INTO price_tiers (name) VALUES ($1) RETURNING id`, [name.trim()],
    );
    await audit(t, actor, 'create', 'PriceTier', row.id, name.trim(), {});
    return { id: row.id };
  });
}

export async function renamePriceTier(
  db: Db, actor: Actor, tierId: string, name: string,
): Promise<void> {
  requireRole(actor, 'admin', 'user');
  if (!name?.trim()) throw new RuleViolation('a price tier needs a name');
  await db.tx(async (t) => {
    await t.query(`UPDATE price_tiers SET name = $2 WHERE id = $1`, [tierId, name.trim()]);
    await audit(t, actor, 'update', 'PriceTier', tierId, name.trim(), {});
  });
}

/** A tier can only be removed while no customer is on it. */
export async function deletePriceTier(
  db: Db, actor: Actor, tierId: string,
): Promise<void> {
  requireRole(actor, 'admin');
  await db.tx(async (t) => {
    const tier = await t.one<{ name: string }>(
      `SELECT name FROM price_tiers WHERE id = $1`, [tierId],
    );
    const inUse = await t.one<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM customers WHERE price_tier_id = $1 AND active`, [tierId],
    );
    if (num(inUse.c) > 0) {
      throw new RuleViolation(
        `${num(inUse.c)} customer(s) are on the ${tier.name} tier. ` +
        `Move them to another tier first`,
      );
    }
    await t.query(`DELETE FROM price_tiers WHERE id = $1`, [tierId]);
    await audit(t, actor, 'delete', 'PriceTier', tierId, tier.name, {});
  });
}

/* ------------------------------------------------------------------ */
/* The rate card                                                       */
/* ------------------------------------------------------------------ */

/**
 * Set one tier's rate for one product.
 *
 * The rate goes in the unit the product is actually sold in: a cased product
 * takes a per-case rate, the 5-gallon takes a per-bottle rate.
 */
export async function setTierPrice(
  db: Db,
  actor: Actor,
  args: { priceTierId: string; productId: string; priceCents: Cents },
): Promise<void> {
  requireRole(actor, 'admin', 'user');
  if (args.priceCents < 0) throw new RuleViolation('a price cannot be negative');

  await db.tx(async (t) => {
    const product = await t.one<{ name: string; bottles_per_case: number }>(
      `SELECT name, bottles_per_case FROM products WHERE id = $1`, [args.productId],
    );
    const cased = num(product.bottles_per_case) > 0;

    await t.query(
      `INSERT INTO price_lists
         (price_tier_id, product_id, price_per_case_cents, price_per_bottle_cents)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (price_tier_id, product_id) DO UPDATE
         SET price_per_case_cents = EXCLUDED.price_per_case_cents,
             price_per_bottle_cents = EXCLUDED.price_per_bottle_cents`,
      [args.priceTierId, args.productId,
       cased ? args.priceCents : 0,
       cased ? 0 : args.priceCents],
    );

    await audit(t, actor, 'update', 'PriceList', args.productId, product.name, {
      priceTierId: args.priceTierId,
      priceCents: args.priceCents,
      unit: cased ? 'per case' : 'per bottle',
      note: 'applies to future orders only',
    });
  });
}

/** Remove a tier's rate for a product, so it falls back to the list price. */
export async function clearTierPrice(
  db: Db, actor: Actor, priceTierId: string, productId: string,
): Promise<void> {
  requireRole(actor, 'admin', 'user');
  await db.tx(async (t) => {
    await t.query(
      `DELETE FROM price_lists WHERE price_tier_id = $1 AND product_id = $2`,
      [priceTierId, productId],
    );
    await audit(t, actor, 'update', 'PriceList', productId, productId, {
      priceTierId, cleared: true,
    });
  });
}

export interface PriceMatrix {
  tiers: Array<{ id: string; name: string; customerCount: number }>;
  products: Array<{
    id: string; name: string; size: string | null;
    bottlesPerCase: number; active: boolean; isReturnable: boolean;
    /** The 5-gallon bottle itself, charged for empties short (7 Oct 2026). */
    isBottleCharge: boolean;
    /** The unit this product is sold and priced in. */
    unit: 'case' | 'bottle';
    listPriceCents: Cents;
    /** priceTierId -> rate in that product's own unit. Absent = list price. */
    tierPrices: Record<string, Cents>;
  }>;
}

/** Everything the pricing screen needs: the full products x tiers grid. */
export async function priceMatrix(db: Db): Promise<PriceMatrix> {
  const tiers = await db.query<{ id: string; name: string; customer_count: number }>(
    `SELECT pt.id, pt.name,
            (SELECT COUNT(*)::int FROM customers c
             WHERE c.price_tier_id = pt.id AND c.active) AS customer_count
     FROM price_tiers pt ORDER BY pt.name`,
  );

  const products = await db.query<{
    id: string; name: string; size: string | null; bottles_per_case: number;
    active: boolean; is_returnable: boolean; is_bottle_charge: boolean;
    price_per_case_cents: number; price_per_bottle_cents: number;
  }>(
    `SELECT id, name, size, bottles_per_case, active, is_returnable, is_bottle_charge,
            price_per_case_cents, price_per_bottle_cents
     FROM products ORDER BY active DESC, bottles_per_case DESC, name`,
  );

  const rates = await db.query<{
    price_tier_id: string; product_id: string;
    price_per_case_cents: number; price_per_bottle_cents: number;
  }>(
    `SELECT price_tier_id, product_id, price_per_case_cents, price_per_bottle_cents
     FROM price_lists`,
  );

  return {
    tiers: tiers.map((t) => ({
      id: t.id, name: t.name, customerCount: num(t.customer_count),
    })),
    products: products.map((p) => {
      const cased = num(p.bottles_per_case) > 0;
      const tierPrices: Record<string, Cents> = {};
      for (const r of rates.filter((x) => x.product_id === p.id)) {
        tierPrices[r.price_tier_id] = cased
          ? num(r.price_per_case_cents)
          : num(r.price_per_bottle_cents);
      }
      return {
        id: p.id,
        name: p.name,
        size: p.size,
        bottlesPerCase: num(p.bottles_per_case),
        active: p.active,
        isReturnable: p.is_returnable,
        isBottleCharge: !!p.is_bottle_charge,
        unit: cased ? ('case' as const) : ('bottle' as const),
        listPriceCents: cased ? num(p.price_per_case_cents) : num(p.price_per_bottle_cents),
        tierPrices,
      };
    }),
  };
}
