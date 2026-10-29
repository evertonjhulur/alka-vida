/**
 * The send screen (Everton, 28 Oct 2026): every "Email..." opens a screen in
 * a new tab with the email written, the document attached, To / Cc / Bcc and
 * room for other files. Several ticked on a list go one at a time.
 * Services: services/sendscreen.ts, services/emailwording.ts.
 */

import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.ts';
import type { Actor } from '../services/core.ts';
import type { Session } from '../lib/auth.ts';
import * as sendscreen from '../services/sendscreen.ts';
import * as wording from '../services/emailwording.ts';
import { RuleViolation } from '@alka/shared';

type Req = { session?: Session; params: unknown; body: unknown; query: unknown };
type Guard = (...roles: Session['role'][]) => (req: never, reply: never) => Promise<void>;

/** 10 MB of files arrive as base64 (a third bigger) inside JSON. */
const SEND_BODY_LIMIT = 16 * 1024 * 1024;

export function registerSendScreenRoutes(
  app: FastifyInstance,
  db: Db,
  h: { allow: Guard; actorOf: (req: { session?: Session }) => Actor },
) {
  const { allow, actorOf } = h;
  const office = { preHandler: allow('admin', 'user') as never };
  const refFrom = (q: unknown) => sendscreen.cleanRef((q ?? {}) as never);

  app.get('/api/send/draft', office, async (req) =>
    sendscreen.draftEmail(db, actorOf(req as Req), refFrom((req as Req).query)));

  app.get('/api/send/preview.pdf', office, async (req, reply) => {
    const doc = await sendscreen.previewPdf(db, actorOf(req as Req), refFrom((req as Req).query));
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${doc.filename}"`)
      .send(doc.pdf);
  });

  app.post('/api/send', { ...office, bodyLimit: SEND_BODY_LIMIT }, async (req) => {
    const b = ((req as Req).body ?? {}) as { ref?: unknown; compose?: unknown };
    return sendscreen.sendEmail(db, actorOf(req as Req), refFrom(b.ref), b.compose as never);
  });

  app.post('/api/send/plan', office, async (req) => {
    const b = ((req as Req).body ?? {}) as { kind?: string; ids?: unknown };
    const ids = Array.isArray(b.ids) ? b.ids.map(String) : String(b.ids ?? '').split(',');
    return sendscreen.planBatch(db, actorOf(req as Req), String(b.kind) as sendscreen.BatchKind, ids);
  });

  // The wording, Settings > Emails & ordering. Anyone in the office can read
  // it; an administrator changes it.
  app.get('/api/email-wording', office, async () => wording.listWording(db));
  app.put('/api/email-wording/:kind', { preHandler: allow('admin') as never }, async (req) => {
    const kind = ((req as Req).params as { kind: string }).kind as wording.WordingKind;
    if (!wording.WORDING_KINDS.includes(kind)) throw new RuleViolation('there is no such kind of email');
    const b = ((req as Req).body ?? {}) as { subject?: string; message?: string; reset?: boolean };
    await wording.setWording(db, actorOf(req as Req), kind,
      b.reset ? null : { subject: String(b.subject ?? ''), message: String(b.message ?? '') });
    return wording.listWording(db);
  });
}
