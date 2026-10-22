/**
 * HTTP routes for the public website at alkavidaja.com (21 Oct 2026).
 * The rules are in services/website.ts.
 *
 * /api/public/* needs no sign-in (server.ts lets it through). The order form
 * is the one public POST that writes, so it is held to a few a minute from
 * any one address, and the form carries a field people never see.
 */

import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.ts';
import type { Actor } from '../services/core.ts';
import type { Session } from '../lib/auth.ts';
import * as website from '../services/website.ts';

type Guard = (...roles: Session['role'][]) => (req: never, reply: never) => Promise<void>;

/** Website orders from one address: at most LIMIT in WINDOW_MS. */
const LIMIT = 5;
const WINDOW_MS = 10 * 60 * 1000;
const recent = new Map<string, number[]>();

function tooMany(ip: string, now = Date.now()): boolean {
  const kept = (recent.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (kept.length >= LIMIT) { recent.set(ip, kept); return true; }
  kept.push(now);
  recent.set(ip, kept);
  if (recent.size > 5000) recent.clear();
  return false;
}

export function registerWebsiteRoutes(
  app: FastifyInstance,
  db: Db,
  h: { allow: Guard; actorOf: (req: { session?: Session }) => Actor },
) {
  const { allow, actorOf } = h;

  // PUBLIC. Products and listed prices, zones and days, phone numbers.
  app.get('/api/public/site', async (_req, reply) => {
    reply.header('cache-control', 'no-cache');
    return website.siteInfo(db);
  });

  // PUBLIC. An order from somebody without an account.
  app.post('/api/public/order', async (req, reply) => {
    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || req.ip;
    if (tooMany(ip)) {
      return reply.status(429).send({ error: 'Several orders have just been sent from here. Please wait a few minutes, or call us.' });
    }
    return website.submitWebsiteOrder(db, req.body as website.WebsiteOrderInput);
  });

  app.get('/api/website-orders', { preHandler: allow('admin', 'user') as never }, async (req) =>
    website.listWebsiteOrders(db, actorOf(req), (req.query as { status?: string }).status));

  app.post('/api/website-orders/:id/book', { preHandler: allow('admin') as never }, async (req) =>
    website.bookWebsiteOrder(db, actorOf(req), (req.params as { id: string }).id, req.body as website.BookTerms));

  app.post('/api/website-orders/:id/decline', { preHandler: allow('admin') as never }, async (req) => {
    const body = req.body as { reason?: string } | undefined;
    await website.declineWebsiteOrder(db, actorOf(req), (req.params as { id: string }).id, body?.reason);
    return { ok: true };
  });
}
