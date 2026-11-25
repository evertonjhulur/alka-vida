/**
 * Charges and services as products (Everton, 25 Nov 2026).
 *
 * "In the creation of products, its all tied to bottles at the moment. So if
 * we only want to charge for packaging because arrangements changed we are
 * unable to do this." BML makes its coolant; Alka Vida gives the labour and
 * the case packaging, invoiced per case, seen only by BML. Other charges (a
 * delivery fee) work the same way.
 *
 *   - A charge is created with its unit; it is never cased or returnable.
 *   - One on a client's brand is offered and sold to that client only; one on
 *     our brand to anyone, a client who buys only their own brands included.
 *   - Office only: never on the portal or the website.
 *   - Never stock: not loaded on a truck, not taken off the shelf when sold,
 *     not made on Production, not counted.
 *   - It invoices like any line, and is worded in its own unit.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { createProduct, updateProduct, priceMatrix, setTierPrice } from '../src/services/pricing.ts';
import { createOrder, createPortalOrder } from '../src/services/orders.ts';
import { counterSale } from '../src/services/counter.ts';
import { customerPrices } from '../src/services/customers.ts';
import { createBrand, setCustomerBrands } from '../src/services/brands.ts';
import { markStop } from '../src/services/delivery.ts';
import { loadRound, confirmLoad, truckPosition } from '../src/services/trucks.ts';
import { completeProduction } from '../src/services/inventory.ts';
import { stockSnapshot, recordCount } from '../src/services/audits.ts';
import { invoiceEmailFigures, qtyWords, renderInvoicePdf } from '../src/services/documents.ts';
import { inflateSync } from 'node:zlib';
import { siteInfo } from '../src/services/website.ts';
import { businessToday } from '../src/services/core.ts';
import { addDays, unitCount, perUnit } from '@alka/shared';

let f: Fixture;
let bmlBrand: string; let bml: string; let packaging: string; let deliveryFee: string; let melkleen: string;
const today = businessToday();

const customer = async (name: string) => (await f.db.one<{ id: string }>(
  `INSERT INTO customers (name, phone, email, delivery_address, delivery_zone)
   VALUES ($1,'876-555-0101','','1 Test Rd','Kingston') RETURNING id`, [name])).id;
const offered = async (customerId: string) =>
  (await customerPrices(f.db, customerId)).map((p) => (p as { name: string }).name).sort();
const stock = async (productId: string) => (await f.db.maybeOne<{ q: number }>(
  `SELECT quantity_on_hand AS q FROM finished_goods_stock WHERE product_id = $1`, [productId]))?.q ?? null;

before(async () => {
  f = await setupFixture();
  bmlBrand = (await createBrand(f.db, f.office, { name: 'BML', type: 'Third-Party Co-Pack' })).id;
  bml = await customer('Brand Management & Logistics');
  melkleen = await customer('Melkleen Distributors Ltd');
  await setCustomerBrands(f.db, f.office, bml, { brandIds: [bmlBrand] });
  const cool = (await createBrand(f.db, f.office, { name: 'Cool Cool', type: 'Third-Party Co-Pack' })).id;
  await setCustomerBrands(f.db, f.office, melkleen, { brandIds: [cool], buysOwnBrand: false });
});
after(async () => { await f.close(); });

/** The text pdfkit drew: its content streams are deflated, strings hex-encoded. */
function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  let out = '';
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    let body: string;
    try { body = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { continue; }
    for (const h of body.matchAll(/<([0-9a-fA-F]+)>/g)) out += Buffer.from(h[1], 'hex').toString('latin1');
    out += '\n';
  }
  return out;
}

