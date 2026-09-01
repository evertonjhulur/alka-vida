-- =====================================================================
-- The invoice ledger carries the customer's NAME, and stops calling an
-- invoice overdue a day early.
--
-- TWO FIXES IN ONE VIEW
--
-- 1. The view exposed customer_id but never the name, so the invoice list
--    had nothing to put in a customer column and simply omitted it. Anyone
--    looking at a list of invoice numbers could not tell whose they were.
--
-- 2. The Overdue rule still compared against current_date - UTC - which
--    migration 004 fixed for every date COLUMN but not inside this view.
--    Jamaica is UTC-5, so from 7pm local until midnight an invoice due
--    today already read Overdue, and any ageing built on this status would
--    have inherited the same one-day error.
-- =====================================================================

CREATE OR REPLACE VIEW invoice_ledger AS
SELECT
  i.id                AS invoice_id,
  i.customer_id,
  i.invoice_number,
  i.invoice_date,
  i.due_date,
  i.grand_total_cents,
  i.is_credit_note,
  i.lifecycle,
  COALESCE(p.paid_cents, 0) AS amount_paid_cents,
  i.grand_total_cents - COALESCE(p.paid_cents, 0) AS balance_cents,
  CASE
    WHEN i.lifecycle = 'Cancelled' THEN 'Cancelled'
    WHEN i.is_credit_note          THEN 'Credit Note'
    -- Exact match or overpaid both read as Paid. Any excess exists only as a
    -- separate unattached Payment; it is never labelled on the invoice.
    WHEN COALESCE(p.paid_cents, 0) >= i.grand_total_cents THEN 'Paid'
    WHEN COALESCE(p.paid_cents, 0) > 0 THEN 'Partial'
    -- business_today(), not current_date: see the note above.
    WHEN i.due_date IS NOT NULL AND i.due_date < business_today() THEN 'Overdue'
    WHEN i.lifecycle = 'Sent' THEN 'Sent'
    ELSE 'Open'
  END AS status,
  -- Added at the END so this can be a REPLACE rather than a drop and rebuild:
  -- dropping the view would take the customer_balances view with it.
  c.name AS customer_name
FROM invoices i
JOIN customers c ON c.id = i.customer_id
LEFT JOIN (
  SELECT invoice_id, SUM(amount_cents) AS paid_cents
  FROM payments
  WHERE status = 'Confirmed' AND invoice_id IS NOT NULL
  GROUP BY invoice_id
) p ON p.invoice_id = i.id;
