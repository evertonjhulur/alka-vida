-- =====================================================================
-- business_date(ts): the calendar date a moment in time falls on, HERE.
--
-- Migration 004 fixed every date COLUMN. It did not fix the several places
-- that take a timestamptz - a payment, a stock movement, a received batch,
-- an approval request - and render it as a date. Those still resolved in
-- UTC, so from 7pm Jamaica time each of them displayed tomorrow. A payment
-- taken at half past seven in the evening was listed under the next day.
--
-- Threading a timezone parameter through every one of those queries invites
-- exactly the same omission again, so the conversion becomes a function that
-- reads the same setting business_today() does. New queries get it right by
-- default rather than by remembering.
-- =====================================================================

CREATE FUNCTION business_date(ts timestamptz) RETURNS date AS $$
  SELECT (ts AT TIME ZONE COALESCE(
    (SELECT value FROM system_settings WHERE key = 'business_timezone'),
    'America/Jamaica'
  ))::date;
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION business_date(timestamptz) IS
  'The business-local calendar date of a timestamp. Use this whenever a '
  'timestamptz is shown to someone as a date; a bare ::date cast is UTC.';
