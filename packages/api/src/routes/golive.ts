/**
 * Go-live routes (Everton, 25 Oct 2026): starting fresh, and the products and
 * prices upload. The rules are in services/cleanup.ts and services/productimport.ts.
 */

import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.ts';
import type { Actor } from '../services/core.ts';
import type { Session } from '../lib/auth.ts';
import * as cleanup from '../services/cleanup.ts';
import * as productImport from '../services/productimport.ts';

type Guard = (...roles: Session['role'][]) => (req: never, reply: never) => Promise<void>;

export function registerGoLiveRoutes(
  app: FastifyInstance,
  db: Db,
  h: { allow: Guard; actorOf: (req: { session?: Session }) => Actor },
) {
  const { allow, actorOf } = h;
  const admin = { preHandler: allow('admin') as never };

  app.get('/api/start-fresh', admin, async (req) => cleanup.cleanupPreview(db, actorOf(req)));
  app.post('/api/start-fresh', admin, async (req) =>
    cleanup.startFresh(db, actorOf(req), req.body as cleanup.CleanupInput));

  app.post('/api/products/import', admin, async (req) =>
    productImport.importProducts(db, actorOf(req), req.body as productImport.ProductImportInput));
}
