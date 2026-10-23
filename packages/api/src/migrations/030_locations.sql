-- =====================================================================
-- Map pins for delivery addresses, so a round's stops can be put in a
-- sensible order (Everton, 23 Oct 2026: "a process of sorting the stops on
-- the route for the driver optimally").
--
-- A street address in Jamaica often does not lead a map to the gate, so the
-- pin that counts is the one the DRIVER saves standing at the customer's
-- door (phone GPS). The office can also place one, or paste a Google Maps
-- link. Where the pin came from and how accurate it was are kept, so a rough
-- one can be told from a good one.
--
-- The main address lives on customers, extra delivery addresses on
-- customer_addresses; each has its own pin. The plant (where rounds start
-- and finish) is a setting: plant_lat / plant_lng.
-- =====================================================================

ALTER TABLE customers
  ADD COLUMN lat double precision,
  ADD COLUMN lng double precision,
  ADD COLUMN location_accuracy_m integer,
  ADD COLUMN location_source text CHECK (location_source IN ('Driver', 'Office', 'Link')),
  ADD COLUMN location_set_at timestamptz,
  ADD COLUMN location_set_by text;

ALTER TABLE customer_addresses
  ADD COLUMN lat double precision,
  ADD COLUMN lng double precision,
  ADD COLUMN location_accuracy_m integer,
  ADD COLUMN location_source text CHECK (location_source IN ('Driver', 'Office', 'Link')),
  ADD COLUMN location_set_at timestamptz,
  ADD COLUMN location_set_by text;
