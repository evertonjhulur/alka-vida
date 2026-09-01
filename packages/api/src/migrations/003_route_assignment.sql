-- =====================================================================
-- Working a route: who has it, and when they started.
--
-- WHY started_at RATHER THAN A THIRD STATUS
--   delivery_sheets.status is deliberately only ('Open','Completed'),
--   because the "one open sheet per zone per day" rule is enforced by a
--   PARTIAL unique index over status = 'Open'. An 'In Progress' status
--   would fall outside that index, so an order placed while the driver is
--   out would open a SECOND sheet for the same zone and day and split the
--   route in half. A sheet being worked stays Open; a late order joins the
--   round the driver is already on, which is what the office wants anyway.
-- =====================================================================

ALTER TABLE delivery_sheets ADD COLUMN started_at timestamptz;

COMMENT ON COLUMN delivery_sheets.started_at IS
  'Set when a driver starts the route. Null means it has not been picked up yet.';
