/** Shared fixture: a fresh migrated database seeded with realistic data. */

import { createPgliteDb, type Db } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import type { Actor } from '../src/services/core.ts';

export interface Fixture {
  db: Db;
  admin: Actor;
  office: Actor;
  driver: Actor;
  brandId: string;
  tierId: string;
  /** 24 x 500ml, sold by the case at JMD 1,200.00/case on the Corporate tier. */
  casedProductId: string;
  /** 5-gallon returnable, sold individually at JMD 450.00/bottle. */
  fiveGalProductId: string;
  /** Corporate customer in the Kingston zone. */
  customerId: string;
  /** A second customer, used for cross-customer reassignment. */
  otherCustomerId: string;
  close(): Promise<void>;
}

export async function setupFixture(): Promise<Fixture> {
  const db = await createPgliteDb();
  await migrate(db, { quiet: true });

  const mkUser = async (email: string, name: string, role: string) =>
    (await db.one<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role)
       VALUES ($1,$2,'x',$3) RETURNING id`, [email, name, role],
    )).id;

  const adminId = await mkUser('admin@alkavida.jm', 'Admin', 'admin');
  const officeId = await mkUser('office@alkavida.jm', 'Office', 'user');
  const driverId = await mkUser('driver@alkavida.jm', 'Driver', 'driver');

  const brandId = (await db.one<{ id: string }>(
    `INSERT INTO brands (name, type, label_source)
     VALUES ('Alka Vida','Owned','Company-purchased') RETURNING id`,
  )).id;

  const casedProductId = (await db.one<{ id: string }>(
    `INSERT INTO products (name, brand_id, size, bottles_per_case,
       price_per_case_cents, price_per_bottle_cents, is_returnable)
     VALUES ('Alka Vida 500ml', $1, '500ml', 24, 130000, 0, false)
     RETURNING id`, [brandId],
  )).id;

  const fiveGalProductId = (await db.one<{ id: string }>(
    `INSERT INTO products (name, brand_id, size, bottles_per_case,
       price_per_case_cents, price_per_bottle_cents, is_returnable)
     VALUES ('Alka Vida 5 Gallon', $1, '5gal', 0, 0, 50000, true)
     RETURNING id`, [brandId],
  )).id;

  // Corporate tier: cheaper than list price on both products.
  const tierId = (await db.one<{ id: string }>(
    `INSERT INTO price_tiers (name) VALUES ('Corporate') RETURNING id`,
  )).id;
  await db.query(
    `INSERT INTO price_lists (price_tier_id, product_id, price_per_case_cents, price_per_bottle_cents)
     VALUES ($1,$2,120000,0), ($1,$3,0,45000)`,
    [tierId, casedProductId, fiveGalProductId],
  );

  const customerId = (await db.one<{ id: string }>(
    `INSERT INTO customers (name, phone, email, brand_id, price_tier_id,
       delivery_address, delivery_zone, route_sequence, payment_terms)
     VALUES ('Blue Mountain Offices','8765551234','ap@bluemountain.jm',$1,$2,
             '12 Hope Road, Kingston','Kingston',10,'Net 30')
     RETURNING id`, [brandId, tierId],
  )).id;

  const otherCustomerId = (await db.one<{ id: string }>(
    `INSERT INTO customers (name, phone, email, price_tier_id,
       delivery_address, delivery_zone, route_sequence)
     VALUES ('Portmore Pharmacy','8765559999','acct@portmorerx.jm',$1,
             '5 Braeton Parkway, Portmore','Portmore',20)
     RETURNING id`, [tierId],
  )).id;

  await db.query(
    `INSERT INTO five_gal_bottle_pool (label, brand_id, clean_ready)
     VALUES ('Alka Vida 5gal pool', $1, 500)`, [brandId],
  );

  return {
    db,
    admin: { id: adminId, name: 'Admin', role: 'admin' },
    office: { id: officeId, name: 'Office', role: 'user' },
    driver: { id: driverId, name: 'Driver', role: 'driver' },
    brandId, tierId, casedProductId, fiveGalProductId, customerId, otherCustomerId,
    close: () => db.close(),
  };
}

/** Every stop on a sheet, in route order. */
export async function stopsOf(db: Db, sheetId: string) {
  return db.query<{ id: string; order_id: string; stop_outcome: string }>(
    `SELECT id, order_id, stop_outcome FROM delivery_stops
     WHERE delivery_sheet_id = $1 ORDER BY sequence_no`, [sheetId],
  );
}

/** All payments for a customer, oldest first. */
export async function paymentsOf(db: Db, customerId: string) {
  return db.query<{
    id: string; invoice_id: string | null; amount_cents: number;
    status: string; is_reversal: boolean;
  }>(
    `SELECT id, invoice_id, amount_cents, status, is_reversal
     FROM payments WHERE customer_id = $1 ORDER BY created_at, amount_cents DESC`,
    [customerId],
  );
}
