# Alka Vida

Operations system for **1506 Investments Limited**, owner of the Alka Vida water
brand. Jamaica; JMD; GCT 15%.

Two product lines:

- **Cased products** (280ml, 500ml, 1.5L, 5L) sold by the case, under the Alka
  Vida brand and as third-party co-pack.
- **5-gallon returnable bottles** sold individually, as a recurring delivery
  service and as cash walk-ins.

---

## Just using it (no terminal)

Double-click **Alka Vida** on the Desktop, or `Start Alka Vida.bat` in this
folder. A small black window opens, the server starts, and your browser opens
at <http://localhost:3001> once it is ready.

Closing that black window stops Alka Vida. Nothing is published anywhere — it
runs entirely on this machine, and the data lives in `packages/api/.data`.

To wipe everything and start over from the sample data, run
`Reset Alka Vida data.bat`.

The frontend is served by the API itself from `packages/web/dist`, so this is
one process on one port. After changing frontend code, rebuild it with
`npm run build -w @alka/web` for the change to appear in that bundle.

---

## Running it for development

Requires **Node 24+** (nothing else — no database server, no Docker).

```bash
npm install
```

```bash
npm run migrate -w @alka/api && npm run seed -w @alka/api
```

```bash
npm run dev:api
```

```bash
npm run dev:web
```

The office app is then at <http://localhost:5173>, the API at
<http://localhost:3001>.

Seeded logins:

| Email | Password | Role |
|---|---|---|
| admin@alkavida.jm | admin1234 | admin |
| office@alkavida.jm | office1234 | user (office) |
| driver@alkavida.jm | driver1234 | driver |
| ap@bluemountain.jm | portal1234 | customer portal |

### Tests

```bash
npm test
```

Runs both suites. The API tests execute against a real PostgreSQL 16 engine
(PGlite, Postgres compiled to WASM) — the same SQL, transactions and constraints
as production, with no server to install.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Database | PostgreSQL 16 | Real transactional consistency for the ledger and FIFO batch tracking |
| Dev/test DB | PGlite | Genuine Postgres in-process, so tests exercise production SQL |
| Backend | TypeScript + Fastify on Node 24 | Static typing catches whole classes of the bugs listed below |
| Frontend | React + Vite | Office, driver and customer-portal views |
| Auth | scrypt + HMAC-signed tokens | Four roles, no native dependency |

TypeScript runs directly on Node's type-stripping — no build step, no
transpiler. That constrains the code to **erasable syntax only**: no `enum`, no
constructor parameter properties, no namespaces. Enumerations are `const` arrays
plus union types (see `packages/shared/src/types.ts`).

```
packages/
  shared/   pure domain logic - money, GCT, FIFO, allocation. No I/O.
  api/      schema, services, HTTP API, tests
  web/      React app for all three audiences
```

---

## The rules that shaped the design

Every item below came from a real failure in the prior build. Each is enforced
structurally where possible, and covered by a named test.

### Money is integer cents, everywhere

There is no floating-point money column in the database and no float
arithmetic in the code. `sum(payments) == grand_total` has to be an exact
comparison for invoice status to derive correctly.

### GCT is charged on the post-discount subtotal

One function — `computeTotals` in `packages/shared/src/money.ts` — is used by
order entry, invoice generation, invoice editing and quotations alike. The prior
build drifted because order entry and invoicing each had a copy, and one taxed
the pre-discount figure.

### `amount_paid` cannot be written

There is **no `amount_paid` column** on `invoices`. It is derived by the
`invoice_ledger` view as the sum of Confirmed payments. Settlement code in the
prior build repeatedly wrote straight to `amount_paid`/`status`, bypassing the
payment ledger. Here there is no column to write to, so that bug is
unrepresentable rather than merely fixed.

### One payment-creation mechanism

`planPayments` emits the complete list of payments for a settled stop — the
invoice-allocated portions and any unallocated remainder — and one uniform loop
writes them. The remainder is the last element of the same list, not a special
case.

The prior build had a second, generic "auto-split any overpayment" rule running
in parallel, which re-detected the same excess and produced duplicate phantom
credit. **Do not add one.**

### Marking a stop Delivered always succeeds

`markStop` records payment fields exactly as entered and validates none of them.
Allocation validation lives in a separate function that stop completion never
calls, because in the prior build wiring it in made a payment mismatch block the
delivery itself.

