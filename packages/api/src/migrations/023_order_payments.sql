-- =====================================================================
-- Payment taken on the New order screen (Everton, 11 Oct 2026).
--
-- Money taken with an order before it is delivered sits on the customer's
-- account (an unattached payment, as any other) and goes against that
-- order's invoice the moment it is raised. payments.order_id remembers which
-- order the money came in with, so it is used for that order first; it is a
-- reference only and changes nothing about how a payment counts.
--
-- customer_orders.pay_when records what the office agreed for payment:
--   'Now'          - taken on the screen when the order was entered
--   'On delivery'  - the driver collects at the door
--   'On account'   - nothing now; it falls due on the customer's terms
-- NULL for orders entered before this (and the portal).
-- =====================================================================

ALTER TABLE payments ADD COLUMN order_id uuid REFERENCES customer_orders(id);
CREATE INDEX payments_order_idx ON payments(order_id) WHERE order_id IS NOT NULL;

ALTER TABLE customer_orders ADD COLUMN pay_when text
  CHECK (pay_when IN ('Now', 'On delivery', 'On account'));
