# How Alka Vida works

A code outline for whoever moves this off the office machine — written
against the code as it stands at commit `0fe0d8f`, not from memory.

Read alongside:
- **`HANDOFF.md`** — what the system does and the rules it must not break
- **`DEPLOY.md`** — the practical steps to host it

The short version: **this is an ordinary Node server talking to an ordinary
PostgreSQL database.** There is no framework magic, no ORM, no build step on
the server side. That is what makes the migration you are planning mostly a
configuration exercise rather than a rewrite.

---

## 1. Shape of the thing

Three packages in one npm workspace, about 31,000 lines.

```
packages/
  shared/   Pure domain logic. No I/O, no database, no HTTP.
            money · allocation · FIFO · recurrence · types
            68 tests, and they run in milliseconds because
            there is nothing to set up.

  api/      db/          two adapters behind one interface
            migrations/  15 numbered .sql files
            lib/         auth, settings
            services/    25 files — ALL the business rules
            server.ts    153 HTTP routes, thin
            test/        343 tests against real PostgreSQL

  web/      React + Vite. 33 page components.
            lib/api.ts     the typed client
            lib/format.ts  money and dates at the edge
```

**The layering rule that matters:** business rules live in `services/`, never
in routes and never in the browser. A route is three or four lines that
unwraps the request and calls a service. The browser is a rendering layer
that never decides anything. If you are porting or re-hosting, `services/`
is the system; everything around it is plumbing you can replace.

### TypeScript runs unbuilt

The server runs `.ts` files directly using Node's own type-stripping. There
is **no compile step and no `dist/` on the API side** — `node src/server.ts`
is the whole thing.

Two consequences you will hit:

- **Node 24+ is mandatory.** Below that, the first `.ts` import is a syntax
  error. This is the single most common deployment failure.
- **Only "erasable" TypeScript is allowed.** No `enum`, no constructor
  parameter properties, no namespaces — anything that emits runtime code.
  Imports carry real `.ts` extensions (`from './core.ts'`), which looks wrong
  to anyone used to bundlers and is correct here.

The browser side *is* built — `tsc && vite build` into `packages/web/dist`,
which the API server serves as static files from disk.

---

## 2. The database layer

`packages/api/src/db/index.ts` — about 190 lines, and the most important file
for your migration.

One interface, two implementations:

```ts
interface Queryable {
  query<T>(sql, params?): Promise<T[]>
  one<T>(sql, params?): Promise<T>        // exactly one row or throw
  maybeOne<T>(sql, params?): Promise<T|null>
  exec(sql): Promise<void>                // multi-statement, simple protocol
}

interface Db extends Queryable {
  tx<T>(fn: (t: Queryable) => Promise<T>): Promise<T>
  close(): Promise<void>
}
```

Selected by environment, nothing else:

```ts
export async function createDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url && url.startsWith('postgres')) return createPostgresDb(url);
  return createPgliteDb(process.env.PGLITE_DIR ?? './.data/alkavida');
}
```

**PGlite** — real PostgreSQL 16 compiled to WebAssembly, storing to a local
folder. Used on the office machine and in every test. Single connection:
`tx()` tracks depth and a nested call joins the outer transaction rather than
opening a second one.

**node-postgres** — a `pg.Pool`. `tx()` checks out a client, `BEGIN`,
run, `COMMIT`/`ROLLBACK`, release.

Both run **identical SQL**. The tests exercise the same statements production
does, including locking semantics. That is why moving to a hosted Postgres is
low-risk: it is the path the code was written for.

---

## 3. What is actually in the database

Plain PostgreSQL. Nothing exotic.

| Object | Count | Notes |
|---|---|---|
| Tables | 44 | |
| Views | 2 | `invoice_ledger`, `customer_balances` |
| Functions | 2 | `business_today()`, `business_date(timestamptz)` |
| Sequences | 4 | invoice / order / quote / PO numbering, all `START 1000` |
| Triggers | 0 | |
| Extensions | **none** | `gen_random_uuid()` is built into PG 13+ |

**No extensions is the good news.** There is nothing to install on the target.

**The two views are load-bearing.** `invoices` deliberately has no
`amount_paid` column — what is owed is derived by `invoice_ledger` from
Confirmed payments, and `customer_balances` gives one running balance per
customer counting every Confirmed payment whether or not it is attached to an
invoice. Adding a stored `amount_paid` back is how the old system produced
phantom money. Do not "optimise" these into columns.

