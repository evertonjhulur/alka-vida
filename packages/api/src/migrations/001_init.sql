-- =====================================================================
-- Alka Vida - initial schema
-- 1506 Investments Limited.  Currency: JMD.  Tax: GCT 15%.
--
-- CONVENTIONS
--   * Every monetary column is BIGINT and named *_cents. There are no
--     floating point money columns anywhere in this database.
--   * Enumerations are TEXT + CHECK rather than native pg enums, so they
--     can be extended in a migration without a table rewrite.
--   * Product quantity is stored as cases + loose bottles plus a
--     denormalised total, guarded by the case-vs-bottle rule.
-- =====================================================================

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL UNIQUE,
  name           text NOT NULL,
  password_hash  text NOT NULL,
  role           text NOT NULL CHECK (role IN ('admin','user','driver','customer')),
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE brands (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  type         text NOT NULL CHECK (type IN ('Owned','Third-Party Co-Pack')),
  contact_info text,
  label_source text CHECK (label_source IN ('Company-purchased','Customer-supplied')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- A pricing tier. Customers point at one; price_lists holds its per-product rates.
CREATE TABLE price_tiers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  delivery_address     text,
  contact_person       text,
  phone                text NOT NULL,
  email                text NOT NULL,
  brand_id             uuid REFERENCES brands(id),
  payment_terms        text,
  price_tier_id        uuid REFERENCES price_tiers(id),
  default_delivery_day text CHECK (default_delivery_day IN
                          ('Mon','Tue','Wed','Thu','Fri','Sat','Sun')),
  -- Route/zone used to place auto-generated delivery stops (Section 3 Step 1).
  delivery_zone        text,
  -- Typical visit order within the zone; a reusable template (Section 8).
  route_sequence       integer NOT NULL DEFAULT 0,
  user_id              uuid REFERENCES users(id),
  -- false once merged away. Inactive customers keep full history but cannot
  -- be selected for new orders (Section 6).
  active               boolean NOT NULL DEFAULT true,
  merged_into_id       uuid REFERENCES customers(id),
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customers_zone_idx ON customers(delivery_zone) WHERE active;

CREATE TABLE suppliers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  contact_person text,
  phone          text,
  email          text,
  address        text,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  brand_id         uuid REFERENCES brands(id),
  size             text,
  -- 0 for the 5-gallon product, which is sold individually and never cased.
  bottles_per_case integer NOT NULL CHECK (bottles_per_case >= 0),
  price_per_case_cents   bigint NOT NULL DEFAULT 0 CHECK (price_per_case_cents >= 0),
  price_per_bottle_cents bigint NOT NULL DEFAULT 0 CHECK (price_per_bottle_cents >= 0),
  is_returnable    boolean NOT NULL DEFAULT false,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- One row per (tier x product). This is what tiered pricing resolves against.
CREATE TABLE price_lists (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  price_tier_id          uuid NOT NULL REFERENCES price_tiers(id) ON DELETE CASCADE,
  product_id             uuid NOT NULL REFERENCES products(id),
  price_per_case_cents   bigint NOT NULL CHECK (price_per_case_cents >= 0),
  price_per_bottle_cents bigint NOT NULL CHECK (price_per_bottle_cents >= 0),
  UNIQUE (price_tier_id, product_id)
);

CREATE TABLE raw_materials (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  category         text NOT NULL CHECK (category IN ('Bottle','Cap','Handle','Label','Water')),
  size_spec        text,
  unit_of_measure  text NOT NULL DEFAULT 'pcs',
  quantity_on_hand numeric(14,3) NOT NULL DEFAULT 0,
  reorder_point    numeric(14,3) NOT NULL DEFAULT 0,
  -- Reference figure only. FIFO batch costs are the source of truth (see
  -- material_batches); this never drives what production is charged.
  unit_cost_cents  bigint NOT NULL DEFAULT 0 CHECK (unit_cost_cents >= 0),
  made_to_order    boolean NOT NULL DEFAULT false,
  consigned        boolean NOT NULL DEFAULT false,
  brand_id         uuid REFERENCES brands(id),
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- A material can have multiple suppliers, each with a standard price.
CREATE TABLE supplier_materials (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id     uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  raw_material_id uuid NOT NULL REFERENCES raw_materials(id) ON DELETE CASCADE,
  unit_cost_cents bigint NOT NULL CHECK (unit_cost_cents >= 0),
  UNIQUE (supplier_id, raw_material_id)
);

-- Volume-tier pricing. Best match = highest min_qty <= quantity ordered.
CREATE TABLE supplier_price_breaks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id     uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  raw_material_id uuid NOT NULL REFERENCES raw_materials(id) ON DELETE CASCADE,
  min_qty         numeric(14,3) NOT NULL CHECK (min_qty > 0),
  unit_cost_cents bigint NOT NULL CHECK (unit_cost_cents >= 0),
  UNIQUE (supplier_id, raw_material_id, min_qty)
);

CREATE TABLE bom_line_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  raw_material_id uuid NOT NULL REFERENCES raw_materials(id),
  component_type  text NOT NULL CHECK (component_type IN ('Bottle','Cap','Handle','Label','Water')),
  -- Quantity of this material consumed per ONE bottle produced.
  quantity        numeric(14,4) NOT NULL CHECK (quantity > 0),
  UNIQUE (product_id, raw_material_id)
);

CREATE TABLE purchase_orders (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id            uuid NOT NULL REFERENCES suppliers(id),
  po_number              text NOT NULL UNIQUE,
  order_date             date NOT NULL DEFAULT current_date,
  expected_delivery_date date,
  receiving_date         date,
  status                 text NOT NULL DEFAULT 'Draft'
                           CHECK (status IN ('Draft','Sent','Partially Received','Received','Cancelled')),
  subtotal_cents    bigint NOT NULL DEFAULT 0,
  gct_cents         bigint NOT NULL DEFAULT 0,
  env_tax_cents     bigint NOT NULL DEFAULT 0,
  grand_total_cents bigint NOT NULL DEFAULT 0,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE po_line_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id             uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  raw_material_id   uuid NOT NULL REFERENCES raw_materials(id),
  quantity_ordered  numeric(14,3) NOT NULL CHECK (quantity_ordered > 0),
  -- Resolved from the supplier price break / standard cost AT CREATION and
  -- then frozen. Later supplier price changes must never rewrite an issued PO.
  unit_cost_cents   bigint NOT NULL CHECK (unit_cost_cents >= 0),
  quantity_received numeric(14,3) NOT NULL DEFAULT 0 CHECK (quantity_received >= 0)
);

-- FIFO costing layer. Each received PO line creates its own batch.
CREATE TABLE material_batches (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_material_id    uuid NOT NULL REFERENCES raw_materials(id),
  supplier_id        uuid REFERENCES suppliers(id),
  po_id              uuid REFERENCES purchase_orders(id),
  po_line_item_id    uuid REFERENCES po_line_items(id),
  received_date      timestamptz NOT NULL DEFAULT now(),
  unit_cost_cents    bigint NOT NULL CHECK (unit_cost_cents >= 0),
  quantity_received  numeric(14,3) NOT NULL CHECK (quantity_received > 0),
  quantity_remaining numeric(14,3) NOT NULL CHECK (quantity_remaining >= 0),
  status             text NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','Consumed')),
  CONSTRAINT batch_remaining_within_received CHECK (quantity_remaining <= quantity_received)
);
-- The FIFO draw order: oldest open batch first.
CREATE INDEX material_batches_fifo_idx
  ON material_batches (raw_material_id, received_date, id) WHERE status = 'Open';

CREATE TABLE production_batches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_date        date NOT NULL DEFAULT current_date,
  operator          text,
  status            text NOT NULL DEFAULT 'Planned' CHECK (status IN ('Planned','Completed','Blocked')),
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE production_batch_line_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id      uuid NOT NULL REFERENCES production_batches(id) ON DELETE CASCADE,
  product_id    uuid NOT NULL REFERENCES products(id),
  cases         integer NOT NULL DEFAULT 0 CHECK (cases >= 0),
  loose_bottles integer NOT NULL DEFAULT 0 CHECK (loose_bottles >= 0),
  total_bottles integer NOT NULL CHECK (total_bottles >= 0)
);

