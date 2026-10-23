-- =====================================================================
-- Customers drop their own pin when they open an account (Everton,
-- 23 Oct 2026: "make the save pin a part of the account opening process").
--
-- On the "Open an account" form and the website's quick order, the person
-- can use their phone's location or click the map. The pin travels with the
-- request and lands on the customer when the office approves or books it,
-- marked 'Customer' so it can be told from the driver's. On the first
-- delivery the driver is asked to save the exact spot at the gate, which
-- replaces it.
-- =====================================================================

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_location_source_check;
ALTER TABLE customers ADD CONSTRAINT customers_location_source_check
  CHECK (location_source IN ('Driver', 'Office', 'Link', 'Customer'));
ALTER TABLE customer_addresses DROP CONSTRAINT IF EXISTS customer_addresses_location_source_check;
ALTER TABLE customer_addresses ADD CONSTRAINT customer_addresses_location_source_check
  CHECK (location_source IN ('Driver', 'Office', 'Link', 'Customer'));

ALTER TABLE customer_applications
  ADD COLUMN lat double precision,
  ADD COLUMN lng double precision,
  ADD COLUMN location_accuracy_m integer;

ALTER TABLE website_orders
  ADD COLUMN lat double precision,
  ADD COLUMN lng double precision,
  ADD COLUMN location_accuracy_m integer;
