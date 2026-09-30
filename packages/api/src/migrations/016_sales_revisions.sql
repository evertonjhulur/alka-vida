-- =====================================================================
-- Everton's revision list, 30 Sep 2026.
--
-- One migration for the whole round because the pieces lean on each other:
-- a quote, an order and an invoice all learn the same two things (a
-- discount can be an amount, and GCT can be switched off), and cycle
-- invoicing needs the customer's cycle before it can do anything.
--
--   * Customers: several delivery days, GCT exemption, an invoice cycle,
--     opt-outs for automatic emails, extra addresses, special prices.
--   * Zones: the days of the week each round runs.
--   * Orders / invoices / quotations: a fixed-amount discount, and GCT off.
--   * Invoices: lines that remember which delivery they came from, so one
--     monthly invoice can list every delivery in the month.
--   * Quotations: GCT shown, an acceptance link, sent/accepted stamps.
--   * Purchasing: GCT- and Env-exempt tags on what a supplier sells, and the
--     tax on each PO line worked out from them.
--   * Payments: a receipt number, given the first time a receipt is issued.
--   * Automatic emails: settings and a log so nothing is sent twice.
-- =====================================================================

-- ---------------------------------------------------------------- customers

ALTER TABLE customers
  -- Several days a week. default_delivery_day stays, holding the first of
  -- them, because older screens and reports read it.
  ADD COLUMN delivery_days text[] NOT NULL DEFAULT '{}',
  ADD COLUMN gct_exempt boolean NOT NULL DEFAULT false,
  -- The certificate or letter the exemption rests on, printed on invoices.
  ADD COLUMN gct_exempt_ref text,
  -- PerDelivery: an invoice at every delivery, as always.
  -- Weekly / Monthly: deliveries collect on the account and ONE invoice is
  -- raised when the week (Mon-Sun) or calendar month closes, due on receipt.
  ADD COLUMN invoice_cycle text NOT NULL DEFAULT 'PerDelivery'
    CHECK (invoice_cycle IN ('PerDelivery','Weekly','Monthly')),
  ADD COLUMN auto_statements boolean NOT NULL DEFAULT true,
  ADD COLUMN auto_reminders boolean NOT NULL DEFAULT true;

UPDATE customers SET delivery_days = ARRAY[default_delivery_day]
WHERE default_delivery_day IS NOT NULL;

-- Addresses beyond the main one on the customer row. The main address stays
-- where it is (every existing screen and the stop read it); these are extras.
CREATE TABLE customer_addresses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label         text NOT NULL,
  address_line1 text,
  address_line2 text,
  city          text,
  parish        text,
  -- Printed on invoices and statements instead of the main address.
  is_billing    boolean NOT NULL DEFAULT false,
  -- Can be chosen as where an order goes; then its own zone decides the round.
  is_delivery   boolean NOT NULL DEFAULT true,
  delivery_zone text,
  route_sequence integer NOT NULL DEFAULT 0,
  contact_person text,
  phone         text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_addresses_customer_idx ON customer_addresses(customer_id) WHERE active;

-- A price for one product, for one customer, over whatever list they are on.
CREATE TABLE customer_prices (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id            uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id             uuid NOT NULL REFERENCES products(id),
  price_per_case_cents   bigint NOT NULL DEFAULT 0 CHECK (price_per_case_cents >= 0),
  price_per_bottle_cents bigint NOT NULL DEFAULT 0 CHECK (price_per_bottle_cents >= 0),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, product_id)
);

-- -------------------------------------------------------------------- zones

ALTER TABLE delivery_zones ADD COLUMN run_days text[] NOT NULL DEFAULT '{}';

-- --------------------------------------------- orders, invoices, quotations

ALTER TABLE customer_orders
  ADD COLUMN discount_fixed_cents bigint NOT NULL DEFAULT 0 CHECK (discount_fixed_cents >= 0),
  ADD COLUMN gct_exempt boolean NOT NULL DEFAULT false,
  ADD COLUMN address_id uuid REFERENCES customer_addresses(id),
  ADD COLUMN quotation_id uuid REFERENCES quotations(id),
  -- The day the goods actually left (a pickup collected, a stop delivered).
  -- A weekly or monthly invoice lists deliveries by this date.
  ADD COLUMN fulfilled_on date;

