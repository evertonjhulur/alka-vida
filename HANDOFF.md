# Handoff

State of the Alka Vida rebuild. Read `README.md` first for what the system
does and the rules behind it; this file covers where things stand, what is
left, and what will bite you.

Last updated after the phone layout pass, on branch `operations-fixes`.

---

## Where it stands

Working and verified end to end, in the browser as well as in tests:

| Area | State |
|---|---|
| Order → delivery → invoice → settlement | Complete. All 8 Section 12 scenarios pass. |
| Corrections (reversal, reassignment, invoice edit, credit notes) | Complete. |
| Stop corrections raised by the office | Complete — routed to an admin for approval (migration 005). |
| Customer ledger & statement | Complete. CSV export, and a real PDF for both the invoice and the statement. The statement carries an age analysis the screen does not. |
| Company logo on documents | Optional file beside the launcher (`Alka Vida logo.png`), deliberately NOT in git. Absent, documents fall back to the wordmark in type. |
| Invoice PDF + emailing | Complete (`documents.ts`, pdfkit). Mail account set in the settings file. |
| Approval queue (discounts / credit notes) | Complete. |
| Customers | Create, edit, merge. |
| Orders | Create, list, edit (pending only), cancel. |
| Counter sales | Own fulfilment type, distinct from pickup (migration 006). |
| Products & pricing | Products, price lists, full rate-card grid. |
| Bills of material | Screen at `/products/:productId/bom`. |
| Suppliers & raw materials | Create/edit, supplier links, volume price breaks. Full material edit, and delete-or-withdraw (migration 010). |
| Material categories & sizes | Managed by an admin on the raw materials screen — add, rename, retire. No longer a list in the code. |
| Purchase orders | Raise (auto-priced), receive into FIFO batches. |
| Production | BOM explosion, feasibility check, FIFO consumption. |
| Stock | Finished goods, movement ledger, physical counts + reconcile. |
| 5-gallon bottle pool | Full cycle incl. washing, holdings, movement history. |
| Standing orders | Complete. Schedule per series; occurrences raised automatically on open and hourly. |
| Route composition & assignment | `routing.ts` — who owns a round, which orders, in what order. |
| Payments screen | Record, reverse, reassign from one place. |
| Auth & roles | 4 roles, enforced at route AND service layer. Per-install signing key. |
| User administration | Logins screen (admin): add, edit, set role, reset password, withdraw access. My password for everyone. `active` checked on EVERY request, so withdrawing bites at once (migration 012). |
| Invitations | An invited account has an unusable password until a one-time link sets one. Only the token HASH is stored. The link is always returned on screen, because mail is usually not configured (migration 013). |
| Customer registration | Public request form, Corporate or Individual. Creates an APPLICATION, never an account. The office approves and sets tier, zone and terms (migration 013). |
| Customer portal | Four modules: place an order, my orders, standing orders, statements & invoices. Ordering, repeat orders, and cancelling what has not gone out. |
| Delivery zones | Managed list, not free text. Rename carries customers and open sheets across (migration 014). |
| Addresses | Line 1, line 2, town, parish. Composed into `delivery_address`, which stays what the stop and the invoice PDF read (migration 014). |

**Tests: 373 passing** — 68 pure domain (`packages/shared`), 305 API
(`packages/api`, against real PostgreSQL via PGlite).

```bash
npm test
```

---

## Layout

```
packages/
  shared/   pure domain logic - money, GCT, FIFO, allocation. No I/O.
  api/      schema, services, HTTP API, tests
  web/      React app for all three audiences
```

**API services** (`packages/api/src/services/`): approvals, audits, bottles,
catalog, core, counter, customers, delivery, documents, inventory, invoices,
invitations, ledger, orders, payments, pricing, quotations, recurring,
registration, reports, routing, settlement, users, zones.

`packages/api/src/lib/`: `auth.ts`, `settings.ts`.

**Migrations** — read the header comment of each; they explain the bug or
decision behind them:

| | |
|---|---|
| 001 | initial schema |
| 002 | per-install settings + per-install token signing key |
| 003 | route assignment (`started_at` rather than a third status) |
| 004 | business date — "today" means today in Jamaica, not UTC |
| 005 | office-raised stop corrections, admin-approved |
| 006 | counter sale as its own fulfilment type |
| 007 | customer name on the invoice ledger; stop calling invoices overdue a day early |
| 008 | `business_date(ts)` applied where 004 missed |
| 009 | standing orders — pause/end, and the unique index that stops an occurrence being raised twice |
| 010 | material categories and sizes become data the office manages; withdrawing a material from use |
| 011 | `counted_at` on a stock count, so confirming can tell whether stock moved underneath it |
| 012 | user administration — `last_login_at`; `active` now honoured per request |
| 013 | invitations (token hash, one use, expiry) and customer applications |
| 014 | addresses in parts; delivery zones as a managed list |