CREATE TABLE finished_goods_stock (
  product_id       uuid PRIMARY KEY REFERENCES products(id),
  quantity_on_hand integer NOT NULL DEFAULT 0
);

-- 5-gallon returnable bottle pool, tracked per brand.
CREATE TABLE five_gal_bottle_pool (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label                text NOT NULL,
  brand_id             uuid REFERENCES brands(id),
  clean_ready          integer NOT NULL DEFAULT 0 CHECK (clean_ready >= 0),
  filled_with_customer integer NOT NULL DEFAULT 0 CHECK (filled_with_customer >= 0),
  returned_dirty       integer NOT NULL DEFAULT 0 CHECK (returned_dirty >= 0),
  lost_damaged         integer NOT NULL DEFAULT 0 CHECK (lost_damaged >= 0)
);

CREATE TABLE inventory_transactions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_type      text NOT NULL CHECK (item_type IN ('RawMaterial','FinishedGoods','BottlePool')),
  item_id        uuid NOT NULL,
  item_name      text NOT NULL,
  quantity       numeric(14,3) NOT NULL,
  direction      text NOT NULL CHECK (direction IN ('in','out','transfer')),
  reference      text,
  reference_type text NOT NULL CHECK (reference_type IN
                   ('PurchaseOrder','ProductionBatch','CustomerOrder','Manual',
                    'BottleReturn','BottleWash','Adjustment')),
  txn_date       timestamptz NOT NULL DEFAULT now(),
  notes          text,
  -- True FIFO-drawn cost for an "out"; batch cost for an "in".
  unit_cost_cents  bigint,
  total_cost_cents bigint,
  -- Which MaterialBatch(es) were drawn from or received into.
  batch_ids      uuid[] NOT NULL DEFAULT '{}'
);
CREATE INDEX inv_txn_item_idx ON inventory_transactions(item_type, item_id, txn_date);

