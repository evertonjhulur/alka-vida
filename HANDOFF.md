# Handoff

State of the Alka Vida rebuild. Read `README.md` first for what the system
does and the rules behind it; this file covers where things stand, what is
left, and what will bite you.

Last updated after the UX review defect fixes (28 Sep 2026), on branch `operations-fixes`.

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
| User administration | Logins screen (admin): search, add, edit, set role (a `user` can be promoted to `admin` in the Edit row), reset password, withdraw access. My password for everyone. `active` checked on EVERY request, so withdrawing bites at once (migration 012). |
| Invitations | An invited account has an unusable password until a one-time link sets one. Only the token HASH is stored. The link is always returned on screen, because mail is usually not configured (migration 013). |
| Customer registration | Public request form, Corporate or Individual. Creates an APPLICATION, never an account. The office approves and sets tier, zone and terms (migration 013). |
| Dashboard | Rebuilt around "what needs me today?" — four figures, round progress, money owed sorted by how LATE rather than how large, and a needs-a-decision list. One `/api/dashboard` call. |
| Customer portal | Four modules: place an order, my orders, standing orders, statements & invoices. Ordering, repeat orders, and cancelling what has not gone out. |
| Delivery zones | Managed list, not free text. Rename carries customers and open sheets across (migration 014). |
| Addresses | Line 1, line 2, town, parish. Composed into `delivery_address`, which stays what the stop and the invoice PDF read (migration 014). |
| Employees & labour cost | Who works here, paid by the hour or by the trip, and the hours/trips recorded against them. Payroll totals for any date range. **Add from logins** creates a record per existing login — title from the role (`admin`→Manager, `user`→Employee, `driver`→Driver), rate left blank — and is safe to press twice. **Deliberately not wired into costing** (migration 015). A person is managed on their own record at `/employees/:id` — details, rate, and their own work history. |

**Tests: 411 passing** — 68 pure domain (`packages/shared`), 343 API
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
- **Labour is not in the cost of a case.** The employees module records what
  work costs (migration 015) but NOTHING reads it: a case of water still
  costs what its materials cost, so every margin in the system reads better
  than it is. Connecting it is a deliberate future decision, not a tidy-up —
  it moves every margin at once. `labourByMonth()` is the figure that work
  will read. A test in `labour.test.ts` asserts nothing reads the table yet,
  so whoever connects it has to delete a test that says why it was not.
- **Payroll is a total, not a payment.** The screen says what is owed for a
  period; nothing pays it, deducts anything statutory, or files anything.
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

**Where a person is managed.** Evert's division, and it decides where new
screens go: a **customer** is managed in Customers, an **employee** in
Employees, and **Logins** is about access only — who may sign in and as what.
A name on a list opens the thing that manages it; do not scatter one person's
management across two screens. Employee job titles follow the login role:
`user` is an employee, `admin` a manager, `driver` a driver.

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
17. **Work cannot be recorded against an employee whose rate is zero.** A zero
    is a blank nobody has filled in — everyone brought across by "Add from
    logins" starts that way — and costing their week at nothing would look
    exactly like it had worked. Typing a rate on the entry is the way past it.
18. **A labour entry keeps the rate it was costed at.** `rate_cents` is copied
    from the employee when the work is recorded and never updated, so a pay
    rise applies to work done after it and never restates an earlier week.
    Same rule as invariant 8, same reason. Never "look up the current rate".

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

**The statement has been walked** — on screen and as a PDF, with the
letterhead, the running ledger, the age analysis and the 5-gallon bottle
account. Three bugs came out of it: the payment column showed the wrong
invoice number, the total sat over the previous column, and dates printed a
day early. All fixed.

**Still to test: corrections** — reversal, reassignment, invoice edit and
credit notes all pass in tests but have not been walked in the browser.

**Untested because it has no data yet: employees.** The module is built and
the tests pass; Evert is entering real people and their rates.

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

### UX review fixes, 28 Sep 2026

Found by walking every screen with a week of trading in it. Tests: 412 passing.

- Sidebar lit both New order and Orders on the New order screen (`exactMatch` in `App.tsx`).
- Dashboard showed every open round under "Today's rounds", whatever its date.
  Now three groups: on the road today, back and waiting to settle, coming up.
- Driver stop card: the outcome chip stretched into a tall blob (flex stretch).
- Driver badge showed the zone sort key (0, 10, 20) instead of the visit number.
- Driver screen listed yesterday's finished round in full above today's; finished
  rounds now fold away underneath.
