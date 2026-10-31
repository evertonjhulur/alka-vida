-- =====================================================================
-- Customers open their own accounts (Everton, 31 Oct 2026): "the approval
-- step is adding a layer of cumbersome for only a few customers ... allow
-- customers to create accounts all the way through". With Google too.
--
-- A sign-up makes the customer and their login at once: Retail prices for a
-- home, Corporate for a business, cash on delivery, the zone they picked.
-- The office looks at each new one afterwards under Needs a decision
-- (signup_reviewed_at) and changes whatever needs changing.
-- =====================================================================

ALTER TABLE customers ADD COLUMN signed_up_at timestamptz;
ALTER TABLE customers ADD COLUMN signup_method text CHECK (signup_method IN ('Google', 'Email'));
ALTER TABLE customers ADD COLUMN signup_reviewed_at timestamptz;
ALTER TABLE customers ADD COLUMN signup_reviewed_by uuid REFERENCES users(id);
-- Customers already on file with the same phone (not the same email - that
-- one is refused): the office decides whether it is the same customer.
ALTER TABLE customers ADD COLUMN possible_duplicates uuid[] NOT NULL DEFAULT '{}';

CREATE INDEX customers_signups_to_review ON customers (signed_up_at)
  WHERE signed_up_at IS NOT NULL AND signup_reviewed_at IS NULL;

-- Google sign-in: the Google account's own id, so a changed email at Google
-- still finds the same login.
ALTER TABLE users ADD COLUMN google_sub text;
CREATE UNIQUE INDEX users_google_sub ON users (google_sub) WHERE google_sub IS NOT NULL;

-- Confirming the email of an email-and-password sign-up. Google has already
-- confirmed its addresses. The account works either way.
ALTER TABLE users ADD COLUMN email_confirmed_at timestamptz;
ALTER TABLE users ADD COLUMN email_confirm_hash text;