CREATE TABLE inventory_audits (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_date   date NOT NULL DEFAULT current_date,
  item_type    text NOT NULL CHECK (item_type IN ('RawMaterial','FinishedGoods')),
  item_id      uuid NOT NULL,
  item_name    text NOT NULL,
  system_qty   numeric(14,3) NOT NULL,
  counted_qty  numeric(14,3) NOT NULL,
  damaged_qty  numeric(14,3) NOT NULL DEFAULT 0,
  discrepancy  numeric(14,3) NOT NULL,
  status       text NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','Reconciled')),
  notes        text
);

-- =====================================================================
-- Sales documents
-- =====================================================================

CREATE TABLE quotations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_number      text NOT NULL UNIQUE,
  customer_id       uuid NOT NULL REFERENCES customers(id),
  quote_date        date NOT NULL DEFAULT current_date,
  valid_until       date,
  status            text NOT NULL DEFAULT 'Draft'
                      CHECK (status IN ('Draft','Sent','Accepted','Converted','Expired','Declined')),
  notes             text,
  subtotal_cents    bigint NOT NULL DEFAULT 0,
  discount_percent  numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  discount_amount_cents bigint NOT NULL DEFAULT 0,
  -- Deliberately NO gct column: quotations have no tax impact.
  grand_total_cents bigint NOT NULL DEFAULT 0,
  converted_order_id uuid,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quotation_line_items (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id               uuid NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  product_id             uuid NOT NULL REFERENCES products(id),
  cases                  integer NOT NULL DEFAULT 0 CHECK (cases >= 0),
  loose_bottles          integer NOT NULL DEFAULT 0 CHECK (loose_bottles >= 0),
  total_bottles          integer NOT NULL DEFAULT 0 CHECK (total_bottles >= 0),
  price_per_case_cents   bigint NOT NULL DEFAULT 0 CHECK (price_per_case_cents >= 0),
  price_per_bottle_cents bigint NOT NULL DEFAULT 0 CHECK (price_per_bottle_cents >= 0),
  line_total_cents       bigint NOT NULL DEFAULT 0
);

