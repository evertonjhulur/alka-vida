# Handoff

State of the Alka Vida rebuild. Read `README.md` first for what the system
does and the rules behind it; this file covers where things stand, what is
left, and what will bite you.

Last updated after Everton's round of 10 Oct 2026 (7 points: rounds filter, driver payments,
collection stops, truck loading and returns, invoice footer, card payments off, email wording)
and Justin's testing findings the same day (reminders, tablet layout, sign-up address, logo,
security), then the UX review build of 11 Oct 2026 (shorter pinned menu with tabs, Statement…
dialog, tidy-ups, customer Details in four parts), then the New sale screen of 11 Oct 2026
(one screen, product then size, payment at the end, credit used first) and the lists round (status
drop-downs, sort by heading, batch actions), then messages to customers chosen by name and the customer page redesign with payment numbers
(12 Oct 2026), then Everton's round of 15 Oct 2026 (order statuses, oldest-first driver money,
dated stock counts applied on save, portal Order History, audit log, multi-select status
filters, counter-sale receipts), then bottled brands and the customer upload from QuickBooks (16 Oct 2026). See the last entries at the end.

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

**Tests: 585 passing** (16 Oct 2026) — 68 pure domain (`packages/shared`), 508 API, 9 web (`packages/web/test`)
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
catalog, core, collections, counter, customers, delivery, documents, inventory, invoices,
invitations, ledger, orders, payments, pricing, quotations, recurring,
registration, reports, routing, settlement, trucks, users, zones.

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
| 015 | employees and labour |
| 016 | Everton's revision list (30 Sep) |
| 017 | the Florida team's round (1 Oct) |
| 019 | order reminders: who was reminded to order for which delivery day, and the message wording |
| 022 | 10 Oct follow-up: last-minute additions to a confirmed load, reconfirmed by the driver (`round_load_additions`, `round_load_lines.added_bottles`) |
| 021 | 10 Oct follow-up: the driver confirms the load the office logged (`round_loads.driver_confirmed_*`) |
| 020 | Everton's round of 10 Oct: payment after delivery (`after_stop_id`), truck loading and returns (`round_loads`, `round_load_lines`), collection stops (`round_collections`), stock-ledger types TruckLoad / TruckReturn / CustomerReturn, settings `document_footer` and `take_card_payments` |
| 026 | notification settings: `users.notify_orders/notify_decisions/notify_load/quiet_from/quiet_to`, `staff_notifications.knocked_at` |
| 025 | 15 Oct follow-up: `customer_orders.ready_at/ready_by_name/seen_at/review_reason`, request type SpecialDayOrder, `push_subscriptions`, `staff_notifications`, `staff_alerts_sent`, `users.decision_emails`, setting `alerts_since` |
| 028 | (withdrawn, empty) standing discount |
| 027 | bottled brands and the customer upload (16 Oct): `customer_brands`, `customers.buys_own_brand/imported_at`, `brands.active` + unique name, `invoices.is_opening_balance/opening_reference` |
| 018 | Everton's round of 7 Oct: email ticks + unsubscribe token, walk-in flag, news pictures, "Payment Only" stops and partial deliveries, empties expected, the 5-gallon bottle product flag and bottles sold, PO "Partially Received - Closed" |

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

**Signing in is an httpOnly cookie (`av_session`), not a token in
localStorage** (10 Oct 2026). Every request from the web app sends
`x-alka-request: 1`; a change (POST/PUT/PATCH/DELETE) made with the cookie is
refused (403) without it or from another site. A `fetch` written outside
`lib/api.ts` must send that header too. Tests and scripts can still use
`Authorization: Bearer <token>` (read the token from the login response's
cookie). The cookie is `Secure` only over https, so http://localhost still
works.

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
   what produced phantom credit before. Since 15 Oct 2026 money the driver did
   not split goes to the oldest open invoice first: `settlement.oldestFirst`
   turns it into more allocation INPUTS before the plan, so it is still one
   plan, one loop.
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
16. **A stock count never overwrites stock that moved after it.** (15 Oct
    2026; it used to be refused.) Applying works to a target: the counted
    usable figure PLUS the net movement since `counted_at`. That is what lets
    a count be dated to an earlier day. `evenThoughStockMoved` still forces
    the old outright overwrite, and says so on the count.
17. **Work cannot be recorded against an employee whose rate is zero.** A zero
    is a blank nobody has filled in — everyone brought across by "Add from
    logins" starts that way — and costing their week at nothing would look
    exactly like it had worked. Typing a rate on the entry is the way past it.
18. **A labour entry keeps the rate it was costed at.** `rate_cents` is copied
    from the employee when the work is recorded and never updated, so a pay
    rise applies to work done after it and never restates an earlier week.
    Same rule as invariant 8, same reason. Never "look up the current rate".
19. **Stock leaves the warehouse once.** On a loaded round the goods left
    when the truck was loaded; a delivery comes off the truck and must not
    call `takeFinishedGoods` too (`trucks.deliversFromTruck`). Loading and
    returns work to a target, so saving them again moves only the
    difference. Pinned in `trucks.test.ts`, point 4.

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

### Everton's revision list, 30 Sep 2026

Eighteen points from his testing, all built. Migration **016_sales_revisions**.
Tests: 443 passing (68 shared + 375 API; `test/revisions.test.ts` is new).
His decisions: weekly/monthly customers get ONE real invoice per period,
**due on receipt**; quotes accepted both ways (office/portal and an email
link); special prices AND price lists; extra addresses of both kinds.

- **Customers** (`components/CustomerForm.tsx`, shared by Add customer and
  the Details tab): business or person first; address in parts; zone is a
  drop-down showing the days the round runs; several delivery days
  (`customers.delivery_days`, first one still fills `default_delivery_day`);
  invoice cycle (Every delivery / Weekly / Monthly); GCT exempt + certificate
  no.; opt-outs for automatic statements and reminders. `updateCustomer` now
  only touches the fields sent, and a field sent as null is cleared.
- **Zones** carry `run_days`. New order defaults the date to the customer's
  next delivery day and warns when a date is not a day the round runs.
- **Other addresses** (`customer_addresses`, `components/CustomerExtras.tsx`):
  one Billing address (invoices, statements, receipts and quotes are addressed
  to it) and any number of Delivery addresses with their own zone. An order
  carries `address_id`; `orders.deliveryTarget` decides the round and the
  address on the stop. Standing orders keep the address.
- **Special prices** (`customer_prices`): precedence is line override >
  special price > price list > list price, in `resolveLines` and in
  `customers.customerPrices` (what `/api/customers/:id/prices` returns).
- **Discounts** may be an amount: `discount_fixed_cents` on orders, invoices,
  quotes and discount approval requests. `computeTotals(lines, pct, applyGct,
  fixedCents)` - a fixed amount wins and never goes below zero.
