/**
 * HTTP routes for bottled brands and the customer upload (16 Oct 2026).
 * The rules are in services/brands.ts and services/imports.ts.
 */

import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.ts';
import type { Actor } from '../services/core.ts';
import type { Session } from '../lib/auth.ts';
import * as brands from '../services/brands.ts';
import * as imports from '../services/imports.ts';

type Guard = (...roles: Session['role'][]) => (req: never, reply: never) => Promise<void>;

export function registerBrandRoutes(
  app: FastifyInstance,
  db: Db,
  h: { allow: Guard; actorOf: (req: { session?: Session }) => Actor },
) {
  const { allow, actorOf } = h;
  const office = { preHandler: allow('admin', 'user') as never };

  app.get('/api/brands', office, async () => brands.listBrands(db));

  app.post('/api/brands', office, async (req) =>
    brands.createBrand(db, actorOf(req), req.body as brands.BrandInput));

  app.patch('/api/brands/:id', office, async (req) => {
    await brands.updateBrand(db, actorOf(req), (req.params as { id: string }).id, req.body as brands.BrandInput);
    return { ok: true };
  });

  app.get('/api/customers/:id/brands', office, async (req) =>
    brands.customerBrands(db, (req.params as { id: string }).id));

  app.put('/api/customers/:id/brands', office, async (req) => {
    const id = (req.params as { id: string }).id;
    await brands.setCustomerBrands(db, actorOf(req), id,
      req.body as { brandIds?: string[]; buysOwnBrand?: boolean });
    return brands.customerBrands(db, id);
  });

  // The upload can be a few hundred customers with their open items.
  app.post('/api/customers/import', { ...office, bodyLimit: 20 * 1024 * 1024 }, async (req) =>
    imports.importCustomers(db, actorOf(req), req.body as imports.ImportInput));
}
