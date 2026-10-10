/**
 * HTTP routes for Everton's round of 10 Oct 2026: a payment on a stop already
 * delivered, collection stops, truck loading and returns, the invoice /
 * statement footer and the card-payments switch.
 *
 * (The Delivery rounds status filter and the order email wording need no
 * route; markStop's truck hook and the settlement checks are in the services.)
 */

import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.ts';
import type { Actor } from '../services/core.ts';
import { DEFAULT_DOCUMENT_FOOTER, documentFooter, requireRole, takesCard, businessToday } from '../services/core.ts';
import type { Session } from '../lib/auth.ts';
import { RuleViolation } from '@alka/shared';
import * as delivery from '../services/delivery.ts';
import * as trucks from '../services/trucks.ts';
import * as collections from '../services/collections.ts';

type Req = { session?: Session; params: unknown; body: unknown; query: unknown };
type Guard = (...roles: Session['role'][]) => (req: never, reply: never) => Promise<void>;

export function registerTruckRoutes(
  app: FastifyInstance,
  db: Db,
  h: { allow: Guard; actorOf: (req: { session?: Session }) => Actor },
) {
  const { allow, actorOf } = h;
  const only = (...roles: Session['role'][]) => ({ preHandler: allow(...roles) as never });
  const office = only('admin', 'user');
  const crew = only('admin', 'user', 'driver');
  const id = (req: Req) => (req.params as { id: string }).id;
  const actor = (req: unknown) => actorOf(req as Req);

  /* ---------------- settings: footer + card payments ---------------- */

  // Every payment-method list asks this, the driver's included.
  app.get('/api/settings/payments', crew, async () => ({ takeCard: await takesCard(db) }));

  const readMoney = async () => ({
    takeCard: await takesCard(db),
    documentFooter: await documentFooter(db),
    defaultFooter: DEFAULT_DOCUMENT_FOOTER,
  });
  app.get('/api/settings/money', office, async () => readMoney());
  app.put('/api/settings/money', only('admin'), async (req) => {
    requireRole(actor(req), 'admin');
    const b = (req.body ?? {}) as { takeCard?: boolean; documentFooter?: string };
    await db.tx(async (t) => {
      const put = (key: string, value: string) => t.query(
        `INSERT INTO system_settings (key, value) VALUES ($1,$2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value],
      );
      if (b.takeCard !== undefined) await put('take_card_payments', b.takeCard ? 'true' : 'false');
      if (b.documentFooter !== undefined) {
        const text = String(b.documentFooter).replace(/\r\n/g, '\n').trim();
        if (text.length > 1500) throw new RuleViolation('keep the footer under 1,500 characters');
        await put('document_footer', text);
      }
    });
    return readMoney();
  });

  /* ---------------- point 2: payment on a delivered stop ---------------- */

  app.post('/api/stops/:id/add-payment', crew, async (req) =>
    delivery.addPaymentToDeliveredStop(db, actor(req), id(req as Req), req.body as never));

  /* ---------------- point 3: collection stops ---------------- */

  app.get('/api/rounds/stop-options', crew, async () => collections.stopOptions(db));
  app.post('/api/delivery-sheets/:id/collections', crew, async (req) =>
    collections.addCollection(db, actor(req), id(req as Req), req.body as never));
  app.get('/api/collections/:id', crew, async (req) => {
    const c = await collections.getCollection(db, id(req as Req));
    if (!c) throw new RuleViolation('that stop no longer exists');
    return c;
  });
  app.post('/api/collections/:id/record', crew, async (req) => {
    await collections.recordCollection(db, actor(req), id(req as Req), req.body as never);
    return collections.getCollection(db, id(req as Req));
  });
  app.delete('/api/collections/:id', office, async (req) => {
    await collections.removeCollection(db, actor(req), id(req as Req));
    return { ok: true };
  });
  app.post('/api/collections/:id/decision', office, async (req) =>
    collections.decideReturn(db, actor(req), id(req as Req), req.body as never));
  app.get('/api/purchase-orders/:id/pickups', office, async (req) => collections.pickupsForPo(db, id(req as Req)));

  /* ---------------- point 4: loading and returns ---------------- */

  app.get('/api/delivery-sheets/:id/loading', crew, async (req) => trucks.loadingSummary(db, id(req as Req)));
  // The office logs the loading; the driver confirms it and starts.
  app.post('/api/delivery-sheets/:id/load', office, async (req) =>
    trucks.loadRound(db, actor(req), id(req as Req), req.body as never));
  app.post('/api/delivery-sheets/:id/confirm-load', only('driver'), async (req) =>
    trucks.confirmLoad(db, actor(req), id(req as Req)));
  // Last-minute additions after the driver confirmed: office adds, driver reconfirms.
  app.post('/api/delivery-sheets/:id/load-additions', office, async (req) =>
    trucks.addToLoad(db, actor(req), id(req as Req), req.body as never));
  app.post('/api/load-additions/:id/confirm', only('driver'), async (req) => {
    await trucks.confirmAddition(db, actor(req), id(req as Req));
    return { ok: true };
  });
  app.post('/api/load-additions/:id/cancel', office, async (req) => {
    await trucks.cancelAddition(db, actor(req), id(req as Req));
    return { ok: true };
  });
  app.get('/api/delivery-sheets/:id/truck', crew, async (req) => trucks.truckPosition(db, id(req as Req)));
  app.post('/api/delivery-sheets/:id/returns', crew, async (req) =>
    trucks.confirmReturns(db, actor(req), id(req as Req), req.body as never));

  app.get('/api/reports/loadings', office, async (req) => {
    const q = (req.query ?? {}) as { from?: string; to?: string };
    const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to ?? '') ? q.to! : businessToday();
    const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from ?? '') ? q.from! : '2000-01-01';
    return trucks.loadingsReport(db, from, to);
  });
}
