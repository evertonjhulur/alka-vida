-- =====================================================================
-- Employees, and what their work costs.
--
-- Two purposes, both of them later:
--
--   * PAYROLL. What is owed to each person for a period.
--   * TRUE PRODUCTION COST. Today a case of water costs what its materials
--     cost. The people who made it are not in that figure, so the margin
--     reads better than it is.
--
-- DELIBERATELY NOT WIRED IN YET. Nothing here touches production costing,
-- FIFO, or any figure the business currently relies on - Evert asked for the
-- structure now and the connection later, and a half-connected cost that
-- silently changes what a case appears to cost is worse than no cost at all.
--
-- Two ways of being paid, because that is how the business pays:
--   * Hourly - production and office staff, paid for time.
--   * Per trip - drivers, paid for rounds run.
-- The rate lives on the employee; the entry LOCKS the rate it was paid at, so
-- a rise next year never rewrites what last year cost. That is the same rule
-- order lines follow (invariant 8), and for the same reason.
-- =====================================================================

CREATE TABLE employees (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  job_title     text,
  -- How this person is paid. Adding a third basis later means widening this
  -- CHECK and teaching the entry form one more shape; nothing else.
  pay_basis     text NOT NULL CHECK (pay_basis IN ('Hourly', 'PerTrip')),
  -- Per hour, or per trip, according to pay_basis. Integer cents like every
  -- other money column in the system.
  rate_cents    bigint NOT NULL DEFAULT 0 CHECK (rate_cents >= 0),
  phone         text,
  email         text,
  -- A driver usually also has a login. Optional: a production hand paid
  -- hourly has no reason to sign in to anything.
  user_id       uuid REFERENCES users(id),
  started_on    date,
  -- Set when somebody leaves. They are never deleted: their past work is
  -- part of what production cost, and payroll history has to stay readable.
  ended_on      date,
  active        boolean NOT NULL DEFAULT true,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX employees_active_idx ON employees (active, name);

CREATE TABLE labour_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL REFERENCES employees(id),
  -- The day the work was done, in Jamaica. Not when it was typed in.
  work_date     date NOT NULL,
  basis         text NOT NULL CHECK (basis IN ('Hourly', 'PerTrip')),
  -- Hours worked, or trips run. One column because it is one idea - how much
  -- of the thing this person is paid for - and the basis says which.
  quantity      numeric(10,2) NOT NULL CHECK (quantity > 0),
  -- LOCKED at entry, copied from the employee. A pay rise must never restate
  -- what an earlier week cost.
  rate_cents    bigint NOT NULL CHECK (rate_cents >= 0),
  amount_cents  bigint NOT NULL CHECK (amount_cents >= 0),
  -- What the work was against, when there is something: a delivery sheet for
  -- a driver's trip, a production batch for a shift. Free text for now -
  -- nothing reads it yet, and guessing at a foreign key before the costing
  -- work is designed would be inventing a decision.
  reference     text,
  notes         text,
  recorded_by   uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX labour_entries_employee_idx ON labour_entries (employee_id, work_date DESC);
CREATE INDEX labour_entries_date_idx ON labour_entries (work_date);

COMMENT ON TABLE labour_entries IS
  'Hours worked or trips run, costed at the rate in force on the day. Feeds '
  'payroll now and true production cost later. Nothing in the current costing '
  'reads this table.';

COMMENT ON COLUMN labour_entries.rate_cents IS
  'Copied from the employee at entry and never updated. A pay rise applies to '
  'work done after it, never to work already recorded.';
