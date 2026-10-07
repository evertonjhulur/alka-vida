-- =====================================================================
-- Everton's round of 7 Oct 2026 (14 points: portal, emails, office,
-- purchasing). His rulings are final; HANDOFF.md has the detail.
--
--   * Customers: two more email ticks ("Order cancelled", "Service
--     announcements"), an unguessable token for the unsubscribe link in
--     every non-essential email (works without signing in), and a walk-in
--     flag so the counter can insist a walk-in pays in full.
--   * News & offers: pictures, uploaded from the office, stored in the
--     database (Railway's disk does not survive a redeploy).
--   * Stops: "Payment only" (the driver took money and delivered nothing),
--     and a partial delivery remembers the day the rest goes.
--   * Orders: how many 5-gallon empties the customer will hand over.
--   * Products: one product is the 5-gallon BOTTLE itself ($1,200 to start,
--     changed on the Products screen like any price), charged when a
--     customer hands over fewer empties than the full bottles they take.
--   * Bottle moves: bottles a customer has bought are theirs, so they come
--     off what they hold of ours.
--   * Purchase orders: "Partially Received - Closed". Closing a PO with goods
--     received against it used to set it Cancelled, which is wrong.
--   * Emails: the contact address in every email, and two more kinds in the
--     automatic-email log.
-- =====================================================================

-- ------------------------------------------------------------ customers

ALTER TABLE customers
  ADD COLUMN cancel_emails  boolean NOT NULL DEFAULT true,
  ADD COLUMN service_emails boolean NOT NULL DEFAULT true,
  -- Identifies the customer in an unsubscribe link. Not a password: it can
  -- only switch emails off, and the page says which customer it is.
  ADD COLUMN email_token    uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN is_walk_in     boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX customers_email_token_idx ON customers(email_token);

-- The shared cash walk-in record (seeded as "Cash Walk-In").
UPDATE customers SET is_walk_in = true
 WHERE lower(regexp_replace(name, '[^a-zA-Z]', '', 'g')) IN ('cashwalkin', 'walkin', 'walkincustomer');

-- ---------------------------------------------------------- news images

CREATE TABLE news_images (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL between upload and the post being saved.
  post_id      uuid REFERENCES news_posts(id) ON DELETE CASCADE,
  position     integer NOT NULL DEFAULT 0,
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp','image/gif')),
  data         bytea NOT NULL,
  bytes        integer NOT NULL,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX news_images_post_idx ON news_images(post_id, position);

-- ----------------------------------------------------------------- stops

ALTER TABLE delivery_stops DROP CONSTRAINT delivery_stops_stop_outcome_check;
ALTER TABLE delivery_stops ADD CONSTRAINT delivery_stops_stop_outcome_check
  CHECK (stop_outcome IN ('Pending','Delivered','Customer Not Home',
                          'Refused','Rescheduled','Other','Payment Only'));

ALTER TABLE delivery_stops
  -- Part delivered: the day the rest goes (it is on that day's round).
  ADD COLUMN remainder_to date,
  -- A stop the driver added to take a payment, with no order behind it.
  ADD COLUMN payment_only boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------- orders

ALTER TABLE customer_orders
  -- 5-gallon empties the customer says they will hand over. NULL = not asked
  -- (older orders, standing orders raised before this round).
  ADD COLUMN empties_expected integer CHECK (empties_expected >= 0);

-- -------------------------------------------------- the 5-gallon bottle

ALTER TABLE products
  ADD COLUMN is_bottle_charge boolean NOT NULL DEFAULT false;

-- The product itself ("5-gallon bottle", $1,200) is created when the app
-- starts (orders.bottleChargeProduct), so a fresh install and this one get it
-- the same way. From then on its price is the Products screen's to change.

ALTER TABLE customer_bottle_moves
  -- Bottles the customer bought: theirs now, so no longer ours on loan.
  ADD COLUMN sold integer NOT NULL DEFAULT 0 CHECK (sold >= 0);

ALTER TABLE five_gal_bottle_pool
  ADD COLUMN sold integer NOT NULL DEFAULT 0;

-- ------------------------------------------------------- purchase orders

ALTER TABLE purchase_orders DROP CONSTRAINT purchase_orders_status_check;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_status_check
  CHECK (status IN ('Draft','Sent','Partially Received','Received',
                    'Partially Received - Closed','Cancelled'));

-- The bug: "Close it (nothing more coming)" set Cancelled even with goods
-- received. Those are partially received and closed.
UPDATE purchase_orders po SET status = 'Partially Received - Closed'
 WHERE po.status = 'Cancelled'
   AND EXISTS (SELECT 1 FROM po_line_items l WHERE l.po_id = po.id AND l.quantity_received > 0);

-- ---------------------------------------------------------------- emails

ALTER TABLE auto_emails DROP CONSTRAINT auto_emails_kind_check;
ALTER TABLE auto_emails ADD CONSTRAINT auto_emails_kind_check
  CHECK (kind IN ('Statement','Reminder','CycleInvoice','OrderPlaced','OrderDelivered',
                  'OrderCancelled','OrderRescheduled','OrderPartDelivered','AccountApproved'));

INSERT INTO system_settings (key, value) VALUES
  ('contact_email', 'orders@alkavidaja.com')
ON CONFLICT (key) DO NOTHING;

-- The correct domain is alkavidaja.com. Anything typed with the old
-- misspelling (alkavidja.com) in a setting is put right.
UPDATE system_settings SET value = replace(value, 'alkavidja.com', 'alkavidaja.com')
 WHERE value LIKE '%alkavidja.com%';
UPDATE news_posts SET body = replace(body, 'alkavidja.com', 'alkavidaja.com')
 WHERE body LIKE '%alkavidja.com%';