CREATE TABLE customer_orders (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number            text NOT NULL UNIQUE,
  customer_id             uuid NOT NULL REFERENCES customers(id),
  order_date              date NOT NULL DEFAULT current_date,
  requested_delivery_date date,
  status                  text NOT NULL DEFAULT 'Pending'
                            CHECK (status IN ('Pending','Partially Delivered','Delivered','Cancelled')),
  notes                   text,
  is_recurring            boolean NOT NULL DEFAULT false,
  recurrence_pattern      text CHECK (recurrence_pattern IN ('Weekly','Biweekly','Monthly')),
  next_delivery_date      date,
  -- Next expected date for the remaining qty when a partial order is on hold.
  hold_until              date,
  parent_recurring_id     uuid REFERENCES customer_orders(id),
  payment_method          text CHECK (payment_method IN ('Cash','Card','Bank Transfer')),
  source                  text NOT NULL DEFAULT 'Admin' CHECK (source IN ('Admin','Portal')),
  delivery_mode           text NOT NULL CHECK (delivery_mode IN ('Delivery','Pickup')),
  discount_percent        numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  -- Calculated live at order entry, mirroring the invoice calculation exactly.
  -- REFERENCE / EXPECTATION ONLY. The invoice generated at actual delivery
  -- recalculates independently from real delivered quantities.
  subtotal_cents          bigint NOT NULL DEFAULT 0,
  discount_amount_cents   bigint NOT NULL DEFAULT 0,
  gct_cents               bigint NOT NULL DEFAULT 0,
  grand_total_cents       bigint NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_orders_customer_idx ON customer_orders(customer_id, order_date);

CREATE TABLE order_line_items (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id               uuid NOT NULL REFERENCES customer_orders(id) ON DELETE CASCADE,
  product_id             uuid NOT NULL REFERENCES products(id),
  cases                  integer NOT NULL DEFAULT 0 CHECK (cases >= 0),
  loose_bottles          integer NOT NULL DEFAULT 0 CHECK (loose_bottles >= 0),
  total_bottles          integer NOT NULL DEFAULT 0 CHECK (total_bottles >= 0),
  -- Locked in from the customer price tier at order creation.
  price_per_case_cents   bigint NOT NULL DEFAULT 0 CHECK (price_per_case_cents >= 0),
  price_per_bottle_cents bigint NOT NULL DEFAULT 0 CHECK (price_per_bottle_cents >= 0),
  price_tier             text,
  delivered_cases        integer NOT NULL DEFAULT 0 CHECK (delivered_cases >= 0),
  delivered_loose        integer NOT NULL DEFAULT 0 CHECK (delivered_loose >= 0),
  delivered_total        integer NOT NULL DEFAULT 0 CHECK (delivered_total >= 0),
  bottles_returned       integer NOT NULL DEFAULT 0 CHECK (bottles_returned >= 0),
  bottle_charge_cents    bigint NOT NULL DEFAULT 0
);

-- =====================================================================
-- Delivery
-- =====================================================================

CREATE TABLE delivery_sheets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_date      date NOT NULL,
  driver_name        text,
  assigned_driver_id uuid REFERENCES users(id),
  vehicle            text,
  zone               text NOT NULL,
  route_notes        text,
  status             text NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','Completed')),
  -- Cash reconciliation. A DRIVER ACCOUNTABILITY CHECK ONLY: this compares the
  -- physical cash handed in against what the driver recorded collecting. It
  -- must never create, adjust or influence any Payment or Invoice record.
  expected_cash_cents bigint NOT NULL DEFAULT 0,
  actual_cash_cents   bigint,
  cash_variance_cents bigint,
  cash_settled        boolean NOT NULL DEFAULT false,
  reconciled_by       uuid REFERENCES users(id),
  reconciled_date     timestamptz,
  settlement_notes    text,
  -- Bottle reconciliation.
  bottle_expected_out     integer NOT NULL DEFAULT 0,
  bottle_actual_returned  integer,
  bottle_variance         integer,
  bottle_settled          boolean NOT NULL DEFAULT false,
  bottle_settle_notes     text,
  created_at              timestamptz NOT NULL DEFAULT now()
);
-- At most one OPEN sheet per zone per day. A Completed sheet does not block a
-- new Open one, which is what lets a late order start a fresh sheet.
CREATE UNIQUE INDEX delivery_sheets_open_zone_date_idx
  ON delivery_sheets (delivery_date, zone) WHERE status = 'Open';