### Driver-owed amounts are always tax-inclusive

`amountOwedForStop` returns the invoice `grand_total` where one exists, else the
order's own live `grand_total`. It can never return a subtotal.

### Cash variance is driver accountability only

The route's cash variance compares physical cash handed in against what the
driver recorded collecting. It creates no Payment, touches no invoice, and never
reaches a customer's account.

### There is no "on-account credit"

A collected amount is always simply a Payment. Whether `invoice_id` is filled or
blank is a detail of that one record — never a separate category, label, filter
or branch. A customer has **one** running balance, not a balance plus a credit
balance.

### Raw material costing is FIFO, not weighted-average

Each received PO line becomes its own `material_batch` at its own cost.
Consumption draws oldest-first and spills into the next batch, so one production
run can draw the same material at two different costs; the true drawn cost and
contributing batch ids land on the InventoryTransaction. The blended average is
computed separately for reporting and never charges production.

### Case-vs-bottle

`bottles_per_case > 0` means whole cases only. `bottles_per_case = 0` (the
5-gallon) means bottles only. Enforced in `assertQuantityShape`, called from the
line-total calculation so no caller can route around it. Production is the one
exception: a run may finish with a partial case, and those bottles are real
stock.

---

## Acceptance scenarios

`packages/api/test/acceptance.test.ts` implements Section 12 of the
specification, one block per numbered scenario:

1. Normal one-off delivery, fully paid — correct GCT, invoice Paid, driver sees a tax-inclusive figure
2. Partial payment — invoice left Partial, delivery still completes
3. Overpayment — exactly one extra unattached Payment, no duplicate
4. Recurring customer's second delivery — its own independent invoice, never batched
5. Payment reversal — original untouched, paired negative entry visible
6. Payment reassignment — same-customer and cross-customer
7. Admin edit reducing a paid invoice — Credit Note auto-posts, no second approval
8. Driver cash shortfall — flagged as a route variance, never absorbed into a customer account

---

## Corrections after the fact

Once a route is Completed it locks. Corrections then go through the ledger
mechanisms, never a reopened settlement screen:

- **Payment reversal** (admin) — paired negated entry; the original is never
  edited or deleted. Reason optional, always audited.
- **Payment reassignment** (admin) — same-customer moves the invoice link;
  cross-customer moves the customer and **clears** the invoice link, so a link
  belonging to the wrong customer's books never carries over.
- **Invoice editing** (admin) — recalculates. If the new total falls below what
  is already paid, a Credit Note posts automatically on the admin's own
  authority, with no separate approval. If it rises, the invoice simply carries
  the larger balance.

Ordinary discretionary discounts and credit notes raised by office staff go to
the approval queue instead: saved immediately so operations continue, but not
reducing what is owed until an admin approves.

---

## Roles

| Action | Admin | User | Driver | Customer |
|---|---|---|---|---|
| View invoices / orders | ✓ | ✓ | own deliveries | own only |
| Generate invoice via normal flow | ✓ | ✓ | — | — |
| Apply discount / raise credit note | ✓ | ✓ (queued) | — | — |
| Approve / reject | ✓ | — | — | — |
| Edit an issued invoice | ✓ | — | — | — |
| Reverse / reassign a payment | ✓ | — | — | — |
| Adjust a driver's allocation | ✓ | ✓ | — | — |
| Correct a stop's recorded data | ✓ | — | — | — |
| Merge customers | ✓ | — | — | — |

Enforced in the service layer (`requireRole`) as well as at the route, so a
route added later cannot bypass a rule that protects money.

---

## Deployment

Set `DATABASE_URL` to a real PostgreSQL server and the API switches adapters
with no code change:

```bash
DATABASE_URL=postgres://user:pass@host:5432/alkavida JWT_SECRET=<32+ random chars> npm start -w @alka/api
```

`JWT_SECRET` is mandatory in production (the server refuses to start without
it). `BUSINESS_TIMEZONE` defaults to `America/Jamaica` and determines the
calendar day a statement period is cut on.

Build the frontend with `npm run build -w @alka/web` and serve `packages/web/dist`
from any static host.

---

## Operations module

The sidebar splits into **Sales** and **Operations**. The operations side
covers the material and production chain end to end:

