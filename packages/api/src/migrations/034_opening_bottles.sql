-- =====================================================================
-- Opening 5-gallon bottle balances (Everton, 28 Oct 2026): "I now need to
-- update bottles owned by us on the customer accounts."
--
-- At go-live the bottle history started at nothing (Start fresh), so a
-- customer's holding only counted deliveries made in the app. The bottles of
-- ours they already had - worked out from the 2026 delivery sheet, as at Fri
-- 23 Oct 2026 - go in as ONE opening row per customer: a bottle move marked
-- opening, dated the day the count is as at. It counts towards what they hold
-- of ours like a delivery, but is shown as their opening balance, not as a
-- delivery. Entering it again replaces it.
--
-- Bottles the customer owns are not recorded here: the app tracks OUR
-- bottles with customers (bought bottles are theirs and leave the count).
-- =====================================================================

ALTER TABLE customer_bottle_moves ADD COLUMN opening boolean NOT NULL DEFAULT false;
ALTER TABLE customer_bottle_moves ADD COLUMN note text;

CREATE UNIQUE INDEX customer_bottle_moves_one_opening
  ON customer_bottle_moves (customer_id) WHERE opening;
