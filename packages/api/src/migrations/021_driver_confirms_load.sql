-- =====================================================================
-- Dual accountability on the truck (Everton, 10 Oct 2026, follow-up to
-- point 4). The OFFICE logs the loading - quantities, extras, who loaded
-- it - and in doing so confirms it was loaded (loaded_by / loaded_by_name).
-- The DRIVER only confirms the totals and starts the route, taking
-- responsibility for what is on the truck. Once the driver has confirmed,
-- the loading is locked.
-- =====================================================================

ALTER TABLE round_loads
  ADD COLUMN driver_confirmed_at   timestamptz,
  ADD COLUMN driver_confirmed_by   uuid REFERENCES users(id),
  ADD COLUMN driver_confirmed_name text;
