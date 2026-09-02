-- =====================================================================
-- When a stock count was taken, so confirming it can tell whether stock
-- moved underneath it.
--
-- A count is the truth: confirming one sets stock to the counted figure
-- outright rather than applying a difference. That is right when the count
-- is confirmed while it is still fresh, and wrong once anything has moved
-- since - a count taken in the morning and confirmed after lunch silently
-- overwrites the deliveries and production that happened in between. The
-- movements keep their own history, but the quantity ends up as though they
-- never occurred.
--
-- The table only ever recorded audit_date, a DATE, which cannot answer
-- "did anything move after this was counted?" for movements on the same
-- day - which is exactly the case that matters. This adds the moment.
--
-- Existing rows are backfilled to the start of their audit date in Jamaica.
-- That errs towards flagging: an old open count looks as though everything
-- that day happened after it, which is the safe direction to be wrong in.
-- =====================================================================

ALTER TABLE inventory_audits
  ADD COLUMN counted_at timestamptz NOT NULL DEFAULT now();

UPDATE inventory_audits
SET counted_at = (audit_date::timestamp AT TIME ZONE 'America/Jamaica')
WHERE counted_at IS NULL OR audit_date < current_date;

-- Finding what moved for one item since a moment is the check's hot path.
CREATE INDEX inventory_transactions_item_time_idx
  ON inventory_transactions (item_type, item_id, txn_date);

COMMENT ON COLUMN inventory_audits.counted_at IS
  'The moment the count was taken. Confirming compares it against the item''s '
  'movements: stock that moved since means the counted figure is already stale.';
