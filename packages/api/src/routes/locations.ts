/**
 * HTTP routes for map pins and sorting a round's stops (23 Oct 2026).
 * The rules are in services/locations.ts.
 */

import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.ts';
import type { Actor } from '../services/core.ts';
import type { Session } from '../lib/auth.ts';
import * as locations from '../services/locations.ts';
import * as places from '../services/places.ts';
import * as approx from '../services/approxpins.ts';

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

  // Approximate pins from the typed address, for everyone with none (31 Oct 2026).
  app.get('/api/settings/approximate-pins', admin, async () => approx.pinCounts(db));
  app.post('/api/settings/approximate-pins', admin, async (req) =>
    approx.approximatePinsForAll(db, actorOf(req), Number((req.body as { max?: number } | undefined)?.max) || 100));

  // Pins on a customer's addresses.
  app.get('/api/customers/:id/pins', office, async (req) => locations.customerPins(db, id(req)));
  app.put('/api/customers/:id/pin', office, async (req) =>
    locations.setCustomerPin(db, actorOf(req), id(req), req.body as locations.PinInput & { clear?: boolean }));

  // The driver saves where they are standing.
  app.post('/api/stops/:id/location', crew, async (req) =>
    locations.setStopPin(db, actorOf(req), id(req), req.body as { lat?: number; lng?: number; accuracyM?: number }));

  // Address suggestions as you type (31 Oct 2026). PUBLIC, because the
  // Open an account form and the website's quick order use them too; held
  // to a daily ceiling and a per-address rate (services/places.ts).
  const ipOf = (req: { headers: Record<string, unknown>; ip: string }) =>
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || req.ip;
  app.get('/api/public/places/config', async () => ({ enabled: places.placesEnabled() }));
  app.get('/api/public/places/suggest', async (req, reply) => {
    if (places.placesTooMany(`s:${ipOf(req as never)}`, 90)) {
      return reply.status(429).send({ error: 'Too many searches from here just now. Wait a few minutes, or find the spot on the map.' });
    }
    return places.suggestPlaces(req.query as { q?: string; session?: string });
  });
  app.get('/api/public/places/lookup', async (req, reply) => {
    if (places.placesTooMany(`l:${ipOf(req as never)}`, 20)) {
      return reply.status(429).send({ error: 'Too many searches from here just now. Wait a few minutes, or find the spot on the map.' });
    }
    const q = req.query as { id?: string; session?: string };
    return places.lookUpPlace(q.id, q.session);
  });

  // Sorting a round, before it starts.
  app.post('/api/delivery-sheets/:id/sort', crew, async (req) =>
    locations.proposeSort(db, actorOf(req), id(req), (req.body as { method?: 'Road' | 'Straight' } | undefined)?.method ?? 'Road'));
  app.post('/api/delivery-sheets/:id/sort/apply', crew, async (req) =>
    locations.applySort(db, actorOf(req), id(req), req.body as { order?: string[]; saveAsUsual?: boolean }));
}
