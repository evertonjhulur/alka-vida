/**
 * Batch actions on the lists (Everton, 11 Oct 2026): tick rows on Invoices,
 * a customer's page, Payments, Purchase orders, Credit notes or Quotes and
 * print or send them together, the way QuickBooks does.
 *
 * Print gives one PDF with each document on its own page. Send emails each
 * one where it belongs (invoices and receipts: one email per customer, with
 * theirs together) and reports, per email, where it went or why it did not -
 * one that cannot go never stops the rest.
 *
 * Also the list of payments received (the Payments screen showed only money
 * not yet against an invoice).
 */

import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.ts';
import type { Actor } from '../services/core.ts';
import type { Session } from '../lib/auth.ts';
import * as documents from '../services/documents.ts';
import * as paperwork from '../services/paperwork.ts';

type Req = { session?: Session; params: unknown; body: unknown; query: unknown };
type Guard = (...roles: Session['role'][]) => (req: never, reply: never) => Promise<void>;

export function registerBatchRoutes(
  app: FastifyInstance,
  db: Db,
  h: { allow: Guard; actorOf: (req: { session?: Session }) => Actor },
) {
  const { allow, actorOf } = h;
  const office = { preHandler: allow('admin', 'user') as never };
  const ids = (req: Req) => {
    const b = (req.body ?? {}) as { ids?: unknown };
    return Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === 'string') : [];
  };
  const pdf = (reply: { header: (k: string, v: string) => unknown; send: (b: unknown) => unknown },
    doc: { filename: string; pdf: Buffer }) => {
    (reply.header('content-type', 'application/pdf') as typeof reply)
      .header('content-disposition', `attachment; filename="${doc.filename}"`);
    return reply.send(doc.pdf);
  };

  // Invoices and credit notes (credit notes are invoices with is_credit_note).
  app.post('/api/batch/invoices/print.pdf', office, async (req, reply) =>
    pdf(reply as never, await documents.printInvoices(db, ids(req as Req))));
  app.post('/api/batch/invoices/send', office, async (req) =>
    documents.emailInvoicesByCustomer(db, actorOf(req as Req), ids(req as Req)));

  // Payments: receipts.
  app.post('/api/batch/receipts/print.pdf', office, async (req, reply) =>
    pdf(reply as never, await paperwork.printReceipts(db, ids(req as Req))));
  app.post('/api/batch/receipts/send', office, async (req) =>
    paperwork.emailReceiptsByCustomer(db, actorOf(req as Req), ids(req as Req)));

  // Purchase orders, to their suppliers.
  app.post('/api/batch/purchase-orders/print.pdf', office, async (req, reply) =>
    pdf(reply as never, await paperwork.printPurchaseOrders(db, ids(req as Req))));
  app.post('/api/batch/purchase-orders/send', office, async (req) =>
    paperwork.emailPurchaseOrders(db, actorOf(req as Req), ids(req as Req)));

  // Quotes.
  app.post('/api/batch/quotes/print.pdf', office, async (req, reply) =>
    pdf(reply as never, await paperwork.printQuotes(db, ids(req as Req))));
  app.post('/api/batch/quotes/send', office, async (req) =>
    paperwork.emailQuotes(db, actorOf(req as Req), ids(req as Req)));

  /**
   * Every payment received (confirmed), newest first, with what it went
   * against and whether it was reversed. Optional customer and date range.
   */
  app.get('/api/payments', office, async (req) => {
    const q = (req as Req).query as { customerId?: string; from?: string; to?: string; limit?: string };
    const day = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    const limit = Math.min(Math.max(Number(q.limit) || 500, 1), 2000);
    return db.query(
      `SELECT p.id, p.customer_id, c.name AS customer_name,
              business_date(p.payment_date)::text AS payment_date,
              p.amount_cents, p.method, p.reference, p.receipt_number, p.invoice_id,
              i.invoice_number, i.is_credit_note, p.is_reversal, p.order_id,
              o.order_number, ds.zone AS round_zone,
              EXISTS (SELECT 1 FROM payments r WHERE r.reverses_payment_id = p.id) AS reversed
       FROM payments p
       JOIN customers c ON c.id = p.customer_id
       LEFT JOIN invoices i ON i.id = p.invoice_id
       LEFT JOIN customer_orders o ON o.id = p.order_id
       LEFT JOIN delivery_sheets ds ON ds.id = p.delivery_sheet_id
       WHERE p.status = 'Confirmed'
         AND ($1::uuid IS NULL OR p.customer_id = $1::uuid)
         AND ($2::date IS NULL OR business_date(p.payment_date) >= $2::date)
         AND ($3::date IS NULL OR business_date(p.payment_date) <= $3::date)
       ORDER BY p.payment_date DESC, p.created_at DESC
       LIMIT $4`,
      [q.customerId || null, day(q.from), day(q.to), limit],
    );
  });
}
