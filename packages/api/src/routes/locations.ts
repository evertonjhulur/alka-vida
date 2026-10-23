/**
 * HTTP routes for map pins and sorting a round's stops (23 Oct 2026).
 * The rules are in services/locations.ts.
 */

import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.ts';
import type { Actor } from '../services/core.ts';
import type { Session } from '../lib/auth.ts';
import * as locations from '../services/locations.ts';

type Guard = (...roles: Session['role'][]) => (req: never, reply: never) => Promise<void>;

export function registerLocationRoutes(
  app: FastifyInstance,
  db: Db,
  h: { allow: Guard; actorOf: (req: { session?: Session }) => Actor },
) {
  const { allow, actorOf } = h;
  const office = { preHandler: allow('admin', 'user') as never };
  const crew = { preHandler: allow('admin', 'user', 'driver') as never };
  const admin = { preHandler: allow('admin') as never };
  const id = (req: { params: unknown }) => (req.params as { id: string }).id;

  // The plant, and whether road-map sorting is on.
  app.get('/api/settings/routing', crew, async () => locations.routingSettings(db));
  app.put('/api/settings/plant-location', admin, async (req) =>
    locations.setPlantLocation(db, actorOf(req), req.body as { lat?: number; lng?: number; text?: string }));

  // Pins on a customer's addresses.
  app.get('/api/customers/:id/pins', office, async (req) => locations.customerPins(db, id(req)));
  app.put('/api/customers/:id/pin', office, async (req) =>
    locations.setCustomerPin(db, actorOf(req), id(req), req.body as locations.PinInput & { clear?: boolean }));

  // The driver saves where they are standing.
  app.post('/api/stops/:id/location', crew, async (req) =>
    locations.setStopPin(db, actorOf(req), id(req), req.body as { lat?: number; lng?: number; accuracyM?: number }));

  // Sorting a round, before it starts.
  app.post('/api/delivery-sheets/:id/sort', crew, async (req) =>
    locations.proposeSort(db, actorOf(req), id(req), (req.body as { method?: 'Road' | 'Straight' } | undefined)?.method ?? 'Road'));
  app.post('/api/delivery-sheets/:id/sort/apply', crew, async (req) =>
    locations.applySort(db, actorOf(req), id(req), req.body as { order?: string[]; saveAsUsual?: boolean }));
}