CREATE TABLE delivery_stops (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_sheet_id uuid NOT NULL REFERENCES delivery_sheets(id) ON DELETE CASCADE,
  customer_id       uuid NOT NULL REFERENCES customers(id),
  order_id          uuid REFERENCES customer_orders(id),
  delivery_address  text,
  contact_phone     text,
  order_ref         text,
  line_items_summary text,
  driver_notes      text,
  signature         text,
  -- Seeded from the customer route_sequence template, editable per sheet.
  sequence_no       integer NOT NULL DEFAULT 0,
  stop_outcome      text NOT NULL DEFAULT 'Pending'
                      CHECK (stop_outcome IN ('Pending','Delivered','Customer Not Home',
                                              'Refused','Rescheduled','Other')),
  outcome_notes     text,
  bottles_delivered_full   integer NOT NULL DEFAULT 0 CHECK (bottles_delivered_full >= 0),
  bottles_empties_picked_up integer NOT NULL DEFAULT 0 CHECK (bottles_empties_picked_up >= 0),
  bottles_lost_damaged     integer NOT NULL DEFAULT 0 CHECK (bottles_lost_damaged >= 0),
  payment_received  boolean NOT NULL DEFAULT false,
  payment_method    text CHECK (payment_method IN ('Cash','Card','Bank Transfer','Cheque','Other')),
  -- The actual total collected. Stored as entered, unvalidated.
  -- REFERENCE ONLY until route settlement creates real Payments.
  payment_amount_cents bigint NOT NULL DEFAULT 0,
  -- Set once route settlement has processed this stop; makes settlement
  -- idempotent so a double click cannot create two sets of Payments.
  settled_at        timestamptz,
  invoice_id        uuid,
  UNIQUE (delivery_sheet_id, order_id)
);
CREATE INDEX delivery_stops_sheet_idx ON delivery_stops(delivery_sheet_id, sequence_no);

-- Actual per-product delivered quantities recorded at the stop.
CREATE TABLE delivery_stop_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stop_id        uuid NOT NULL REFERENCES delivery_stops(id) ON DELETE CASCADE,
  order_line_id  uuid NOT NULL REFERENCES order_line_items(id),
  product_id     uuid NOT NULL REFERENCES products(id),
  cases          integer NOT NULL DEFAULT 0 CHECK (cases >= 0),
  loose_bottles  integer NOT NULL DEFAULT 0 CHECK (loose_bottles >= 0),
  total_bottles  integer NOT NULL DEFAULT 0 CHECK (total_bottles >= 0),
  UNIQUE (stop_id, order_line_id)
);

-- The driver suggested split of collected cash across open invoices.
-- PROVISIONAL: creates no Payment record and affects no balance.
CREATE TABLE delivery_stop_allocations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stop_id      uuid NOT NULL REFERENCES delivery_stops(id) ON DELETE CASCADE,
  invoice_id   uuid,
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0)
);

-- =====================================================================
-- Billing
-- =====================================================================

