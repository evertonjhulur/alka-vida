-- =====================================================================
-- The public website at alkavidaja.com (Everton, 21 Oct 2026).
--
-- "One site": the app serves alkavidaja.com, and the GoDaddy Website
-- Builder pages and the JotForm go. Somebody without an account can still
-- order ("quick order, then account"): what they send is a WEBSITE ORDER,
-- not an order. Nobody is signed in, the price tier, zone and day are the
-- office's to agree, and the person may already be a customer under another
-- spelling - so it waits under Needs a decision. Booking it there creates
-- (or picks) the customer and makes a real order from it in one step.
--
-- The lines are kept as JSON: they are what the person asked for, at the
-- listed prices they saw, and become order lines (priced the normal way)
-- only when booked.
-- =====================================================================

CREATE TABLE website_orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference        text NOT NULL UNIQUE,
  first_name       text NOT NULL,
  last_name        text NOT NULL,
  business_name    text,
  phone            text NOT NULL,
  email            text,
  -- 'Deliver' or 'Collect' (at White Marl).
  fulfilment       text NOT NULL CHECK (fulfilment IN ('Deliver', 'Collect')),
  address_line1    text,
  address_line2    text,
  city             text,
  parish           text,
  -- The weekday they would like ('Mon'..'Sat') or null for "any day".
  preferred_day    text CHECK (preferred_day IN ('Mon','Tue','Wed','Thu','Fri','Sat')),
  pay_method       text NOT NULL CHECK (pay_method IN ('Cash', 'Bank Transfer')),
  -- [{ productId, name, size, qty, unit: 'case'|'bottle', priceCents }]
  lines            jsonb NOT NULL,
  -- "First 5 gallon order, no empty to swap": book with no empties expected,
  -- so the bottle charge is added the usual way.
  no_empties       boolean NOT NULL DEFAULT false,
  -- "Open an account with this order": booking also makes a login and
  -- emails the link to set a password.
  wants_account    boolean NOT NULL DEFAULT false,
  notes            text,
  status           text NOT NULL DEFAULT 'Pending'
                     CHECK (status IN ('Pending', 'Booked', 'Declined')),
  decided_at       timestamptz,
  decided_by       uuid REFERENCES users(id),
  decline_reason   text,
  customer_id      uuid REFERENCES customers(id),
  order_id         uuid REFERENCES customer_orders(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX website_orders_pending_idx ON website_orders (created_at DESC) WHERE status = 'Pending';

CREATE SEQUENCE IF NOT EXISTS website_order_seq;
