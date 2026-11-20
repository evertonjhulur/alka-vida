-- Discounts from office staff need an administrator's approval (Everton,
-- 19 Nov 2026). Until now only a discount added to an invoice already raised
-- went for approval; one put on the ORDER went straight onto its invoice.
--
-- An order's discount is 'Approved' (an admin set it, or it was approved),
-- 'Pending' (waiting under Needs a decision) or 'Rejected' (turned down: the
-- discount is taken off the order). Everything already on file counts as
-- approved, so standing arrangements such as FOC customers carry on.
ALTER TABLE customer_orders
  ADD COLUMN IF NOT EXISTS discount_status text NOT NULL DEFAULT 'Approved'
    CHECK (discount_status IN ('Approved','Pending','Rejected'));
