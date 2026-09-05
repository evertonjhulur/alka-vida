/**
 * Seed a working dataset: users, brands, the real product line, pricing
 * tiers, suppliers with price breaks, BOMs, customers and opening stock.
 *
 * Idempotent - safe to re-run; it skips seeding if users already exist.
 */

import { createDb, type Db } from './index.ts';
import { migrate } from './migrate.ts';
import { hashPassword } from '../lib/auth.ts';

export async function seed(db: Db, opts: { quiet?: boolean } = {}): Promise<void> {
  const log = (m: string) => { if (!opts.quiet) console.log(m); };

  const existing = await db.query(`SELECT id FROM users LIMIT 1`);
  if (existing.length > 0) { log('already seeded, skipping'); return; }

  await db.tx(async (t) => {
    /* users */
    const mk = async (email: string, name: string, role: string, pw: string) =>
      (await t.one<{ id: string }>(
        `INSERT INTO users (email, name, password_hash, role)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [email, name, await hashPassword(pw), role],
      )).id;

    await mk('admin@alkavida.jm', 'System Administrator', 'admin', 'admin1234');
    await mk('office@alkavida.jm', 'Office Clerk', 'user', 'office1234');
    const driverId = await mk('driver@alkavida.jm', 'Route Driver', 'driver', 'driver1234');
    const portalUserId = await mk('ap@bluemountain.jm', 'Blue Mountain AP', 'customer', 'portal1234');

    /* brands */
    const alkaVida = (await t.one<{ id: string }>(
      `INSERT INTO brands (name, type, label_source)
       VALUES ('Alka Vida','Owned','Company-purchased') RETURNING id`,
    )).id;
    const coPack = (await t.one<{ id: string }>(
      `INSERT INTO brands (name, type, label_source)
       VALUES ('Island Fresh (co-pack)','Third-Party Co-Pack','Customer-supplied') RETURNING id`,
    )).id;

    /* products - bottles_per_case is 0 ONLY for the 5-gallon line */
    const product = async (name: string, brand: string, size: string, bpc: number,
                           caseCents: number, bottleCents: number, returnable = false) =>
      (await t.one<{ id: string }>(
        `INSERT INTO products (name, brand_id, size, bottles_per_case,
           price_per_case_cents, price_per_bottle_cents, is_returnable)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [name, brand, size, bpc, caseCents, bottleCents, returnable],
      )).id;

    const p280 = await product('Alka Vida 280ml', alkaVida, '280ml', 24, 90_000, 0);
    const p500 = await product('Alka Vida 500ml', alkaVida, '500ml', 24, 130_000, 0);
    const p1500 = await product('Alka Vida 1.5L', alkaVida, '1.5L', 12, 180_000, 0);
    const p5L = await product('Alka Vida 5L', alkaVida, '5L', 4, 220_000, 0);
    const p5gal = await product('Alka Vida 5 Gallon', alkaVida, '5gal', 0, 0, 50_000, true);
    await product('Island Fresh 500ml', coPack, '500ml', 24, 110_000, 0);

    /* pricing tiers */
    const tier = async (name: string) =>
      (await t.one<{ id: string }>(
        `INSERT INTO price_tiers (name) VALUES ($1) RETURNING id`, [name],
      )).id;
    // Case sales run on Retail / Wholesale / Distributor.
    // The 5-gallon line runs on Corporate / Retail.
    const corporate = await tier('Corporate');
    const retail = await tier('Retail');
    const wholesale = await tier('Wholesale');
    const distributor = await tier('Distributor');

    const rate = async (tierId: string, productId: string, c: number, b: number) =>
      t.query(
        `INSERT INTO price_lists (price_tier_id, product_id,
           price_per_case_cents, price_per_bottle_cents) VALUES ($1,$2,$3,$4)`,
        [tierId, productId, c, b],
      );
    // Case rates, cheapest tier last. A tier deliberately does not have to
    // carry every product - a blank falls back to the product list price.
    for (const [t, r280, r500, r1500, r5L] of [
      [retail,      86_000, 128_000, 176_000, 215_000],
      [wholesale,   80_000, 118_000, 164_000, 200_000],
      [distributor, 74_000, 108_000, 152_000, 188_000],
      [corporate,   82_000, 120_000, 168_000, 205_000],
    ] as const) {
      await rate(t, p280, r280, 0);
      await rate(t, p500, r500, 0);
      await rate(t, p1500, r1500, 0);
      await rate(t, p5L, r5L, 0);
    }

    // The 5-gallon line is priced per bottle, and only on these two tiers.
    await rate(corporate, p5gal, 0, 45_000);
    await rate(retail, p5gal, 0, 48_000);

    /* suppliers, materials and volume pricing */
    const supplier = async (name: string, contact: string) =>
      (await t.one<{ id: string }>(
        `INSERT INTO suppliers (name, contact_person, phone)
         VALUES ($1,$2,'876-555-0100') RETURNING id`, [name, contact],
      )).id;
    const preformCo = await supplier('Caribbean Preforms Ltd', 'M. Chen');
    const capCo = await supplier('Kingston Closures', 'A. Brown');
    const labelCo = await supplier('Island Labels', 'D. Ellis');

    const material = async (name: string, category: string, spec: string | null,
                            unitCost: number, reorder: number) =>
      (await t.one<{ id: string }>(
        `INSERT INTO raw_materials (name, category, size_spec, unit_cost_cents,
           reorder_point, quantity_on_hand)
         VALUES ($1,$2,$3,$4,$5,0) RETURNING id`,
        [name, category, spec, unitCost, reorder],
      )).id;

    /**
     * The real catalogue. Sizes come from the fixed list the materials screen
     * offers, so the same cap is never entered three different ways.
     *
     * Caps: 28mm covers 280ml/500ml/1.5L, 48mm the 5L, 55mm the 5-gallon.
     * Handles are 5L ONLY. Labels go on everything up to 5gal; 5-gallon
     * bottles are rotated and relabelled as needed, so they carry no label
     * line here - that usage is recorded against the material when it happens.
     */
    const preform280 = await material('280ml preform', 'Bottle', '280ml', 700, 20_000);
    const preform500 = await material('500ml preform', 'Bottle', '500ml', 900, 20_000);
    const preform1500 = await material('1.5L preform', 'Bottle', '1.5L', 1_400, 15_000);
    const bottle5L = await material('5L bottle', 'Bottle', '5L', 4_800, 3_000);
    const bottle5gal = await material('5 gallon bottle', 'Bottle', '5gal', 95_000, 100);

    const cap28 = await material('28mm cap', 'Cap', '28mm', 400, 30_000);
    const cap48 = await material('48mm cap', 'Cap', '48mm', 900, 6_000);
    const cap55 = await material('55mm cap', 'Cap', '55mm', 1_100, 1_500);

    const label280 = await material('280ml label', 'Label', '280ml', 200, 25_000);
    const label500 = await material('500ml label', 'Label', '500ml', 250, 25_000);
    const label1500 = await material('1.5L label', 'Label', '1.5L', 320, 15_000);
    const label5L = await material('5L label', 'Label', '5L', 480, 3_000);
    const label5gal = await material('5 gallon label', 'Label', '5gal', 900, 800);

    const handle5L = await material('5L handle', 'Handle', null, 1_200, 3_000);
    const water = await material('Purified water', 'Water', null, 30, 5_000);

    /**
     * Who sells what, at what price. A purchase order takes the best break
     * for the quantity ordered and freezes it on the line; what is actually
     * paid on receipt becomes the cost of that stock.
     */
    const sells = async (supplierId: string, materialId: string, unitCost: number,
                         breaks: Array<[number, number]> = []) => {
      await t.query(
        `INSERT INTO supplier_materials (supplier_id, raw_material_id, unit_cost_cents)
         VALUES ($1,$2,$3)`,
        [supplierId, materialId, unitCost],
      );
      for (const [minQty, cost] of breaks) {
        await t.query(
          `INSERT INTO supplier_price_breaks
             (supplier_id, raw_material_id, min_qty, unit_cost_cents)
           VALUES ($1,$2,$3,$4)`,
          [supplierId, materialId, minQty, cost],
        );
      }
    };

    // Bottles and preforms - the more ordered, the cheaper each becomes.
    await sells(preformCo, preform280, 700, [[10_000, 660], [50_000, 620]]);
    await sells(preformCo, preform500, 900, [[10_000, 850], [50_000, 780]]);
    await sells(preformCo, preform1500, 1_400, [[10_000, 1_320]]);
    await sells(preformCo, bottle5L, 4_800, [[2_000, 4_500]]);
    await sells(preformCo, bottle5gal, 95_000, [[200, 91_000]]);

    // Closures.
    await sells(capCo, cap28, 400, [[20_000, 360], [100_000, 330]]);
    await sells(capCo, cap48, 900, [[5_000, 840]]);
    await sells(capCo, cap55, 1_100, [[1_000, 1_020]]);
    await sells(capCo, handle5L, 1_200, [[5_000, 1_100]]);

    // Print.
    await sells(labelCo, label280, 200, [[20_000, 180]]);
    await sells(labelCo, label500, 250, [[20_000, 225]]);
    await sells(labelCo, label1500, 320, [[10_000, 290]]);
    await sells(labelCo, label5L, 480, [[5_000, 440]]);
    await sells(labelCo, label5gal, 900, [[500, 820]]);

    /* bills of material, per ONE bottle produced */
    const bom = async (
      productId: string,
      lines: Array<[string, string, number]>,
    ) => {
      for (const [materialId, componentType, qty] of lines) {
        await t.query(
          `INSERT INTO bom_line_items (product_id, raw_material_id, component_type, quantity)
           VALUES ($1,$2,$3,$4)`,
          [productId, materialId, componentType, qty],
        );
      }
    };

    await bom(p280, [[preform280, 'Bottle', 1], [cap28, 'Cap', 1],
                     [label280, 'Label', 1], [water, 'Water', 0.28]]);
    await bom(p500, [[preform500, 'Bottle', 1], [cap28, 'Cap', 1],
                     [label500, 'Label', 1], [water, 'Water', 0.5]]);
    await bom(p1500, [[preform1500, 'Bottle', 1], [cap28, 'Cap', 1],
                      [label1500, 'Label', 1], [water, 'Water', 1.5]]);
    // The 5L is the ONLY product that takes a handle.
    await bom(p5L, [[bottle5L, 'Bottle', 1], [cap48, 'Cap', 1], [label5L, 'Label', 1],
                    [handle5L, 'Handle', 1], [water, 'Water', 5]]);
    // No handle and no label on the 5-gallon: bottles are rotated, and a
    // returning bottle is relabelled only when it needs one.
    await bom(p5gal, [[bottle5gal, 'Bottle', 1], [cap55, 'Cap', 1],
                      [water, 'Water', 18.9]]);

    /* opening stock
     *
     * Written as real FIFO batches rather than a bare quantity, so the
     * material screens, costing and production all have something true to
     * work from on day one. The two preform batches are deliberately at
     * different costs, which is what makes FIFO visible.
     */
    const openingStock = async (
      materialId: string, supplierId: string | null,
      qty: number, unitCost: number, daysAgo: number,
    ) => {
      const batch = await t.one<{ id: string }>(
        `INSERT INTO material_batches
           (raw_material_id, supplier_id, unit_cost_cents,
            quantity_received, quantity_remaining, received_date)
         VALUES ($1,$2,$3,$4,$4, now() - ($5 || ' days')::interval)
         RETURNING id`,
        [materialId, supplierId, unitCost, qty, String(daysAgo)],
      );
      await t.query(
        `UPDATE raw_materials SET quantity_on_hand = quantity_on_hand + $2 WHERE id = $1`,
        [materialId, qty],
      );
      const m = await t.one<{ name: string }>(
        `SELECT name FROM raw_materials WHERE id = $1`, [materialId],
      );
      await t.query(
        `INSERT INTO inventory_transactions
           (item_type, item_id, item_name, quantity, direction, reference,
            reference_type, unit_cost_cents, total_cost_cents, batch_ids, txn_date)
         VALUES ('RawMaterial',$1,$2,$3,'in','Opening stock','Manual',$4,$5,$6,
                 now() - ($7 || ' days')::interval)`,
        [materialId, m.name, qty, unitCost, Math.round(unitCost * qty),
         [batch.id], String(daysAgo)],
      );
    };

    // Older, cheaper preforms first - production draws these before the newer ones.
    await openingStock(preform500, preformCo, 30_000, 850, 45);
    await openingStock(preform500, preformCo, 25_000, 920, 10);
    await openingStock(preform280, preformCo, 20_000, 700, 30);
    await openingStock(preform1500, preformCo, 12_000, 1_400, 30);
    await openingStock(bottle5L, preformCo, 2_500, 4_800, 40);
    await openingStock(bottle5gal, preformCo, 300, 95_000, 60);

    await openingStock(cap28, capCo, 40_000, 400, 30);
    await openingStock(cap48, capCo, 6_000, 900, 30);
    await openingStock(cap55, capCo, 1_800, 1_100, 30);
    await openingStock(handle5L, capCo, 4_000, 1_200, 40);

    await openingStock(label280, labelCo, 22_000, 200, 30);
    await openingStock(label500, labelCo, 35_000, 250, 30);
    await openingStock(label1500, labelCo, 14_000, 320, 30);
    await openingStock(label5L, labelCo, 4_000, 480, 30);
    await openingStock(label5gal, labelCo, 900, 900, 30);

    await openingStock(water, null, 50_000, 30, 5);

    await t.query(
      `INSERT INTO finished_goods_stock (product_id, quantity_on_hand)
       VALUES ($1, 4800), ($2, 2400), ($3, 600)`,
      [p500, p280, p1500],
    );

    /* customers */
    const customer = async (
      name: string, phone: string, email: string, tierId: string,
      address: string | null, zone: string | null, seq: number,
      day: string | null, terms: string, userId: string | null = null,
    ) =>
      (await t.one<{ id: string }>(
        `INSERT INTO customers (name, phone, email, brand_id, price_tier_id,
           delivery_address, delivery_zone, route_sequence, default_delivery_day,
           payment_terms, user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [name, phone, email, alkaVida, tierId, address, zone, seq, day, terms, userId],
      )).id;

    // The rounds themselves, before anybody is put on one. Migration 014
    // backfills these from customers already on file, but a FRESH install
    // seeds its customers AFTER that migration has run, and would otherwise
    // leave them on rounds the zone list has never heard of.
    const ZONES = [
      ['Kingston', 'Kingston and St Andrew'],
      ['Portmore', 'Portmore and St Catherine'],
      ['North Coast', 'St Ann and St Mary'],
    ] as const;
    for (let i = 0; i < ZONES.length; i++) {
      await t.query(
        `INSERT INTO delivery_zones (name, covers, sort_order) VALUES ($1,$2,$3)
         ON CONFLICT (name) DO NOTHING`,
        [ZONES[i][0], ZONES[i][1], (i + 1) * 10],
      );
    }

    await customer('Blue Mountain Offices', '876-555-1234', 'ap@bluemountain.jm',
      corporate, '12 Hope Road, Kingston 6', 'Kingston', 10, 'Mon', 'Net 30', portalUserId);
    await customer('Portmore Pharmacy', '876-555-9999', 'acct@portmorerx.jm',
      retail, '5 Braeton Parkway, Portmore', 'Portmore', 20, 'Tue', 'Net 15');
    await customer('Half Way Tree Clinic', '876-555-4321', 'admin@hwtclinic.jm',
      corporate, '3 Constant Spring Road, Kingston 10', 'Kingston', 20, 'Mon', 'Net 30');
    await customer('Ocho Rios Resort', '876-555-7777', 'purchasing@ochoresort.jm',
      corporate, 'Main Street, Ocho Rios', 'North Coast', 10, 'Wed', 'Net 30');
    // A cash walk-in still needs a real customer record so a receipt can issue.
    await customer('Cash Walk-In', '000', 'walkin@alkavida.jm',
      retail, null, null, 0, null, 'Cash on delivery');

    /* opening bottle pool */
    await t.query(
      `INSERT INTO five_gal_bottle_pool (label, brand_id, clean_ready,
         filled_with_customer, returned_dirty)
       VALUES ('Alka Vida 5gal pool', $1, 850, 1200, 60)`,
      [alkaVida],
    );

    await t.query(
      `INSERT INTO delivery_sheets (delivery_date, zone, driver_name, assigned_driver_id, vehicle)
       VALUES (business_today(), 'Kingston', 'Route Driver', $1, 'Truck 1')`,
      [driverId],
    );
  });

  log('seeded: 4 users, 2 brands, 6 products, 2 tiers, 3 suppliers, 6 materials, 5 customers');
  log('logins -> admin@alkavida.jm / admin1234 | office@alkavida.jm / office1234');
  log('         driver@alkavida.jm / driver1234 | ap@bluemountain.jm / portal1234');
}

if (import.meta.filename === process.argv[1]) {
  const db = await createDb();
  await migrate(db, { quiet: true });
  await seed(db);
  await db.close();
}