ALTER TABLE invoices
  ADD COLUMN discount_fixed_cents bigint NOT NULL DEFAULT 0 CHECK (discount_fixed_cents >= 0),
  ADD COLUMN gct_exempt boolean NOT NULL DEFAULT false,
  -- Set on an invoice raised for a week or month of deliveries.
  ADD COLUMN cycle text CHECK (cycle IN ('Weekly','Monthly')),
  ADD COLUMN period_from date,
  ADD COLUMN period_to date,
  -- A reminder that it is overdue, so they are not sent every hour.
  ADD COLUMN last_reminder_on date;

ALTER TABLE invoice_line_items
  -- Which delivery a line came from, on an invoice that covers several.
  ADD COLUMN delivered_on date,
  ADD COLUMN order_id uuid REFERENCES customer_orders(id),
  ADD COLUMN reference text;

ALTER TABLE approval_requests
  ADD COLUMN discount_fixed_cents bigint;

ALTER TABLE quotations
  ADD COLUMN discount_fixed_cents bigint NOT NULL DEFAULT 0 CHECK (discount_fixed_cents >= 0),
  ADD COLUMN gct_exempt boolean NOT NULL DEFAULT false,
  -- What GCT the order will attract, shown so the customer sees the real total.
  -- A quote still books nothing: this is a figure on a page, not a liability.
  ADD COLUMN gct_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN delivery_mode text NOT NULL DEFAULT 'Delivery' CHECK (delivery_mode IN ('Delivery','Pickup')),
  ADD COLUMN sent_date date,
  ADD COLUMN accepted_at timestamptz,
  ADD COLUMN accepted_via text,
  ADD COLUMN decline_reason text,
  -- Only the hash is kept, the same rule invitations follow.
  ADD COLUMN accept_token_hash text,
  ADD COLUMN created_by_id uuid REFERENCES users(id),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX quotations_accept_token_idx ON quotations(accept_token_hash)
  WHERE accept_token_hash IS NOT NULL;

-- --------------------------------------------------------------- purchasing

ALTER TABLE supplier_materials
  ADD COLUMN gct_exempt boolean NOT NULL DEFAULT false,
  ADD COLUMN env_exempt boolean NOT NULL DEFAULT false;

ALTER TABLE po_line_items
  ADD COLUMN gct_exempt boolean NOT NULL DEFAULT false,
  ADD COLUMN env_exempt boolean NOT NULL DEFAULT true,
  ADD COLUMN line_total_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN gct_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN env_tax_cents bigint NOT NULL DEFAULT 0;

-- Existing lines: the totals they were raised with (GCT on everything, no
-- Env - which is how every PO before this was calculated).
UPDATE po_line_items
SET line_total_cents = round(unit_cost_cents * quantity_ordered)::bigint,
    gct_cents = round(round(unit_cost_cents * quantity_ordered) * 0.15)::bigint;

ALTER TABLE purchase_orders
  ADD COLUMN sent_to text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- ----------------------------------------------------------------- payments

CREATE SEQUENCE receipt_number_seq START 1000;
ALTER TABLE payments ADD COLUMN receipt_number text UNIQUE;

-- -------------------------------------------------------- automatic emails

-- One row per email the system sent on its own, so the hourly check can tell
-- what has gone and a person can see it did.
CREATE TABLE auto_emails (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('Statement','Reminder','CycleInvoice')),
  customer_id uuid NOT NULL REFERENCES customers(id),
  sent_on     date NOT NULL DEFAULT business_today(),
  sent_to     text,
  -- For a statement, the month it covers ('2026-09'); for a reminder, the
  -- invoice numbers. What stops the same thing going twice.
  period_key  text,
  detail      text,
  ok          boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auto_emails_customer_idx ON auto_emails(customer_id, kind, sent_on);

INSERT INTO system_settings (key, value) VALUES
  ('auto_statements_enabled', 'false'),
  ('auto_statements_day', '1'),
  ('auto_reminders_enabled', 'false'),
  ('auto_reminders_after_days', '7'),
  ('auto_reminders_every_days', '14'),
  ('cycle_invoices_auto_send', 'false'),
  ('env_tax_rate_percent', '0.375')
ON CONFLICT (key) DO NOTHING;
