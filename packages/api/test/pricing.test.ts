/** Products, price tiers and the tiered rate card. */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, stopsOf, type Fixture } from './helpers.ts';
import {
  createProduct, updateProduct, createPriceTier, renamePriceTier,
  deletePriceTier, setTierPrice, clearTierPrice, priceMatrix,
} from '../src/services/pricing.ts';
import { createOrder } from '../src/services/orders.ts';
import { createCustomer } from '../src/services/customers.ts';
import { markStop } from '../src/services/delivery.ts';
import { getInvoiceLedger } from '../src/services/invoices.ts';

let f: Fixture;
before(async () => { f = await setupFixture(); });
after(async () => { await f.close(); });

describe('Price tiers', () => {
  test('the real-world tiers can be set up', async () => {
    const wholesale = await createPriceTier(f.db, f.office, 'Wholesale');
    const distributor = await createPriceTier(f.db, f.office, 'Distributor');
    const retail = await createPriceTier(f.db, f.office, 'Retail');
    assert.ok(wholesale.id && distributor.id && retail.id);

    const m = await priceMatrix(f.db);
    const names = m.tiers.map((t) => t.name).sort();
    assert.deepEqual(names, ['Corporate', 'Distributor', 'Retail', 'Wholesale']);
  });

  test('duplicate tier names are rejected, case-insensitively', async () => {
    await assert.rejects(createPriceTier(f.db, f.office, 'wholesale'), /already exists/);
  });

  test('a tier can be renamed', async () => {
    const t = await createPriceTier(f.db, f.office, 'Typo Terr');
    await renamePriceTier(f.db, f.office, t.id, 'Hotel');
    const m = await priceMatrix(f.db);
    assert.ok(m.tiers.some((x) => x.name === 'Hotel'));
  });

  test('a tier in use by a customer cannot be deleted', async () => {
    const m = await priceMatrix(f.db);
    const corporate = m.tiers.find((t) => t.name === 'Corporate')!;
    assert.ok(corporate.customerCount > 0, 'the fixture has customers on Corporate');
    await assert.rejects(
      deletePriceTier(f.db, f.admin, corporate.id), /customer\(s\) are on the Corporate tier/,
    );
  });

  test('an unused tier can be deleted by an admin only', async () => {
    const t = await createPriceTier(f.db, f.office, 'Temporary');
    await assert.rejects(deletePriceTier(f.db, f.office, t.id), /requires role admin/);
    await deletePriceTier(f.db, f.admin, t.id);
    const m = await priceMatrix(f.db);
    assert.ok(!m.tiers.some((x) => x.name === 'Temporary'));
  });
});