- "Started 03:16" was the UTC time sliced off the timestamp; `time()` in
  `format.ts` gives Jamaica time. Same fix on the office round page.
- Round page: "Settle route" was the filled button before the round had started.
  The filled button now follows the round: Start, then Settle once every stop is worked.
- Bottle pool: the headline count out with customers disagreed with the holdings
  table (opening balance belongs to no customer). The gap is now its own line.
  Its movement history also printed every date as a dash - `poolHistory` never
  returned `txn_day`.
- Customer record header labelled ("Business account · Kingston zone ·
  Corporate price list · Terms: Net 30"); bare, two parts both read "Corporate".
- Phone tab strip hid the portal's fourth module off-screen; it is a two-column grid now.

### Logo colours, 28 Sep 2026

Evert chose the logo's colours over the old teal (#0b7285, not in the logo).
`styles.css` `:root` now carries them: ALKA blue `--brand` #0e76bc, VIDA cyan
`--cyan` for the current menu item, indigo `--nav` #2d3590 for the menu, top bar
and sign-in, pH yellow `--badge` for waiting counts and the menu focus ring.
Input and secondary-button borders use `--line-control`; ok/warn status text
darkened to pass 4.5:1. The full palette and its rules live in the Alka Vida
Design System artifact.

### Menu regrouped, 28 Sep 2026

The office menu is seven sections by job - Sales, Deliveries, Money,
Production & stock, Reports, Settings, under Today - instead of Sales /
Operations / Administration. New order is a button under the brand
(`placement: 'action'`), My password sits with Sign out (`placement:
'account'`). Delivery sheets are called Delivery rounds on screen; the routes
and the API keep `/delivery` and "sheet". Agreed with Evert from the UX review.

### Red for destructive buttons, 29 Sep 2026

Every button that deletes, removes, cancels, reverses, retires, ends,
declines, merges away or withdraws access is `className="danger-soft"`:
white, red text and red edge, pale red on hover, same size as the rest.
Where one button toggles (Withdraw access / Give access back, Retire /
Restore, Mark as left / Bring back) only the destructive state is red.
Buttons that merely close a form ("Cancel") stay plain. Evert's request.
Its green partner, `className="approve-soft"`, marks Approve (Approvals),
Approve… and Approve and invite (Account requests): green text and edge, pale
green on hover.

### Top bar and the customer page as a hub, 29 Sep 2026

Built from the mockups Evert approved.

- `components/TopBar.tsx`, desktop only (hidden under 760px, where the phone
  top bar and drawer carry on): search across customers, orders and invoices
  (reads `/api/customers`, `/api/orders`, `/api/invoices` once per page and
  filters in the browser; Enter opens the first hit), a "+ New" menu (order,
  counter sale `?mode=Counter`, payment received, customer `?new=1`), "Needs
  a decision" with the approvals + account-request count, and the account
  menu (My password, Sign out). The sidebar is now brand + menu only.
- `/orders/new` reads `?mode=` and `?customer=`; `/customers` reads `?new=1`.
  Both routes are wrapped in `Keyed` so a new query string starts the form
  again.
- `CustomerRecord.tsx` is the customer's hub with tabs in the address
  (`?tab=orders|standing|invoices|payments|bottles|details`): Overview (open
  invoices, money on account not yet applied, recent orders, standing order,
  delivery and contact), Orders, Standing orders (pause / resume / end),
  Invoices & statement (reuses `StatementView`), Payments, Bottles, and
  Details, which edits the record in place with zones from the managed list.
  Header: Statement PDF, New order, Take a payment, More (send statement,
  edit details, merge link for admins).
- Mock-only and not built yet: "Needs a decision" as its own screen replacing
  Approvals + Account requests in the menu; merged menu items (Stock and
  counts, Purchasing, People and logins); the round page steps; driver stop
  and portal redesigns.


### Overnight build from the second set of mockups, 29 Sep 2026

Built unattended from the mockups Evert approved ("I like it").

**Needs a decision** (`pages/Decisions.tsx`, `/decisions`). One list of
everything waiting on an administrator: money changes (discount, credit
note, stop correction; green Approve, red Reject) and requests to open an
account (Approve… opens price list, zone, terms inline; the zone is chosen
from the parish when a zone's "covers" names it; Decline… asks for a reason
inline, no browser prompt). Filter pills, also reachable as `?show=money` /
`?show=accounts`. Approvals and Account requests are gone from the sidebar;
`/approvals` and `/applications` redirect here, and `Approvals.tsx` /
`Applications.tsx` were removed. The top bar's "Needs a decision" is now a
link here with the count; on a phone it heads the menu drawer (`placement:
'decide'` in `NAV`).

**Orders** (`pages/Orders.tsx`). Status in words from `standing()`: Collect
today, To collect, Not collected yet, On a round, On the road, Late, Missed
<day>, Needs a round, Part delivered, Delivered/Collected/Sold, Cancelled.
Rows show what is on the order and the round it is on; the customer links to
their page. Filters: find (number or customer), Waiting/Delivered/Cancelled/
All pills (Waiting sorted soonest first), How, For (today, this week, late).
"Collected" sits on a collection's row; ⋯ holds Change the order, Make it a
standing order, Take it off the round (`DELETE /api/stops/:id`, only while
the round has not started) and a red Cancel order. All former
`window.prompt`/`confirm` calls are now panels under the row.
API: `listOrders` also returns `lines_summary`, the latest stop and its
round (`stop_id`, `stop_outcome`, `sheet_zone`, `sheet_date`, `sheet_status`,
`sheet_started`), `customer_zone` and `today`; `GET /api/orders?limit=` up
to 500. Test added in `maintenance.test.ts`. `format.ts` gained `day()`
("Tue 29 Sep") and `relDay()` ("yesterday").

**New order** (`pages/NewOrder.tsx`). Customer picker you type into (name or
phone, Enter takes the first match) with their price list, terms, zone and
what they owe (from `/api/customers/:id/history`) underneath. "We deliver /
They collect / Counter sale, paid now" buttons; for a delivery the date
shows which round it lands on (`/api/delivery-sheets?date=`), or that it
starts one, or that the customer has no zone. Products are added with one
tap and counted with − / +; unit follows `bottles_per_case`. Right column:
"Repeat this order" switch (every week / 2 weeks / month, next date shown)
which, after the order is saved, calls `POST /api/orders/:id/recurring`;
totals with discount and GCT; counter sales take method and amount there.
`/api/customers/:id/prices` now also returns `is_returnable`. `#mode` is kept
as a hidden input so older checks still read it.

**Invoice page** (`pages/InvoiceDetail.tsx`). The invoice laid out as the
customer receives it (logo from the new public `GET /api/logo`, which serves
the same "Alka Vida logo.png" beside the launcher that the PDFs use, and
falls back to the name in type; `components/Logo.tsx`). Beside it: a green
"$X is on their account … Apply $Y here" when the customer has unattached
money, a "What has happened" timeline (raised / emailed / discount waiting /
credit notes / payments / still owed, due or late) with an inline Reverse…
for admins, and "Something wrong with it?" (Change quantities for admins,
Give a discount, red Credit note). Every former prompt is a panel.
API: new `payments.applyToInvoice` (oldest unattached payment first; a
larger payment is split, the rest stays unattached; office or admin) behind
`POST /api/invoices/:id/apply-on-account` and `POST /api/payments/:id/apply`,
tests in `test/apply.test.ts`. `getInvoiceDetail` also returns `delivery`,
`creditNotes`, `history` (the invoice's audit rows), `onAccountCents`,
address fields, and `reverses_payment_id` on payments.

**Payments** (`pages/Payments.tsx`). One form: From (the new shared
`components/CustomerPicker.tsx`, also used by New order), Amount, How, Bank
ref. Their open invoices appear as tick-boxes, ticked oldest first as the
amount is typed (untick/tick to choose), with a sentence saying what it
does ("Clears 2 invoices exactly. Nothing left over.") and "Record $X".
Below, "On account, not yet against an invoice": each row pre-selects an
exact-match invoice (or the oldest) and Apply uses `POST
/api/payments/:id/apply` (office can do it now; it used to be the admin-only
reassign), and "Apply every exact match" does the lot. Unapplied payments
now say which round they came in on (`round_zone`).

**Reports** (`pages/Reports.tsx`), tabs in the address (`?tab=`): Sales,
Margin, Money owed, Bottles, Discounts, Material cost, over one period
(this month, last month, this year, all time, chosen dates). "Export for
accountant" downloads the open tab as a CSV; Print hides the menus. New API:
`GET /api/reports/sales` (before GCT, after approved discounts; by product,
by the round it went out on or "Collected or counter", top customers,
returnable bottles out/back; credit notes shown separately, not deducted)
and `GET /api/reports/margin` (sales less bill-of-materials cost at the
quantity-weighted average price paid for each material across every batch
received; the returnable 5 gallon bottle itself is left out of each fill;
labelled "labour, delivery and overheads not included"). Tests in
`test/reports-sales.test.ts`. Money owed and Bottles reuse the existing
receivables and bottle-pool reports.

**Sign in and Open an account.** Sign in is the logo on white (headline in
Anton from Google Fonts, falling back to Arial Narrow/Impact offline) with
the form on the indigo; the seeded passwords are no longer printed on the
page (they still show in the start-up window). Fixed: a wrong password used
to say "Your session has expired" (`lib/api.ts` treated every 401 as an
expired session); it now says the email and password do not match. Open an
account: header with logo, "A business / My home" buttons, a details card
and a "Where we deliver" card, big "Send my request". `.login-page` (also
used by Choose a password) finally has styles.

**Delivery round page** (`pages/RouteDetail.tsx`). Title "Kingston · Mon
28 Sep 2026" with a status chip (Not started / On the road / Back, ready to
settle / Settled), then four steps: Assigned (driver chooser), Started
(Start round button until it is), Delivering (x of y worked), Settle (a
"Settle now" button once every stop has an outcome). Stops table with
numbered badges, "Next stop", invoice links and "on account"; the add-order
chooser sits under the stops; a side card totals what is on the truck, cash
collected, full bottles out and empties back, with Settle round (early).
API: `delivery.getSheet` stops also carry `order_total_cents`,
`delivery_mode` and `invoice_number`.

**Driver stop** (`pages/DriverStop.tsx`), phone first: "‹ My route · Stop 3
of 5 · Kingston" bar, the customer with Call and Notes (their standing notes
plus the driver's own), "What you dropped" with big − / + per line (full
bottles out follows them until typed over), empties and lost, "To collect"
with the terms ("on Net 30 terms, so paying now is optional" / "cash on
delivery") and Not paid / Cash / Cheque / Card / Transfer buttons (amount
prefilled with what is owed), then a big green Delivered with Not home,
Refused, Another day under it, each recording the stop at once. The cash
split is folded away and only offered when money was taken. A stop already
Delivered no longer shows the buttons (recording it again would move the
bottles twice); Not home can still be changed to Delivered. API:
`getStopForDriver` also returns `stop_position`, `stop_count`, `sheet_zone`,
`payment_terms`, `customer_notes`.