- **GCT removable**: `gct_exempt` on orders, invoices and quotes (defaults to
  the customer's). An admin can switch it on the invoice's "Change quantities,
  discount or GCT".
- **Unit prices** show and can be typed per line on New order and Change the
  order (sent as the line override, which was always allowed for the office).
- **Weekly/monthly invoicing** (`services/cycles.ts`): for those customers a
  delivery or collection raises no invoice; stops keep `invoice_id` null and
  collections have no `invoice_orders` row. `raiseCycleInvoices` groups by
  Mon-Sun week or calendar month and raises one invoice per closed period,
  lines tagged `delivered_on`/`order_id`/`reference`, each order's discount
  carried as one fixed amount, `due_date = invoice_date`. Unattached money
  (driver cash) is applied straight after. Runs hourly with the standing
  orders; "Invoice now" on the customer page bills everything waiting.
  `customer_orders.fulfilled_on` records the day goods left.
- **Quotes** (`pages/Quotes.tsx`, `/quotes`): list, editor, view, PDF,
  email with an accept link (`/#/quote/<token>`, public, token hash only),
  mark sent/accepted/declined, convert to order at the quoted prices. Portal
  has a Quotes tab. **Quotes now SHOW GCT** (previously none; the old test
  asserting no GCT was rewritten on purpose). The accept link points at
  PORTAL_URL, so it only works off this PC once the app is hosted.
- **Credit notes** (`pages/CreditNotes.tsx`): by product (lines, GCT worked
  out) or by amount (GCT split out of the total), against an invoice or just
  the account; PDF and email. Office ones still go to Needs a decision; the
  split is kept in the approval payload.
- **Several invoices, one email** (customer Invoices tab tick boxes):
  `documents.renderInvoicesPdf` (cover page + each invoice), `emailInvoices`.
- **Receipts**: "Email a receipt" tick box on every payment form
  (`sendReceipt`); receipt PDF from the customer's Payments tab. A receipt
  that cannot be sent never undoes the payment. `payments.receipt_number`.
- **Automatic emails** (`/auto-emails`, `paperwork.runAutomation`, hourly):
  monthly statements, overdue reminders (first after N days, then every M),
  optional auto-send of cycle invoices; `auto_emails` log stops repeats.
  Switched OFF until an administrator turns them on; needs the mail account.
- **Purchasing**: supplier products tagged GCT exempt / Env exempt
  (`supplier_materials`); each PO line carries its own GCT and Environmental
  Levy (0.375%, `system_settings.env_tax_rate_percent`). POs can be changed
  or deleted until goods are received, closed after, downloaded as a PDF and
  emailed to the supplier.
- Fixed on the way: invoice PDF dates printed a day early (`String(Date)`);
  ledger rows now give ISO dates.
- All mail goes through `documents.sendMail`; tests catch it with
  `setMailSinkForTests`.

### Florida team's testing round, 1 Oct 2026

Their 23-point list, tested on the Railway copy. Migration 017, routes in
`routes/feedback.ts`, services `messaging.ts`, `portal.ts`, `stockmoves.ts`,
tests in `test/feedback.test.ts` (25). Totals: 400 API + 68 shared passing.

Everton's rulings: a same-day order after the cut-off is **taken but waits for
approval** (Needs a decision: "Deliver today" / "Next delivery day" — never
cancelled); customers can cancel **until the driver starts the round**;
changing a posted payment **needs approval** (an admin's own change applies at
once); News & offers **and** messages to customers, with **lists by zone or
any rule**, and **WhatsApp** (click-to-chat links per customer and an "Order on
WhatsApp" button — bulk WhatsApp needs Meta's paid API, not built).

- Portal: Home (balance, overdue, next due, next delivery, News & offers,
  WhatsApp), My profile (contact, main address, delivery notes, extra addresses,
  email choices), order form shows Subtotal / GCT / Total stacked, delivery
  address, customer PO; "Delivery date" column; invoices open, print and
  download; order number + PO printed under the invoice number.
- Every invoice now gets a due date from the terms (`termsDays`); 017
  backfills. Overdue = balance on invoices past due (`accountPosition`).
- Forgotten password: `requestPasswordReset` reuses `user_invitations`
  (purpose 'reset'). Same answer whether or not the address exists.
- Links in emails use `siteUrl()`: PORTAL_URL, else Railway's automatic
  RAILWAY_PUBLIC_DOMAIN, else localhost.
- Order placed / delivered emails (`sendOrderPlacedEmail`,
  `sendDeliveredEmail`, fire-and-forget from the routes, logged in auto_emails,
  never twice; delivered attaches the invoice). Settings › Emails & ordering.
- Editing an order's date or address moves its pending stop to the right round
  (unless that round has started — warning instead).
- "Another day" on a stop takes a date and a reason (`rescheduleStop`).
- Delivery notes (customer / address `delivery_instructions`, order notes)
  show under the order on rounds and the driver's stop.
- Standing orders: raised straight away when a schedule starts; Delivery rounds
  lists ones expected on a chosen day beyond the 7-day lead, with "Put them on
  their rounds now" (`expectedOn`, `raiseThrough`).
- **Finished goods now go down when sold** (delivery, collection, counter;
  reference_type 'Sale'). They never did before. Counter/collection 5-gallon
  bottles move the pool and are recorded per customer
  (`customer_bottle_moves`); holdings union stops + moves. Driver's empties are
  suggested as an exchange up to what the customer holds.
- Payment dates typed as a day are stored at noon Jamaica (`paymentInstant`):
  a bare date cast to timestamptz is midnight UTC = 7pm the day before.
- Stock counts: finished goods in cases + loose; a difference needs a reason
  (service-enforced); count sheet + `/api/audits/batch`; variance report CSV.
- Reports: credit notes come off sales (net/GCT after credits for QuickBooks);
  Sales transactions tab lists every invoice/credit note with its order.
- Exports (CSV, opens in Excel): invoices, raw materials, stock, movements.
- Dates: PO "Arrived on", production date, payment "Date paid".
- Logins filter by role. Orders filter by a date range (server-side).


### Everton's round, 7 Oct 2026

Fourteen points, his rulings final. Migration **018_october_round**, routes in
`routes/october.ts`, email layout in `services/emailkit.ts`, tests in
`test/october.test.ts` (20). **Tests: 420 API + 68 shared, all passing.**
Backup of the folder as it was before this round: `alka-vida-backup-7-Oct-before-round`
(sent alongside, not in git).

**Portal**

1. **Approving a new customer emails them** "Your account is approved" with a
   Set my password button (`registration.emailAccountApproved`, called from
   `approveApplication`; logged in `auto_emails` as `AccountApproved`). The
   link is still shown on Needs a decision, which now says whether the email
   went.
2. **Home redone** (`Portal.tsx`): the "Order water, and see what you owe."
   line is gone. News & offers is first and large, as picture cards (a post
   with a picture leads, full width); then Place an order / WhatsApp /
   Invoices; then Your next delivery and Your account.
3. **News & offers pictures.** Uploaded on Messages & news › News & offers
   (and on Send a message). The browser shrinks each photo to 1600px JPEG
   (`web/src/lib/pictures.ts`), `POST /api/news/images` stores it in the
   database (`news_images`, bytea - Railway's disk is wiped on deploy), and a
   post is saved with `imageIds`. Served publicly at
   `/api/public/news-images/:id` so the portal and email clients can show
   them. Pictures uploaded but never saved with a post are removed after a
   day. A post can be emailed from its row ("Email it"), pictures and all.
4. **My Profile › Emails from us** gains "Order cancelled" and "Service
   announcements" (`customers.cancel_emails`, `service_emails`); the office
   sees the same ticks on the customer's Details tab. Every category checks
   its own tick (`emailkit.customerWants`):
   orders (placed, delivered, part delivered, rescheduled) `order_emails`;
   cancelled `cancel_emails`; monthly statement `auto_statements`; reminders
   `auto_reminders`; offers `NOT marketing_opt_out`; service `service_emails`
   (Service messages used to go to everyone). New: an "Order cancelled" email
   (`sendOrderCancelledEmail`, from both cancel routes).
5. **Unsubscribe without logging in.** Every non-essential email carries a
   link `/unsubscribe?t=<customers.email_token>&c=<category>` plus a
   `List-Unsubscribe` header. Opening the link only ASKS (mail scanners open
   links); the button POSTs. There is an "every non-essential email" option
   and an undo. Essential mail (invoice, receipt, quote or statement the
   office sends, password links, the approval) has no link and no tick.

**Emails and look**

6. **One layout for every email** (`emailkit.renderEmail` / `customerEmail`):
   logo (or the ALKA VIDA wordmark when no logo file is present - which is
   the case on Railway, since the logo is not in git), a blue #0E76BC band,
   indigo #2D3590 headings, a footer band with the current offer (newest
   live Promotion, with its first picture), "Contact orders@alkavidaja.com
   for any orders or queries", and the unsubscribe link. Every email is HTML
   with a plain-text twin. The order confirmation has the tick, "Thank you
   for your order", order number, items, Subtotal / GCT / Total, delivery
   address and date. Invoices, statements, reminders, receipts, quotes, the
   invitation, password reset, PO (to suppliers: no offer, no unsubscribe),
   messages and the delivered email all use it. PDFs: titles in indigo,
   table rules in blue, and the contact line in the footer. The contact
   address is a setting (Settings › Emails & ordering; `contact_email`).
7. **Domain.** Nothing in the code said alkavidja.com; 018 corrects it in
   settings and news text if it was typed anywhere there. **Railway's
   MAIL_FROM and MAIL_REPLY_TO could not be read from here (values are
   hidden) - check them in Railway › @alka/web › Variables, and that the
   sending domain verified in Resend is alkavidaja.com.**

**Office**

8. **Rescheduled stop** ("Another day"): the customer is emailed the new date
   and the reason (`sendRescheduledEmail`, from the stop route). Orders,
   the customer's Orders tab and the portal's My orders show "Rescheduled
   from Mon 5 Oct to Wed 7 Oct (reason)" (`orders.ORDER_EVENTS`, returned as
   `events` by listOrders / getOrder / customerHistory).
9. **Partially delivered.** Driver's stop: "Partially delivered: the rest
   another day" - set what was handed over, pick the day, Record part
   delivery (`markStop` with `remainderTo`). What was handed over is invoiced
   now (the invoice is built from THIS stop's lines, `delivery_stop_lines`,
   never the order's running total); the rest goes on that day's round at
   once, its stop and the driver's screen show only what is left, and it is
   invoiced when delivered. A fixed-amount discount comes off the first
   invoice only. The order's delivered figures are recounted from its stops
   (`orders.recomputeDelivered`), also after a stop correction. Customers
   see "Part delivered ...; the rest on ..." and "Still to come".
10. **Payment at a stop with no delivery.** My route › "+ Took a payment,
    nothing to deliver" (pick the customer, method, amount) adds a
    "Payment Only" stop (`addPaymentStop`, `POST /api/delivery-sheets/:id/payment-stop`).
    On an order's stop, "Payment only" records the money and leaves the order
    undelivered. Either way it is only a record until the office settles the
    round - `settleStop` / `planPayments` remain the only way it becomes a
    Payment (invariant 2 untouched).
11. **Statements filter** Open / Paid / Partially paid / Overdue
    (`ledger.getStatement` `status`, on screen, PDF, CSV and email). The
    statement then lists those invoices and the payments against them, and
    opening, running and closing balances are worked out over just those.
12. **Counter sale.** A walk-in pays in full; part payment only with a
    customer account. Customer left blank = the shared Cash Walk-In record
    (`counter.walkInCustomer`). `customers.is_walk_in` marks walk-ins (set on
    Cash Walk-In and on anyone added with "Add them quickly"; untick it on
    their Details tab to give them an account). Paid left blank = in full.
13. **5-gallon empties.** A product "5-gallon bottle" (`products.is_bottle_charge`,
    $1,200 to start, created at start-up, priced on Products like any other).
    Orders ask how many empties they will hand over (`customer_orders.empties_expected`;
    portal, New order, counter); the shortfall is added as bottles
    (`orders.withBottleShortfall`). Bought bottles are the customer's: they
    come off what the customer holds of ours (`customer_bottle_moves.sold`,
    `five_gal_bottle_pool.sold`) and count as their empties next time; no
    refund. The driver's stop shows "Expect N back" and, when fewer come
    back, an "Add the bottle charge" box (`markStop` `bottlesCharged`).
    Standing orders do not copy the bottle line. The portal hides the bottle
    from its product list (it is only ever added for a shortfall).
    **Test changed on purpose:** feedback.test "5-gallon bottles sold at the
    counter" now expects the 2 short to be bought (holding unchanged), per
    this ruling.

**Purchasing**

14. **Why closing a PO showed Cancelled:** "Close it (nothing more coming)"
    called `cancelPurchaseOrder`, which set every PO to Cancelled, goods
    received or not. Now: Received / Partially received / **Partially
    received - closed** (closed with goods received) / Cancelled (deleted or
    closed with nothing received - the PO is kept, not removed). 018 put
    right any PO already wrongly marked Cancelled. A closed PO cannot receive
    more. **Test changed on purpose:** revisions.test expected a deleted PO
    to vanish; it is now kept as Cancelled.

Not done / to know:

- Google Fonts and the logo do not load in Claude's sandbox; nothing to fix.
- The bottle charge at the door uses the bottle's Products price shown to the
  driver; the invoice uses the customer's own price for it (special or price
  list) if one was set - normally the same.
- "Delivered" with less than ordered and no date for the rest still means
  "they took less, nothing more to come" (the button says so).


### Tomorrow's reminders (WhatsApp, one tap each), 7 Oct 2026

Asked for after the round above: prompt customers to order the evening before
their round. Menu: Deliveries › **Tomorrow's reminders** (`pages/Reminders.tsx`,
`/reminders`). Migration **019_order_reminders**, service `services/reminders.ts`,
routes in `routes/october.ts`, test at the end of `test/october.test.ts`.

- **Who is listed** for a delivery day (default tomorrow): active, non-walk-in
  customers whose own delivery days include that weekday - or, when they have
  none, whose zone's `run_days` do - and who have NO order (other than a
  counter sale or a cancelled one) for that date. A standing order's
  occurrence is raised a week ahead, so those customers drop off on their own.
- **The message** is one template (`system_settings.reminder_template`, edited
  on the screen) filled per customer: {name} (contact person, else business),
  {business}, {zone}, {when} ("tomorrow, Thu 8 Oct"), {ask} ("Would you like
  your usual 3 cases of 500ml?" from their last non-counter order, bottles
  bought left out; "Would you like us to bring you some water?" when they have
  none), {link} (portal order page).
