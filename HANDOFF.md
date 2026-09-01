# Handoff

State of the Alka Vida rebuild. Read `README.md` first for what the system
does and the rules behind it; this file covers where things stand, what is
left, and what will bite you.

Last updated after standing orders landed, on branch `operations-fixes`.

---

## Where it stands

Working and verified end to end, in the browser as well as in tests:

| Area | State |
|---|---|
| Order → delivery → invoice → settlement | Complete. All 8 Section 12 scenarios pass. |
| Corrections (reversal, reassignment, invoice edit, credit notes) | Complete. |
| Stop corrections raised by the office | Complete — routed to an admin for approval (migration 005). |
| Customer ledger & statement | Complete. CSV export, and a real invoice PDF. |
| Invoice PDF + emailing | Complete (`documents.ts`, pdfkit). Mail account set in the settings file. |
| Approval queue (discounts / credit notes) | Complete. |
| Customers | Create, edit, merge. |
| Orders | Create, list, edit (pending only), cancel. |
| Counter sales | Own fulfilment type, distinct from pickup (migration 006). |
| Products & pricing | Products, price lists, full rate-card grid. |
| Bills of material | Screen at `/products/:productId/bom`. |
| Suppliers & raw materials | Create/edit, supplier links, volume price breaks. |
| Purchase orders | Raise (auto-priced), receive into FIFO batches. |
| Production | BOM explosion, feasibility check, FIFO consumption. |
| Stock | Finished goods, movement ledger, physical counts + reconcile. |
| 5-gallon bottle pool | Full cycle incl. washing, holdings, movement history. |
| Standing orders | Complete. Schedule per series; occurrences raised automatically on open and hourly. |
| Route composition & assignment | `routing.ts` — who owns a round, which orders, in what order. |
| Payments screen | Record, reverse, reassign from one place. |
| Auth & roles | 4 roles, enforced at route AND service layer. Per-install signing key. |

**Tests: 281 passing** — 64 pure domain (`packages/shared`), 217 API
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
ledger, orders, payments, pricing, quotations, recurring, reports, routing,
settlement.

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

---

## Not built yet

- **Quotations have full service + tests but no screen.** Low priority; the
  spec calls them optional and low-frequency.
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

Seeded logins are in `README.md`.

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

The pattern that kept repeating: **the business logic was right and the
delivery layer was wrong.** Test in the browser, not just through the services.