describe('The rate card', () => {
  test('case tiers price per case, and the 5-gallon tiers price per bottle', async () => {
    const m = await priceMatrix(f.db);
    const wholesale = m.tiers.find((t) => t.name === 'Wholesale')!;
    const distributor = m.tiers.find((t) => t.name === 'Distributor')!;
    const retail = m.tiers.find((t) => t.name === 'Retail')!;

    // Case sales: Retail 1,280 / Wholesale 1,150 / Distributor 1,050 per case
    await setTierPrice(f.db, f.office, {
      priceTierId: retail.id, productId: f.casedProductId, priceCents: 128_000,
    });
    await setTierPrice(f.db, f.office, {
      priceTierId: wholesale.id, productId: f.casedProductId, priceCents: 115_000,
    });
    await setTierPrice(f.db, f.office, {
      priceTierId: distributor.id, productId: f.casedProductId, priceCents: 105_000,
    });
    // 5-gallon: Retail 480 per bottle (Corporate is already 450 from the fixture)
    await setTierPrice(f.db, f.office, {
      priceTierId: retail.id, productId: f.fiveGalProductId, priceCents: 48_000,
    });

    const after = await priceMatrix(f.db);
    const cased = after.products.find((p) => p.id === f.casedProductId)!;
    const fiveGal = after.products.find((p) => p.id === f.fiveGalProductId)!;

    assert.equal(cased.unit, 'case');
    assert.equal(cased.tierPrices[distributor.id], 105_000);
    assert.equal(fiveGal.unit, 'bottle');
    assert.equal(fiveGal.tierPrices[retail.id], 48_000);

    // A tier need not cover every product: Wholesale has no 5-gallon rate.
    assert.equal(fiveGal.tierPrices[wholesale.id], undefined);
  });

  test('a rate is stored in the correct column for the product unit', async () => {
    const m = await priceMatrix(f.db);
    const distributor = m.tiers.find((t) => t.name === 'Distributor')!;
    const row = await f.db.one<{ c: number; b: number }>(
      `SELECT price_per_case_cents c, price_per_bottle_cents b
       FROM price_lists WHERE price_tier_id = $1 AND product_id = $2`,
      [distributor.id, f.casedProductId],
    );
    assert.equal(Number(row.c), 105_000, 'cased goods carry a per-case rate');
    assert.equal(Number(row.b), 0, 'and no per-bottle rate to be picked up by mistake');
  });

  test('a customer on a tier is charged that tier rate', async () => {
    const m = await priceMatrix(f.db);
    const distributor = m.tiers.find((t) => t.name === 'Distributor')!;
    const c = await createCustomer(f.db, f.office, {
      name: 'Big Distributor Ltd', phone: '876', email: 'd@x.jm',
      priceTierId: distributor.id, deliveryZone: 'Kingston',
    });

    const order = await createOrder(f.db, f.office, {
      customerId: c.id, deliveryMode: 'Pickup',
      lines: [{ productId: f.casedProductId, cases: 10 }],
    });
    // 10 x 1,050.00 = 10,500.00 + 15% = 12,075.00
    assert.equal(order.subtotalCents, 1_050_000);
    assert.equal(order.grandTotalCents, 1_207_500);
  });

  test('clearing a rate falls the customer back to list price', async () => {
    const m = await priceMatrix(f.db);
    const retail = m.tiers.find((t) => t.name === 'Retail')!;
    const c = await createCustomer(f.db, f.office, {
      name: 'Fallback Shop', phone: '8', email: 'fb@x.jm', priceTierId: retail.id,
    });

    const withRate = await createOrder(f.db, f.office, {
      customerId: c.id, deliveryMode: 'Pickup',
      lines: [{ productId: f.casedProductId, cases: 1 }],
    });
    assert.equal(withRate.subtotalCents, 128_000, 'the Retail rate');

    await clearTierPrice(f.db, f.office, retail.id, f.casedProductId);

    const afterClear = await createOrder(f.db, f.office, {
      customerId: c.id, deliveryMode: 'Pickup',
      lines: [{ productId: f.casedProductId, cases: 1 }],
    });
    // The fixture product's own list price is 1,300.00 per case.
    assert.equal(afterClear.subtotalCents, 130_000, 'falls back to the list price');
  });

  test('a negative rate is rejected', async () => {
    const m = await priceMatrix(f.db);
    const retail = m.tiers.find((t) => t.name === 'Retail')!;
    await assert.rejects(
      setTierPrice(f.db, f.office, {
        priceTierId: retail.id, productId: f.casedProductId, priceCents: -100,
      }),
      /cannot be negative/,
    );
  });
});

