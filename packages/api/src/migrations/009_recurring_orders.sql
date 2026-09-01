-- =====================================================================
-- Standing orders: pausing, ending, and never raising the same one twice.
--
-- The columns for recurrence have existed since 001 but nothing ever wrote
-- next_delivery_date or created the following occurrence, so a standing
-- weekly customer had to be re-entered by hand every week.
--
-- The shape:
--   * The FIRST order of a series is the schedule itself. It carries
--     is_recurring, recurrence_pattern and next_delivery_date, and has no
--     parent_recurring_id.
--   * Every later occurrence is an ordinary one-off order pointing back at
--     that schedule through parent_recurring_id.
--
-- So a delivery is always just a delivery. Nothing about invoicing,
-- settlement or the ledger has to know a series exists, which is what keeps
-- "every delivery gets its own invoice at the moment of delivery" true for
-- standing customers without a special case anywhere.
-- =====================================================================

ALTER TABLE customer_orders
  -- Paused keeps the series and its history but stops it producing work.
  -- Deleting or cancelling the schedule would lose the arrangement itself.
  ADD COLUMN recurrence_paused boolean NOT NULL DEFAULT false,
  -- An agreed finish, for a contract with an end date. NULL runs indefinitely.
  ADD COLUMN recurrence_ends_on date,
  -- Diagnostics: when the generator last looked at this schedule, and what it
  -- did. Without these a schedule that quietly stops producing orders is very
  -- hard to explain to the person asking why their customer got no water.
  ADD COLUMN recurrence_last_run_at timestamptz,
  ADD COLUMN recurrence_last_note text;

-- THE IDEMPOTENCY BACKBONE.
--
-- The generator may run on startup, on a timer, and from a button, possibly
-- at the same moment. This index is what makes running it twice harmless:
-- a series can hold at most one order per delivery date, enforced by the
-- database rather than by remembering to check first.
CREATE UNIQUE INDEX customer_orders_one_occurrence_per_date_idx
  ON customer_orders (parent_recurring_id, requested_delivery_date)
  WHERE parent_recurring_id IS NOT NULL;

-- Finding schedules with work due is the generator's hot path.
CREATE INDEX customer_orders_due_schedules_idx
  ON customer_orders (next_delivery_date)
  WHERE is_recurring AND NOT recurrence_paused AND parent_recurring_id IS NULL;

COMMENT ON COLUMN customer_orders.next_delivery_date IS
  'On a schedule (is_recurring, no parent): the date of the NEXT occurrence '
  'still to be raised. Advanced by the generator as occurrences are created.';
