/**
 * HTTP API.
 *
 * Roles map straight onto Section 10. Authorisation is enforced in the
 * service layer (requireRole) as well as here, so a route added later cannot
 * accidentally bypass a rule that protects money.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, type Db } from './db/index.ts';
import { migrate } from './db/migrate.ts';
import { loadSigningKey, login, userAccess, verifyToken, type Session } from './lib/auth.ts';
import { loadSettings } from './lib/settings.ts';
import { ForbiddenError, RuleViolation, type RecurrencePattern } from '@alka/shared';
import { BUSINESS_TIMEZONE, type Actor } from './services/core.ts';

import * as orders from './services/orders.ts';
import * as delivery from './services/delivery.ts';
import * as routing from './services/routing.ts';
import * as settlement from './services/settlement.ts';
import * as invoices from './services/invoices.ts';
import * as documents from './services/documents.ts';
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
import * as recurring from './services/recurring.ts';
import * as users from './services/users.ts';
import * as invitations from './services/invitations.ts';
import * as registration from './services/registration.ts';
import * as zones from './services/zones.ts';
import { collectOrder, counterSale } from './services/counter.ts';

declare module 'fastify' {
  interface FastifyRequest {
    session?: Session;
  }
}

export async function buildServer(db: Db) {
  // Settings the owner edits in Notepad, loaded before anything reads them.
  loadSettings();

  // Tokens are signed with a per-install key kept in this database, so a
  // token minted against a previous one stops verifying. Must happen before
  // any route can sign or check a token.
  await loadSigningKey(db);

  // business_today() resolves dates against this. Keeping it in the database
  // means SQL defaults and application code cannot disagree about what day
  // it is - which is exactly how invoices ended up dated a day ahead.
  await db.query(
    `INSERT INTO system_settings (key, value) VALUES ('business_timezone', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [BUSINESS_TIMEZONE],
  );

  // Quiet by default: the console window is user-facing, so only problems
  // should appear there. Set LOG_LEVEL=info to see every request.
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } });
  await app.register(cors, { origin: process.env.CORS_ORIGIN ?? true });

  /**
   * Accept an empty body on a JSON request.
   *
   * Plenty of endpoints here are pure actions - start a route, delete a tier,
   * mark an invoice sent - and carry nothing. Fastify's stock JSON parser
   * rejects those outright ("Body cannot be empty..."), which surfaces to the
   * person clicking the button as a 500 with a database-flavoured message for
   * what is really an empty POST. Treat no body as {}.
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' },
    (_req, body: string, done) => {
      if (!body || body.trim() === '') return done(null, {});
      try {
        done(null, JSON.parse(body));
      } catch (err) {
        (err as { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    });

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

    // Fastify's own client errors - malformed JSON, a bad route parameter -
    // already carry the right 4xx. Reporting those as an internal failure
    // sends the reader hunting a server bug for what is a bad request.
    const clientStatus = (err as { statusCode?: number }).statusCode;
    if (clientStatus && clientStatus >= 400 && clientStatus < 500) {
      return reply.status(clientStatus).send({ error: err.message });
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
    // Answering this is how the browser learns the server is out of date;
    // requiring a token would hide the very problem it exists to report.
    if (req.url.startsWith('/api/version')) return;
    // Asking for an account, and setting a password from an invitation, are
    // both done by people who by definition have no way in yet. Each is
    // written to give nothing away to somebody who is only probing.
    if (req.url.startsWith('/api/register')) return;
    if (req.url.startsWith('/api/invitations/')) return;
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    const session = token ? verifyToken(token) : null;
    if (!session) return reply.status(401).send({ error: 'authentication required' });

    // A good signature proves the token came from this system - not that the
    // person it names is still here. Wiping the data reseeds the users with
    // new ids, leaving a browser "signed in" as somebody who is gone. Left
    // unchecked that surfaces at the END of the first write, as a raw
    // audit_log foreign key error, with the order number already burned.
    const access = await userAccess(db, session.id);
    if (access === 'gone') {
      return reply.status(401).send({
        error: 'Your session has expired. Please sign in again.',
      });
    }
    // Checked per request, not only at login, so withdrawing access takes
    // effect on the very next thing they touch.
    if (access === 'disabled') {
      return reply.status(401).send({
        error: 'This login has been deactivated. Speak to an administrator.',
      });
    }
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
  /**
   * The frontend build this server came up with.
   *
   * The server serves packages/web/dist from disk on every request, so
   * rebuilding the app changes what the BROWSER gets while this process keeps
   * running the old API. A new screen then calls endpoints that do not exist
   * and the page dies - which reads as "the screen goes blank", with nothing
   * to suggest that closing and reopening the window is the fix.
   *
   * Read once, at startup, on purpose: it has to reflect the process, not
   * whatever is on disk now.
   */
  let startedWithBuild: string | null = null;
  try {
    const shell = readFileSync(join(webDist, 'index.html'), 'utf8');
    startedWithBuild = shell.match(/assets\/([A-Za-z0-9._-]+\.js)/)?.[1] ?? null;
  } catch { /* no build yet: the dev server is serving the frontend */ }

  app.get('/api/version', async () => ({ build: startedWithBuild }));

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

  // Anybody may change their OWN password - the one thing in user
  // administration that is not restricted to an administrator.
  app.post('/api/auth/change-password', async (req) => {
    const body = req.body as { currentPassword: string; newPassword: string };
    await users.changeOwnPassword(db, actorOf(req), body.currentPassword, body.newPassword);
    return { ok: true };
  });

  /* ---------------- the portal's own actions ---------------- */

  /** The customer this portal session belongs to, or a refusal. */
  const portalCustomer = (req: { session?: Session }): string => {
    const s = req.session!;
    if (s.role !== 'customer' || !s.customerId) {
      throw new ForbiddenError('this is only for a customer portal login');
    }
    return s.customerId;
  };

  app.post('/api/portal/orders/:id/cancel', { preHandler: allow('customer') },
    async (req) => {
      const body = (req.body ?? {}) as { reason?: string };
      await orders.cancelOwnOrder(db, actorOf(req), portalCustomer(req),
        (req.params as { id: string }).id, body.reason);
      return { ok: true };
    });

  app.get('/api/portal/recurring', { preHandler: allow('customer') },
    async (req) => recurring.listSchedulesForCustomer(db, portalCustomer(req)));

  // Turn one of their own pending orders into a repeat.
  app.post('/api/portal/orders/:id/repeat', { preHandler: allow('customer') },
    async (req) => {
      const body = req.body as { pattern: RecurrencePattern; endsOn?: string | null };
      return recurring.startOwnSchedule(db, actorOf(req), portalCustomer(req),
        (req.params as { id: string }).id,
        { pattern: body.pattern, endsOn: body.endsOn ?? null });
    });

  app.post('/api/portal/recurring/:id/pause', { preHandler: allow('customer') },
    async (req) => {
      const body = req.body as { paused: boolean };
      await recurring.setOwnSchedulePaused(db, actorOf(req), portalCustomer(req),
        (req.params as { id: string }).id, body.paused === true);
      return { ok: true };
    });

  app.post('/api/portal/recurring/:id/cancel', { preHandler: allow('customer') },
    async (req) => {
      const body = (req.body ?? {}) as { reason?: string };
      await recurring.endOwnSchedule(db, actorOf(req), portalCustomer(req),
        (req.params as { id: string }).id, body.reason);
      return { ok: true };
    });

  /**
   * What is sitting waiting for somebody, for the badges in the sidebar.
   *
   * One small call rather than the screens each polling their own list: the
   * navigation is on every page, and a request per module per page load is a
   * cost paid constantly for something that is usually zero.
   */
  app.get('/api/pending-counts', { preHandler: allow('admin', 'user') },
    async () => {
      const apps = await db.one<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM customer_applications WHERE status = 'Pending'`);
      const approvals = await db.one<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM approval_requests WHERE status = 'Pending'`);
      return { applications: Number(apps.n), approvals: Number(approvals.n) };
    });

  /* ---------------- delivery zones ---------------- */

  app.get('/api/zones', { preHandler: allow('admin', 'user') },
    async () => zones.listZones(db));

  app.post('/api/zones', { preHandler: allow('admin', 'user') },
    async (req) => zones.createZone(db, actorOf(req), req.body as never));

  app.patch('/api/zones/:id', { preHandler: allow('admin', 'user') },
    async (req) => {
      await zones.updateZone(db, actorOf(req), (req.params as { id: string }).id,
        req.body as never);
      return { ok: true };
    });

  app.delete('/api/zones/:id', { preHandler: allow('admin') },
    async (req) => zones.deleteZone(db, actorOf(req), (req.params as { id: string }).id));

  app.post('/api/zones/:id/restore', { preHandler: allow('admin') },
    async (req) => {
      await zones.restoreZone(db, actorOf(req), (req.params as { id: string }).id);
      return { ok: true };
    });

  /* ---------------- registration and invitations ---------------- */

  // PUBLIC. A prospect asking for a trading account. It creates a request,
  // never an account: the price tier, delivery zone and terms are the
  // office's to set, and until they do there is nothing to sign in to.
  app.post('/api/register', async (req) =>
    registration.submitApplication(db, req.body as never));

  // PUBLIC. Who an invitation is for, so the page can greet them. Returns
  // null for anything that is not a live invitation - never why, because the
  // difference between "expired", "used" and "invented" only helps somebody
  // working through tokens.
  app.get('/api/invitations/:token', async (req) => {
    const { token } = req.params as { token: string };
    return { invitee: await invitations.inviteeFor(db, token) };
  });

  // PUBLIC. Setting a password from an invitation - the one way into an
  // account nobody has ever signed into.
  app.post('/api/invitations/:token/accept', async (req) => {
    const { token } = req.params as { token: string };
    const body = req.body as { password: string };
    return invitations.acceptInvitation(db, token, body?.password);
  });

  app.get('/api/applications', { preHandler: allow('admin', 'user') },
    async (req) => registration.listApplications(db, actorOf(req),
      (req.query as { status?: string }).status));

  app.post('/api/applications/:id/approve', { preHandler: allow('admin') },
    async (req) => registration.approveApplication(db, actorOf(req),
      (req.params as { id: string }).id, req.body as never));

  app.post('/api/applications/:id/decline', { preHandler: allow('admin') },
    async (req) => {
      const body = req.body as { reason?: string };
      await registration.declineApplication(db, actorOf(req),
        (req.params as { id: string }).id, body?.reason);
      return { ok: true };
    });

  // Issue (or re-issue) an invitation for an existing login. The link comes
  // back either way: with no mail account set up, the office reads it out or
  // sends it on, which is how this will be used on day one.
  app.post('/api/users/:id/invite', { preHandler: allow('admin') },
    async (req) => {
      const inv = await invitations.createInvitation(db, actorOf(req),
        (req.params as { id: string }).id);
      const mail = await invitations.emailInvitation(inv.email, inv.name, inv.link);
      return { link: inv.link, expiresAt: inv.expiresAt, to: inv.email, ...mail };
    });

  /* ---------------- user administration ---------------- */

  app.get('/api/users', { preHandler: allow('admin') },
    async (req) => users.listUsers(db, actorOf(req)));

  app.post('/api/users', { preHandler: allow('admin') },
    async (req) => users.createUser(db, actorOf(req), req.body as never));

  app.patch('/api/users/:id', { preHandler: allow('admin') },
    async (req) => {
      await users.updateUser(db, actorOf(req),
        (req.params as { id: string }).id, req.body as never);
      return { ok: true };
    });

  // Withdrawing access, rather than deleting: audit_log rows reference a
  // user, so a person is never removed.
  app.post('/api/users/:id/active', { preHandler: allow('admin') },
    async (req) => {
      const body = req.body as { active: boolean };
      await users.setUserActive(db, actorOf(req),
        (req.params as { id: string }).id, body.active === true);
      return { ok: true };
    });

  app.post('/api/users/:id/password', { preHandler: allow('admin') },
    async (req) => {
      const body = req.body as { password: string };
      await users.resetPassword(db, actorOf(req),
        (req.params as { id: string }).id, body.password);
      return { ok: true };
    });

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

  // The statement as a document. A customer may download their own, the same
  // rule the JSON above follows.
  app.get('/api/customers/:id/statement.pdf', async (req, reply) => {
    const { id } = req.params as { id: string };
    assertOwnCustomer(req, id);
    const q = req.query as { from?: string; to?: string; filter?: ledger.StatementFilter };
    const doc = await documents.renderStatementPdf(db, id,
      { from: q.from, to: q.to, filter: q.filter });
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${doc.filename}"`)
      .send(doc.pdf);
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
      const s = req.session!;
      // A portal order goes through its own narrow entry point rather than
      // the office one. Spreading the request body into createOrder let a
      // customer set a line price - which outranks their tier rate - and a
      // discount. createPortalOrder takes quantities and nothing else.
      if (s.role === 'customer') {
        if (!s.customerId) throw new ForbiddenError('this login is not linked to a customer');
        return orders.createPortalOrder(db, actorOf(req), s.customerId,
          req.body as orders.PortalOrderInput);
      }
      return orders.createOrder(db, actorOf(req), req.body as orders.CreateOrderInput);
    });

  app.get('/api/orders', { preHandler: allow('admin', 'user', 'customer') },
    async (req) => {
      const q = req.query as { status?: string; customerId?: string };
      const s = req.session!;
      // A customer sees their own orders and no one else's, whatever they ask
      // for - the same rule the invoice list follows.
      const customerId = s.role === 'customer' ? s.customerId ?? undefined : q.customerId;
      return orders.listOrders(db, { status: q.status, customerId });
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

  // A pickup order being collected: billed now, from what is handed over.
  app.post('/api/orders/:id/collect', { preHandler: allow('admin', 'user') },
    async (req) => collectOrder(db, actorOf(req), {
      ...(req.body as Record<string, unknown>),
      orderId: (req.params as { id: string }).id,
    } as never));

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
      return routing.listSheets(db, actorOf(req), { date: q.date, status: q.status });
    });

  app.get('/api/drivers', { preHandler: allow('admin', 'user') },
    async () => routing.listDrivers(db));

  app.post('/api/delivery-sheets/:id/assign', { preHandler: allow('admin', 'user', 'driver') },
    async (req) => routing.assignDriver(db, actorOf(req), (req.params as { id: string }).id,
      (req.body as { driverId?: string | null }).driverId ?? null));

  app.post('/api/delivery-sheets/:id/start', { preHandler: allow('admin', 'user', 'driver') },
    async (req) => routing.startRoute(db, actorOf(req), (req.params as { id: string }).id));

  app.get('/api/delivery-sheets/:id/candidates', { preHandler: allow('admin', 'user') },
    async (req) => routing.deliveryCandidates(db, (req.params as { id: string }).id));

  app.delete('/api/stops/:id', { preHandler: allow('admin', 'user') },
    async (req) => routing.removeStop(db, actorOf(req), (req.params as { id: string }).id));

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
  app.post('/api/stops/:id/correct', { preHandler: allow('admin', 'user') },
    async (req) => {
      const body = req.body as { changes: Record<string, unknown>; reason: string };
      // An admin correction applies at once; an office one waits for approval.
      return settlement.requestStopCorrection(db, actorOf(req),
        (req.params as { id: string }).id, body.changes as never, body.reason);
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

  // The invoice as a document: the same figures the screen shows.
  app.get('/api/invoices/:id/pdf', { preHandler: allow('admin', 'user') },
    async (req, reply) => {
      const doc = await documents.renderInvoicePdf(db, (req.params as { id: string }).id);
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', `attachment; filename="${doc.filename}"`)
        .send(doc.pdf);
    });

  // Whether a Send button can work at all, so a screen can say so plainly
  // instead of offering something that will fail.
  app.get('/api/settings/mail', { preHandler: allow('admin', 'user') },
    async () => ({ configured: documents.mailConfigured() }));

  app.post('/api/invoices/:id/email', { preHandler: allow('admin', 'user') },
    async (req) => documents.emailInvoice(db, actorOf(req),
      (req.params as { id: string }).id,
      (req.body as { to?: string | null }).to ?? null));

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

  // Money received now, applied across whichever invoices it covers. This is
  // the bank-transfer path: one receipt, several invoices, a remainder on
  // account if it does not land exactly.
  app.post('/api/payments/receive', { preHandler: allow('admin', 'user') },
    async (req) => payments.receivePayment(db, actorOf(req), req.body as never));

  app.get('/api/payments/unapplied', { preHandler: allow('admin', 'user') },
    async (req) => payments.unappliedPayments(db,
      (req.query as { customerId?: string }).customerId));

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

  /* ---------------- material categories and sizes ---------------- */

  // Anyone who can see materials needs the list in order to read the screen;
  // only an admin changes what the list contains.
  app.get('/api/material-categories', { preHandler: allow('admin', 'user') },
    async () => catalog.listMaterialCategories(db));

  app.post('/api/material-categories', { preHandler: allow('admin') },
    async (req) => catalog.createMaterialCategory(db, actorOf(req), req.body as never));

  app.patch('/api/material-categories/:id', { preHandler: allow('admin') },
    async (req) => {
      await catalog.updateMaterialCategory(db, actorOf(req),
        (req.params as { id: string }).id, req.body as never);
      return { ok: true };
    });

  // Deletes outright when nothing is filed under it, retires it when
  // something is. The response says which happened.
  app.delete('/api/material-categories/:id', { preHandler: allow('admin') },
    async (req) => catalog.deleteMaterialCategory(db, actorOf(req),
      (req.params as { id: string }).id));

  app.post('/api/material-categories/:id/restore', { preHandler: allow('admin') },
    async (req) => {
      await catalog.restoreMaterialCategory(db, actorOf(req), (req.params as { id: string }).id);
      return { ok: true };
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

  // Deletes a material nothing has ever used; retires one that carries
  // history, so past costing and stock value survive. Admin only - it is the
  // one action on this screen that cannot simply be typed back in.
  app.delete('/api/raw-materials/:id', { preHandler: allow('admin') },
    async (req) => catalog.deleteRawMaterial(db, actorOf(req),
      (req.params as { id: string }).id));

  app.post('/api/raw-materials/:id/restore', { preHandler: allow('admin') },
    async (req) => {
      await catalog.restoreRawMaterial(db, actorOf(req), (req.params as { id: string }).id);
      return { ok: true };
    });

  app.get('/api/raw-materials/:id/batches', { preHandler: allow('admin', 'user') },
    async (req) => catalog.materialBatches(db, (req.params as { id: string }).id));

  // Material used outside a production run - 5gal labels applied to rotated
  // bottles being the case that requires it.
  app.post('/api/raw-materials/:id/issue', { preHandler: allow('admin', 'user') },
    async (req) => {
      const body = req.body as { quantity: number; reason?: string | null };
      return inventory.issueMaterial(db, actorOf(req), {
        rawMaterialId: (req.params as { id: string }).id,
        quantity: Number(body.quantity),
        reason: body.reason ?? null,
      });
    });

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

  /* ---------------- standing orders ---------------- */

  app.get('/api/recurring', { preHandler: allow('admin', 'user') },
    async () => recurring.listSchedules(db));

  /** Raise every occurrence now due. Safe to call repeatedly. */
  app.post('/api/recurring/generate', { preHandler: allow('admin', 'user') },
    async (req) => recurring.generateDueOrders(db, actorOf(req)));

  /** Turn an existing order into the start of a standing order. */
  app.post('/api/orders/:id/recurring', { preHandler: allow('admin', 'user') },
    async (req) => recurring.startSchedule(db, actorOf(req),
      (req.params as { id: string }).id, req.body as never));

  app.patch('/api/recurring/:id', { preHandler: allow('admin', 'user') },
    async (req) => {
      await recurring.updateSchedule(db, actorOf(req),
        (req.params as { id: string }).id, req.body as never);
      return { ok: true };
    });

  app.post('/api/recurring/:id/pause', { preHandler: allow('admin', 'user') },
    async (req) => recurring.setSchedulePaused(db, actorOf(req),
      (req.params as { id: string }).id, (req.body as { paused: boolean }).paused));

  app.post('/api/recurring/:id/end', { preHandler: allow('admin', 'user') },
    async (req) => {
      await recurring.endSchedule(db, actorOf(req), (req.params as { id: string }).id,
        (req.body as { reason?: string })?.reason);
      return { ok: true };
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

  // What moved for this item since the count was taken - what confirming
  // would overwrite.
  app.get('/api/audits/:id/movements', { preHandler: allow('admin', 'user') },
    async (req) => audits.movementsSinceCount(db, (req.params as { id: string }).id));

  // Reconciling writes off real value, so it is admin-only. It is refused
  // when stock moved after the count was taken, unless the caller says
  // explicitly that it should be applied over those movements anyway.
  app.post('/api/audits/:id/reconcile', { preHandler: allow('admin') },
    async (req) => {
      const body = (req.body ?? {}) as { notes?: string; evenThoughStockMoved?: boolean };
      return audits.reconcileCount(db, actorOf(req), (req.params as { id: string }).id,
        body.notes, { evenThoughStockMoved: body.evenThoughStockMoved === true });
    });

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

  /**
   * Raise standing orders that have come due.
   *
   * Runs at startup and then once an hour. This app is opened and closed like
   * a desktop program rather than left running on a server, so waiting for a
   * nightly moment would mean a machine that is off overnight never generates
   * anything. Opening it is the reliable trigger; the timer covers a machine
   * left on for days.
   *
   * The work is idempotent - a unique index makes a duplicate occurrence
   * impossible - so running it often costs nothing and missing a run only
   * delays, never loses.
   */
  // Work the system does on its own still has to be attributable, and the
  // audit log's user_id is a real foreign key. So it gets its own account
  // rather than borrowing a person's - nobody should appear in the log
  // raising orders at 3am. It cannot be signed into: the password hash is
  // deliberately not a valid one.
  const systemUser = await db.one<{ id: string }>(
    `INSERT INTO users (email, name, password_hash, role, active)
     VALUES ('system@alkavida.local', 'Alka Vida (automatic)', 'x-not-a-login', 'admin', false)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
  );
  const generator: Actor = {
    id: systemUser.id, name: 'Alka Vida (automatic)', role: 'admin',
  };
  const runStandingOrders = async (why: string) => {
    try {
      const { generateDueOrders } = await import('./services/recurring.ts');
      const r = await generateDueOrders(db, generator);
      if (r.created.length) {
        console.log(`  ${r.created.length} standing order(s) raised (${why}).`);
      }
      if (r.skipped.length) {
        console.log(
          `  ${r.skipped.length} standing order date(s) were too far past to raise. ` +
          `See Standing orders for which.`,
        );
      }
      for (const p of r.problems) {
        console.log(`  Standing order for ${p.customerName} needs attention: ${p.reason}`);
      }
    } catch (err) {
      // Never let this stop the app starting - the office can still work,
      // and the button on the Standing orders screen retries it.
      console.error(`  Could not raise standing orders: ${(err as Error).message}`);
    }
  };

  await runStandingOrders('on startup');
  const timer = setInterval(() => { void runStandingOrders('hourly check'); }, 60 * 60 * 1000);
  timer.unref();

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
