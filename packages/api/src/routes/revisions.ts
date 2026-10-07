/**
 * HTTP routes for Everton's revision list (30 Sep 2026): quotations, credit
 * notes, customer addresses and special prices, weekly/monthly invoicing,
 * sending several invoices at once, receipts, automatic emails, and the
 * purchase-order paperwork.
 *
 * Kept in their own file so server.ts stays readable. The guards are the
 * same ones server.ts uses, passed in.
 */

import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.ts';
import type { Actor } from '../services/core.ts';
import type { Session } from '../lib/auth.ts';
import { ForbiddenError, RuleViolation } from '@alka/shared';
import * as customers from '../services/customers.ts';
import * as quotations from '../services/quotations.ts';
import * as invoices from '../services/invoices.ts';
import * as documents from '../services/documents.ts';
import * as paperwork from '../services/paperwork.ts';
import * as cycles from '../services/cycles.ts';
import * as inventory from '../services/inventory.ts';

type Req = { session?: Session; params: unknown; body: unknown; query: unknown };
type Guard = (...roles: Session['role'][]) => (req: never, reply: never) => Promise<void>;

export function registerRevisionRoutes(
  app: FastifyInstance,
  db: Db,
  h: {
    allow: Guard;
    actorOf: (req: { session?: Session }) => Actor;
    assertOwnCustomer: (req: { session?: Session }, customerId: string) => void;
  },
) {
  const { allow, actorOf, assertOwnCustomer } = h;
  const id = (req: Req) => (req.params as { id: string }).id;
  const pdf = (reply: { header: (k: string, v: string) => unknown; send: (b: unknown) => unknown },
    doc: { filename: string; pdf: Buffer }) => {
    (reply.header('content-type', 'application/pdf') as typeof reply)
      .header('content-disposition', `attachment; filename="${doc.filename}"`);
    return reply.send(doc.pdf);
  };
  const only = (...roles: Session['role'][]) => ({ preHandler: allow(...roles) as never });
  const office = only('admin', 'user');

  /* ---------------- customers: addresses and special prices ---------------- */

  app.get('/api/customers/:id/addresses', async (req) => {
    assertOwnCustomer(req as Req, id(req as Req));
    return customers.listAddresses(db, id(req as Req));
  });
  app.post('/api/customers/:id/addresses', office, async (req) =>
    customers.saveAddress(db, actorOf(req as Req), id(req as Req), null, req.body as never));
  app.patch('/api/customers/:id/addresses/:addressId', office, async (req) => {
    const p = req.params as { id: string; addressId: string };
    return customers.saveAddress(db, actorOf(req as Req), p.id, p.addressId, req.body as never);
  });
  app.delete('/api/customers/:id/addresses/:addressId', office, async (req) => {
    const p = req.params as { id: string; addressId: string };
    await customers.removeAddress(db, actorOf(req as Req), p.id, p.addressId);
    return { ok: true };
  });

  app.get('/api/customers/:id/special-prices', office, async (req) =>
    customers.listSpecialPrices(db, id(req as Req)));
  app.put('/api/customers/:id/special-prices', office, async (req) => {
    const b = req.body as { productId: string; priceCents: number | null };
    await customers.setSpecialPrice(db, actorOf(req as Req), id(req as Req), b.productId, b.priceCents);
    return { ok: true };
  });

  /* ---------------- quotations ---------------- */

  app.get('/api/quotations', only('admin', 'user', 'customer'), async (req) => {
    const s = (req as Req).session!;
    const q = req.query as { customerId?: string; status?: string };
    const customerId = s.role === 'customer' ? s.customerId ?? '00000000-0000-0000-0000-000000000000' : q.customerId;
    const rows = await quotations.listQuotations(db, { customerId, status: q.status || null });
    // A customer sees only what has been sent to them, never drafts.
    return s.role === 'customer' ? rows.filter((r) => r.status !== 'Draft') : rows;
  });
  app.patch('/api/quotations/:id', office, async (req) =>
    quotations.updateQuotation(db, actorOf(req as Req), id(req as Req), req.body as never));
  app.delete('/api/quotations/:id', office, async (req) => {
    await quotations.deleteQuotation(db, actorOf(req as Req), id(req as Req));
    return { ok: true };
  });
  app.get('/api/quotations/:id/pdf', only('admin', 'user', 'customer'), async (req, reply) => {
    const q = await quotations.getQuotation(db, id(req as Req)) as { customer_id: string; status: string } | null;
    if (!q) throw new RuleViolation('that quotation no longer exists');
    assertOwnCustomer(req as Req, q.customer_id);
    return pdf(reply as never, await paperwork.renderQuotePdf(db, id(req as Req)));
  });
  app.post('/api/quotations/:id/email', office, async (req) => {
    const b = (req.body ?? {}) as { to?: string; note?: string };
    return paperwork.emailQuote(db, actorOf(req as Req), id(req as Req), b);
  });
  app.post('/api/quotations/:id/mark-sent', office, async (req) =>
    paperwork.markQuoteSent(db, actorOf(req as Req), id(req as Req)));

  // The customer answering in their portal.
  app.post('/api/portal/quotations/:id/answer', only('customer'), async (req) => {
    const s = (req as Req).session!;
    if (!s.customerId) throw new ForbiddenError('this login is not linked to a customer');
    const b = req.body as { decision: 'Accepted' | 'Declined'; reason?: string };
    if (!['Accepted', 'Declined'].includes(b.decision)) throw new RuleViolation('accept or decline');
    await quotations.respondAsCustomer(db, actorOf(req as Req), s.customerId, id(req as Req), b.decision, b.reason);
    return { ok: true };
  });

  // PUBLIC: the accept link in the email. Answers only to the token.
  app.get('/api/public/quote/:token', async (req, reply) => {
    const q = await quotations.quoteByToken(db, (req.params as { token: string }).token);
    if (!q) return reply.status(404).send({ error: 'This link is not valid. Please contact us for a fresh copy.' });
    return q;
  });
  app.post('/api/public/quote/:token', async (req) => {
    const b = (req.body ?? {}) as { decision?: 'Accepted' | 'Declined'; reason?: string };
    return quotations.answerByToken(db, (req.params as { token: string }).token,
      b.decision === 'Declined' ? 'Declined' : 'Accepted', b.reason);
  });

  /* ---------------- credit notes ---------------- */

  app.get('/api/credit-notes', office, async (req) =>
    invoices.listCreditNotes(db, (req.query as { customerId?: string }).customerId || null));
  app.post('/api/credit-notes', office, async (req) =>
    invoices.createCreditNote(db, actorOf(req as Req), req.body as never));

  /* ---------------- invoices: several at once, cycles ---------------- */

  app.post('/api/invoices/batch.pdf', office, async (req, reply) => {
    const b = req.body as { invoiceIds: string[] };
    return pdf(reply as never, await documents.renderInvoicesPdf(db, b.invoiceIds ?? []));
  });
  app.post('/api/invoices/email-batch', office, async (req) => {
    const b = req.body as { invoiceIds: string[]; to?: string; note?: string };
    return documents.emailInvoices(db, actorOf(req as Req), b.invoiceIds ?? [], { to: b.to, note: b.note });
  });

  app.get('/api/invoice-cycles/waiting', office, async () => cycles.waitingSummary(db));
  app.get('/api/customers/:id/uninvoiced', office, async (req) =>
    cycles.pendingDeliveries(db, id(req as Req)));
  app.post('/api/invoice-cycles/run', office, async (req) =>
    cycles.raiseCycleInvoices(db, actorOf(req as Req), { mode: 'closed' }));
  app.post('/api/customers/:id/invoice-now', office, async (req) =>
    cycles.invoiceCustomerNow(db, actorOf(req as Req), id(req as Req)));

  /* ---------------- receipts ---------------- */

  app.post('/api/receipts.pdf', office, async (req, reply) => {
    const b = req.body as { paymentIds: string[] };
    return pdf(reply as never, await paperwork.renderReceiptPdf(db, b.paymentIds ?? []));
  });
  app.post('/api/receipts/email', office, async (req) => {
    const b = req.body as { paymentIds: string[]; to?: string };
    return paperwork.emailReceipt(db, actorOf(req as Req), b.paymentIds ?? [], { to: b.to });
  });

  /* ---------------- automatic emails ---------------- */

  app.get('/api/automation', office, async () => ({
    settings: await paperwork.getAutomation(db),
    log: await paperwork.automationLog(db, 60),
  }));
  app.put('/api/automation', only('admin'), async (req) =>
    paperwork.setAutomation(db, actorOf(req as Req), req.body as never));
  app.post('/api/automation/run', only('admin'), async (req) =>
    paperwork.runAutomation(db, actorOf(req as Req)));

  /* ---------------- purchase orders ---------------- */

  app.patch('/api/purchase-orders/:id', office, async (req) =>
    inventory.updatePurchaseOrder(db, actorOf(req as Req), id(req as Req), req.body as never));
  app.delete('/api/purchase-orders/:id', office, async (req) => {
    await inventory.deletePurchaseOrder(db, actorOf(req as Req), id(req as Req));
    return { ok: true };
  });
  // "Close it (nothing more coming)". Says which status it ended up in.
  app.post('/api/purchase-orders/:id/cancel', office, async (req) => {
    const r = await inventory.cancelPurchaseOrder(db, actorOf(req as Req), id(req as Req));
    return { ok: true, status: r.status };
  });
  app.get('/api/purchase-orders/:id/pdf', office, async (req, reply) =>
    pdf(reply as never, await paperwork.renderPoPdf(db, id(req as Req))));
  app.post('/api/purchase-orders/:id/email', office, async (req) => {
    const b = (req.body ?? {}) as { to?: string; note?: string };
    return paperwork.emailPurchaseOrder(db, actorOf(req as Req), id(req as Req), b);
  });
  app.get('/api/settings/env-tax', office, async () => ({ ratePercent: (await inventory.envTaxRate(db)) * 100 }));
}