- **Send on WhatsApp** is a wa.me link to the customer's WhatsApp number (else
  their phone) with the message filled in; the office presses send in
  WhatsApp. Pressing it ticks the customer off (`order_reminders`, channel
  WhatsApp; "undo" removes the tick) and the next one is highlighted, with a
  "Next: ..." button at the top. WhatsApp cannot be sent without a person
  pressing send unless the business pays for Meta's template messages, which
  Everton ruled out on 1 Oct.
- **Email** to ticked customers (only those with an address who have not
  turned off Service announcements): branded email, Order now button,
  unsubscribe link (category `service`). Logged per customer, sent or failed.


### Everton's round, 10 Oct 2026

Seven points, his rulings final. Migration **020_trucks_and_collections**, routes in
`routes/trucks.ts`, services `trucks.ts` (loading/returns/report) and
`collections.ts` (collection stops), shared screen parts in
`web/src/components/Truck.tsx`, tests in `test/trucks.test.ts` (15).
**Tests: 436 API + 68 shared, all passing.** Walked in a real browser
(driver on a phone-size screen, office on desktop): loading, start, deliver,
add a payment after delivery, add a collection stop, office-planned returned
goods, count back, settle with a credit note and restock, loadings report,
invoice PDF footer.

1. **Delivery rounds status filter.** Pills All · Not started · Out on the
   road · Settled, each with a count, over whatever day is chosen; the Status
   column says the same three words (`DeliverySheets.tsx`, `phaseOf`: Open +
   no `started_at` / Open + `started_at` / Completed). The round page's own
   chip says "Out on the road" too (it keeps "Back, ready to settle" once
   every stop is worked).
2. **Driver: payment on a stop already delivered.** The delivered stop's
   screen shows "Payments on this stop" and an **Add a payment** box: method
   + amount only (`delivery.addPaymentToDeliveredStop`,
   `POST /api/stops/:id/add-payment`). No payment on the stop yet: it goes on
   the stop. One already there: a **Payment only** stop of its own, linked by
   `delivery_stops.after_stop_id`, so each amount keeps its own method at
   settlement ("Payment after delivery of SO-…" on the round and the
   settlement page). Only a record until the office settles: `settleStop` /
   `planPayments` untouched (invariant 2). Refused once the round is settled.
3. **Collection stops.** "+ Add a stop" on My route and on the round page,
   four kinds:
   - *Collect payment* = the existing Payment only stop. New: the office can
     **plan** one with no amount (`addPaymentStop` `planned: true` → a
     Pending stop "Collect payment"); the driver records what was taken
     (Record the payment / Not home / Did not pay) through `markStop`.
   - *Collect empties* (customer + count), *Collect returned goods*
     (customer + products/qty + reason), *Pick up from supplier* (supplier,
     optional PO with its lines, and/or what was collected in words) live in
     **`round_collections`**, not `delivery_stops`: they have no order (a
     supplier has no customer either), and every `delivery_stops` query joins
     customers and carries money logic. Shown in the same visit-ordered list;
     screen `/route/collection/:id` (`DriverCollection.tsx`).
   - A **driver's** is recorded as done (Collected). The **office's** is
     planned (Pending) for the driver to record, or "Not collected".
     Anything still Pending at settlement closes as Not collected.
   - On settling (`collections.settleCollections`, inside `settleRoute`):
     empties go into the pool (filled → returned dirty) and off what the
     customer holds (`customer_bottle_moves.returned`), and count towards the
     bottle check; **returned goods block closing until the office decides**
     on the settlement page — "Raise a credit note" (created at the
     customer's own prices via `createCreditNote`; an office user's waits for
     approval as usual) or "No credit note", plus "Put the goods back in
     stock" (moved in at settlement, ledger type CustomerReturn). Once a
     credit note is raised the decision is final (cancel it on Credit notes).
   - Supplier pick-ups move no stock. Opening the PO (also from the
     settlement page link, `/purchase-orders?po=`) prefills **Receiving now**
     and **Arrived on** from the pick-up; receiving marks the pick-up used
     (`markPickupsReceived`, in `receivePurchaseOrder`).
4. **Truck loading and returns (moves stock).** **Dual accountability**
   (his follow-up the same day, migration **021_driver_confirms_load**):
   - The **office logs the loading** on the round page (step 2 "Log the
     loading"): per product, what the round's orders still need
     (undelivered stops, less earlier part deliveries; the 5-gallon *bottle*
     product is never loaded), an **Extra** stepper per product, "add a
     product not on the orders", and **Who loaded the truck?** (active
     employees). "Confirm loaded: log it" (`trucks.loadRound`, office only)
     records it in that office user's name (`loaded_by_name`, date/time
     automatic) and moves the stock. The office can change it until the
     driver confirms.
   - The **driver only confirms**: My route shows "Confirm the load" - the
     totals per product and in all, who logged it, who loaded it - and **"I
     confirm this load: start route"** (`trucks.confirmLoad`,
     `POST /api/delivery-sheets/:id/confirm-load`; records
     `driver_confirmed_at/_by/_name`, then starts). No quantities to change;
     a wrong count is the office's to correct first. Before the office has
     logged it the driver sees "The office has not logged the loading for
     this round yet" and cannot start. A driver's plain `/start` call goes
     through `confirmLoad` too. Once confirmed, the loading is **locked**.
   - The office can still "start without a loading" (no stock moves;
     deliveries come off the warehouse as before) - only offered while no
     loading is logged.
   - **Last-minute additions** (migration **022_load_additions**): after
     the driver has confirmed, the office can still **add** to the load
     (round page › The truck › "+ Add to the load": products and
     quantities, who loaded it, an optional reason; add only).
     `trucks.addToLoad` moves that stock warehouse → truck at once, kept in
     `round_load_lines.added_bottles` and `round_load_additions`. The driver
     sees "The office added to your load" at the top of My route and presses
     **"I confirm this was added"** (`confirmAddition`). The office can
     **cancel** an addition the driver has not confirmed (stock goes back,
     `cancelAddition`); a confirmed one stands. **Settling is refused while
     an addition waits for the driver.** The truck table shows "incl. N
     added later"; the loadings report credits each addition to its own
     loaders and lists it as "(added later)" in the export.
   - Loading moves finished goods warehouse → truck (ledger TruckLoad).
     Deliveries on a loaded round then **do not** come off the warehouse
     again (`markStop` asks `trucks.deliversFromTruck`). A round with no
     loading behaves exactly as before.
   - The office can save the loading again (only the difference moves)
     until the driver confirms it; after that it is refused. A loading is
     also refused on a round already under way without one (its deliveries
     came off the warehouse).
   - **Back at the yard**: when every stop is done the driver sees loaded /
     delivered / on truck per product and **What came back on the truck**
     (full cases per product, prefilled with what should be there, plus the
     5-gallon empties count and a note). `trucks.confirmReturns` puts full
     goods back on the warehouse (TruckReturn); it works to a target, so a
     correction moves only the difference. Empties are a count: each stop
     already moved its empties into the pool, collected empties move at
     settlement; the count prefills the settlement's "Empty bottles
     returned".
   - The round page and the settlement page show **Loaded – Delivered –
     Back – Difference**; a difference is red ("1 cs missing" / "over").
     The office counts it back on the round page once the driver is done
     (or "Count what came back now"), or on the settlement page.
     **Settling a loaded round is refused until the returns are in.**
   - Report: Reports › **Truck loadings** — by day and loader (each loader
     credited with the whole load), and every loading with who logged it,
     who confirmed it, loaded / delivered / back / difference; CSV export
     (one row per loader per product).
5. **Invoice and statement footer.** Settings › **Invoices & payments**
   (`MoneySettings.tsx`, `/api/settings/money`, admin edits). Printed line
   for line at the foot of every **invoice** PDF and every **statement** PDF
   (`documents.drawPaymentFooter`), "Electronic Transfers:" and "Note to
   customer" in bold. Not on quotes and **not on credit notes** (nothing to
   pay). Default text is exactly Everton's (`core.DEFAULT_DOCUMENT_FOOTER`),
   with a "put back the original wording" link.
6. **Card payments off.** Setting "We take card payments", default **off**
   (`take_card_payments`). Off: Card is left out of every list
   (`web/src/lib/payments.ts` `payMethods`/`useTakeCard`: driver's stop, My
   route / add a stop, counter sale, New order, Orders collect, Payments,
   invoice, customer record, payment change). A list showing an existing
   card payment keeps Card. The server also refuses a NEW card payment while
   off (`core.assertMethodAllowed`: recordPayment, receivePayment,
   counterSale, collectOrder, payment stops, add-payment, payment change) -
   **never** in `markStop` (invariant 3) or settlement/reversal.
   **Test changed on purpose:** sales.test "paying at collection" paid by
   Card; now Cash.
7. **Order email wording.** "You told us you will hand over N empty 5-gallon
   bottles." → **"Empties to be returned: N"** (`messaging.sendOrderPlacedEmail`).
   The sentence was nowhere else; the portal's "order is in" confirmation
   now ends with the same line when 5-gallons were ordered.

Not now (his ruling): customer delivery days from zones (to be worked out
operationally first); Cash Walk-In's old balance (test data, will be wiped).

Not done / to know:

- Two of the driver's rounds not started both show their confirm-load
  panel; each has its own button.
- Returned goods sit outside the truck count (they are not stock until the
  office decides to restock them at settlement).
- The round page's "Stop N of M" on the stop screen counts payment-only
  stops but not collection stops.


### Tester's findings, 10 Oct 2026 (Justin, on the Railway site)

Added to the 10 Oct round. Everton's rulings: logo into the app, address
required on sign-up, both security items now. No migration. Tests in
`test/security.test.ts` (12) and additions to `october.test.ts` (reminders)
and `registration.test.ts`. **Tests: 451 API + 68 shared, all passing.**
Walked in a browser as admin (desktop, tablet, phone widths), driver and portal
customer (phone), and the public sign-up and invitation pages.

**A. Tomorrow's reminders**