---

## Not built yet

- **Quotations have full service + tests but no screen.** Low priority; the
  spec calls them optional and low-frequency.
- **The app is only reachable on this machine.** No customer can use the
  portal from off-site: `PORTAL_URL` defaults to `http://localhost:3001`, so
  an invitation link sent to a phone points at that phone. Evert intends to
  host it on a web server. On that day: set `PORTAL_URL` to the public
  address and serve over HTTPS, because customers set passwords through that
  link. The server already binds `0.0.0.0`.
- **Automatic zone assignment.** Zones and structured addresses now exist to
  support it (preset areas, or geo-tagging from the address); nothing assigns
  automatically yet.
- **The dashboard is nearly empty** — two panels. It is the screen the owner
  opens every morning and it says almost nothing.
- **Excel export is CSV.** It opens in Excel and carries the columns an
  accountant needs, but is not a real `.xlsx`. The invoice PDF *is* real now.
- Route sequencing is the zone-template model by design — no geocoding.

---

## Gotchas that will bite you

**TypeScript runs unbuilt, via Node type-stripping.** *Erasable syntax only*:
no `enum`, no constructor parameter properties, no namespaces. Use `const`
arrays + union types (`packages/shared/src/types.ts`). Imports must carry the
real `.ts` extension.

**After changing anything in `packages/web`, rebuild:**

```bash
npm run build -w @alka/web
```

The server serves `packages/web/dist`, not the source. Forgetting this is the
easiest way to think a change "did nothing".

**Never declare a React component inside another component.** It becomes a new
component type each render, so inputs unmount and remount — fields lose focus
mid-typing and blur handlers never fire. This bit the pricing grid; the fix was
plain functions returning JSX, called as `{grid(...)}` not `<Grid/>`.

**Dates: use `business_date(ts)`, not raw timestamp arithmetic.** A `date`
column arrives as a JS `Date`; over JSON it serialises to ISO and slices
correctly, but `String(dateObj).slice(0,10)` on the server gives the *previous*
day in local time. Migrations 004 and 008 exist because this was got wrong
twice — once for columns, once for derived expressions.

**PGlite is a single connection.** Nested `db.tx()` joins the outer transaction
rather than opening a second one.

**Check for a concurrent session before editing.** Run `git log --oneline -3`
first. Two agents editing this tree at once will conflict — it has already
happened here.

**Do NOT restart the app while Evert is testing.** Two "bugs" he reported were
in-flight requests dying on a restart done underneath him — a saved allocation
that "failed to fetch", and a screen that would not load. Ask first, or wait.

**React Router drives the HashRouter through the History API, so `hashchange`
never fires.** Anything that needs the current path must read `useLocation()`.
A flag maintained by a `hashchange` listener sticks on whatever it was at page
load: it did, and signing in after setting a password left the login form on
screen while the session sat happily in storage.

**The phone layout is one breakpoint, `max-width: 760px`.** Below it the
sidebar is replaced by `.topbar` — a strip of pills for a role with five or
fewer destinations, a Menu drawer for the office. A table marked
`phone-cards` becomes one card per row, each cell printing its column name
from `data-label`. Desktop is untouched by all of it. A table that is a
running ledger (the statement) stays a table inside `.table-scroll` instead,
because the balance column only means anything read down the page.

---

## Invariants that must not be broken

Load-bearing. Each corresponds to a real bug and is pinned by a named test.

1. **`invoices` has no `amount_paid` column.** Derived by the `invoice_ledger`
   view from Confirmed payments. Do not add it back.
2. **`planPayments` is the only way delivery activity becomes Payments.** Never
   add a second "detect an overpayment and split it" rule — that duplication is
   what produced phantom credit before.
3. **Marking a stop Delivered must always succeed.** No payment validation may
   be reachable from `markStop`.
4. **Amounts shown to a driver are tax-inclusive**, always.
5. **Cash variance is driver accountability only** — never touches a customer
   account, never creates a Payment.
6. **There is no "on-account credit" concept.** A payment with a blank
   `invoice_id` is just a payment.
7. **Money is integer cents everywhere.** No float money columns or arithmetic.
8. **Repricing never rewrites history.** Order lines lock their price at
   creation.
9. **A material's `quantity_on_hand` always equals the sum of its open FIFO
   layers.** A stock count works to a target, not a delta, so it repairs drift.
