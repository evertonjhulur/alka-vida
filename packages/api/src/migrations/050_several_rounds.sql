-- =====================================================================
-- Several rounds a day (Everton, 27 Nov 2026). His rulings:
--   * The office can make a round by hand (day, zone, driver, vehicle,
--     optional name) - more than one for the same zone on the same day,
--     for different drivers.
--   * New orders follow the FIRST round for their zone and day that has
--     not started. Once every one of them has started, the order waits under
--     Deliveries with no round for the office to place it.
--   * A round may carry stops from other zones once they are moved onto it
--     by hand; automatic placement stays by zone.
--   * Stops can be moved between rounds, even after the round has started,
--     with the driver then re-sorting the stops left to do. The reason for
--     a move is optional.
--   * Rounds can be merged.
-- =====================================================================

-- One open round per zone per day is no longer the rule.
DROP INDEX IF EXISTS delivery_sheets_open_zone_date_idx;
CREATE INDEX IF NOT EXISTS delivery_sheets_zone_date_idx ON delivery_sheets (delivery_date, zone);

ALTER TABLE delivery_sheets
  -- "Portmore 2": optional; shown instead of the zone when set.
  ADD COLUMN name text,
  -- Who made it by hand (NULL = made by the app for an order).
  ADD COLUMN created_by_name text,
  -- A stop was moved onto this round after it started: the driver sorts the
  -- stops still to do (cleared when they do).
  ADD COLUMN resort_needed_at timestamptz,
  ADD COLUMN resort_note text;