1. Dates: `reminders.reminderDay` refuses an impossible or unreadable date
   with a 400 and a plain message ("…is not a date we can use. Pick the day
   from the calendar."), and a past day ("that day has gone"); blank means
   tomorrow. Used by the list, ticking off and emailing (undo may name a past
   day). The date box has `min` = today.
2. The heading follows the day: "Tomorrow's round" / "Today's round" /
   "Round on Tue 13 Oct" (server `heading`; `when` still fills messages).
3. "Last order" is the last **delivered** order (`fulfilled_on`, never in the
   future); the "usual" comes from it too. No delivered order: "no deliveries
   yet". **Test changed on purpose:** october.test's reminders test used a
   future pending order as the usual; it now delivers it first.
4. Counter: "N left to remind · N done", counted against what is on the
   screen, "(hidden)" when Hide the ones done is ticked.
5. A customer who cannot be emailed says why under their name and on the
   tick's tooltip: "No email address" / "Turned off service emails"
   (`emailBlocked`).
6. Changing the day with customers ticked asks first (in-app dialog: "Change
   the day" / "Stay on this day").
7. Phone: ticks and buttons on the rows at least 44 × 44px.
8. Template: 500 characters at most (`MAX_TEMPLATE`, checked on the server),
   with a "n / 500 characters" counter.
9. "Send on WhatsApp" is locked while its tick saves (a double tap opens one
   chat and ticks once; the server also ignores the same tick within 30
   seconds). Each load is numbered and only the newest answer is used, so a
   new day cancels an earlier request. Every action clears the last notice.

**B. App-wide**

10. Tablet: below 900px the navigation is the phone's (top strip / Menu
    drawer) and the page gets the full width; the top bar keeps just the
    search box, so office search works on a phone too. Up to 1100px a panel
    holding a wide table scrolls sideways inside itself (panels with row menus
    are left alone, as a scrolling box would clip the menu); filter rows wrap.
    Checked at 375, 790, 905, 1000 and 1100px on 30 office screens: no page
    scrolls sideways. Phone touch sizes and card tables still start at 760px.
11. Unknown addresses inside the app show "Page not found" with a way back
    (`NotFound` in App.tsx). Signing in from `#/login` goes to the start.
12. When the session runs out, the page they were on is remembered
    (sessionStorage) and signing in again goes back to it
    (`takeReturnPath`). The app now also switches to the sign-in page at once
    (`alkavida:signed-out` event) instead of staying on a dead screen.
13. A non-JSON error (Railway's 502 page while restarting) reads "Alka Vida is
    not answering just now (error 502). It may be restarting: wait a minute
    and try again." A dropped connection says so too.
14. `<DialogHost />` is mounted at the root, signed in or not; a question
    asked before it mounts waits for it. No `window.confirm/prompt` anywhere
    (Applications' decline reason now uses `askText`).

**C. Sign-up**

15. Delivery address required: street, town and parish, on the form and on
    the server (`registration.submitApplication`; parish must be one of the
    14). Every field has `autocomplete` and a maximum length, the same
    maximums the server checks (`registration.MAX`).

**D. Logo**

16. The logo is in the app: `packages/api/assets/alka-vida-logo.png` (from
    Everton's folder). `documents.logoPath()` still prefers the owner's file
    beside the launcher, then this one, so /api/logo, emails and PDFs always
    have it and the /api/logo 404 is gone. Favicon (`web/public/favicon.png`,
    64px) and an Apple touch icon made from it; `/favicon.ico` answers too.
    `.gitignore` now ignores only the logo at the folder root.

**E. Security**

17. Every response: `X-Frame-Options: DENY`, `X-Content-Type-Options:
    nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`;
    `Strict-Transport-Security` when reached over https
    (`x-forwarded-proto`). Pages and API answers carry a
    Content-Security-Policy: self only, Google Fonts, `data:`/`blob:`
    images, `frame-ancestors 'none'`, no inline script (`style-src` allows
    inline styles, which React's style attributes and the unsubscribe page
    use). PDFs and pictures carry no policy, so the browser's PDF viewer is
    never blocked; "Print" now opens the PDF's own address in a new tab.
18. Sign-in: `POST /api/auth/login` sets `av_session` (httpOnly,
    SameSite=Strict, Path=/, 12 hours, Secure over https) and returns only
    the session (who it is) - the token never reaches page scripts; an old
    token left in localStorage is removed. Changes made with the cookie need
    the `x-alka-request` header and, when the browser says where the request
    came from, this site. `POST /api/auth/logout` clears it (Sign out calls
    it). An expired or forged cookie is cleared and answered 401. CORS is off
    by default (`CORS_ORIGIN` can name an origin). Checked: admin, office,
    driver and portal customer all work on the cookie alone; invitation and
    password links unchanged.
19. `GET /api/health` without signing in; unknown `/api` addresses are 404
    for everyone (previously 401 before signing in); an unknown invitation
    token is 404 (one answer for unknown, used or expired); `robots.txt`
    disallows everything; unknown files (anything with an extension) are
    404 rather than the app shell.

Not done / to know:

- After this goes live everyone is signed out once (the old token is no
  longer accepted from the browser) and simply signs in again.
- The "Alka Vida has been updated since it was started" banner appears if the
  web app is rebuilt while the server keeps running; restarting fixes it.

### UX review build, 11 Oct 2026

From the UX review of 10 Oct (project doc `claude/ux-review-oct-2026.md`) and
the shorter-menu mockups. Everton chose **option A: tabs on the page** (not a
menu that expands in place), then said build the menu, the tidy-ups and the
customer Details split. No migration. **Tests: 452 API + 68 shared, all
passing** (new: "UX review, 11 Oct 2026: the Stock page" in `trucks.test.ts`).
Walked in a browser as admin (laptop and phone), office user, driver and
portal customer.

**Menu (App.tsx).** 13 links instead of 23: + New order, Today; Sales: Orders,
Customers; Deliveries: Delivery rounds, Tomorrow's reminders; Money: Invoices,
Payments; Stock: Production, Stock, Purchasing; a rule; Reports, Settings.
A section named `RULE` prints a line instead of a heading. The sidebar is
`position: sticky`, full height with its own scroll, so it never scrolls
away (it fits a 768px laptop screen exactly). The rest became tabs
(`components/SectionTabs.tsx`, each tab still its own address, `also` keeps
the menu item lit):

- Orders: Orders · Standing orders · Quotes (the accepted-quotes count moved
  to the Quotes tab, and the Orders menu item).
- Customers: Customers · Messages & news.
- Invoices: Invoices · Credit notes.
- Stock: Stock levels · Count · Bottle pool.
- Purchasing: Purchase orders · Suppliers · Raw materials.
- Settings: one page of cards, `/settings` (`pages/SettingsHub.tsx`):
  Products & pricing, Delivery zones, Emails & ordering, Invoices & payments,
  People & logins (admin) / Employees (office). Each of those pages has a
  "← Settings" link (`BackToSettings`).
- Statements is no longer a menu item or page: `/statement` redirects to
  Invoices. The dashboard's links that went there now go to Invoices, or to
  the customer's Invoices & statement tab.

**Statement… (`components/StatementDialog.tsx`).** Everton: the customer
screen did not ask for dates. The customer page's top "Statement PDF" (an
all-time statement, no questions) and "Send statement by email" under More
are replaced by one **Statement…** button: quick choices (This month, Last
month, Last 3 months, This year, Everything, Choose dates), From/To boxes,
"More choices" (show, invoice state), a line saying what the period comes to
("N entries … Balance due $X"), then **Download PDF** or **Email it…** (send
to, blank = the record's address). Same dialog on the Invoices page, where it
first asks which customer. The Invoices & statement tab's on-screen statement
is unchanged; its button now reads "Download PDF".

**Tidy-ups.**

- Today: the low-stock panel is **Running low**. "Needs a decision" on the
  dashboard now shows only what the top bar counts (applications and
  approvals), and only when there is something, so the two never disagree.
- Stock levels: the 5-gallon bottle charge product is no longer listed as
  stock (`audits.stockSnapshot` leaves out `is_bottle_charge`; also the stock
  count). New **On trucks** column from `trucks.goodsOnTrucks`: for each
  open round with a loading whose returns are not in, loaded (with
  additions) less delivered. The bottle-pool table moved to its own tab.
  Movements show the latest 10 with "See all movements (n)". Page height
  3,450px → about 2,600px (the raw materials table is the rest).
- Raw materials: each row has Edit and a **More ▾** menu (Batches, Record
  usage, Add a supplier, Delete) instead of five buttons; 78 buttons → 33.
- New order and Production no longer offer the 5-gallon bottle charge as a
  product; on an order it still comes from the empties box.
- Export buttons all read "Export to Excel".
- Page language is `en-JM`. Note: Chrome and Edge draw date boxes in the
  browser's own language, not the page's, so a browser set to English
  (United States) still shows mm/dd/yyyy. Setting the browser's language to
  English (United Kingdom) or (Jamaica) shows dd/mm/yyyy.

**Customer Details in four parts (CustomerForm `part`, CustomerRecord
`PARTS`).** Contact & delivery (customer type, the business/person, where we
deliver, driver notes, notes) · Billing (price list, terms, invoice cycle,
GCT, walk-in) · Emails (the automatic emails) · Addresses & prices (other
addresses, special prices). Each part has its own "Save …" button and saves
the whole record with the other parts as last saved, so an unsaved change on
one part is never saved by another. The part is in the address
(`?tab=details&part=billing`). Add customer still shows everything on one
page.

Not done / to know:

- Not built from the review: the Stock page's "on waiting orders / free to
  sell" figures shown in the mockup, and per-row tidy-ups beyond Raw
  materials.
- Tabs sit above the page title (the existing pattern), not under it as in
  the mockup.

### Statement: order and bottle note, 11 Oct 2026

- Same day: invoices (then credit notes) come before payments
  (`ledger.getStatement` orders by date, then type, then time). A payment
  keyed with just a date read as midnight and sat above its invoice, so the
  running balance dipped below zero for a line.
- The statement PDF's four-figure bottle box (held at start, delivered,
  collected, held now) is replaced, at Everton's wording, by
  **OUR 5-GALLON BOTTLES WITH YOU** and the count at the end of the period,
  with a very small grey note: "These are to be returned or purchased at
  $X each." X is this customer's price for the bottle charge product (price
  list or special price, else standard), GCT included as every statement
  amount is (GCT-exempt customers see it without). Printed only when they
  hold some of ours; bottles they bought are not mentioned. The on-screen
  statement is unchanged. Test: "Statement wording, 11 Oct 2026" in
  `trucks.test.ts`. Bottle ownership decisions: project doc
  `claude/bottle-charge-decisions.md`.

### Invoice and statement layout, 11 Oct 2026

Everton sent his QuickBooks invoice and statement as the model, asking for
the logo on both, bank details on statements that carry a balance, and
attention to type sizes, spacing, flow and readability. Mock-ups approved
the same day. All in `documents.ts`; no data changes.

- Shared header (`docHeader`): title in blue top left (INVOICE, CREDIT NOTE,
  STATEMENT, INVOICES ENCLOSED), the company block under it (Alka Vida,
  White Marl, Unit 7, St Catherine, GCT Registration No. 003-948-412 -
  `COMPANY`, taken from the QuickBooks invoice), email / phone / website in
  a second column, the logo top right.
- A light blue band (`band`) for who it is for. Invoice: Bill to and Ship
  to, a dashed line, then Invoice details in two columns (number, date, due
  date; terms, order no., customer PO, period, GCT exemption).
- Invoice lines: #, Date, Product or service (bold), Description, Qty,
  Rate, Amount, Tax (GCT / Exempt). Totals on the right: Subtotal, "GCT @
  15% on $X", Total and Balance due in large bold, "Paid in Full" in green
  when settled. Bank details and the note to the customer on the left
  (`paymentColumn`, from the same setting as before; "Electronic Transfers"
  bold, "Note to customer" a size larger). Credit notes show plain amounts
  under their own title, no bank details.
- Statement: band with To on the left and statement date, period, terms
  and **Total due (JMD)** on the right; the ledger under a blue heading
  strip with "Balance forward" first and short descriptions ("Invoice
  INV-001001", "Payment, INV-001000"); Balance due; our bottles with them;
  the age strip Current / 1-30 / 31-60 / 61-90 / 90+ days past due / Amount
  due (the query now splits 61-90 from over 90); bank details only when
  something is owed.
- Dates on documents are dd/mm/yyyy (`dmy`); emails keep "5 Oct 2026".
- One small line pinned at the foot of each page (`smallPrint`).
- The several-invoices PDF has a matching cover page.
- Test changed on purpose: trucks.test Point 5 expects "Electronic
  Transfers" without its colon (set as a heading).


### New sale, one screen, 11 Oct 2026

Everton's redesign of New order, worked through as mockups first (Design
canvas "Alka Vida order screens", round 3 is what was built). His rulings:
products from a **drop-down, product first then size** (several products
will share a size); **one screen** for walk-ins and account customers, with
a type-in customer search and a **Walk-in** button beside it; account
customers' **payment at the end**, where collecting now or later is decided;
money taken before delivery **sits as credit** and goes against the order's
invoice when it is raised; customers can prepay or overpay; when a customer
is chosen **their address shows**, with the other addresses to choose from;
the finish button is **green like QuickBooks** (`--go: #108000`, 5.1:1).

Screen (`pages/NewOrder.tsx`, styles under `.ns` at the end of styles.css):
- Strip across the top: Customer (CustomerPicker + Walk-in, or the chosen
  customer with price list / terms / balance chips and Change), How it goes
  out (Taking it now = Counter, Collecting later = Pickup, We deliver =
  Delivery), date, their PO. Under it: Deliver to (main + extra delivery
  addresses, round note follows the address's zone) and Bill to (the billing
  address, else the main one). Walk-in: name / phone / email inline; name +
  phone puts them on file as a walk-in (found again by name + phone).
- Products: a row per line, Product drop-down then Size drop-down. Product
  and size come from the product NAME (`splitName`: the size at the end of
  the name, e.g. "Alka Vida Purified 500ml" -> "Alka Vida Purified" /
  "500ml"); a product with one size fills the size in. Qty selects on focus,
  Enter goes to the next product. Rate stays editable per line. Empties box,
  note (to the driver), Repeat as before.
- Right: totals, then Payment. Account: Now / On delivery (only when we
  deliver) / On account, defaulted from their terms. Now: method, amount for
  this order (default = total less spare credit), reference, tick older open
  invoices. Walk-in pays in full; cash received shows change. Receipt PDF
  downloads after a counter sale; emailed if there is an address.

Server:
- Migration **023**: `payments.order_id` (the order money came in with, a
  reference only) and `customer_orders.pay_when` ('Now' | 'On delivery' |
  'On account').
- `payments.applyAccountCredit(t, actor, invoiceId)`: a new invoice uses
  money on the account - first what was paid with an order it bills, then
  other money only as far as it is more than their other open invoices owe
  (real credit). Money paid with ANOTHER order still to be delivered is kept
  for it. Walk-in records are never touched. Called after `markStop` commits
  (wrapped, never blocks a delivery - invariant 3) and inside
  `invoiceAndTakePayment` (counter sale, collection). Cycle invoices keep
  using `applyToInvoice`, which now also takes order-linked money first.
- `delivery.owedAtStop`: what the driver collects = invoice total less money
  on it from outside this round (or, before delivery, the order total less
  what was paid with it / spare credit). The driver's stop shows "less $X
  already paid or in credit" and what the office agreed (`pay_when`).
- `POST /api/orders` takes `payment` {amountCents, method, reference,
  allocations to older invoices, sendReceipt}: method checked before the
  order is made; the rest kept for this order. `POST /api/counter-sale`
  takes `olderPayment`, `reference`, `sendReceipt`, and returns `paymentIds`.
- `customerHistory` returns `keptForOrdersCents`; `customerPrices` returns
  `size`; the customer list returns `is_walk_in`; a walk-in may be put on
  file without an email address.

Tests: 529 passing (68 shared + 461 API). New `test/orderpayments.test.ts`
(8). october.test "statements filtered by invoice state" now uses its own
customer, because earlier tests leave money on the shared ones and that money
is now (correctly) used by the next invoice.

Not done: a separate "note on the invoice" (orders have one note, which the
driver sees); a product line / size field on Products & pricing (the split
comes from the name - name new products "<product> <size>").

### Lists: status drop-down, sort by heading, batch actions, 11 Oct 2026

Everton: filter by status **with a drop-down, like the statement's** (not
buttons with counts), **sort by every heading**, and **batch actions like
QuickBooks' invoice list** on the customer page and Invoices, Payments,
Purchase orders, Credit notes, etc.

Shared pieces: `web/src/components/ListTools.tsx` (`StatusSelect`, `useSort` +
`SortTh` - click a heading A-Z / lowest first, again to reverse, blanks
last, rows keep their own order until a heading is clicked; `useTicks` +
`TickAllTh`/`TickTd`; `BatchBar` - "Batch actions ▾" menu, greyed actions
say why; `sendSummary`). `web/src/lib/invoiceState.ts`: one set of invoice
words for screen and filter, the statement's (Open, Overdue, Partially paid,
Paid) plus Sent, Credit note, Cancelled; Overdue wins over part paid. Styles
at the end of styles.css (`.th-sort`, `.batch-tools`, `.batch-pop`).