describe('Making a charge', () => {
  test('it needs a unit and a price, and is never cased or returnable', async () => {
    await assert.rejects(createProduct(f.db, f.office, {
      name: 'Coolant packaging', bottlesPerCase: 0, pricePerBottleCents: 15000, isCharge: true, chargeUnit: ' ',
    }), /what the charge is per/);
    await assert.rejects(createProduct(f.db, f.office, {
      name: 'Coolant packaging', bottlesPerCase: 0, isCharge: true, chargeUnit: 'case',
    }), /a charge needs a price/);

    packaging = (await createProduct(f.db, f.office, {
      // Whatever the form sends for cases or returnable, a charge is neither.
      name: 'Coolant – labour & case packaging', bottlesPerCase: 24, isReturnable: true, size: '1 gal',
      pricePerBottleCents: 15000, brandId: bmlBrand, isCharge: true, chargeUnit: 'Case',
    })).id;
    deliveryFee = (await createProduct(f.db, f.office, {
      name: 'Delivery fee', bottlesPerCase: 0, pricePerBottleCents: 50000,
      brandId: f.brandId, isCharge: true, chargeUnit: 'delivery',
    })).id;

    const row = await f.db.one(`SELECT * FROM products WHERE id = $1`, [packaging]);
    assert.equal(Number(row.bottles_per_case), 0);
    assert.equal(row.is_returnable, false);
    assert.equal(row.size, null);
    assert.equal(row.charge_unit, 'case');

    const m = await priceMatrix(f.db);
    const p = m.products.find((x) => x.id === packaging)!;
    assert.equal(p.unit, 'charge');
    assert.equal(p.isCharge, true);
    assert.equal(p.chargeUnit, 'case');
    assert.equal(p.listPriceCents, 15000);
  });

  test('its unit can change; it cannot be turned into water, cased or returnable', async () => {
    await updateProduct(f.db, f.office, deliveryFee, { chargeUnit: 'Trip' });
    assert.equal((await f.db.one(`SELECT charge_unit FROM products WHERE id = $1`, [deliveryFee])).charge_unit, 'trip');
    await updateProduct(f.db, f.office, deliveryFee, { chargeUnit: 'delivery' });
    await assert.rejects(updateProduct(f.db, f.office, deliveryFee, { isCharge: false }), /cannot be switched/);
    await assert.rejects(updateProduct(f.db, f.office, deliveryFee, { bottlesPerCase: 12 }), /own unit/);
    await assert.rejects(updateProduct(f.db, f.office, deliveryFee, { isReturnable: true }), /own unit/);
    // Water stays water.
    await assert.rejects(updateProduct(f.db, f.office, f.casedProductId, { isCharge: true }), /cannot be switched/);
  });

  test('it takes price-list rates like any product', async () => {
    await setTierPrice(f.db, f.office, { priceTierId: f.tierId, productId: deliveryFee, priceCents: 40000 });
    const prices = await customerPrices(f.db, f.customerId) as Array<{ name: string; price_per_bottle_cents: number; is_charge: boolean; charge_unit: string }>;
    const fee = prices.find((p) => p.name === 'Delivery fee')!;
    assert.equal(Number(fee.price_per_bottle_cents), 40000);
    assert.equal(fee.is_charge, true);
    assert.equal(fee.charge_unit, 'delivery');
  });
});

describe('Who sees a charge', () => {
  test("a client's packaging only that client; our delivery fee everyone", async () => {
    assert.ok((await offered(bml)).includes('Coolant – labour & case packaging'));
    assert.ok(!(await offered(f.customerId)).includes('Coolant – labour & case packaging'));
    assert.ok((await offered(f.customerId)).includes('Delivery fee'));
    // Melkleen buys only its own brand, but can still be charged our delivery fee.
    assert.deepEqual(await offered(melkleen), ['Delivery fee']);

    await assert.rejects(createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Pickup', lines: [{ productId: packaging, looseBottles: 10 }],
    } as never), /bottled for another customer/);
  });

  test('office only: not orderable on the portal, not on the website', async () => {
    const portal = { ...f.admin, role: 'customer' as const, customerId: bml };
    await assert.rejects(createPortalOrder(f.db, portal, bml, {
      lines: [{ productId: packaging, looseBottles: 5 }],
    }), /charge the office adds/);
    const site = await siteInfo(f.db);
    assert.ok(!site.products.some((p) => p.id === deliveryFee || p.id === packaging));
  });
});