describe('Repricing never rewrites history', () => {
  test('an existing order and its invoice keep the price they were agreed at', async () => {
    const m = await priceMatrix(f.db);
    const wholesale = m.tiers.find((t) => t.name === 'Wholesale')!;
    const c = await createCustomer(f.db, f.office, {
      name: 'History Ltd', phone: '8', email: 'h@x.jm',
      priceTierId: wholesale.id, deliveryZone: 'Kingston',
    });

    const order = await createOrder(f.db, f.office, {
      customerId: c.id, deliveryMode: 'Delivery',
      requestedDeliveryDate: '2027-08-02',
      lines: [{ productId: f.casedProductId, cases: 10 }],
    });
    // 10 x 1,150.00 = 11,500.00 + 15% = 13,225.00
    assert.equal(order.grandTotalCents, 1_322_500);

    // Deliver it, producing an invoice at that price.
    const [stop] = await stopsOf(f.db, order.deliverySheetId!);
    const delivered = await markStop(f.db, f.driver, {
      stopId: stop.id, outcome: 'Delivered',
    });
    const invoiceBefore = await getInvoiceLedger(f.db, delivered.invoiceId!);
    assert.equal(invoiceBefore!.grandTotalCents, 1_322_500);

    // Now put the Wholesale rate up sharply.
    await setTierPrice(f.db, f.office, {
      priceTierId: wholesale.id, productId: f.casedProductId, priceCents: 200_000,
    });

    // Neither the order nor the invoice moves.
    const orderAfter = await f.db.one<{ grand_total_cents: number }>(
      `SELECT grand_total_cents FROM customer_orders WHERE id = $1`, [order.id],
    );
    assert.equal(Number(orderAfter.grand_total_cents), 1_322_500);
    const invoiceAfter = await getInvoiceLedger(f.db, delivered.invoiceId!);
    assert.equal(invoiceAfter!.grandTotalCents, 1_322_500,
      'the customer is not re-billed at the new rate');

    // Only the NEXT order picks up the new price.
    const next = await createOrder(f.db, f.office, {
      customerId: c.id, deliveryMode: 'Pickup',
      lines: [{ productId: f.casedProductId, cases: 10 }],
    });
    assert.equal(next.subtotalCents, 2_000_000);
  });
});

describe('Products', () => {
  test('a new cased product can be added and priced', async () => {
    const p = await createProduct(f.db, f.office, {
      name: 'Alka Vida 750ml', size: '750ml',
      bottlesPerCase: 12, pricePerCaseCents: 150_000,
    });
    const m = await priceMatrix(f.db);
    const row = m.products.find((x) => x.id === p.id)!;
    assert.equal(row.unit, 'case');
    assert.equal(row.listPriceCents, 150_000);
  });

  test('a product sold individually can be added', async () => {
    const p = await createProduct(f.db, f.office, {
      name: 'Alka Vida 3 Gallon', bottlesPerCase: 0,
      pricePerBottleCents: 30_000, isReturnable: true,
    });
    const m = await priceMatrix(f.db);
    const row = m.products.find((x) => x.id === p.id)!;
    assert.equal(row.unit, 'bottle');
    assert.equal(row.listPriceCents, 30_000);
    assert.equal(row.isReturnable, true);
  });

  test('a product must be priced in the unit it is sold in', async () => {
    await assert.rejects(
      createProduct(f.db, f.office, {
        name: 'No case price', bottlesPerCase: 24, pricePerBottleCents: 500,
      }),
      /needs a price per case/,
    );
    await assert.rejects(
      createProduct(f.db, f.office, {
        name: 'No bottle price', bottlesPerCase: 0, pricePerCaseCents: 500,
      }),
      /needs a price per bottle/,
    );
  });

  test('the case size of an already-sold product cannot be changed', async () => {
    await assert.rejects(
      updateProduct(f.db, f.office, f.casedProductId, { bottlesPerCase: 12 }),
      /already been sold/,
    );
  });

  test('a retired product cannot be ordered but its history survives', async () => {
    const p = await createProduct(f.db, f.office, {
      name: 'Discontinued 250ml', bottlesPerCase: 24, pricePerCaseCents: 70_000,
    });
    await updateProduct(f.db, f.office, p.id, { active: false });

    await assert.rejects(
      createOrder(f.db, f.office, {
        customerId: f.customerId, deliveryMode: 'Pickup',
        lines: [{ productId: p.id, cases: 1 }],
      }),
      /no longer sold/,
    );

    // Still visible on the pricing screen, marked inactive.
    const m = await priceMatrix(f.db);
    assert.equal(m.products.find((x) => x.id === p.id)!.active, false);
  });

  test('the list price can be corrected in place', async () => {
    const p = await createProduct(f.db, f.office, {
      name: 'Mispriced 1L', bottlesPerCase: 12, pricePerCaseCents: 1_000,
    });
    await updateProduct(f.db, f.office, p.id, { pricePerCaseCents: 140_000 });
    const m = await priceMatrix(f.db);
    assert.equal(m.products.find((x) => x.id === p.id)!.listPriceCents, 140_000);
  });
});