CREATE TABLE invoices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number   text NOT NULL UNIQUE,
  invoice_date     date NOT NULL DEFAULT current_date,
  due_date         date,
  sent_date        date,
  customer_id      uuid NOT NULL REFERENCES customers(id),
  -- The manually-controlled part of status only. The PAID/PARTIAL part is
  -- derived from the payment ledger and is deliberately not stored here.
  lifecycle        text NOT NULL DEFAULT 'Open'
                     CHECK (lifecycle IN ('Open','Sent','Cancelled')),
  subtotal_cents        bigint NOT NULL DEFAULT 0,
  discount_percent      numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  discount_amount_cents bigint NOT NULL DEFAULT 0,
  discount_status  text NOT NULL DEFAULT 'Approved'
                     CHECK (discount_status IN ('Approved','Pending','Rejected')),
  gct_cents        bigint NOT NULL DEFAULT 0,
  grand_total_cents bigint NOT NULL DEFAULT 0,
  -- NOTE: there is deliberately NO amount_paid column. amount_paid is ALWAYS
  -- the sum of Confirmed payments and is exposed through the invoice_ledger
  -- view, so no code path can write it directly (Section 3, Step 6).
  is_credit_note   boolean NOT NULL DEFAULT false,
  credit_status    text NOT NULL DEFAULT 'Approved'
                     CHECK (credit_status IN ('Approved','Pending','Rejected')),
  linked_invoice_id uuid REFERENCES invoices(id),
  approval_request_id uuid,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoices_customer_idx ON invoices(customer_id, invoice_date);

-- An invoice can cover more than one order.
CREATE TABLE invoice_orders (
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  order_id   uuid NOT NULL REFERENCES customer_orders(id),
  PRIMARY KEY (invoice_id, order_id)
);

CREATE TABLE invoice_line_items (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id             uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id             uuid NOT NULL REFERENCES products(id),
  cases                  integer NOT NULL DEFAULT 0,
  loose_bottles          integer NOT NULL DEFAULT 0,
  price_per_case_cents   bigint NOT NULL DEFAULT 0,
  price_per_bottle_cents bigint NOT NULL DEFAULT 0,
  line_total_cents       bigint NOT NULL DEFAULT 0
);

CREATE TABLE approval_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_type   text NOT NULL CHECK (request_type IN ('Discount','CreditNote')),
  status         text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected')),
  entity_type    text NOT NULL,
  entity_id      uuid NOT NULL,
  entity_label   text,
  customer_id    uuid REFERENCES customers(id),
  -- Financial impact of the request.
  amount_cents   bigint NOT NULL DEFAULT 0,
  discount_percent numeric(5,2),
  reason         text,
  requested_by_id uuid REFERENCES users(id),
  requested_date timestamptz NOT NULL DEFAULT now(),
  reviewed_by_id uuid REFERENCES users(id),
  reviewed_date  timestamptz,
  review_notes   text
);
CREATE INDEX approval_requests_pending_idx ON approval_requests(status, requested_date);

CREATE TABLE payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    uuid NOT NULL REFERENCES customers(id),
  -- Optional. Blank means unattached. Which invoice a payment is attached to
  -- is bookkeeping detail; it does NOT gate the customer running balance.
  invoice_id     uuid REFERENCES invoices(id),
  -- Reversals store the amount negated, hence no non-negative check.
  amount_cents   bigint NOT NULL,
  payment_date   timestamptz NOT NULL DEFAULT now(),
  method         text NOT NULL CHECK (method IN ('Cash','Card','Bank Transfer','Cheque','Other')),
  reference      text,
  notes          text,
  -- Provisional = captured during a route, not yet real.
  -- Confirmed    = counts toward the balance.
  status         text NOT NULL DEFAULT 'Confirmed' CHECK (status IN ('Provisional','Confirmed')),
  delivery_sheet_id uuid REFERENCES delivery_sheets(id),
  delivery_stop_id  uuid REFERENCES delivery_stops(id),
  -- Informational tag only. Does not affect the balance and must never be
  -- branched on to produce a distinct "credit" category.
  kind           text,
  is_reversal    boolean NOT NULL DEFAULT false,
  reverses_payment_id uuid REFERENCES payments(id),
  created_by_id  uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_customer_idx ON payments(customer_id, payment_date);