describe('Never stock', () => {
  test('a round: water is loaded and comes off stock; the charge is invoiced only', async () => {
    await f.db.query(
      `INSERT INTO finished_goods_stock (product_id, quantity_on_hand) VALUES ($1, 240)
       ON CONFLICT (product_id) DO UPDATE SET quantity_on_hand = 240`, [f.casedProductId]);
    const day = addDays(today, 3);
    const o = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Delivery', requestedDeliveryDate: day,
      lines: [{ productId: f.casedProductId, cases: 2 }, { productId: deliveryFee, looseBottles: 1 }],
    });
    // 2 cases at the Corporate J$1,200 + one delivery at the Corporate J$400.
    assert.equal(o.subtotalCents, 240000 + 40000);
    const st = await f.db.one<{ id: string; delivery_sheet_id: string }>(
      `SELECT id, delivery_sheet_id FROM delivery_stops WHERE order_id = $1`, [o.id]);

    await loadRound(f.db, f.office, st.delivery_sheet_id, {});
    const load = await f.db.query<{ product_id: string; loaded_bottles: number }>(
      `SELECT product_id, loaded_bottles FROM round_load_lines WHERE delivery_sheet_id = $1`, [st.delivery_sheet_id]);
    assert.deepEqual(load.map((l) => [l.product_id, Number(l.loaded_bottles)]), [[f.casedProductId, 48]]);
    await confirmLoad(f.db, f.driver, st.delivery_sheet_id);
    assert.equal(Number(await stock(f.casedProductId)), 192);

    const r = await markStop(f.db, f.driver, { stopId: st.id, outcome: 'Delivered' });
    const pos = await truckPosition(f.db, st.delivery_sheet_id);
    assert.ok(!pos!.lines.some((l) => l.productId === deliveryFee), 'a charge is never on the truck');
    assert.equal(await stock(deliveryFee), null, 'no stock row for a charge');

    const lines = await f.db.query<{ product_id: string; loose_bottles: number; line_total_cents: number }>(
      `SELECT product_id, loose_bottles, line_total_cents FROM invoice_line_items WHERE invoice_id = $1`, [r.invoiceId]);
    const fee = lines.find((l) => l.product_id === deliveryFee)!;
    assert.equal(Number(fee.loose_bottles), 1);
    assert.equal(Number(fee.line_total_cents), 40000);

    const email = await invoiceEmailFigures(f.db, r.invoiceId!);
    assert.ok(email.items.some((i) => i.name === 'Delivery fee' && i.qty === '1 delivery'));
    // The invoice PDF describes it by its unit, not as a bottle size.
    const pdf = (await renderInvoicePdf(f.db, r.invoiceId!)).pdf;
    assert.ok(pdfText(pdf).includes('per delivery'));
    assert.ok(email.items.some((i) => i.name === 'Alka Vida 500ml' && i.qty === '2 cases'));
  });

  test('a counter sale of packaging moves no stock', async () => {
    const before = await f.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM inventory_transactions`);
    const sale = await counterSale(f.db, f.office, {
      customerId: bml, lines: [{ productId: packaging, looseBottles: 12 }],
    } as never);
    assert.equal(sale.grandTotalCents, Math.round(12 * 15000 * 1.15));
    const after = await f.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM inventory_transactions`);
    assert.equal(Number(after.n), Number(before.n));
    assert.equal(await stock(packaging), null);
    const email = await invoiceEmailFigures(f.db, sale.invoiceId);
    assert.equal(email.items[0].qty, '12 cases');
  });

  test('not made on Production, not counted, not on the stock list', async () => {
    await assert.rejects(completeProduction(f.db, f.office, { productId: packaging, looseBottles: 10 }),
      /charge or service, not something made/);
    await assert.rejects(recordCount(f.db, f.office, {
      itemType: 'FinishedGoods', itemId: deliveryFee, countedQty: 3,
    } as never), /not stock, so it is not counted/);
    const snap = await stockSnapshot(f.db) as { goods: Array<{ productId?: string; product_id?: string }> };
    assert.ok(!JSON.stringify(snap).includes(deliveryFee));
  });
});

describe('Wording', () => {
  test('a charge is counted in its own unit', () => {
    assert.equal(unitCount(12, 'case'), '12 cases');
    assert.equal(unitCount(1, 'delivery'), '1 delivery');
    assert.equal(unitCount(3, 'delivery'), '3 deliveries');
    assert.equal(unitCount(2, 'box'), '2 boxes');
    assert.equal(unitCount(4, 'each'), '4');
    assert.equal(perUnit('case'), 'per case');
    assert.equal(perUnit('each'), 'each');
    assert.equal(qtyWords(0, 0, 5, 'trip'), '5 trips');
    assert.equal(qtyWords(24, 3, 0), '3 cases');
  });
});
