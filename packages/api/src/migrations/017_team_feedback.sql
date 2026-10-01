-- =====================================================================
-- The Florida team's testing round, 1 Oct 2026 (23 points, portal + office).
--
--   * Customers: standing delivery instructions (gate code etc.), a WhatsApp
--     number, a marketing opt-out, and whether they want order emails.
--   * Orders: the customer's own PO number; a same-day order placed after the
--     cut-off waits for the office (needs_review) instead of going on a round.
--   * Stops: "Another day" now names the day, and says why.
--   * Invoices: every invoice gets a due date from the customer's terms.
--   * Approvals: same-day orders after the cut-off, and payment changes.
--   * Stock counts: finished goods counted in cases + loose bottles, and who
--     applied a count.
--   * News & offers for the portal, customer lists, and messages to them.
--   * Password reset links reuse the invitation table (purpose column).
--   * Bottles that leave at the counter or on a collection are recorded per
--     customer too (customer_bottle_moves), not only those on a round.
-- =====================================================================

ALTER TABLE customers
  ADD COLUMN delivery_instructions text,
  ADD COLUMN whatsapp text,
  ADD COLUMN marketing_opt_out boolean NOT NULL DEFAULT false,
  ADD COLUMN order_emails boolean NOT NULL DEFAULT true;

ALTER TABLE customer_addresses
  ADD COLUMN delivery_instructions text;

ALTER TABLE customer_orders
  ADD COLUMN customer_po text,
  ADD COLUMN needs_review boolean NOT NULL DEFAULT false,
  ADD COLUMN placed_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE delivery_stops
  ADD COLUMN rescheduled_to date,
  ADD COLUMN reschedule_reason text;

-- ------------------------------------------------------------- due dates

-- "Net 30" -> 30 days, "Cash on delivery" / "Due on receipt" -> same day.
UPDATE invoices i
   SET due_date = i.invoice_date
                + COALESCE(NULLIF(substring(c.payment_terms from '([0-9]+)'), '')::int, 0)
  FROM customers c
 WHERE c.id = i.customer_id AND i.due_date IS NULL AND NOT i.is_credit_note;

-- -------------------------------------------------------------- approvals

ALTER TABLE approval_requests DROP CONSTRAINT approval_requests_request_type_check;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_request_type_check
  CHECK (request_type IN ('Discount','CreditNote','StopCorrection','SameDayOrder','PaymentChange'));

-- ---------------------------------------------------------- stock counts

ALTER TABLE inventory_audits
  ADD COLUMN counted_cases integer,
  ADD COLUMN counted_loose integer,
  ADD COLUMN counted_by text,
  ADD COLUMN reconciled_by text,
  ADD COLUMN reconciled_at timestamptz;

ALTER TABLE inventory_transactions DROP CONSTRAINT inventory_transactions_reference_type_check;
ALTER TABLE inventory_transactions ADD CONSTRAINT inventory_transactions_reference_type_check
  CHECK (reference_type IN ('PurchaseOrder','ProductionBatch','CustomerOrder','Manual',
    'BottleReturn','BottleWash','Adjustment','Sale'));

-- ----------------------------------------------- bottles off the rounds

-- 5-gallon bottles that went out (or came back) at the counter or on a
-- collected order. Stops keep their own columns; holdings add the two.
CREATE TABLE customer_bottle_moves (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  uuid NOT NULL REFERENCES customers(id),
  moved_on     date NOT NULL DEFAULT business_today(),
  delivered    integer NOT NULL DEFAULT 0 CHECK (delivered >= 0),
  returned     integer NOT NULL DEFAULT 0 CHECK (returned >= 0),
  lost         integer NOT NULL DEFAULT 0 CHECK (lost >= 0),
  order_id     uuid REFERENCES customer_orders(id),
  reference    text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_bottle_moves_customer_idx ON customer_bottle_moves(customer_id, moved_on);

-- --------------------------------------------------- password reset links

ALTER TABLE user_invitations
  ADD COLUMN purpose text NOT NULL DEFAULT 'invite' CHECK (purpose IN ('invite','reset'));

-- ------------------------------------------------- news, lists, messages

CREATE TABLE news_posts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL DEFAULT 'News'
                CHECK (kind IN ('News','Promotion','Closure','Update')),
  title       text NOT NULL,
  body        text NOT NULL DEFAULT '',
  -- Shown on the portal from this day until ends_on (blank = no end).
  starts_on   date NOT NULL DEFAULT business_today(),
  ends_on     date,
  published   boolean NOT NULL DEFAULT true,
  pinned      boolean NOT NULL DEFAULT false,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- A saved group of customers: the rule that picks them (zones, days, type,
-- cycle, price list, owes money...) plus anyone added or left out by hand.
CREATE TABLE customer_lists (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  criteria    jsonb NOT NULL DEFAULT '{}'::jsonb,
  include_ids uuid[] NOT NULL DEFAULT '{}',
  exclude_ids uuid[] NOT NULL DEFAULT '{}',
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE broadcasts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject     text NOT NULL,
  body        text NOT NULL,
  -- Marketing respects the opt-out; Service (closures, blackout days) does not.
  purpose     text NOT NULL DEFAULT 'Marketing' CHECK (purpose IN ('Marketing','Service')),
  list_id     uuid REFERENCES customer_lists(id) ON DELETE SET NULL,
  list_name   text,
  criteria    jsonb,
  news_post_id uuid REFERENCES news_posts(id) ON DELETE SET NULL,
  created_by  uuid REFERENCES users(id),
  created_by_name text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE broadcast_recipients (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id  uuid NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  customer_id   uuid NOT NULL REFERENCES customers(id),
  email         text,
  whatsapp      text,
  -- Queued -> Sent / Failed / Skipped (no email address, opted out).
  status        text NOT NULL DEFAULT 'Queued'
                  CHECK (status IN ('Queued','Sent','Failed','Skipped')),
  error         text,
  sent_at       timestamptz,
  UNIQUE (broadcast_id, customer_id)
);
CREATE INDEX broadcast_recipients_queue_idx ON broadcast_recipients(status) WHERE status = 'Queued';

ALTER TABLE auto_emails DROP CONSTRAINT auto_emails_kind_check;
ALTER TABLE auto_emails ADD CONSTRAINT auto_emails_kind_check
  CHECK (kind IN ('Statement','Reminder','CycleInvoice','OrderPlaced','OrderDelivered'));

INSERT INTO system_settings (key, value) VALUES
  -- Same-day orders placed after this time (Jamaica) wait for the office.
  ('same_day_cutoff', '10:00'),
  -- The business WhatsApp number customers can message, e.g. 18765551234.
  ('whatsapp_number', ''),
  -- Resend's free plan allows 100 emails a day; leave room for invoices.
  ('broadcast_daily_cap', '80'),
  ('order_placed_emails', 'true'),
  ('order_delivered_emails', 'true')
ON CONFLICT (key) DO NOTHING;