CREATE INDEX payments_invoice_idx ON payments(invoice_id) WHERE invoice_id IS NOT NULL;
-- A payment may only reverse a given payment once.
CREATE UNIQUE INDEX payments_one_reversal_idx
  ON payments(reverses_payment_id) WHERE reverses_payment_id IS NOT NULL;

CREATE TABLE audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts          timestamptz NOT NULL DEFAULT now(),
  user_id     uuid REFERENCES users(id),
  user_name   text,
  action      text NOT NULL CHECK (action IN
                ('create','update','delete','deliver','receive','pay','finalize','adjust')),
  entity_type text NOT NULL,
  entity_id   uuid,
  entity_label text,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_entity_idx ON audit_log(entity_type, entity_id, ts);

-- Guards against a slow response plus a repeated click creating two real
-- records for one transaction (Section 6, duplicate submission guard).
CREATE TABLE idempotency_keys (
  key         text PRIMARY KEY,
  operation   text NOT NULL,
  result_id   uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- Derived views: the single source of truth for money owed.
-- =====================================================================

-- amount_paid is ALWAYS the sum of Confirmed payments attached to the
-- invoice. Because it lives in a view there is no column for any code path
-- to write to, which makes the Section 3 Step 6 bug unrepresentable.
CREATE VIEW invoice_ledger AS
SELECT
  i.id                AS invoice_id,
  i.customer_id,
  i.invoice_number,
  i.invoice_date,
  i.due_date,
  i.grand_total_cents,
  i.is_credit_note,
  i.lifecycle,
  COALESCE(p.paid_cents, 0) AS amount_paid_cents,
  i.grand_total_cents - COALESCE(p.paid_cents, 0) AS balance_cents,
  CASE
    WHEN i.lifecycle = 'Cancelled' THEN 'Cancelled'
    WHEN i.is_credit_note          THEN 'Credit Note'
    -- Exact match or overpaid both read as Paid. Any excess exists only as a
    -- separate unattached Payment; it is never labelled on the invoice.
    WHEN COALESCE(p.paid_cents, 0) >= i.grand_total_cents THEN 'Paid'
    WHEN COALESCE(p.paid_cents, 0) > 0 THEN 'Partial'
    WHEN i.due_date IS NOT NULL AND i.due_date < current_date THEN 'Overdue'
    WHEN i.lifecycle = 'Sent' THEN 'Sent'
    ELSE 'Open'
  END AS status
FROM invoices i
LEFT JOIN (
  SELECT invoice_id, SUM(amount_cents) AS paid_cents
  FROM payments
  WHERE status = 'Confirmed' AND invoice_id IS NOT NULL
  GROUP BY invoice_id
) p ON p.invoice_id = i.id;

-- ONE running balance per customer. Not a balance plus a separate credit
-- balance: every Confirmed payment counts, attached to an invoice or not.
CREATE VIEW customer_balances AS
SELECT
  c.id AS customer_id,
  c.name,
  COALESCE(inv.total_cents, 0)  AS invoiced_cents,
  COALESCE(pay.total_cents, 0)  AS paid_cents,
  COALESCE(inv.total_cents, 0) - COALESCE(pay.total_cents, 0) AS balance_cents
FROM customers c
LEFT JOIN (
  SELECT customer_id, SUM(grand_total_cents) AS total_cents
  FROM invoices WHERE lifecycle <> 'Cancelled' GROUP BY customer_id
) inv ON inv.customer_id = c.id
LEFT JOIN (
  SELECT customer_id, SUM(amount_cents) AS total_cents
  FROM payments WHERE status = 'Confirmed' GROUP BY customer_id
) pay ON pay.customer_id = c.id;

-- =====================================================================
-- Document numbering. Sequences rather than max()+1 so two concurrent
-- deliveries can never mint the same invoice number.
-- =====================================================================
CREATE SEQUENCE invoice_number_seq START 1000;
CREATE SEQUENCE order_number_seq   START 1000;
CREATE SEQUENCE quote_number_seq   START 1000;
CREATE SEQUENCE po_number_seq      START 1000;