**Portal: Order water.** Every product listed with its price for this
customer and − / + (no more "add a line, choose a product"), Deliver to me /
I'll collect, optional date and note, then the total with GCT and a big
Place order. Same `POST /api/orders` payload as before.

### Leftovers from the mockups, 30 Sep 2026

**Rounds and cash** tab on Reports (`GET /api/reports/rounds`,
`reports.roundsReport`): every round in the period with driver, stops
delivered of total, invoiced, cash recorded by the driver, cash handed in at
settlement (short/over in red/grey), bottles out and back; totals across the
top; CSV export. Test in `test/reports-sales.test.ts`.

**Readable dates everywhere.** New `when()` in `lib/format.ts`: "Tue 29 Sep"
this year, "29 Sep 2025" otherwise. Every screen's displayed dates use it
(22 files); `date()` is kept for comparisons, date boxes and exports.
Delivery rounds list: "Open route" now "Open round".

**Menu items merged** (as in the mockups): "Stock and counts" (tabs Stock,
Stock count), "Purchasing" (Purchase orders, Suppliers), and for
administrators "People and logins" (Employees, Logins); office staff still
see "Employees". Each tab keeps its own address. `components/SectionTabs.tsx`;
`NavItem.also` keeps the menu item lit on its other tab.

**No more browser pop-ups.** `components/Dialog.tsx` gives `ask()` (yes/no,
red confirm button for anything destructive) and `askText()` (a short note),
drawn by `<DialogHost />` in the shell. All 14 remaining `window.confirm` /
`window.prompt` calls (logins, price lists, raw materials, suppliers, stock
count, employees, portal orders and repeats, standing orders, zones) use it,
each with a button that says what it does ("Cancel the order" / "Keep it").
