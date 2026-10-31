-- =====================================================================
-- Approximate pins from the typed address (Everton, 31 Oct 2026).
--
-- A stop with no pin cannot be sorted; it just goes last. When address
-- suggestions are switched on (GOOGLE_MAPS_API_KEY), an address with no pin
-- is looked up once with Google's Geocoding API and given a rough pin,
-- marked 'Approximate'. It never replaces a pin someone placed, and the
-- driver's "Save this location" at the gate replaces it.
--
-- geocoded_text keeps the address text that was looked up, so the same
-- address is never asked about twice (found or not); if the address is
-- edited, an approximate pin is worked out again.
-- =====================================================================

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_location_source_check;
ALTER TABLE customers ADD CONSTRAINT customers_location_source_check
  CHECK (location_source IN ('Driver', 'Office', 'Link', 'Customer', 'Approximate'));
ALTER TABLE customer_addresses DROP CONSTRAINT IF EXISTS customer_addresses_location_source_check;
ALTER TABLE customer_addresses ADD CONSTRAINT customer_addresses_location_source_check
  CHECK (location_source IN ('Driver', 'Office', 'Link', 'Customer', 'Approximate'));

ALTER TABLE customers
  ADD COLUMN geocoded_text text,
  ADD COLUMN geocoded_at timestamptz;
ALTER TABLE customer_addresses
  ADD COLUMN geocoded_text text,
  ADD COLUMN geocoded_at timestamptz;