**The two functions read a settings row.** Both resolve the business timezone
from `system_settings` (defaulting to `America/Jamaica`) rather than taking a
parameter:

```sql
CREATE FUNCTION business_today() RETURNS date AS $$
  SELECT (now() AT TIME ZONE COALESCE(
    (SELECT value FROM system_settings WHERE key = 'business_timezone'),
    'America/Jamaica'))::date;
$$ LANGUAGE sql STABLE;
```

They are column defaults on six tables. A server in UTC that used
`current_date` would date every evening order a day ahead — this is the fix,
and it must survive the move intact.

**Numbering uses sequences, not `max()+1`,** so two concurrent deliveries can
never mint the same invoice number. Sequences do not migrate with a plain
`INSERT`-based data copy — you must `setval()` them past the highest existing
number or the first new invoice collides.

### Migrations

`packages/api/src/db/migrate.ts` — 40 lines. Reads `migrations/*.sql` sorted
by filename, skips any already recorded in `_migrations`, and applies each
**inside a transaction together with its own bookkeeping row**, so a
migration either lands completely or not at all.

It runs automatically at startup, before the server listens. A failure there
kills the process rather than serving a half-migrated schema — which is why
"the app won't start" is usually a migration or connection problem.

---

## 4. Authentication and authorisation

`packages/api/src/lib/auth.ts`. All of it is hand-rolled, deliberately, with
no native dependencies.

- **Passwords**: scrypt from `node:crypto`, stored as
  `scrypt$<salt-b64>$<hash-b64>`, compared with `timingSafeEqual`.
- **Tokens**: HMAC-SHA256 JWTs, signed and verified in-process. 12-hour TTL.
- **Signing key**: `JWT_SECRET` when set, otherwise a random per-install key
  stored in `system_settings`. **In production (`NODE_ENV=production`) an
  unset `JWT_SECRET` throws at startup** rather than falling back to anything
  guessable. Setting `JWT_SECRET` is also what lets several servers share one
  database.
- **Roles**: `admin`, `user`, `driver`, `customer`.

### Every request

```
browser
  → fetch with `Authorization: Bearer <token>`
  → Fastify onRequest hook
       · non-/api/ paths pass through (static frontend must be public)
       · /api/auth/login, /api/version, /api/register, /api/invitations/* are open
       · verifyToken() — signature and expiry
       · userAccess(db, session.id) — a DATABASE HIT ON EVERY REQUEST
  → route preHandler: allow('admin', 'user')
  → service function: requireRole(actor, 'admin')
  → db.tx(...) → work → audit(...) row
  → response
```

Two things worth understanding before you change any of it:

**Authorisation is enforced twice, on purpose.** Once at the route, once
inside the service. A route added later that forgets its guard is still
refused by the service. Do not remove either layer as duplication.

**`userAccess` hits the database on every single request.** That is a
deliberate trade: withdrawing somebody's access takes effect on the very next
thing they touch, rather than whenever their token expires. A driver
dismissed at nine in the morning is locked out at 9:01. It is also the
hottest query in the system — if you ever put this behind a load balancer,
that is the thing to cache carefully, not casually.

**Portal scoping rides on the token.** A `customer` login carries
`customerId`, and `assertOwnCustomer()` refuses any request for somebody
else's records.

---

## 5. Services — where the system actually lives

25 files, one per area: `orders`, `delivery`, `routing`, `settlement`,
`invoices`, `payments`, `ledger`, `inventory`, `bottles`, `pricing`,
`approvals`, `recurring`, `users`, `labour`, and so on.

The shape is consistent enough to learn once:

```ts
export async function doTheThing(db: Db, actor: Actor, input: Input) {
  requireRole(actor, 'admin', 'user');      // who may
  if (somethingIsWrong) throw new RuleViolation('plain English');

  return db.tx(async (t) => {               // one transaction
    const row = await t.one(`SELECT ... FOR UPDATE`, [id]);   // lock
    // ... the work ...
    await audit(t, actor, 'create', 'Thing', row.id, label, details);
    return { id: row.id };
  });
}
```

Four conventions that are non-negotiable:

1. **Money is integer cents everywhere** — database, service, HTTP. It is
   formatted once, in `packages/web/src/lib/format.ts`, at the moment of
   display. No float ever touches money.