Where (the old filter pills were replaced by drop-downs):
- Invoices: status, sort, ticks. Batch: Print (one PDF, any customers),
  Send by email (each customer gets theirs together), Receive payment (one
  customer: opens their Payments tab with those invoices filled in,
  `?tab=payments&pay=id,id`), Mark as sent, Export to Excel. Lists every
  invoice now (status filtered in the browser).
- Customer page: Orders tab (status, sort), Invoices tab (status, sort,
  batch: email together, print, receive payment, mark sent, export - now
  every invoice, from `/api/invoices?customerId`), Payments tab (show:
  against an invoice / on account / reversed; sort; batch: print receipts,
  one receipt email, export - every payment, from `/api/payments`).
- Payments: new "Payments received" list (find, show, how, dates - this
  month to start; sort; batch: print receipts, email receipts one per
  customer, export). The on-account list says when money was paid with an
  order still to be delivered.
- Orders: Status drop-down (Waiting and its kinds: on a round, needs a
  round, to collect, late/missed, part delivered, needs approval; Delivered;
  Cancelled; Any), sort, batch: Export, Cancel orders (red; only those not
  delivered; asks why once; each customer told as for one).
- Delivery rounds, Standing orders: status drop-down and sort.
- Customer statement (Invoices & statement tab, and Statements): headings sort too
  (date, type, description, reference, amount); each line's Balance stays the
  balance after that entry in date order.
- Purchase orders: find, status (incl. "Still to come"), sort, batch: Print,
  Email each to its supplier, Export.
- Credit notes: status (Counted / Waiting / Rejected / Counted not sent /
  Sent), sort, batch: Print, Email (counted only), Export.
- Quotes: status drop-down (Out with the customer first), sort, batch:
  Print, Email with accept link, Mark as sent, Export.

Server (`routes/batches.ts`): `POST /api/batch/{invoices|receipts|purchase-orders|quotes}/print.pdf`
and `.../send` with `{ ids }`; send answers `[{label, sentTo?, error?}]`, one
that cannot go never stops the rest. `GET /api/payments` (confirmed payments
with invoice, order, reversal; customerId/from/to). Paperwork drawing split
from the PDF so several go in one document: `drawQuote`, `drawPo`,
`drawReceipt` (paperwork.ts), `printInvoices` and `emailInvoicesByCustomer`
(documents.ts). `unappliedPayments` returns `order_number`, `order_open`.

Tests: 534 passing (68 shared + 466 API); new `test/batches.test.ts` (5).

### Messages to customers chosen by name, 12 Oct 2026

Everton: he could only message a saved list, so one customer meant making a
list first. Now **Send to** on Messages & news › Send a message has
"Customers I choose by name…" (saved lists sit under a "Saved lists" group).
Type a name or phone number (the same `CustomerPicker` as New order), add as
many as wanted, × takes one off. Walk-ins and closed accounts cannot be
chosen, as on lists; opening the screen for one says so.

- No portal post: the "Also show it under News & offers" tick is hidden and
  never sent for chosen customers (a post is seen by everyone).
- One customer: the button reads "Email <name>", the confirm names them.
- Who it goes to shows a WhatsApp button per chosen customer with the subject
  and message typed in, so someone without an email can still be reached.
  Those are not logged under Sent (only emails are).
- Customer page › More › **Send a message** opens `/messages?customer=<id>`
  with them chosen (active customers only).
- Server unchanged: `createBroadcast` already took `customerIds`; the preview
  uses `resolveList({ zones: ['__none__'] }, picked)` so only the chosen come
  back. Sent shows it as "1 chosen customer".

Tests: 535 passing (68 shared + 467 API); new test in feedback.test.ts.

### Customer page redesign and payment numbers, 12 Oct 2026

