-- =====================================================================
-- Adjusting a customer's 5-gallon bottle balance (Everton, 20 Nov 2026):
-- "Can I see the bottle movement per client under their bottle details?
-- also ability to edit their bottle balance if needs be?"
--
-- An adjustment is one row in customer_bottle_moves with `adjusted` set to
-- the difference (+ or -) between what was on record and what the customer
-- actually has. It counts towards what they hold of ours, and nothing else:
-- it is not a delivery, a return, a loss or a sale, and it does not move the
-- empties at the plant (those are counted on Stock > Count).
-- Administrators only, with a reason; every change is in the audit log.
-- =====================================================================

ALTER TABLE customer_bottle_moves ADD COLUMN adjusted integer NOT NULL DEFAULT 0;
ALTER TABLE customer_bottle_moves ADD COLUMN created_by uuid REFERENCES users(id);
