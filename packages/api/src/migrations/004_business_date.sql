-- =====================================================================
-- "Today" means today in Jamaica, not today in UTC.
--
-- THE BUG THIS FIXES
--   Every business date was stamped with current_date, which Postgres
--   evaluates in the SERVER's timezone - UTC. Jamaica is UTC-5 and does not
--   observe daylight saving, so from 7pm local until midnight, current_date
--   is already TOMORROW.
--
--   For five hours of every single day - exactly the hours when a route
--   settles and the counter cashes up - every invoice, order and quotation
--   was dated a day into the future. That mis-sorts a customer statement
--   (proved by a failing test), throws off any date-range bill, and hands
--   the customer a document dated tomorrow.
--
--   The statement itself was already careful: it renders payment timestamps
--   in the business timezone (ledger.ts). It was the DATE columns that were
--   wrong, so the two disagreed with each other for five hours a day.
--
-- The timezone lives in system_settings so there is one answer, shared by
-- the database and the application, rather than a constant compiled into
-- each of them separately.
-- =====================================================================

INSERT INTO system_settings (key, value)
VALUES ('business_timezone', 'America/Jamaica')
ON CONFLICT (key) DO NOTHING;

CREATE FUNCTION business_today() RETURNS date AS $$
  SELECT (now() AT TIME ZONE COALESCE(
    (SELECT value FROM system_settings WHERE key = 'business_timezone'),
    'America/Jamaica'
  ))::date;
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION business_today() IS
  'The current date in the business timezone. Use this for every business '
  'date; current_date is UTC and runs a day ahead every evening.';

ALTER TABLE purchase_orders   ALTER COLUMN order_date   SET DEFAULT business_today();
ALTER TABLE production_batches ALTER COLUMN batch_date  SET DEFAULT business_today();
ALTER TABLE inventory_audits  ALTER COLUMN audit_date   SET DEFAULT business_today();
ALTER TABLE quotations        ALTER COLUMN quote_date   SET DEFAULT business_today();
ALTER TABLE customer_orders   ALTER COLUMN order_date   SET DEFAULT business_today();
ALTER TABLE invoices          ALTER COLUMN invoice_date SET DEFAULT business_today();
