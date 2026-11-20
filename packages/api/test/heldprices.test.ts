/**
 * Holding today's Retail customers on their 5-gallon price while new
 * customers pay the standard one (Everton, 19 Nov 2026): rename "Retail" to
 * "Retail - held", add a new "Retail" as a copy of it with the 5-gallon at the
 * Corporate rate; later, move everyone on the held list across.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { createPriceTier, renamePriceTier, moveTierCustomers, setTierPrice } from '../src/services/pricing.ts';
import { createOrder } from '../src/services/orders.ts';
import { signUp } from '../src/services/signup.ts';
import { loadSigningKey } from '../src/lib/auth.ts';
import { businessToday } from '../src/services/core.ts';
import { addDays } from '@alka/shared';

let f: Fixture;
let retail = '';
before(async () => {
  f = await setupFixture();
  await loadSigningKey(f.db);
  retail = (await f.db.one<{ id: string }>(`INSERT INTO price_tiers (name) VALUES ('Retail') RETURNING id`)).id;
  await setTierPrice(f.db, f.admin, { priceTierId: retail, productId: f.fiveGalProductId, priceCents: 43478 });
  await setTierPrice(f.db, f.admin, { priceTierId: retail, productId: f.casedProductId, priceCents: 115000 });
  await f.db.query(`UPDATE customers SET price_tier_id = $2 WHERE id = $1`, [f.customerId, retail]);
});
after(async () => { await f.close(); });

const jugPrice = async (customerId: string) => {
  const o = await createOrder(f.db, f.office, { customerId, deliveryMode: 'Delivery', noRound: true,
    requestedDeliveryDate: addDays(businessToday(), 5), lines: [{ productId: f.fiveGalProductId, looseBottles: 1 }] } as never);
  return Number((await f.db.one<{ p: number }>(
    `SELECT price_per_bottle_cents AS p FROM order_line_items WHERE order_id = $1`, [o.id])).p);
};

describe('Held prices for current Retail customers', () => {
  test('rename, copy, re-rate: current customers keep J$434.78, new sign-ups pay the standard', async () => {
    await renamePriceTier(f.db, f.admin, retail, 'Retail - held');
    const fresh = await createPriceTier(f.db, f.office, 'Retail', { copyFrom: retail });
    assert.equal(fresh.ratesCopied, 2, 'every rate copied');
    await setTierPrice(f.db, f.office, { priceTierId: fresh.id, productId: f.fiveGalProductId, priceCents: 52174 });

    assert.equal(await jugPrice(f.customerId), 43478, 'the existing customer keeps the held price');
    const cases = await f.db.one<{ c: number }>(
      `SELECT price_per_case_cents AS c FROM price_lists WHERE price_tier_id = $1 AND product_id = $2`, [fresh.id, f.casedProductId]);
    assert.equal(Number(cases.c), 115000, 'case prices are the same on both lists');

    const s = await signUp(f.db, { method: 'email', email: 'newhome@example.com', password: 'water1234',
      accountType: 'Individual', firstName: 'New', lastName: 'Home', phone: '876-222-3333',
      addressLine1: '1 New St', city: 'Kingston', parish: 'Kingston' } as never);
    const tier = await f.db.one<{ name: string }>(
      `SELECT t.name FROM customers c JOIN price_tiers t ON t.id = c.price_tier_id WHERE c.id = $1`, [s.customerId]);
    assert.equal(tier.name, 'Retail', 'a new sign-up lands on the new standard Retail');
    assert.equal(await jugPrice(s.customerId!), 52174);

    const a = await f.db.one<{ details: { renamedFrom?: string } }>(
      `SELECT details FROM audit_log WHERE entity_type = 'PriceTier' AND entity_id = $1 AND action = 'update'`, [retail]);
    assert.equal(a.details.renamedFrom, 'Retail');
  });

  test('ending the hold: everyone on the held list moves, inactive too; admins only', async () => {
    const fresh = await f.db.one<{ id: string }>(`SELECT id FROM price_tiers WHERE name = 'Retail'`);
    const idle = await f.db.one<{ id: string }>(
      `INSERT INTO customers (name, phone, email, delivery_address, account_type, price_tier_id, active) VALUES ('Idle Person', '876-000-0000', '', '1 Idle Rd', 'Individual', $1, false) RETURNING id`, [retail]);
    await assert.rejects(moveTierCustomers(f.db, f.office, retail, fresh.id), /requires role/);
    await assert.rejects(moveTierCustomers(f.db, f.admin, retail, retail), /different price list/);
    const r = await moveTierCustomers(f.db, f.admin, retail, fresh.id);
    assert.equal(r.moved, 2);
    const left = await f.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM customers WHERE price_tier_id = $1`, [retail]);
    assert.equal(left.n, 0);
    const idleNow = await f.db.one<{ t: string }>(`SELECT price_tier_id AS t FROM customers WHERE id = $1`, [idle.id]);
    assert.equal(idleNow.t, fresh.id);
    assert.equal(await jugPrice(f.customerId), 52174, 'the moved customer now pays the standard price');
  });

  test('a rename cannot take a name already in use', async () => {
    const other = await createPriceTier(f.db, f.admin, 'Promo');
    await assert.rejects(renamePriceTier(f.db, f.admin, other.id, 'retail'), /already exists/);
  });
});