2. **Every money-moving operation writes an `audit_log` row inside the same
   transaction.** The log has a real foreign key to `users(id)`, which is why
   a user is never deleted — only deactivated.
3. **Rates and prices are copied and locked at the moment of the transaction**
   — an order line keeps the price it was sold at, a labour entry keeps the
   rate it was costed at. A later change never restates history.
4. **Row locks are real.** `SELECT ... FOR UPDATE` appears in ten services
   (orders, payments, bottles, approvals, stock counts, invitations). This
   matters for your connection pooling choice — see below.

Errors are typed and map to status codes in one handler:
`RuleViolation` → 400, `ForbiddenError` → 403, anything unexpected → 500 with
a short reference code printed to the console.

---

## 6. The browser side

React 18 + Vite, `HashRouter`, 33 pages, no state library — each page fetches
what it needs and holds it in `useState`.

Three things that will confuse you if you don't know them:

- **The router drives through the History API even under `HashRouter`**, so
  `hashchange` never fires. Anything reacting to navigation must use
  `useLocation()`. A listener on `hashchange` silently never runs.
- **`lib/format.ts` is the single place that decides how a date is read.** A
  date-only value is taken as written; a real timestamp is converted to
  Jamaica time. Slicing a timestamp string is how dates came out a day early,
  three separate times.
- **The frontend and API are one origin, one process, one port.** The server
  serves `packages/web/dist` from disk on every request, which means a rebuilt
  frontend is live without restarting the server — and an old server can serve
  a new frontend, which produces confusing "not found" errors. There is a
  `/api/version` endpoint and a `StaleServerNotice` component precisely
  because that bit us.

---

## 7. Moving to Supabase

Supabase is PostgreSQL, so the database side is genuinely close to free.
`DATABASE_URL` already switches adapters. What follows is what is *not* free.

### The thing that will fail first: TLS

`createPostgresDb` builds its pool with nothing but the connection string:

```ts
const pool = new Pool({ connectionString });
```

Supabase requires TLS. Depending on the `pg` version and the URL you paste,
this is likely to fail on the first connection with a self-signed-certificate
error. It is a one-line fix in that function — add an `ssl` option, or use a
connection string with the appropriate `sslmode`. **Try this first rather
than hunting elsewhere; it is the most likely first failure.**

### Do not turn on Row Level Security

Supabase's whole model assumes RLS plus anon/service keys, because it expects
browsers to talk to Postgres directly. **This application does not work that
way and should not be made to.** Every rule — who may do what, what a customer
portal login may see, what makes a payment valid — lives in the service layer
and is enforced twice there.

So:

- Connect as a role that owns the schema. The app is the only client.
- **Never expose the Supabase anon key to the browser for these tables.** A
  browser that can query `invoices` directly bypasses every rule in
  `services/`, including the ones that stop phantom money.
- Enabling RLS without policies would simply break the app; enabling it *with*
  permissive policies would be security theatre. Leave it off and keep the
  database private.

### Connection pooling

The app uses real transactions with `SELECT ... FOR UPDATE` row locks. Each
transaction checks out one client and holds it for the duration, which is
compatible with transaction-mode pooling in principle — but prepared
statements and session state are where PgBouncer bites.

**Recommendation: start on the direct connection or session mode.** This is a
single small server; you do not need the transaction pooler. If you later move
to it, test the settlement and payment paths specifically — they are the ones
with the locks. *(Verify this against Supabase's current pooler docs; it is
the part of this document most likely to age.)*

### Keep the app's own authentication, for now

It is tempting to adopt Supabase Auth because it is there. Consider what it
would cost:

- Rewriting login, invitations, password setting and reset
- Replacing the per-request `userAccess` check
- Re-implementing portal scoping (`customerId` carried on the token)
- Migrating scrypt hashes, which cannot be converted — every user would have
  to set a new password
- `users(id)` is a foreign key from `audit_log` and several other tables, so
  the identity table cannot simply be swapped for `auth.users`

None of that buys anything the system does not already have. Keep the existing
auth, set `JWT_SECRET`, and revisit only if you want social login or MFA.

### Moving the data across

If you want the current test data (you may well not — see `DEPLOY.md` on
starting clean):