| Screen | What it does |
|---|---|
| Raw materials | Stock, reorder flags, FIFO batches per material, and linking suppliers with costs and volume breaks |
| Suppliers | Supplier records, what each supplies, standard cost and volume pricing |
| Purchase orders | Raise a PO against a supplier (lines auto-price from their volume tiers), then receive against it |
| Production | Explodes the bill of material, shows shortages *before* committing, then consumes FIFO and adds finished goods |
| Stock on hand | Finished goods and the full stock-movement ledger |
| Stock count | Record a physical count; an admin applies it to stock |
| Bottle pool | The 5-gallon exchange cycle, washing, who is holding bottles, and every movement |

Two behaviours worth knowing:

**Supplier pricing drives purchase orders.** A material can have several
suppliers, each with a standard cost plus volume breaks ("10,000+ → $8.50").
When a PO line is entered, the server is asked what that supplier charges at
that quantity and fills the cost in. The chosen cost is then frozen on the
line — later supplier price changes never rewrite an issued order.

**The bottle pool is a closed loop.** A 5-gallon bottle is an asset that keeps
circulating, so it always sits in one of four states:

```
clean_ready ──delivery──▶ filled_with_customer ──empties collected──▶ returned_dirty
     ▲                             │                                         │
     └─────────── wash ────────────┼─────────────────────────────────────────┘
                                   └──reported lost or damaged──▶ lost_damaged
```

Deliveries and collections move it automatically from the driver's stop.
Washing is the step that closes the loop and puts bottles back into clean
stock. A loss is a **business loss** — written off, never billed to the
customer, and no invoice line is produced from it. Every movement writes an
InventoryTransaction, so the pool has a real history rather than four running
totals that can silently drift.

**Counting and adjusting are separate steps.** Recording a count changes
nothing; the audit sits Open so a miscount can be corrected. Only an admin can
apply it, because it writes off real value. A shortage is drawn FIFO and valued
at what the missing stock actually cost; an overage is added at the blended
average and labelled as an estimate, since there is no real receipt to price it
against.

---

## Known gaps

- **Statement/report export is CSV plus browser print-to-PDF**, not generated
  `.xlsx` and typeset PDF files. The CSV opens in Excel and carries the columns
  an accountant needs; a branded PDF would want a real PDF library.
- **Route sequencing is the zone-template model** described in the spec —
  deliberately no geocoding or route optimisation.
- **Bills of material are API-only.** `GET`/`PUT /api/products/:id/bom` work and
  are covered by tests, but there is no screen for editing a BOM yet; the seed
  sets them up for the 500ml and 5-gallon lines.
## Products and pricing

**Sales → Products & pricing** is the rate card. A *price list* (Retail,
Wholesale, Distributor, Corporate, …) is a named set of rates; a customer is
put on one and pays those rates.

The grid is split by how a product is sold, because the two are priced in
different units and must never be mixed:

- **Case sales** — the rate is the price of one full case.
- **Sold individually** — the 5-gallon line; the rate is the price of one bottle.

A price list does **not** need a rate for every product. Leave a cell blank and
customers on that list pay the product's own list price — which is what lets
case lists and 5-gallon lists cover different parts of the range without
inventing rates nobody sells at.

Two rules enforced in code, each covered by a test:

- **Repricing only affects future orders.** Order lines lock in their price
  when the order is created, so raising a rate never re-bills a customer for
  work already delivered.
- **A product must be priced in the unit it is sold in.** A cased product needs
  a per-case price and the 5-gallon needs a per-bottle price; the other field
  is never consulted when a line total is computed. The case size of a product
  that has already been sold cannot be changed at all — retire it and add a
  new one instead.

A price list can only be deleted while no customer is on it.

---

## Troubleshooting

**"Internal error" on a page that used to work.** Almost always a stale
frontend: the browser is running a previous build. The server now sends
`no-cache` on the app shell so this should not recur, but a hard reload
(Ctrl+Shift+R) settles it. Errors now carry the real message and a reference
code that also appears in the black console window.

**The app opens but a page is blank.** Check the console window for a line
beginning with a reference code in brackets - that is the actual failure.

**Nothing happens when you double-click the icon.** If Alka Vida is already
running, the launcher says so and just opens the browser; it will not start a
second copy. Only one black window can run at a time.

**After changing frontend code**, run `npm run build -w @alka/web` - the server
serves the built bundle, not the source.