Everton, comparing with QuickBooks' customer page; mockups on the Design
canvas "Alka Vida customer page" (1, and 2A for weekly/monthly customers).
His rulings: open balance AND overdue shown together; Statement…, New order
and Take a payment grouped in one action; More keeps the rest; one list of
invoices and money received in place of the invoices list + statement;
running balance as an optional tick; payments get numbers ("helps to
identify if errors are made"); weekly/monthly customers keep the box of
deliveries waiting for their invoice above the list (2A, not rows in it);
the Payments tab goes.

Screen (`pages/CustomerRecord.tsx`, styles under "Customer page, 12 Oct
2026" at the end of styles.css):
- Header panel: name, chips (account, zone, price list, terms/cycle, days),
  green **New transaction ▾** (New order, Take a payment, Statement…, New
  quote, New credit note), **More ▾** (Send a message, Edit details, Merge).
  Contact grid: email, phone + WhatsApp link, contact, Bill to (the billing
  address, else the main one), Deliver to (+ other addresses), notes,
  portal. Strip: next delivery, standing orders, 5-gallon bottles.
- **Money summary** (right): Open balance (or In credit) with "N open
  invoices ($x), less $y credit"; Overdue in red when anything is late;
  "Paid, on account" and "Delivered, not invoiced yet (before GCT)" lines.
  Clicking Open balance / Overdue filters the list to those invoices.
- Tabs: Overview, **Transactions**, Orders, Standing orders, Bottles,
  Details. `?tab=invoices` and `?tab=payments` (old links, `&pay=`) open
  Transactions; links elsewhere now say `?tab=transactions`. The Overview's
  "Delivery and contact" card is gone (it is in the header).
- Transactions: the waiting-for-invoice box (cycle customers) on top; then
  Batch actions, Type / Status / Date (this month, last month, chosen dates)
  filters, Running balance tick, Export. Columns Date, Type, No.,
  Description, Amount (+ invoice, - payment/credit note, + reversal), Still
  open, [Balance], Status, actions (Receive payment / Receipt / Change /
  View). Newest first; every heading sorts. Phone: cards.
- `web/src/lib/transactions.ts` (pure, tested in `web/test`): builds the
  list. Counts what the statement counts (not cancelled; credit notes once
  approved; confirmed payments, reversals stored negated). A payment over
  several invoices is several rows sharing one number: ONE line here.
  Change… on such a payment asks which part (each row is changed on its own,
  as before).
- `/api/invoices` also returns `credit_status`, `notes`, `order_numbers`.

Payment numbers (migration **024**, `services/payments.ts`):
- `payments.receipt_number` is now the payment's number, given when it is
  recorded (`RCT-001000` on, sequence `receipt_number_seq`), no longer
  unique per row. `insertPayment` gives one number to every row recorded
  for the same customer in the same transaction (remembered per
  transaction in a WeakMap keyed by the transaction and now(); NOT read back
  from the table, or a split-off part of an older payment recorded in the
  same transaction would lend its number to new money). A part split off
  onto an invoice (`putAgainstInvoice`) keeps its payment's number
  (`receiptNumber` input). Reversals carry the reversed payment's number.
- Migration: drops the unique constraint, renames RC- to RCT-, numbers old
  rows one per (customer, created_at), oldest first, moves the sequence on,
  gives reversals their payment's number. Re-runnable (the test runs it again).
- Receipts are for whole payments: `drawReceipt` takes in every row with
  the chosen rows' numbers; `printReceipts` prints one receipt per number.

Bug fixed on the way: a reversed payment left on the account was still
counted as money on account (`unappliedPayments`, the customer's "on
account" figure, the driver's "already paid", the invoice page) and could be
put against a new invoice (`moneyOnAccount`). All now skip a payment that
has a reversal. Test in `paymentnumbers.test.ts`.

Not done: the Payments screen's "Payments received" list is still one line
per row (it shows the number now); the Statement PDF still references the
invoice a payment went against rather than its number.

Tests: 546 (68 shared + 474 API + 4 web). New: `api/test/paymentnumbers.test.ts`
(7), `web/test/transactions.test.ts` (4); `web` has a `test` script now.

### Everton's round, 15 Oct 2026

Screenshots he sent: portal news picture cropped, Place an order (where the
standing-order switch goes), My orders with the action buttons circled, and
Saks' Order History + order page as the model.

**Orders screen statuses.** The Status filter is now Ready, Out for Delivery,
Partially Delivered, Delivered, Cancelled (`web/src/lib/orderStatus.ts`,
`orderStage`). His ruling: Ready = taken but not on the road yet (needs a
round, on a round not started, or to collect); Out for Delivery = on a round
the driver has started. "Waiting (not delivered yet)" and its sub-filters
are gone; the default ticks Ready + Out + Partially Delivered (soonest first).
The row chip "On the road" now reads "Out for delivery". Customer page ›
Orders uses the same five (history query gained `sheet_started`).

**Multi-select status filters, everywhere** (`MultiStatusSelect` + `passes`
in `components/ListTools.tsx`): Orders, customer page (Orders; Transactions
type and status), Invoices, Payments received, Credit notes, Quotes (default
Draft + Sent), Purchase orders, Standing orders, Delivery rounds, Statement
and the Statement… dialog. Nothing ticked = any. Statements take several
states server-side: `status=Open,Overdue` (`ledger.asStatementStatuses`,
`invoicesInStatuses`; `Statement.status` is now the joined words and
`statuses` the list). `StatusSelect` (single) is still used for the
Transactions date choice.

**Purchasing.** "Still to come" removed from the PO status filter (tick
Draft + Sent + Partially received instead).

**Rounds: money the driver did not split** goes to the customer's OLDEST open
invoice first, then the next; if only this delivery's invoice is open it goes
there; anything left after every open invoice stays on the account
(`settlement.oldestFirst`, used by `settleStop` and shown in the settlement
review as `autoApplied`, "oldest first:" in the Applied to column). A split
the driver did make stands; only the rest goes oldest first. Driver screen
and settlement panel say so. Acceptance scenario 3 now expects the excess on
older invoices first (the no-phantom-duplicate check is unchanged).

**Stock count.** "Date of count" on the count sheet (today, or an earlier
day; not the future). Saving applies at once, for anyone in the office (his
ruling, changing his first answer): `/api/audits/batch` takes `countDate` and
`apply` (default true). A past day is measured at the end of that day in
Jamaica: `system_qty` = stock then (now less movements since), and applying
carries the movements since forward (invariant 16). The sheet shows "System
had on <day>" figures from `/api/stock/snapshot?asOf=`. `POST /api/audits`
on its own still records an Open count for an admin to apply.

**Portal.**
- News pictures: shown whole and centred (`object-fit: contain`, taller lead).
  Uploads sharper: up to 2400px, 92% JPEG, stepped downscaling; a picture
  already small enough (<= 2,200,000 bytes and 2400px) is kept untouched.
- Place an order: "Make this a standing order" switch top right (as on the
  office New order), with Weekly / Every 2 weeks / Monthly. Sent as `repeat`
  on POST /api/orders; the route sets it up after the order is safe
  (`startOwnSchedule`) and returns `standing` or `standingError`. A
  collection needs a date to count from.
- "My orders" is now **Order History** (`pages/PortalOrders.tsx`), Saks-style:
  All / Pending / Completed / Standing orders radios, a period drop-down, one
  row per order (date, number, items, total, status in bold, a bottle tile,
  › arrow). No buttons on the list. The "Standing orders" menu item is gone
  (`/portal/repeats` and `?show=standing` open that filter); the explainer
  text he quoted is removed.
- `/portal/orders/:id` — the order's page: date | number | status, Make it a
  standing order and Cancel order on the right (only before it goes out),
  Items with price and delivered state, Order details (address, date, PO,
  empties, note, invoice link) and Order summary. `GET /api/portal/orders/:id`
  (`portal.myOrderDetail`).
- `/portal/standing/:id` — a standing order's page: Edit (how often, next
  date: `POST /api/portal/recurring/:id/update`, `recurring.updateOwnSchedule`),
  Pause / Start again, Cancel standing order, what comes each time, the
  orders it raised. Quantities are not editable by the customer (the template
  order may already be delivered): the page says to call or WhatsApp.

**Audit log** — Settings › Audit log (admin only, `/settings/audit-log`,
`pages/AuditLog.tsx`, `services/auditlog.ts`, `GET /api/audit-log` and
`/api/audit-log/filters`). Reads `audit_log`: date range (last 7 days to
start), who, record type and action (multi), free-text find (label, details,
name), Show more (cursor `before`), Export. Internal ids are hidden from the
details; records with a page are linked.

**Counter sale / walk-in receipt** is a SALES RECEIPT (`paperwork.drawSalesReceipt`,
chosen in `drawReceipt` when a payment is on a Counter order's invoice):
items with qty, unit price, amount; subtotal, discount, GCT, total; "Paid by
<method>", anything else paid at the same time, "Still to pay" or "Paid in
full"; account balance only for account customers. Emailed receipts use the
same PDF. The walk-in record's placeholder phone is not printed.

Tests: 558 (68 shared + 486 API + 4 web). New `api/test/oct15.test.ts` (12);
`inventory.test.ts` movement tests rewritten for carry-forward.

Not done / to watch: the settlement review's oldest-first preview and the
real settlement agree because both read the ledger, but a payment taken in
the office between review and settlement changes where the money goes.

### How staff hear about orders, 15 Oct 2026 (evening)

His question: "how is the staff alerted when an order is placed by a customer?"
Answer was: they weren't. His rulings: every order (office or portal) comes in
**Pending**; it is **Ready** once the office logs the truck load for its round
(or someone marks it ready, e.g. a collection); push and email to admins for
everything in Needs a decision; a declined delivery-day request is either
moved to a date the admin picks or cancelled.

**Order stages** (`web/src/lib/orderStatus.ts`): Pending, Ready, Out for
Delivery, Partially Delivered, Delivered, Cancelled. Ready = `ready_at` set
(⋯ › Mark ready / Mark ready to collect; "Not ready yet" undoes it) OR the
order's open round has a `round_loads` row (`load_logged_at` in listOrders,
customer history and the portal detail). The Status column shows the stage
chip with the old words ("On a round", "Needs approval"…) underneath.

**Orders overview tiles** above the list: New orders (Pending; "N new
online"), Ready, Out for Delivery, Delivered (today). A click filters to it.
**Menu count** on Orders: online orders with `seen_at IS NULL`
(`/api/pending-counts` → `newOrders`, shown before accepted quotes; refreshed
every minute too). The Orders screen marks what it shows as seen
(`POST /api/orders/seen`) and puts a yellow "New" chip on them for that visit.
Office-entered orders are seen on creation.

**Portal delivery days.** `orders.deliveryDaysFor(customer, address)`:
another address in another zone → that zone's run days; else the customer's
own days; else their zone's run days; none = any day. Place an order shows
"Next delivery day" + the next dates on their days, and "Another day… needs
our OK" (`GET /api/portal/delivery-days`). `createPortalOrder` marks a
delivery on any other weekday `needsReview` with `reviewReason: 'SpecialDay'`
→ approval request **SpecialDayOrder**, not put on a round. Collections are
any day. Needs a decision shows Approve that day / Change the date / Cancel
order (same-day orders also get Change the date and Cancel):
`reviewApproval(..., { deliveryDate, cancel })`. The customer is emailed
`sendDeliveryDayEmail` (booked for <day>) or the cancellation email.

**Push notifications** (`services/push.ts`, `services/alerts.ts`,
`web/public/sw.js`, `web/src/lib/push.ts`, `components/NotificationsCard.tsx`):
- No library. VAPID key pair made on first use and kept in system_settings
  (`vapid_public_key`, `vapid_private_pem`) — nothing to set on Railway.
- The push is an EMPTY knock (no payload, so no encryption); the service
  worker fetches `GET /api/push/inbox` with the person's cookie and shows
  their unread notes; with none unread it re-shows the latest (same tag) so
  a phone always has something to show. 404/410 forgets the device.
- Turn on: My account & notifications › Notifications (and a "Turn on
  notifications" nudge on Today until on or dismissed). Admins also have
  "Email me about Needs a decision" (`users.decision_emails`).
- `runAlerts` every 15 s (and kicked after POSTs): new portal orders → push
  to admins + office; pending approval_requests and customer_applications →
  push + email to admins; load additions → push to the round's driver.
  `staff_alerts_sent` makes each once; only events after `alerts_since`.
  An order waiting for a decision is announced once, as the decision.
- Needs https or localhost; iPhone needs iOS 16.4+ and Add to Home Screen
  (`manifest.webmanifest`). Not testable in the sandbox's headless browser
  (permission always denied there): the server side is tested, including
  verifying the VAPID signature; try it for real on the Railway site.

Also fixed: the Today screen's Needs a decision card called every non-discount
request a "Credit note".

Tests: 564 (68 + 492 + 4). New `api/test/alerts.test.ts` (6).

### Managing notifications, 15 Oct 2026 (late)

Everton asked for all four: a switch per kind, quiet hours, a devices list
with Remove, and admins setting other people's.

- Kinds (`push.ALERT_KINDS`): `orders` (admin + office), `decisions` push and
  `decisionEmails` (admin), `load` (driver). `runAlerts` sends each only to
  those with it on. `setAlertSettings` changes only the kinds the person's
  role can have; your own, or anyone's for an admin.
- Quiet hours (`quiet_from`/`quiet_to`, Jamaica time, may run over midnight;
  `inQuietHours`): the note is still written but not knocked
  (`knocked_at` null); `knockHeld()` (each alert run) knocks once when the
  quiet hours are over, and the phone then shows what was held. Emails are
  not held.
- Devices: My account lists them ("this device" marked), Remove deletes the
  subscription (removing this device also unsubscribes the browser). An admin
  can see and remove anyone's from Settings › Notifications.
- My account › Notifications (`components/NotificationsCard.tsx`) and
  Settings › Notifications (`pages/NotificationSettings.tsx`, admin only).
  Routes: `GET/PATCH /api/me/alerts`, `DELETE /api/push/devices/:id`,
  `GET /api/alert-settings`, `PATCH /api/alert-settings/:userId`,
  `GET /api/alert-settings/:userId/devices`.

Tests: 567 (68 + 495 + 4); 3 more in `alerts.test.ts`.

### Bottled brands and the customer upload, 16 Oct 2026

Everton's rulings: Alka Lyfe and Sunra are the local distributors (each on
its own prices); Treasure Isle buys the brand overseas and is treated as a
distributor for its price. We bottle for Alka Lyfe (brands Alka Lyfe and Sky
Drops), Melkleen (Cool Cool) and Living Hope (Living Water; Living
Possibilities is the same customer, Living Hope going forward). **Third-party
products are never sold to anybody but the customer they are bottled for.**
Melkleen and Living Hope buy no Alka Vida products "so far".

**Who may buy what** (`services/brands.ts`, migration 027):
- A product of an Owned brand, or with no brand, is for every customer whose
  `buys_own_brand` is true (the default). A product of a Third-Party Co-Pack
  brand only for customers linked to it in `customer_brands` (any number per
  customer) while the brand is `active`. The bottle charge is never held back.
- `productAvailableSql(p, customer)` filters `customerPrices` (New order,
  quotes, credit notes, the portal, special prices all read it) and
  `GET /api/products` for a customer login. `?for=walkin` (New order with no
  customer) = own products only (`ownProductSql`).
- `assertAvailable` runs inside `resolveLines`, so orders, edits, quotes,
  counter sales and standing orders all refuse a product the customer may not
  buy. `editOrder` passes the lines already on the order (`alreadyOnIt`) so an
  order taken before a brand was unlinked can still be changed. A standing
  order that hits it is reported as a problem, like any other.
- The old single `customers.brand_id` is kept; a co-pack brand in it was
  copied into `customer_brands`.
- Screens: Products & pricing has a **Brands** panel (add, rename, retire;
  "Ours" / "Bottled for a customer", who it is linked to) and a brand
  drop-down under each product. A customer's Details has a new
  **Products & prices** part (Addresses is now its own part): "Can order Alka
  Vida products" and tick boxes for the bottled brands, above Special prices
  (whose product list is now only what they may buy).
- Routes (`routes/brands.ts`): `GET/POST /api/brands`, `PATCH /api/brands/:id`,
  `GET/PUT /api/customers/:id/brands`.

**Customer upload** (`services/imports.ts`, `pages/CustomerImport.tsx`,
Customers › Upload customers, `/customers/import`):
- Reads the merged file as edited: the .xlsx itself (`lib/sheetfile.ts`, a
  small zip/XML reader on the browser's DecompressionStream - no library) or a
  CSV. `lib/customerUpload.ts` finds columns by heading, in any order; uses
  the "Customer Upload" sheet, and "Open Items" for each customer's open
  QuickBooks invoices and unapplied payments.
- `POST /api/customers/import { rows, asOf, holdAutoEmails, dryRun }`. The
  screen checks first (dry run: row by row, nothing written), then "Bring them
  in" is ONE transaction - all or nothing; any row with a problem stops it.
- A name already on file (active) is skipped, never overwritten, so the file
  can be uploaded again. Customer Type: Individual/Corporate; Distributor =
  Corporate on the "Distributor" price list (warning if there is none);
  blank = Individual with a warning. Unknown zones and bottled brands are
  ADDED (listed in the preview so a misspelling shows). Days "Mon, Thu",
  "Monday and Thursday", "Mon/Fri". Phone and Mobile are kept together in
  `phone`; no phone or email is allowed for an import (a warning).
- Opening balances: when the customer's Open Items add up to the Opening
  Balance column, each open invoice becomes an invoice `OB-<QuickBooks no.>`
  with its date and due date, no lines, `is_opening_balance`, lifecycle Sent,
  no GCT (QuickBooks already charged it); each unapplied payment becomes an
  unattached payment (method Other, kind "Opening credit") = credit on
  account. Otherwise one line dated "as of". Items that net to zero bring in
  nothing. The invoice PDF and page show "Balance brought forward".
- "Hold automatic statements and reminders" (ticked by default) turns
  `auto_statements`/`auto_reminders` off for those customers so nobody is
  emailed the day they arrive.
- Tried end to end with the real file (265 customers, J$1,713,610.36, ties to
  the Collections Report). The real file is NOT in git (the repo is public);
  `web/test/fixtures/sample-upload.xlsx` is made-up customers.

Tests: 583 (68 + 507 + 8). New `api/test/brands.test.ts` (12), `web/test/upload.test.ts` (4).

**Upload file v2 (16 Oct 2026, later).** Everton added the 1506 Customer List
(delivery day, credit terms DOR/EOM/15 days/FOC, 5-gallon price, green =
"invoice urgently"), the Delivery Area list (zone blocks by day) and the A/R
Ageing Summary at 16 Oct (balances now J$3,115,278.10 - the collections
report had left out current invoices). The upload now also reads:
- Payment Terms (free text, the usual ones recognised) and Invoice Cycle
  (Every delivery / Weekly / Monthly; Weekly and Monthly force Due on
  receipt). EOM on his list = Monthly.
- Delivery Instructions (gate codes) and Notes (added above the
  "Brought across" line).
- Open Items "Description": printed on an opening invoice with no QuickBooks
  number (the "current balance" and ageing-bucket lines).
- "Check" and "Sources" columns are reference only and ignored.
Zones are Everton's to set up: the file carries a draft from his Delivery Area
list (Portmore/Downtown Mon, Red Hills/Uptown Tue+Thu, New Kingston/Cross
Roads Wed, Downtown Fri - "we go downtown twice"). His rule: the delivery
DAY supersedes the zone; the app already works that way (a customer's own
days come before their zone's run days in `orders.deliveryDaysFor`).
Tests: 1 more API, 1 more web.

**No pricing from the upload (16 Oct 2026).** Everton: "please do not change
any pricing mechanisms in the systems, the lists aren't perfect and needs
updating by me before." A standing-discount feature (migration 028) and the
upload setting 5-gallon special prices were built and then removed the same
day; 028 is now an empty migration kept for numbering. The upload sets no
prices and no discounts; the 5-gallon price and free-of-cost columns in the
file are reference only (FOC customers are charged and discounted 100% by
hand; Kool 97FM is billed and offset as marketing spend). It still puts a
"Distributor" customer on the Distributor price list.

**Upload file v3** uses the QuickBooks Open Invoices report (16 Oct, 4:41 pm,
J$3,054,018.29) for every opening invoice and unapplied payment; the 3:00 pm
A/R Ageing's extra pennies (J$0.25 in all) are folded into each customer's
latest invoice; larger differences are flagged (payments posted in between).

Tests: 585 (68 + 508 + 9).


---

## The public website at alkavidaja.com (21-22 Oct 2026)

Everton: "migrate the app and guide customers into our ecosystem" - one
access point at alkavidaja.com, with login and customer interaction. Rulings
(21 Oct): ONE SITE served by the app (GoDaddy Website Builder and the JotForm
retired; point the domain at Railway); guests can order without an account
("quick order, then account"); show listed prices; separate pages, not one
long home page; the About page keeps the ORIGINAL copy word for word; the
business number is 876-528-6112. Mockups: https://claude.ai/artifact/7EpDVWC4XjzpDdFZ5ZH6Ph
(project doc claude/landing-page-oct-2026.md). Then: "build for the team to
see and generate feedback".

Web (`packages/web/src/site/Site.tsx`, `site.css`, all scoped under `.site`):
- Pages: `/` home (signed out only; signed in, `/` is still the app), `/water`,
  `/delivery`, `/your-account`, `/business`, `/about`, `/contact`, `/order`.
  `SITE_PATHS` in Site.tsx; App.tsx `Routed` shows them signed in or not.
- `/sign-in` is the old sign-in page (`?forgot=1` opens "reset password");
  any other address signed out still shows sign-in (session-expiry return).
  The home page and Your account carry their own sign-in form.
- Live from the system, never typed twice: products and LISTED prices (each
  product's own price - what a walk-in or a customer with no tier pays; tier
  prices are never public), zones with run days (Delivery page "When do you
  come to my area?"), WhatsApp number (Settings, else 876-528-6112).
  Own-brand products only (`ownProductSql`), never co-pack, never the bottle
  charge. GCT 15% shown on the order estimate, prices "before GCT".
- Size photos: `packages/web/public/site/<size>.jpg` (5gal, 5l, 1.5l, 500ml,
  280ml - see README.txt there); a drawn bottle until then.
- Contact form opens the visitor's own email (mailto) - no mail from the page.

API:
- Migration 029 `website_orders` (+ `website_order_seq`, refs WEB-000001).
- `services/website.ts`: `siteInfo`, `submitWebsiteOrder` (validates, own
  products only, hidden "website" field for robots), `listWebsiteOrders`
  (with `possible_matches` by email or last 7 phone digits),
  `bookWebsiteOrder` (ADMIN: new customer from what they typed, or an
  existing one; creates the order with `createOrder` - Delivery/Pickup,
  pay on delivery, note "Website order WEB-…: will pay cash/by transfer",
  empties 0 when "first 5 gallon, no empty" so the bottle charge applies;
  if they ticked "Open an account" and gave an email: login + invitation +
  the approved email), `declineWebsiteOrder` (ADMIN).
- `routes/website.ts`: PUBLIC `GET /api/public/site`, `POST /api/public/order`
  (5 per 10 minutes per address); office `GET /api/website-orders`; admin
  `POST /api/website-orders/:id/book` and `/decline`.
- Needs a decision: website orders sit under "New accounts and website
  orders" (`components/WebsiteOrderRow.tsx`); badge counts and the dashboard
  include them; admins get push + email ("website-order" alert kind).

Tests: 595 (68 + 518 + 9). New `api/test/website.test.ts` (10). The alerts
"quiet hours" test can fail if run across midnight Jamaica time; rerun it.

Still to do / to decide: real case prices (Everton is updating pricing
himself); zones and days; the photos; real Privacy Policy and Terms text;
then point alkavidaja.com at Railway (GoDaddy DNS: CNAME www -> Railway, and
the root via forwarding or Railway's instructions) - keep the MX records so
orders@alkavidaja.com keeps working. Set PORTAL_URL=https://alkavidaja.com on
Railway once the domain is live, so emailed links use it.

---

## Map pins and sorting a round's stops (23 Oct 2026) - stage 1

Everton: "a process of sorting the stops on the route for the driver
optimally" (openmapquest had come up); it should sort at the start and work
offline. Mockups: https://claude.ai/artifact/R29KPiZ4k4JMKEfpt6SEUX; project
doc claude/route-sorting-oct-2026.md. His ruling: do both stages, stage 1
first (pins + sort). Stage 2 (the whole driver app working with no signal)
is still to do.

- Migration 030: `lat`, `lng`, `location_accuracy_m`, `location_source`
  (Driver / Office / Link), `location_set_at`, `location_set_by` on
  customers (main address) and customer_addresses (each extra address).
  The plant is settings `plant_lat` / `plant_lng`.
- `shared/src/routeorder.ts`: straight-line sort (nearest neighbour + 2-opt,
  from the plant and back), `tourKm`, `parseLatLng` (plain "lat, lng", @,
  q=, !3d!4d links), `inJamaica`. In shared so the phone can use it offline
  in stage 2.
- `services/locations.ts` + `routes/locations.ts`:
  - `GET /api/settings/routing` (plant + whether road sort is on),
    `PUT /api/settings/plant-location` (admin; lat/lng or pasted text).
  - `GET /api/customers/:id/pins`, `PUT /api/customers/:id/pin` (office;
    lat/lng, `text` = link/coordinates - short maps.app.goo.gl links are
    followed server side - or `clear`).
  - `POST /api/stops/:id/location` (driver at the door; their own round only;
    refused when the phone's fix is worse than 200 m). Lands on the address
    the order goes to.
  - `POST /api/delivery-sheets/:id/sort` {method Road|Straight} -> proposal;
    `.../sort/apply` {order, saveAsUsual}. Only before the round starts
    (started_at) - then locked. Drivers only on their own round, and never
    saveAsUsual. Stops with no pin go last.
  - Road sort = openrouteservice optimisation (VROOM) when ORS_API_KEY is set
    (Railway variable, or a line in "Alka Vida settings.txt"; documented in
    the example file). Max 50 stops. Any failure falls back to straight line
    with a note saying why.
- Web: `components/MapView.tsx` (Leaflet 1.9.4 + OpenStreetMap tiles; new
  dependency in packages/web), `SortStopsPanel` (round page before start, and
  the driver's route before start), `LocationPinsPanel` (customer › Details ›
  Addresses › Map pins), `StopLocation` ("Save this location" on the driver's
  stop; a pin taken with no signal waits in localStorage
  `alkavida.pendingPins` and is sent later), `PlantLocationPanel` (Settings ›
  Delivery zones). Rounds show a "no map pin" chip; the driver's stop has a
  Directions button (Google Maps) once pinned.

Tests: 608 (74 shared + 525 API + 9 web). New `shared/test/routeorder.test.ts`,
`api/test/locations.test.ts`.

To switch on road sorting: free account at openrouteservice.org, put the key
in "Alka Vida settings.txt" as ORS_API_KEY=... (and on Railway as a variable).

**Customers drop their own pin when they sign up (23 Oct 2026).** Everton:
"make the save pin a part of the account opening process for customers".
- Migration 031: location_source may also be 'Customer'; customer_applications
  and website_orders get lat, lng, location_accuracy_m.
- `components/PinPicker.tsx` ("Help our driver find you", optional): "I'm
  there now: use my location" (phone GPS) or pick/drag on a map. On Open an
  account (Register) and on the website's quick order when delivering.
- `registration.publicPin` validates it (in Jamaica, else a plain message);
  approving an account request / booking a website order as a NEW customer
  copies it to the customer as source 'Customer'.
- Needs a decision shows "They dropped a pin ... see it on the map".
- The driver's stop: a 'Customer' pin is used for sorting, but the driver is
  asked to "Save the exact spot" at the gate, which replaces it. The
  customer page says "Dropped by the customer when they signed up".
Tests: 610 (74 + 527 + 9).

---

## Recording a sale or delivery on an earlier day (23 Oct 2026)

Everton: "we need to be able to enter invoices for prior days ... set it as
3 for now and change to 1 down the line. Admins should have the right to
enter for any date."

- Migration 032: `customer_orders.recorded_late`; setting `backdate_days`
  (default 3), edited in Settings › Invoices & payments ("Recording an
  earlier day", admin only, 0-31).
- `counter.recordPastDelivery` (POST /api/past-delivery, admin/user): the
  order (order_date, requested date, fulfilled_on), the invoice (invoice_date,
  so the due date runs from it) and any payment taken are dated the day it
  went out. how = Delivered (delivery_mode Delivery, `noRound` - never on a
  round) or Collected (Pickup). Office staff refused beyond backdate_days;
  admins any day; never a future day. Walk-ins still pay in full.
  Weekly/monthly customers: no invoice now - marked delivered that day and
  picked up by `cycles.pendingDeliveries` (recorded_late orders count like
  collections) for that week's/month's invoice; money taken sits on account.
- `invoiceAndTakePayment` takes `on` (date) for the invoice, payments and
  fulfilled_on; `createOrder` takes `noRound`.
- New sale: "It already went out on an earlier day" tick (account customers
  and walk-ins) with "Went out on" (min = today - backdate_days for office
  staff, none for admins; max today); modes become "We delivered it / They
  took it"; payment "Paid at the time / On account"; no round, no repeat,
  no older-invoice payments. Button "Record it for <day>".
Tests: 615 (74 + 532 + 9). New `api/test/pastdelivery.test.ts`.

**Fix (23 Oct 2026, evening): website page clashed with Delivery rounds.**
The website's delivery page used `/delivery`, which is also the office's
Delivery rounds screen, so signed-in staff landed on the website. The
website page is now `/how-we-deliver`; `web/test/sitepaths.test.ts` fails if
any website address ever matches an app route again.

## Empties on the settlement, and who loaded the truck (23 Oct 2026, late)

Everton, after further testing:
1. "If the driver delivers to a customer and lists empty bottles collected,
   they don't come back on the settlement report."
2. "When logging the loading, the user making the note should not be
   selecting staff as the loader unless it is an admin user; it should
   automatically record the user confirming from their profile. For the
   admin, it should be a drop-down from office users if not themselves."

**1. Empties.** The stop always saved them (`bottles_empties_picked_up`);
the settlement screen simply never showed them, and its "Empty bottles
returned" box started blank (so a round settled without a bottle count).
- `settlement.getSettlementReview` now returns `bottles` (fullOut,
  emptiesFromStops, emptiesFromCollections, emptiesRecorded, lostDamaged,
  counted, variance) and, once Completed, `settledCash` (handed in,
  variance, notes).
- Settlement screen: a **Bottles** column per stop ("3 full out · 2 empties
  back · 1 lost"); "Empty bottles returned" defaults to what was counted off
  the truck, else to the empties recorded, until someone types; new lines
  Empties recorded across stops / Empties returned / Empties difference. A
  settled round now shows its cash and bottle reconciliation read-only (it
  used to show nothing).
- `reports.roundsReport` "Empties recorded" now includes empties from
  collection stops, as settlement always did.

**2. Loader.** Loaders are now office LOGINS, not employees.
- `trucks.resolveLoader`: office staff (`user`) are always the loader,
  whatever is sent; an admin sends `loaderId` (an active admin/user login),
  blank = themselves; anything else is refused ("choose who loaded it from
  the office logins"). Used by `loadRound` and `addToLoad`. Legacy
  `loaderIds[0]` is still read for an admin. Stored as a one-element
  `loader_ids`/`loader_names`, so the loadings report is unchanged.
- `loadingSummary.loaders` lists active admin/user logins (job_title
  Administrator/Office) for the admin's drop-down.
- `Truck.tsx`: the employee tick-boxes are gone. Office staff see "Loaded by
  <their name> · recorded from your login"; admins get a drop-down, "Me
  (<name>)" first. `loaderWords()` reads "Loaded by X" when the person who
  logged it loaded it, else "Logged by X; loaded by Y".
Tests: 617 (74 + 533 + 10). trucks.test.ts updated for loaders and a new
describe for empties on the settlement.

## Documents open in a new tab (23 Oct 2026, late)

Everton: viewing a receipt (Payments, customer transaction history) downloaded
it instead of showing it; "all viewing of statements, invoices and receipts
should be opened in a new tab instead of the same tab."

- Every PDF route now sends `content-disposition: inline` (was `attachment`),
  keeping the filename, so the browser's viewer shows it; its own buttons
  save or print it.
- `lib/api.ts` `openPdfPost(path, body, filename)`: for the POST-built PDFs
  (receipts, batch prints). Opens the tab FIRST, synchronously in the click
  (pop-up blockers allow that), then points it at a blob of the PDF; falls
  back to a download if the tab is blocked. Call it before any await in a
  click handler. GET documents use the existing `openPdf(path)`.
- Switched to a new tab: receipts (customer page, Payments - which also gets
  a **Receipt** link on every payment row - and New sale's "View receipt"),
  invoice and credit note PDFs, the Statement dialog and Statement page
  ("View PDF"), batch "Print (one PDF)" on Invoices, Credit notes, Quotes,
  Purchase orders, Payments and the customer page, quote and PO PDFs, and
  the portal's quote/invoice PDF buttons. The portal invoice's explicit
  "Download PDF" button still downloads; CSV/Excel exports still download.
- New sale no longer downloads the receipt by itself after a paid sale: a
  tab can only be opened from a click, so it is the "View receipt" link on
  the confirmation.
Tests unchanged at 617; checked in a browser that receipts and invoices open
in a new tab and show, with no download.
