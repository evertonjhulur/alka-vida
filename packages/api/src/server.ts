/**
 * HTTP API.
 *
 * Roles map straight onto Section 10. Authorisation is enforced in the
 * service layer (requireRole) as well as here, so a route added later cannot
 * accidentally bypass a rule that protects money.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, type Db } from './db/index.ts';
import { migrate } from './db/migrate.ts';
import { login, verifyToken, type Session } from './lib/auth.ts';
import { ForbiddenError, RuleViolation } from '@alka/shared';
import type { Actor } from './services/core.ts';

import * as orders from './services/orders.ts';
import * as delivery from './services/delivery.ts';
import * as settlement from './services/settlement.ts';
import * as invoices from './services/invoices.ts';
import * as payments from './services/payments.ts';
import * as ledger from './services/ledger.ts';
import * as customers from './services/customers.ts';
import * as approvals from './services/approvals.ts';
import * as inventory from './services/inventory.ts';
import * as reports from './services/reports.ts';
import * as quotations from './services/quotations.ts';
import * as catalog from './services/catalog.ts';
import * as audits from './services/audits.ts';
import * as bottles from './services/bottles.ts';
import * as pricing from './services/pricing.ts';
import { counterSale } from './services/counter.ts';

declare module 'fastify' {
  interface FastifyRequest {
    session?: Session;
  }
}

export async function buildServer(db: Db) {
  // Quiet by default: the console window is user-facing, so only problems
  // should appear there. Set LOG_LEVEL=info to see every request.
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } });
  await app.register(cors, { origin: process.env.CORS_ORIGIN ?? true });

  // Business rules surface as 400, permission failures as 403.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof RuleViolation || err.name === 'RuleViolation') {
      return reply.status(400).send({ error: err.message });
    }
    if (err instanceof ForbiddenError || err.name === 'ForbiddenError') {
      return reply.status(403).send({ error: err.message });
    }
    if (err.name === 'InsufficientStockError') {
      return reply.status(400).send({ error: err.message });
    }

    // An unexpected failure. "internal error" alone leaves the person using
    // the app with nothing to report and nothing to act on, so surface the
    // actual message and a reference that ties it to the console output.
    const ref = Math.random().toString(36).slice(2, 8).toUpperCase();
    console.error(`\n  [${ref}] ${req.method} ${req.url}\n  ${err.stack ?? err.message}\n`);
    return reply.status(500).send({
      error: `Something went wrong: ${err.message}`,
      reference: ref,
    });
  });

  app.addHook('onRequest', async (req, reply) => {
    // Authentication guards the API only. The static frontend (the HTML shell,
    // its JS and CSS) must be publicly reachable - it contains no data, and
    // requiring a token to fetch the login page itself is a deadlock.
    if (!req.url.startsWith('/api/')) return;
    if (req.url.startsWith('/api/auth/login')) return;
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    const session = token ? verifyToken(token) : null;
    if (!session) return reply.status(401).send({ error: 'authentication required' });
    req.session = session;
  });

  const actorOf = (req: { session?: Session }): Actor => {
    const s = req.session!;
    return { id: s.id, name: s.name, role: s.role };
  };

  /** Guard a route to specific roles. */
  const allow = (...roles: Session['role'][]) =>
    async (req: { session?: Session }, reply: { status: (n: number) => { send: (b: unknown) => unknown } }) => {
      if (!req.session || !roles.includes(req.session.role)) {
        reply.status(403).send({ error: 'not permitted for your role' });
      }
    };

  /** A portal customer may only ever read their own records. */
  const assertOwnCustomer = (req: { session?: Session }, customerId: string) => {
    const s = req.session!;
    if (s.role === 'customer' && s.customerId !== customerId) {
      throw new ForbiddenError('you can only view your own records');
    }
  };

  app.get('/health', async () => ({ ok: true }));

  /**
   * Serve the built frontend from this same server when it exists, so the
   * whole system runs as ONE process on ONE port. Falls back silently when
   * the app has not been built (during development the Vite dev server
   * handles it instead, proxying /api here).
   */
  const webDist = join(
    dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist',
  );
  if (existsSync(join(webDist, 'index.html'))) {
    const fastifyStatic = (await import('@fastify/static')).default;
    await app.register(fastifyStatic, { root: webDist });

    /**
     * Cache policy, applied through Fastify's own reply API rather than
     * @fastify/static's setHeaders hook - that hook is handed an object
     * without setHeader here, and calling it crashes the whole server on the
     * first file served.
     *
     * Asset filenames carry a content hash, so they can be cached hard.
     * index.html must NOT be, or a browser keeps running the previous build
     * after an update and requests asset files that no longer exist.
     */
    app.addHook('onSend', async (req, reply) => {
      if (req.url.startsWith('/api/')) return;
      if (req.url.startsWith('/assets/')) {
        reply.header('cache-control', 'public, max-age=31536000, immutable');
      } else {
        reply.header('cache-control', 'no-cache, must-revalidate');
      }
    });

    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.status(404).send({ error: 'not found' });
      }
      // A missing asset must fail as a missing asset. Serving index.html here
      // hands the browser HTML where it expected JavaScript, which surfaces as
      // a baffling syntax error instead of an obvious 404.
      if (req.url.startsWith('/assets/')) {
        return reply.status(404).send({ error: 'asset not found - reload the page' });
      }
      // Everything else is a client route: serve the shell.
      return reply.sendFile('index.html');
    });
  }

  /* ---------------- auth ---------------- */

  app.post('/api/auth/login', async (req, reply) => {
    const { email, password } = req.body as { email: string; password: string };
    const result = await login(db, email, password);
    if (!result) return reply.status(401).send({ error: 'invalid email or password' });
    return result;
  });

  app.get('/api/auth/me', async (req) => req.session);

  /* ---------------- customers ---------------- */

  app.get('/api/customers', { preHandler: allow('admin', 'user', 'driver') },
    async () => customers.listSelectableCustomers(db));

  app.post('/api/customers', { preHandler: allow('admin', 'user') },
    async (req) => customers.createCustomer(db, actorOf(req), req.body as never));

  app.patch('/api/customers/:id', { preHandler: allow('admin', 'user') },
    async (req) => customers.updateCustomer(db, actorOf(req),
      (req.params as { id: string }).id, req.body as never));

  app.get('/api/customers/:id', { preHandler: allow('admin', 'user') },
    async (req) => customers.getCustomer(db, (req.params as { id: string }).id));

  app.post('/api/customers/merge', { preHandler: allow('admin') },
    async (req) => customers.mergeCustomers(db, actorOf(req), req.body as never));

  /**
   * The prices THIS customer will actually be charged, per product: their tier
   * rate where one exists, otherwise the product list price. Order entry uses
   * this so the total on screen matches the total that gets saved.
   */
  app.get('/api/customers/:id/prices', { preHandler: allow('admin', 'user', 'customer') },
    async (req) => {
      const { id } = req.params as { id: string };
      assertOwnCustomer(req, id);
      return db.query(
        `SELECT p.id AS product_id,
                p.name,
                p.bottles_per_case,
                COALESCE(pl.price_per_case_cents, p.price_per_case_cents)     AS price_per_case_cents,
                COALESCE(pl.price_per_bottle_cents, p.price_per_bottle_cents) AS price_per_bottle_cents,
                pt.name AS price_tier
         FROM products p
         LEFT JOIN customers c ON c.id = $1
         LEFT JOIN price_tiers pt ON pt.id = c.price_tier_id
         LEFT JOIN price_lists pl
           ON pl.product_id = p.id AND pl.price_tier_id = c.price_tier_id
         WHERE p.active
         ORDER BY p.name`,
        [id],
      );
    });

  app.get('/api/customers/:id/balance', async (req) => {
    const { id } = req.params as { id: string };
    assertOwnCustomer(req, id);
    return payments.getCustomerBalance(db, id);
  });

  app.get('/api/customers/:id/statement', async (req) => {
    const { id } = req.params as { id: string };
    assertOwnCustomer(req, id);
    const q = req.query as { from?: string; to?: string; filter?: ledger.StatementFilter };
    return ledger.getStatement(db, id, { from: q.from, to: q.to, filter: q.filter });
  });

  /* ---------------- catalogue ---------------- */

  app.get('/api/products', async () =>
    db.query(`SELECT * FROM products WHERE active ORDER BY name`));

  app.get('/api/price-tiers', { preHandler: allow('admin', 'user') }, async () =>
    db.query(`SELECT * FROM price_tiers ORDER BY name`));

  /* ---------------- products & pricing ---------------- */

  /** The full products x tiers rate card, for the pricing screen. */
  app.get('/api/pricing', { preHandler: allow('admin', 'user') },
    async () => pricing.priceMatrix(db));

  app.post('/api/products', { preHandler: allow('admin', 'user') },
    async (req) => pricing.createProduct(db, actorOf(req), req.body as never));

  app.patch('/api/products/:id', { preHandler: allow('admin', 'user') },
    async (req) => {
      await pricing.updateProduct(db, actorOf(req),
        (req.params as { id: string }).id, req.body as never);
      return { ok: true };
    });

  app.post('/api/price-tiers', { preHandler: allow('admin', 'user') },
    async (req) => pricing.createPriceTier(db, actorOf(req),
      (req.body as { name: string }).name));

  app.patch('/api/price-tiers/:id', { preHandler: allow('admin', 'user') },
    async (req) => {
      await pricing.renamePriceTier(db, actorOf(req),
        (req.params as { id: string }).id, (req.body as { name: string }).name);
      return { ok: true };
    });

  app.delete('/api/price-tiers/:id', { preHandler: allow('admin') },
    async (req) => {
      await pricing.deletePriceTier(db, actorOf(req), (req.params as { id: string }).id);
      return { ok: true };
    });

  /** Set or clear one tier's rate for one product. */
  app.put('/api/pricing/rate', { preHandler: allow('admin', 'user') },
    async (req) => {
      const b = req.body as {
        priceTierId: string; productId: string; priceCents: number | null;
      };
      if (b.priceCents === null) {
        await pricing.clearTierPrice(db, actorOf(req), b.priceTierId, b.productId);
      } else {
        await pricing.setTierPrice(db, actorOf(req), b as never);
      }
      return { ok: true };
    });

  /* ---------------- orders ---------------- */

  app.post('/api/orders', { preHandler: allow('admin', 'user', 'customer') },
    async (req) => {
      const body = req.body as orders.CreateOrderInput;
      const s = req.session!;
      // A portal order is always for the logged-in customer and marked Portal.
      if (s.role === 'customer') {
        if (!s.customerId) throw new ForbiddenError('this login is not linked to a customer');
        return orders.createOrder(db, actorOf(req),
          { ...body, customerId: s.customerId, source: 'Portal' });
      }
      return orders.createOrder(db, actorOf(req), body);
    });

  app.get('/api/orders', { preHandler: allow('admin', 'user') },
    async (req) => {
      const q = req.query as { status?: string; customerId?: string };
      return orders.listOrders(db, { status: q.status, customerId: q.customerId });
    });

  app.patch('/api/orders/:id', { preHandler: allow('admin', 'user') },
    async (req) => orders.editOrder(db, actorOf(req),
      (req.params as { id: string }).id, req.body as never));

  app.post('/api/orders/:id/cancel', { preHandler: allow('admin', 'user') },
    async (req) => {
      await orders.cancelOrder(db, actorOf(req), (req.params as { id: string }).id,
        (req.body as { reason?: string })?.reason);
      return { ok: true };
    });

  app.get('/api/orders/:id', async (req) => {
    const { id } = req.params as { id: string };
    const order = await orders.getOrder(db, id);
    if (order) assertOwnCustomer(req, (order as { customer_id: string }).customer_id);
    return order;
  });

  app.post('/api/counter-sale', { preHandler: allow('admin', 'user') },
    async (req) => counterSale(db, actorOf(req), req.body as never));

  /* ---------------- quotations ---------------- */

  app.post('/api/quotations', { preHandler: allow('admin', 'user') },
    async (req) => quotations.createQuotation(db, actorOf(req), req.body as never));

  app.get('/api/quotations/:id', { preHandler: allow('admin', 'user') },
    async (req) => quotations.getQuotation(db, (req.params as { id: string }).id));

  app.post('/api/quotations/:id/status', { preHandler: allow('admin', 'user') },
    async (req) => {
      const body = req.body as { status: 'Draft' | 'Sent' | 'Accepted' | 'Expired' | 'Declined' };
      await quotations.setQuotationStatus(db, actorOf(req),
        (req.params as { id: string }).id, body.status);
      return { ok: true };
    });

  app.post('/api/quotations/:id/convert', { preHandler: allow('admin', 'user') },
    async (req) => quotations.convertQuotation(db, actorOf(req),
      (req.params as { id: string }).id, req.body as never));

  /* ---------------- delivery ---------------- */

  app.get('/api/delivery-sheets', { preHandler: allow('admin', 'user', 'driver') },
    async (req) => {
      const q = req.query as { date?: string; status?: string };
      return db.query(
        `SELECT d.*, COUNT(s.id)::int AS stop_count
         FROM delivery_sheets d LEFT JOIN delivery_stops s ON s.delivery_sheet_id = d.id
         WHERE ($1::date IS NULL OR d.delivery_date = $1::date)
           AND ($2::text IS NULL OR d.status = $2)
         GROUP BY d.id ORDER BY d.delivery_date DESC, d.zone`,
        [q.date ?? null, q.status ?? null],
      );
    });

  app.get('/api/delivery-sheets/:id', { preHandler: allow('admin', 'user', 'driver') },
    async (req) => delivery.getSheet(db, (req.params as { id: string }).id));

  app.get('/api/stops/:id', { preHandler: allow('admin', 'user', 'driver') },
    async (req) => delivery.getStopForDriver(db, (req.params as { id: string }).id));

  // Marking a stop must always succeed; nothing about payment gates it.
  app.post('/api/stops/:id/outcome', { preHandler: allow('admin', 'user', 'driver') },
    async (req) => delivery.markStop(db, actorOf(req), {
      ...(req.body as delivery.MarkStopInput),
      stopId: (req.params as { id: string }).id,
    }));

  // Provisional only. Validated here, and never able to block the stop above.
  app.post('/api/stops/:id/allocation', { preHandler: allow('admin', 'user', 'driver') },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as { allocations: Array<{ invoiceId: string; amountCents: number }> };
      await delivery.saveStopAllocation(db, actorOf(req), id, body.allocations);
      return { ok: true };
    });

  app.post('/api/delivery-sheets/:id/add-order', { preHandler: allow('admin', 'user') },
    async (req) => delivery.addOrderToSheet(db, actorOf(req),
      (req.params as { id: string }).id, (req.body as { orderId: string }).orderId));

  app.post('/api/delivery-sheets/:id/resequence', { preHandler: allow('admin', 'user') },
    async (req) => {
      const body = req.body as { order: Array<{ stopId: string; sequenceNo: number }> };
      await delivery.resequenceStops(db, actorOf(req),
        (req.params as { id: string }).id, body.order);
      return { ok: true };
    });

  /* ---------------- settlement ---------------- */

  app.get('/api/delivery-sheets/:id/settlement', { preHandler: allow('admin', 'user') },
    async (req) => settlement.getSettlementReview(db, (req.params as { id: string }).id));

  // Adjusting the ALLOCATION is open to office staff.
  app.post('/api/stops/:id/adjust-allocation', { preHandler: allow('admin', 'user') },
    async (req) => {
      const body = req.body as { allocations: Array<{ invoiceId: string; amountCents: number }> };
      await settlement.adjustAllocation(db, actorOf(req),
        (req.params as { id: string }).id, body.allocations);
      return { ok: true };
    });

  // Correcting the RECORDED DATA is Admin-only, to prevent collusion.
  app.post('/api/stops/:id/correct', { preHandler: allow('admin') },
    async (req) => {
      const body = req.body as { changes: Record<string, unknown>; reason: string };
      await settlement.correctStopRecord(db, actorOf(req),
        (req.params as { id: string }).id, body.changes as never, body.reason);
      return { ok: true };
    });

  app.post('/api/delivery-sheets/:id/settle', { preHandler: allow('admin', 'user') },
    async (req) => settlement.settleRoute(db, actorOf(req),
      (req.params as { id: string }).id, req.body as never));

  /* ---------------- invoices ---------------- */

  app.get('/api/invoices', async (req) => {
    const s = req.session!;
    const q = req.query as { customerId?: string; status?: string };
    const customerId = s.role === 'customer' ? s.customerId : (q.customerId ?? null);
    return db.query(
      `SELECT * FROM invoice_ledger
       WHERE ($1::uuid IS NULL OR customer_id = $1::uuid)
         AND ($2::text IS NULL OR status = $2)
       ORDER BY invoice_date DESC, invoice_number DESC`,
      [customerId, q.status ?? null],
    );
  });

  app.get('/api/invoices/:id', async (req) => {
    const { id } = req.params as { id: string };
    const inv = await invoices.getInvoiceDetail(db, id);
    if (inv) assertOwnCustomer(req, (inv as { customerId: string }).customerId);
    return inv;
  });

  app.patch('/api/invoices/:id', { preHandler: allow('admin') },
    async (req) => invoices.editInvoice(db, actorOf(req),
      (req.params as { id: string }).id, req.body as never));

  app.post('/api/invoices/:id/sent', { preHandler: allow('admin', 'user') },
    async (req) => {
      await invoices.markInvoiceSent(db, actorOf(req), (req.params as { id: string }).id);
      return { ok: true };
    });

  app.post('/api/invoices/:id/credit-note', { preHandler: allow('admin', 'user') },
    async (req) => invoices.createCreditNote(db, actorOf(req), {
      invoiceId: (req.params as { id: string }).id,
      ...(req.body as { amountCents: number; reason: string }),
    }));

  app.post('/api/invoices/:id/discount', { preHandler: allow('admin', 'user') },
    async (req) => {
      const body = req.body as { discountPercent: number; reason: string };
      return approvals.requestInvoiceDiscount(db, actorOf(req),
        (req.params as { id: string }).id, body.discountPercent, body.reason);
    });

  /* ---------------- payments ---------------- */

  app.post('/api/payments', { preHandler: allow('admin', 'user') },
    async (req) => payments.recordPayment(db, actorOf(req), req.body as never));

  app.post('/api/payments/:id/reverse', { preHandler: allow('admin') },
    async (req) => payments.reversePayment(db, actorOf(req),
      (req.params as { id: string }).id, (req.body as { reason?: string })?.reason));

  app.post('/api/payments/:id/reassign', { preHandler: allow('admin') },
    async (req) => {
      const body = req.body as {
        customerId?: string; invoiceId?: string | null; reason?: string;
      };
      return payments.reassignPayment(db, actorOf(req),
        (req.params as { id: string }).id, body, body.reason);
    });

  /* ---------------- approvals ---------------- */

  app.get('/api/approvals', { preHandler: allow('admin', 'user') },
    async () => approvals.listPendingApprovals(db));

  app.post('/api/approvals/:id/review', { preHandler: allow('admin') },
    async (req) => {
      const body = req.body as { decision: 'Approved' | 'Rejected'; notes?: string };
      return approvals.reviewApproval(db, actorOf(req),
        (req.params as { id: string }).id, body.decision, body.notes);
    });

  /* ---------------- suppliers ---------------- */

  app.get('/api/suppliers', { preHandler: allow('admin', 'user') },
    async () => catalog.listSuppliers(db));

  app.post('/api/suppliers', { preHandler: allow('admin', 'user') },
    async (req) => catalog.createSupplier(db, actorOf(req), req.body as never));

  app.patch('/api/suppliers/:id', { preHandler: allow('admin', 'user') },
    async (req) => {
      await catalog.updateSupplier(db, actorOf(req),
        (req.params as { id: string }).id, req.body as never);
      return { ok: true };
    });

  /** Attach a material to a supplier with a cost and optional price breaks. */
  app.post('/api/suppliers/:id/materials', { preHandler: allow('admin', 'user') },
    async (req) => {
      await catalog.setSupplierMaterial(db, actorOf(req), {
        supplierId: (req.params as { id: string }).id,
        ...(req.body as { rawMaterialId: string; unitCostCents: number }),
      });
      return { ok: true };
    });

  app.delete('/api/suppliers/:id/materials/:materialId', { preHandler: allow('admin', 'user') },
    async (req) => {
      const p = req.params as { id: string; materialId: string };
      await catalog.removeSupplierMaterial(db, actorOf(req), p.id, p.materialId);
      return { ok: true };
    });

  /** What a supplier would charge for a quantity - drives PO line pricing. */
  app.get('/api/suppliers/:id/price', { preHandler: allow('admin', 'user') },
    async (req) => {
      const { id } = req.params as { id: string };
      const q = req.query as { materialId: string; quantity: string };
      const unitCostCents = await inventory.lookupSupplierPrice(
        db, id, q.materialId, Number(q.quantity) || 0,
      );
      return { unitCostCents };
    });

  /* ---------------- raw materials ---------------- */

  app.get('/api/raw-materials', { preHandler: allow('admin', 'user') },
    async () => catalog.listRawMaterials(db));

  app.post('/api/raw-materials', { preHandler: allow('admin', 'user') },
    async (req) => catalog.createRawMaterial(db, actorOf(req), req.body as never));

  app.patch('/api/raw-materials/:id', { preHandler: allow('admin', 'user') },
    async (req) => {
      await catalog.updateRawMaterial(db, actorOf(req),
        (req.params as { id: string }).id, req.body as never);
      return { ok: true };
    });

  app.get('/api/raw-materials/:id/batches', { preHandler: allow('admin', 'user') },
    async (req) => catalog.materialBatches(db, (req.params as { id: string }).id));

  /* ---------------- bills of material ---------------- */

  app.get('/api/products/:id/bom', { preHandler: allow('admin', 'user') },
    async (req) => catalog.getBom(db, (req.params as { id: string }).id));

  app.put('/api/products/:id/bom', { preHandler: allow('admin', 'user') },
    async (req) => {
      await catalog.setBom(db, actorOf(req), (req.params as { id: string }).id,
        (req.body as { lines: never[] }).lines);
      return { ok: true };
    });

  /* ---------------- purchase orders ---------------- */

  app.get('/api/purchase-orders', { preHandler: allow('admin', 'user') },
    async (req) => inventory.listPurchaseOrders(db, (req.query as { status?: string }).status));

  app.get('/api/purchase-orders/:id', { preHandler: allow('admin', 'user') },
    async (req) => inventory.getPurchaseOrder(db, (req.params as { id: string }).id));

  app.post('/api/purchase-orders', { preHandler: allow('admin', 'user') },
    async (req) => inventory.createPurchaseOrder(db, actorOf(req), req.body as never));

  app.post('/api/purchase-orders/:id/receive', { preHandler: allow('admin', 'user') },
    async (req) => inventory.receivePurchaseOrder(db, actorOf(req),
      (req.params as { id: string }).id,
      (req.body as { receipts: never[] }).receipts));

  /* ---------------- production ---------------- */

  app.get('/api/production', { preHandler: allow('admin', 'user') },
    async () => inventory.listProductionBatches(db));

  app.get('/api/production/feasibility', { preHandler: allow('admin', 'user') },
    async (req) => {
      const q = req.query as { productId: string; bottles: string };
      return inventory.productionFeasibility(db, q.productId, Number(q.bottles) || 0);
    });

  app.post('/api/production', { preHandler: allow('admin', 'user') },
    async (req) => inventory.completeProduction(db, actorOf(req), req.body as never));

  /* ---------------- stock ---------------- */

  app.get('/api/finished-goods', { preHandler: allow('admin', 'user') },
    async () => inventory.finishedGoods(db));

  app.get('/api/inventory-transactions', { preHandler: allow('admin', 'user') },
    async (req) => {
      const q = req.query as { itemType?: string; itemId?: string; limit?: string };
      return inventory.listInventoryTransactions(db, {
        itemType: q.itemType, itemId: q.itemId,
        limit: q.limit ? Number(q.limit) : undefined,
      });
    });

  /* ---------------- 5-gallon bottle pool ---------------- */

  app.get('/api/bottle-pool', { preHandler: allow('admin', 'user', 'driver') },
    async () => ({
      pools: await bottles.listPools(db),
      holdings: await bottles.customerHoldings(db),
      history: await bottles.poolHistory(db),
    }));

  /** Returned dirty bottles washed back into clean, ready stock. */
  app.post('/api/bottle-pool/wash', { preHandler: allow('admin', 'user') },
    async (req) => bottles.washBottles(db, actorOf(req), req.body as never));

  /** Direct correction of the counts. Admin only, reason required. */
  app.post('/api/bottle-pool/adjust', { preHandler: allow('admin') },
    async (req) => bottles.adjustPool(db, actorOf(req), req.body as never));

  /* ---------------- stock counts / audit ---------------- */

  app.get('/api/audits', { preHandler: allow('admin', 'user') },
    async (req) => audits.listAudits(db, (req.query as { status?: 'Open' | 'Reconciled' }).status));

  app.post('/api/audits', { preHandler: allow('admin', 'user') },
    async (req) => audits.recordCount(db, actorOf(req), req.body as never));

  // Reconciling writes off real value, so it is admin-only.
  app.post('/api/audits/:id/reconcile', { preHandler: allow('admin') },
    async (req) => audits.reconcileCount(db, actorOf(req),
      (req.params as { id: string }).id, (req.body as { notes?: string })?.notes));

  /* ---------------- reports ---------------- */

  app.get('/api/reports/discounts', { preHandler: allow('admin', 'user') },
    async (req) => {
      const q = req.query as { from?: string; to?: string };
      return {
        totals: await reports.totalDiscounts(db, q.from, q.to),
        byClient: await reports.discountsByClient(db, q.from, q.to),
      };
    });

  app.get('/api/reports/material-costs', { preHandler: allow('admin', 'user') },
    async (req) => inventory.materialCostReport(db, (req.query as { id?: string }).id));

  app.get('/api/reports/receivables', { preHandler: allow('admin', 'user') },
    async () => reports.receivablesSummary(db));

  app.get('/api/reports/reorder', { preHandler: allow('admin', 'user') },
    async () => reports.reorderReport(db));

  app.get('/api/reports/bottle-pool', { preHandler: allow('admin', 'user') },
    async () => reports.bottlePoolReport(db));

  return app;
}

