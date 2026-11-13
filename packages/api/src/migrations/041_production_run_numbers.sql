-- =====================================================================
-- Production run numbers (Everton, 13 Nov 2026: the production report
-- shows each run's number and who entered it).
--
-- Runs had no number a person could quote, only an internal id. Existing
-- runs are numbered in the order they were entered (deleted ones included,
-- so a number is never reused); new runs take the next number. Shown as
-- PR-0001.
-- =====================================================================
CREATE SEQUENCE IF NOT EXISTS production_run_number_seq START 1;

ALTER TABLE production_batches ADD COLUMN run_number integer;

UPDATE production_batches pb SET run_number = x.n
FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM production_batches) x
WHERE x.id = pb.id;

SELECT setval('production_run_number_seq',
              COALESCE((SELECT max(run_number) FROM production_batches), 0) + 1, false);

ALTER TABLE production_batches
  ALTER COLUMN run_number SET DEFAULT nextval('production_run_number_seq');

CREATE UNIQUE INDEX IF NOT EXISTS production_batches_run_number_idx ON production_batches(run_number);

-- ---------------------------------------------------------------------
-- The batch number printed on the goods (Everton, 13 Nov 2026). All the
-- Alka Vida cased goods made in one production session share one batch
-- number; the other brands have their own. Required for cased goods from
-- now on; earlier runs stay blank.
-- ---------------------------------------------------------------------
ALTER TABLE production_batches ADD COLUMN batch_code text;
CREATE INDEX IF NOT EXISTS production_batches_batch_code_idx ON production_batches(batch_code);
