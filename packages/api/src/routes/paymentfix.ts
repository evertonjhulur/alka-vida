/**
 * The payment ⋯ menu (Everton, 4 Nov 2026): edit, move to another customer,
 * reverse or delete a whole payment. Service: services/paymentfix.ts.
 */

import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.ts';
import type { Actor } from '../services/core.ts';
import type { Session } from '../lib/auth.ts';
import * as fix from '../services/paymentfix.ts';

type Req = { session?: Session; params: unknown; body: unknown; query: unknown };
type Guard = (...roles: Session['role'][]) => (req: never, reply: never) => Promise<void>;

export function registerPaymentFixRoutes(
  app: FastifyInstance,
  db: Db,
  h: { allow: Guard; actorOf: (req: { session?: Session }) => Actor },
) {
  const { allow, actorOf } = h;
  const office = { preHandler: allow('admin', 'user') as never };
  const idOf = (req: Req) => String((req.params as { id: string }).id);

  app.get('/api/payments/:id/fix', office, async (req) =>
    fix.paymentFixInfo(db, actorOf(req as Req), idOf(req as Req)));

  app.post('/api/payments/:id/fix', office, async (req) => {
    const b = (req.body ?? {}) as { fix?: fix.PaymentFix; reason?: string | null };
    return fix.requestPaymentFix(db, actorOf(req as Req), idOf(req as Req), b.fix as fix.PaymentFix, b.reason ?? null);
  });
}