10. **A printed invoice and an on-screen one read from the same ledger
    figures**, so they cannot disagree.
11. **Withdrawing a material changes nothing about work already done.** Its
    stock, its FIFO cost history and every recipe it is on stay exactly as
    they were; it only stops being *offered* for new POs, recipes and usage.
    A screen that hides withdrawn materials must hide them from the picker
    only — never from the list it also uses to look a line's material up.
    Filtering the whole list is what made a withdrawn component read as
    costing zero and, on the next save, relabelled it `Water`.
12. **A portal order goes through `createPortalOrder`, never `createOrder`.**
    Order entry accepts a price per LINE, and that outranks the customer's
    tier rate by design — it is how the office overrides a rate for one order.
    The portal takes quantities, delivery-or-collection, a date and a note,
    and sets everything else itself.
13. **A customer cancels only what has not been delivered.** A delivered order
    has an invoice against it; reversing that is a credit note the office
    raises.
14. **A user is never deleted, only deactivated**, because every write ends in
    an `audit_log` row that references `users(id)`. And the system can never
    be locked out of itself: deactivating yourself, changing your own role, and
    removing the last active administrator are all refused.
15. **A password is never trimmed; an email address always is.** A space is a
    legitimate character in a password and stripping it locks people out. A
    trailing space on an address is a keyboard artefact and refusing it is
    indistinguishable, to the person, from the password being wrong.
16. **A stock count is refused once stock has moved under it**, because
    confirming writes the counted figure outright rather than applying a
    difference. The override is deliberate and is recorded on the count.

---

## Running it

Non-technical path: double-click **Alka Vida** on the Desktop (or
`Start Alka Vida.bat`). One process, one port, browser opens by itself.
`Reset Alka Vida data.bat` wipes back to sample data.

Developer path: `npm run dev:api` and `npm run dev:web` in two terminals.

**Settings** live in `Alka Vida settings.txt` beside the launcher — copy
`Alka Vida settings.example.txt` and edit in Notepad. The real file is
gitignored, so the mail password stays on the machine. Everything is optional;
with nothing set the app runs normally minus emailing.

Data lives in `packages/api/.data` (PGlite, gitignored). Set `DATABASE_URL` to
a real PostgreSQL server and the adapter switches with no code change.

Seeded logins are in `README.md`. **The seeded passwords are printed on the
sign-in page and have not been changed** — the first real job on any install
is to create proper logins and withdraw the shared ones.

---

## Where testing has reached

Evert walks the system in business order and reports what breaks; diagnose and
discuss before building.

**Walked and working:** customers, orders, delivery sheets, driver routes, raw
materials, suppliers and PO pricing, production, stock counts, the bottle pool,
products and pricing, and — as of this week — registration, approval,
invitation, first sign-in, portal ordering, repeat orders and cancellation.

**The money path has been walked** — order → delivery → invoice → payment —
as of 2026-09-05.

**Still to test: the statement.** It now has a real PDF document
(`renderStatementPdf`) with a letterhead, the running ledger and an age
analysis. The letterhead uses a logo file if one is present beside the
launcher; with none it falls back to the wordmark in type.

---

## Session history worth knowing

Bugs found *after* the code looked finished, mostly by driving the real browser
rather than only calling service functions:

- Auth hook guarded the login page itself — nobody could sign in.
- `@fastify/static`'s `setHeaders` hook crashed the whole server on the first
  file served.
- Missing assets were served as `index.html`, so a stale browser got HTML where
  it expected JavaScript.
- The launcher's browser-opener died on a stray `^`: server started, nothing
  opened.
- Order entry previewed list prices while the server saved tier prices.
- Statement date filtering broke on timezone (twice — see 004 and 008).
- Production couldn't finish a partial case.
- "Pickup" silently ran the counter-sale path.
- A React component declared inside another lost focus on every keystroke.
- The portal route spread the request body into `createOrder`, and a line
  price outranks the customer's tier rate by design — so a customer could have
  named their own price and given themselves 100% off. `createPortalOrder` is
  an allowlist now.
- A trailing space in an email address was refused at sign-in. Capitals were
  forgiven, whitespace was not, and a trailing space is what a phone keyboard,
  an autofill and a copy-paste all add.
- The driver's split list had two sources: the screen bolted a "Today's
  delivery" row on the front while the server supplied the rest, so one
  part-paid invoice could show two different balances.
- A stock count confirmed after stock had moved silently put the moved stock
  back. Counts now record when they were taken and refuse, with an override.

The pattern that kept repeating: **the business logic was right and the
delivery layer was wrong.** Test in the browser, not just through the services.
