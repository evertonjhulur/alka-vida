/**
 * HTTP routes for the Florida team's testing round (1 Oct 2026): the
 * customer's own profile and home page, invoice PDFs on the portal, password
 * reset, payment changes, standing orders expected on a round, the stock
 * snapshot and count report, the sales transaction list, News & offers,
 * customer lists, messages to customers, and the ordering settings.
 */

import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.ts';
import type { Actor } from '../services/core.ts';
import { getSetting, requireRole } from '../services/core.ts';
import type { Session } from '../lib/auth.ts';
import { ForbiddenError, RuleViolation } from '@alka/shared';
import * as portal from '../services/portal.ts';
import * as messaging from '../services/messaging.ts';
import * as payments from '../services/payments.ts';
import * as recurring from '../services/recurring.ts';
import * as audits from '../services/audits.ts';
import * as reports from '../services/reports.ts';
import * as documents from '../services/documents.ts';
import * as invitations from '../services/invitations.ts';
import { accountPosition } from '../services/customers.ts';

type Req = { session?: Session; params: unknown; body: unknown; query: unknown };
type Guard = (...roles: Session['role'][]) => (req: never, reply: never) => Promise<void>;

export function registerFeedbackRoutes(
  app: FastifyInstance,
  db: Db,
  h: {
    allow: Guard;
    actorOf: (req: { session?: Session }) => Actor;
  },
) {
  const { allow, actorOf } = h;
  const only = (...roles: Session['role'][]) => ({ preHandler: allow(...roles) as never });
  const office = only('admin', 'user');
  const customerOnly = only('customer');
  const id = (req: Req) => (req.params as { id: string }).id;
  const me = (req: Req): string => {
    const s = req.session!;
    if (s.role !== 'customer' || !s.customerId) throw new ForbiddenError('this is only for a customer portal login');
    return s.customerId;
  };

  /* ---------------- public: forgotten password ---------------- */

  // The same answer whatever happened, so nobody can use it to find out
  // which addresses have a login.
  app.post('/api/auth/forgot-password', async (req) => {
    const b = (req.body ?? {}) as { email?: string };
    try { await invitations.requestPasswordReset(db, b.email ?? ''); } catch { /* never says */ }
    return { ok: true };
  });

  /* ---------------- the customer's own portal ---------------- */

  app.get('/api/portal/home', customerOnly, async (req) => {
    const customerId = me(req as Req);
    const next = await db.maybeOne(
      `SELECT o.order_number, o.requested_delivery_date::text AS requested_delivery_date,
              o.delivery_mode, o.needs_review
       FROM customer_orders o
       WHERE o.customer_id = $1 AND o.status IN ('Pending','Partially Delivered')
       ORDER BY o.requested_delivery_date NULLS LAST, o.created_at LIMIT 1`, [customerId],
    );
    return {
      position: await accountPosition(db, customerId),
      news: await messaging.listNews(db, { live: true }),
      whatsapp: await messaging.businessWhatsapp(db),
      cutoff: (await getSetting(db, 'same_day_cutoff', '10:00')).trim() || '10:00',
      nextOrder: next,
    };
  });

  app.get('/api/portal/profile', customerOnly, async (req) => portal.getMyProfile(db, me(req as Req)));

  app.patch('/api/portal/profile', customerOnly, async (req) => {
    await portal.updateMyProfile(db, actorOf(req as Req), me(req as Req), req.body as never);
    return { ok: true };
  });

  app.post('/api/portal/addresses', customerOnly, async (req) =>
    portal.saveMyAddress(db, actorOf(req as Req), me(req as Req), null, req.body as never));

  app.patch('/api/portal/addresses/:addressId', customerOnly, async (req) =>
    portal.saveMyAddress(db, actorOf(req as Req), me(req as Req),
      (req.params as { addressId: string }).addressId, req.body as never));

  app.delete('/api/portal/addresses/:addressId', customerOnly, async (req) => {
    await portal.removeMyAddress(db, actorOf(req as Req), me(req as Req),
      (req.params as { addressId: string }).addressId);
    return { ok: true };
  });

  // Their own invoice as a PDF, to download or print (point 6).
  app.get('/api/portal/invoices/:id/pdf', customerOnly, async (req, reply) => {
    const owner = await db.maybeOne<{ customer_id: string }>(
      `SELECT customer_id FROM invoices WHERE id = $1`, [id(req as Req)],
    );
    if (!owner || owner.customer_id !== me(req as Req)) {
      throw new RuleViolation('that invoice could not be found on your account');
    }
    const doc = await documents.renderInvoicePdf(db, id(req as Req));
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${doc.filename}"`)
      .send(doc.pdf);
  });

  /* ---------------- payments: change a posted payment ---------------- */

  app.post('/api/payments/:id/change', office, async (req) => {
    const b = (req.body ?? {}) as { changes?: payments.PaymentChange; reason?: string };
    return payments.requestPaymentChange(db, actorOf(req as Req), id(req as Req),
      b.changes ?? {}, b.reason ?? '');
  });

  /* ---------------- standing orders on the rounds ---------------- */

  app.get('/api/recurring/expected', office, async (req) => {
    const q = req.query as { date?: string };
    if (!q.date) throw new RuleViolation('which day?');
    return recurring.expectedOn(db, q.date);
  });

  app.post('/api/recurring/raise-through', office, async (req) => {
    const b = (req.body ?? {}) as { date?: string };
    if (!b.date) throw new RuleViolation('which day?');
    return recurring.raiseThrough(db, actorOf(req as Req), b.date);
  });

  /* ---------------- stock ---------------- */

  app.get('/api/stock/snapshot', office, async () => audits.stockSnapshot(db));

  // Several counts in one go, from the count sheet. Each is checked on its
  // own; the ones that pass are saved and the rest come back with why.
  app.post('/api/audits/batch', office, async (req) => {
    const b = (req.body ?? {}) as { counts?: audits.CountInput[] };
    const saved: Array<{ itemId: string; id: string; discrepancy: number }> = [];
    const problems: Array<{ itemId: string; message: string }> = [];
    for (const c of b.counts ?? []) {
      try {
        const r = await audits.recordCount(db, actorOf(req as Req), c);
        saved.push({ itemId: c.itemId, id: r.id, discrepancy: r.discrepancy });
      } catch (err) {
        problems.push({ itemId: c.itemId, message: (err as Error).message });
      }
    }
    return { saved, problems };
  });

  /* ---------------- reports ---------------- */

  app.get('/api/reports/sales-transactions', office, async (req) => {
    const q = req.query as { from?: string; to?: string };
    return reports.salesTransactions(db, q.from || null, q.to || null);
  });

  /* ---------------- News & offers ---------------- */

  app.get('/api/news', office, async () => messaging.listNews(db));
  app.post('/api/news', office, async (req) => messaging.saveNews(db, actorOf(req as Req), null, req.body as never));
  app.patch('/api/news/:id', office, async (req) =>
    messaging.saveNews(db, actorOf(req as Req), id(req as Req), req.body as never));
  app.delete('/api/news/:id', office, async (req) => {
    await messaging.deleteNews(db, actorOf(req as Req), id(req as Req));
    return { ok: true };
  });

  /* ---------------- customer lists and messages ---------------- */

  app.get('/api/customer-lists', office, async () => messaging.listCustomerLists(db));
  app.post('/api/customer-lists', office, async (req) =>
    messaging.saveCustomerList(db, actorOf(req as Req), null, req.body as never));
  app.patch('/api/customer-lists/:id', office, async (req) =>
    messaging.saveCustomerList(db, actorOf(req as Req), id(req as Req), req.body as never));
  app.delete('/api/customer-lists/:id', office, async (req) => {
    await messaging.deleteCustomerList(db, actorOf(req as Req), id(req as Req));
    return { ok: true };
  });
  app.post('/api/customer-lists/preview', office, async (req) => {
    const b = (req.body ?? {}) as { criteria?: messaging.ListCriteria; includeIds?: string[]; excludeIds?: string[] };
    const members = await messaging.resolveList(db, b.criteria ?? {}, b.includeIds ?? [], b.excludeIds ?? []);
    return members.map((m) => ({ ...m, whatsappLink: messaging.whatsappLink(m.whatsapp ?? m.phone) }));
  });

  app.get('/api/broadcasts', office, async () => messaging.listBroadcasts(db));
  app.get('/api/broadcasts/:id', office, async (req) => messaging.getBroadcast(db, id(req as Req)));
  app.post('/api/broadcasts', office, async (req) =>
    messaging.createBroadcast(db, actorOf(req as Req), req.body as never));
  app.post('/api/broadcasts/send-queued', office, async () => messaging.sendQueuedMessages(db));

  /* ---------------- ordering settings ---------------- */

  const SETTINGS: Record<string, string> = {
    sameDayCutoff: 'same_day_cutoff',
    whatsappNumber: 'whatsapp_number',
    broadcastDailyCap: 'broadcast_daily_cap',
    orderPlacedEmails: 'order_placed_emails',
    orderDeliveredEmails: 'order_delivered_emails',
  };
  const readSettings = async () => {
    const out: Record<string, string | boolean | number> = {};
    for (const [k, key] of Object.entries(SETTINGS)) out[k] = await getSetting(db, key, '');
    return {
      sameDayCutoff: String(out.sameDayCutoff || '10:00'),
      whatsappNumber: String(out.whatsappNumber ?? ''),
      broadcastDailyCap: Number(out.broadcastDailyCap) || 80,
      orderPlacedEmails: out.orderPlacedEmails !== 'false',
      orderDeliveredEmails: out.orderDeliveredEmails !== 'false',
      mailConfigured: documents.mailConfigured(),
    };
  };
  app.get('/api/settings/ordering', office, async () => readSettings());
  app.put('/api/settings/ordering', only('admin'), async (req) => {
    requireRole(actorOf(req as Req), 'admin');
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.sameDayCutoff !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.sameDayCutoff))) {
      throw new RuleViolation('the cut-off is a time like 10:00 or 14:30');
    }
    await db.tx(async (t) => {
      for (const [k, key] of Object.entries(SETTINGS)) {
        if (!(k in b)) continue;
        await t.query(
          `INSERT INTO system_settings (key, value) VALUES ($1,$2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, String(b[k])],
        );
      }
    });
    return readSettings();
  });
}
