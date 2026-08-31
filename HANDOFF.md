# Handoff

State of the Alka Vida rebuild at the end of the first working session.
Read `README.md` first for what the system does and the rules behind it; this
file covers where things stand and what to watch out for when picking it up.

---

## Where it stands

Working and verified end to end, in the browser as well as in tests:

| Area | State |
|---|---|
| Order → delivery → invoice → settlement | Complete. All 8 Section 12 scenarios pass. |
| Corrections (reversal, reassignment, invoice edit, credit notes) | Complete. |
| Customer ledger & statement | Complete (CSV export + print-to-PDF). |
| Approval queue (discounts / credit notes) | Complete. |
| Customers | Create, edit, merge. |
| Orders | Create, list, edit (pending only), cancel. |
| Products & pricing | Products, price lists, full rate-card grid. |
| Suppliers & raw materials | Create/edit, supplier links, volume price breaks. |
| Purchase orders | Raise (auto-priced), receive into FIFO batches. |
| Production | BOM explosion, feasibility check, FIFO consumption. |
| Stock | Finished goods, movement ledger, physical counts + reconcile. |
| 5-gallon bottle pool | Full cycle incl. washing, holdings, movement history. |
| Auth & roles | 4 roles, enforced at route AND service layer. |

**Tests: 180 passing** — 42 pure domain (`packages/shared`), 138 API
(`packages/api`, against real PostgreSQL via PGlite).

```bash
npm test
```

---

## Not built yet

- **Bill-of-material editing has no screen.** `GET`/`PUT /api/products/:id/bom`
  work and are tested; the seed sets up BOMs for the 500ml and 5-gallon lines.
  A product with no BOM can't be costed or produced, so this is the most
  worthwhile next screen.
- **Export is CSV + browser print-to-PDF**, not generated `.xlsx` or typeset
  PDF. The CSV carries the columns an accountant needs. A branded PDF wants a
  real PDF library.
- **Recurring orders** have their fields (`is_recurring`, `recurrence_pattern`,
  `next_delivery_date`) and are invoiced correctly per delivery, but nothing
  automatically generates the next occurrence — they are created by hand today.
- **Quotations** have full service + tests but no screen.
- Route sequencing is the zone-template model by design — no geocoding.

---

## Gotchas that will bite you

**TypeScript runs unbuilt, via Node type-stripping.** That means *erasable
syntax only*: no `enum`, no constructor parameter properties, no namespaces.
Use `const` arrays + union types (see `packages/shared/src/types.ts`). Imports
must carry the real `.ts` extension.

**After changing anything in `packages/web`, rebuild:**

```bash
npm run build -w @alka/web
```

The server serves `packages/web/dist`, not the source. Forgetting this is the
single easiest way to think a change "did nothing".

**Never declare a React component inside another component.** It becomes a new
component type each render, so inputs unmount and remount — fields lose focus
mid-typing and blur handlers never fire. This bit the pricing grid; the fix was
plain functions returning JSX, called as `{grid(...)}` not `<Grid/>`.

**`date` columns arrive as JS `Date` objects.** Over JSON they serialise to ISO
and slice correctly, but `String(dateObj).slice(0,10)` on the server gives the
*previous* day in local time. Statement dates are deliberately rendered to text
in SQL in the business timezone (`ledger.ts`).

**PGlite is a single connection.** Nested `db.tx()` joins the outer transaction
rather than opening a second one. Fine in practice, but don't assume isolation
between nested calls.

---

## Invariants that must not be broken

These are load-bearing. Each corresponds to a real bug from the prior build and
is pinned by a named test.

1. **`invoices` has no `amount_paid` column.** It is derived by the
   `invoice_ledger` view from Confirmed payments. Do not add the column back.
2. **`planPayments` is the only way delivery activity becomes Payments.** Never
   add a second "detect an overpayment and split it" rule — that duplication is
   exactly what produced phantom credit before.
3. **Marking a stop Delivered must always succeed.** No payment validation may
   be reachable from `markStop`.
4. **Amounts shown to a driver are tax-inclusive**, always.
5. **Cash variance is driver accountability only** — never touches a customer
   account, never creates a Payment.
6. **There is no "on-account credit" concept.** A payment with a blank
   `invoice_id` is just a payment.
7. **Money is integer cents everywhere.** No float money columns, no float
   arithmetic.
8. **Repricing never rewrites history.** Order lines lock their price at
   creation.
9. **A material's `quantity_on_hand` always equals the sum of its open FIFO
   layers.** A stock count works to a target, not a delta, so it repairs drift
   rather than carrying it forward.

---

## Running it

Non-technical path: double-click **Alka Vida** on the Desktop (or
`Start Alka Vida.bat`). One process, one port, browser opens by itself.
`Reset Alka Vida data.bat` wipes back to sample data.

Developer path: `npm run dev:api` and `npm run dev:web` in two terminals.

Data lives in `packages/api/.data` (PGlite, gitignored). Set `DATABASE_URL` to
a real PostgreSQL server and the adapter switches with no code change;
`JWT_SECRET` is mandatory in production.

Seeded logins are listed in `README.md`.

---

## Session history worth knowing

Bugs found and fixed *after* the initial build, mostly by testing in the real
browser rather than only in unit tests:

- Auth hook guarded the login page itself — nobody could sign in.
- `@fastify/static`'s `setHeaders` hook crashed the whole server on the first
  file served (it isn't handed an object with `setHeader`).
- Missing assets were served as `index.html`, so a stale browser got HTML where
  it expected JavaScript.
- The launcher's browser-opener died on a stray `^`, so the server started but
  nothing ever opened.
- Order entry previewed list prices while the server saved tier prices.
- Statement date filtering broke on timezone.
- Production couldn't finish a partial case.

The lesson that kept repeating: **the business logic was right, the delivery
layer was wrong.** Test in the browser, not just through the service functions.