1. Create the Supabase project, get the connection string.
2. Run the app once against it with `DATABASE_URL` set — migrations build the
   whole schema from `migrations/*.sql`. Do not hand-copy DDL.
3. Copy table data in dependency order.
4. **`setval()` the four sequences** past their highest existing values, or
   the first new invoice number collides.
5. Confirm `system_settings` has the `business_timezone` row, or every date
   silently falls back to the hard-coded default.

---

## 8. Moving to AWS

### Not Lambda

Two hard reasons:

- The process holds an **hourly `setInterval`** that raises standing orders.
  Serverless has no long-lived process to hold it. You would have to move that
  to EventBridge plus a separate entry point.
- It **serves the built frontend from local disk** on every request.

Use something that keeps a process alive: **App Runner** (simplest — give it
the repo, a build command and a start command), **ECS Fargate** (more control),
or plain **EC2 / Lightsail** (cheapest, most work).

### One instance

Do not enable autoscaling. The standing-order timer is per-process, so two
instances means two timers. The work is idempotent — a unique index makes a
duplicate occurrence impossible — so it would not corrupt anything, but there
is no reason to find out. Scaling this system means a bigger instance, not
more of them; it serves one business.

### Ephemeral filesystem

On App Runner and Fargate the disk does not survive a deploy. Two things
currently live on disk:

- **`packages/api/.data`** — irrelevant once `DATABASE_URL` points at Supabase.
- **`Alka Vida logo.png`** — read from the application root when producing
  invoice and statement PDFs. It is gitignored on purpose. On an ephemeral
  filesystem it must either be baked into the image or moved to S3, which
  would need a small change in `services/documents.ts`. Without it, documents
  fall back to the wordmark in type, so this is cosmetic rather than blocking.

### Configuration

`Alka Vida settings.txt` exists because the office machine has nowhere to set
an environment variable. **A real environment variable always wins over that
file**, so on AWS you ignore the file entirely and set:

`DATABASE_URL` · `JWT_SECRET` · `PORTAL_URL` · `NODE_ENV=production` ·
`CORS_ORIGIN` · and the SMTP values.

Put `JWT_SECRET`, `DATABASE_URL` and `SMTP_PASS` in Secrets Manager or
Parameter Store rather than plain environment configuration.

### Also worth knowing

- **`PORT`** is read from the environment; App Runner and Fargate set it.
- The server binds **`0.0.0.0`** already.
- There is a **`/health`** endpoint returning `{ ok: true }` — point the load
  balancer or health check at that, not at `/`, which serves the whole app.
- Set **`LOG_LEVEL=info`** temporarily when diagnosing; the default is `warn`
  because the console is user-facing on the office machine.

---

## 9. Sanity checks before you trust the migration

Beyond the 411 automated tests (`npm test`), walk these by hand against the
migrated system. Each corresponds to something that has actually gone wrong:

- [ ] Place an order in the evening, Jamaica time. Confirm it is dated
      **today**, not tomorrow. This proves `business_today()` survived and the
      settings row is present.
- [ ] Take a payment larger than the invoice. Confirm the credit shows on the
      customer's balance — proves `customer_balances` is intact.
- [ ] Raise two invoices in quick succession. Confirm the numbers are
      consecutive and do not collide with existing ones — proves the sequences
      were `setval()`'d.
- [ ] Settle a delivery round with bottles out and back. Heaviest use of row
      locking; proves the pooling choice works.
- [ ] Withdraw a login, then use that browser session. Should be refused
      immediately, not at token expiry.
- [ ] Send an invitation and open the link on another device. Proves
      `PORTAL_URL` is right.
- [ ] Produce an invoice PDF. Confirm it renders with or without the logo.

---

## 10. What I would not change while migrating

Move the hosting; leave the design alone. Each of these looks like something
to tidy and is load-bearing:

- The **two views** rather than stored balance columns
- **Authorisation enforced twice**, at route and service
- **`userAccess` on every request** rather than at login
- **Integer cents** rather than a decimal type
- **`business_today()`** rather than `current_date`
- **Rates copied and locked** onto each transaction line
- **Users deactivated, never deleted**

`HANDOFF.md` lists all eighteen invariants with the bug each one came from.
Read it before changing anything in `services/`.

---

*Alka Vida — 1506 Investments Limited. Outline current at commit `0fe0d8f`,
11 September 2026.*