if (import.meta.filename === process.argv[1]) {
  const db = await createDb();
  await migrate(db, { quiet: true });

  // First run on a fresh machine: load the starting data so the app is
  // usable immediately. seed() is idempotent and skips once data exists.
  const { seed } = await import('./db/seed.ts');
  await seed(db, { quiet: true });

  const app = await buildServer(db);
  const port = Number(process.env.PORT ?? 3001);

  try {
    await app.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    // Almost always means Alka Vida is already open in another window.
    // A Node stack trace is no help to the person reading this, so say
    // plainly what happened and what to do.
    if ((err as { code?: string }).code === 'EADDRINUSE') {
      console.log('');
      console.log('  Alka Vida is already running in another window.');
      console.log('');
      console.log(`  Open  http://localhost:${port}  to use it.`);
      console.log('');
      console.log('  If you want to restart it, close the other Alka Vida');
      console.log('  window first, then open Alka Vida again.');
      console.log('');
      process.exit(0);
    }
    throw err;
  }

  console.log('');
  console.log('  Alka Vida is running.');
  console.log(`  Open  http://localhost:${port}`);
  console.log('');
  console.log('  Sign in with:');
  console.log('    admin@alkavida.jm      / admin1234    (administrator)');
  console.log('    office@alkavida.jm     / office1234   (office staff)');
  console.log('    driver@alkavida.jm     / driver1234   (delivery driver)');
  console.log('    ap@bluemountain.jm     / portal1234   (customer portal)');
  console.log('');
  console.log('  Close this window to stop Alka Vida.');
  console.log('');
}
