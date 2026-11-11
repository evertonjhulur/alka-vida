-- =====================================================================
-- Deleting (or editing) a production run entered wrongly (Everton, 11 Nov
-- 2026: three runs of Fri 6 Nov were entered twice).
--
-- A deleted run is kept in the table, status 'Reversed' with who, when and
-- why, and leaves the Production list; its finished goods come back off
-- stock and the materials (and, for a 5-gallon run, the empties) go back
-- where they came from. The stock ledger keeps the run's rows (relabelled
-- "(deleted)") beside the put-backs.
-- =====================================================================
ALTER TABLE production_batches DROP CONSTRAINT IF EXISTS production_batches_status_check;
ALTER TABLE production_batches ADD CONSTRAINT production_batches_status_check
  CHECK (status IN ('Planned','Completed','Blocked','Reversed'));
ALTER TABLE production_batches
  ADD COLUMN reversed_at     timestamptz,
  ADD COLUMN reversed_by_id  uuid REFERENCES users(id),
  ADD COLUMN reversed_reason text;
