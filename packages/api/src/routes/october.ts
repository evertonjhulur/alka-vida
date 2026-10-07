/**
 * HTTP routes for Everton's round of 7 Oct 2026: the unsubscribe link that
 * works without signing in, pictures on News & offers, and a payment taken
 * at a stop where nothing was delivered.
 *
 * (Order cancelled / rescheduled emails hang off the existing routes in
 * server.ts; the statement's Open / Paid / Partially paid / Overdue filter
 * is a parameter on the existing statement routes.)
 */

import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.ts';
import type { Actor } from '../services/core.ts';
import type { Session } from '../lib/auth.ts';
import * as emailkit from '../services/emailkit.ts';
import * as messaging from '../services/messaging.ts';
import * as delivery from '../services/delivery.ts';
import * as reminders from '../services/reminders.ts';

type Req = { session?: Session; params: unknown; body: unknown; query: unknown };
type Guard = (...roles: Session['role'][]) => (req: never, reply: never) => Promise<void>;

export function registerOctoberRoutes(
  app: FastifyInstance,
  db: Db,
  h: { allow: Guard; actorOf: (req: { session?: Session }) => Actor },
) {
  const { allow, actorOf } = h;
  const only = (...roles: Session['role'][]) => ({ preHandler: allow(...roles) as never });
  const office = only('admin', 'user');

  /*
   * The confirm button on the unsubscribe page is a plain HTML form, and a
   * mail program's own one-click unsubscribe POSTs "List-Unsubscribe=One-Click"
   * the same way. Fastify reads neither without being told.
   */
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' },
    (_req, body: string, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body || '')));
    });

  /* ---------------- unsubscribe (PUBLIC; outside /api) ---------------- */

  const html = (reply: { header: (k: string, v: string) => { send: (b: string) => unknown } }, body: string) =>
    reply.header('content-type', 'text/html; charset=utf-8').send(body);

  // Opening the link only ASKS. Mail scanners open links on their own, and a
  // scanner must not be able to switch a customer's emails off.
  app.get('/unsubscribe', async (req, reply) => {
    const q = (req.query ?? {}) as { t?: string; c?: string };
    const category = emailkit.isCategory(q.c) ? q.c : null;
    const who = q.t && /^[0-9a-f-]{36}$/i.test(q.t)
      ? await db.maybeOne<{ name: string }>(`SELECT name FROM customers WHERE email_token = $1::uuid`, [q.t])
      : null;
    if (!who || !category) {
      return html(reply as never, emailkit.unsubscribePage({
        title: 'This link has expired',
        message: 'We could not find the account this link belongs to. Sign in and choose your emails under My Profile, or reply to any of our emails and we will take you off.',
      }));
    }
    return html(reply as never, emailkit.unsubscribePage({
      title: 'Unsubscribe',
      message: `Stop sending ${emailkit.CATEGORY_LABEL[category]} to ${who.name}? Invoices, receipts and statements we send you still come.`,
      form: { token: q.t!, category, label: `Stop ${emailkit.CATEGORY_LABEL[category]}` },
    }));
  });

  app.post('/unsubscribe', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string>;
    const b = (req.body ?? {}) as Record<string, string>;
    const token = String(b.t ?? q.t ?? '');
    const raw = String(b.c ?? q.c ?? '');
    const category = raw === 'all' ? 'all' : emailkit.isCategory(raw) ? raw : null;
    const on = String(b.on ?? '') === '1';
    const done = category ? await db.tx((t) => emailkit.setByToken(t, token, category, on)) : null;
    if (!done || !category) {
      return html(reply as never, emailkit.unsubscribePage({
        title: 'This link has expired',
        message: 'We could not find the account this link belongs to. Sign in and choose your emails under My Profile.',
      }));
    }
    const what = category === 'all' ? 'emails that are not invoices, receipts or statements' : emailkit.CATEGORY_LABEL[category];
    return html(reply as never, emailkit.unsubscribePage({
      title: on ? 'You are back on the list' : 'You are unsubscribed',
      message: on ? `We will send ${what} to ${done.name} again.` : `We will not send ${what} to ${done.name} any more.`,
      undo: on ? null : { token, category },
    }));
  });

  /* ---------------- News & offers pictures ---------------- */

  // PUBLIC: the portal shows them, and so do emails, which carry no token.
  app.get('/api/public/news-images/:id', async (req, reply) => {
    const img = await messaging.getNewsImage(db, (req.params as { id: string }).id);
    if (!img) return reply.status(404).send({ error: 'no such picture' });
    return reply.header('content-type', img.type)
      .header('cache-control', 'public, max-age=86400').send(img.data);
  });

  // A photo arrives as a data URL, already shrunk by the browser; the limit
  // is generous because base64 is a third bigger than the file.
  app.post('/api/news/images', { ...office, bodyLimit: 6 * 1024 * 1024 }, async (req) =>
    messaging.uploadNewsImage(db, actorOf(req as Req), ((req.body ?? {}) as { dataUrl?: string }).dataUrl ?? ''));

  /* ---------------- payment at a stop, nothing delivered ---------------- */

  app.get('/api/driver/customers', only('admin', 'user', 'driver'), async () => delivery.customersForDriver(db));

  app.post('/api/delivery-sheets/:id/payment-stop', only('admin', 'user', 'driver'), async (req) =>
    delivery.addPaymentStop(db, actorOf(req as Req), (req.params as { id: string }).id, req.body as never));

  /* ---------------- tomorrow's round: remind customers to order ---------------- */

  app.get('/api/reminders', office, async (req) =>
    reminders.remindersFor(db, { date: ((req.query ?? {}) as { date?: string }).date ?? null }));
  app.post('/api/reminders/:customerId/sent', office, async (req) => {
    const b = (req.body ?? {}) as { date?: string };
    await reminders.markReminded(db, actorOf(req as Req), (req.params as { customerId: string }).customerId, b.date ?? '');
    return { ok: true };
  });
  app.delete('/api/reminders/:customerId/sent', office, async (req) => {
    const q = (req.query ?? {}) as { date?: string };
    await reminders.unmarkReminded(db, actorOf(req as Req), (req.params as { customerId: string }).customerId, q.date ?? '');
    return { ok: true };
  });
  app.post('/api/reminders/email', office, async (req) => {
    const b = (req.body ?? {}) as { date?: string; customerIds?: string[] };
    return reminders.emailReminders(db, actorOf(req as Req), b.date ?? '', b.customerIds ?? []);
  });
  app.put('/api/reminders/template', office, async (req) => ({
    template: await reminders.setReminderTemplate(db, actorOf(req as Req), ((req.body ?? {}) as { template?: string }).template ?? ''),
  }));
}
