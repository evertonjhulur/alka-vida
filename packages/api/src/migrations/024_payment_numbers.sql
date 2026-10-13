-- =====================================================================
-- Every payment has a number from the moment it is taken (Everton,
-- 12 Oct 2026: "it would be good to identify payments and it also helps to
-- identify if errors are made").
--
-- Until now a payment got a receipt number (RC-...) only when a receipt was
-- first printed or emailed, on one row of it. Now:
--   * the number is given when the money is recorded, RCT-001000 onwards;
--   * a payment spread over several invoices is several rows here, one per
--     invoice; they share ONE number, so the office sees one payment;
--   * part of a payment later put against an invoice keeps its number;
--   * a reversal carries the number of the payment it reverses.
-- So receipt_number is no longer unique per row: it names the payment.
--
-- Existing payments are numbered here, oldest first. Rows recorded together
-- (the same customer, the same moment: one transaction) are one payment.
-- =====================================================================

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_receipt_number_key;
CREATE INDEX IF NOT EXISTS payments_receipt_number_idx ON payments(receipt_number);

-- The old prefix becomes the new one: RC-001003 -> RCT-001003.
UPDATE payments SET receipt_number = 'RCT-' || substr(receipt_number, 4)
WHERE receipt_number LIKE 'RC-%';

-- Rows recorded with a row that already has a number take that number.
UPDATE payments p SET receipt_number = q.receipt_number
FROM payments q
WHERE p.receipt_number IS NULL AND NOT p.is_reversal
  AND q.receipt_number IS NOT NULL AND NOT q.is_reversal
  AND q.customer_id = p.customer_id AND q.created_at = p.created_at;

-- The rest, one number per (customer, moment recorded), oldest first.
CREATE TEMP TABLE _pay_groups AS
SELECT customer_id, created_at, MIN(payment_date) AS first_paid
FROM payments
WHERE receipt_number IS NULL AND NOT is_reversal
GROUP BY customer_id, created_at;

ALTER TABLE _pay_groups ADD COLUMN n bigint;
UPDATE _pay_groups g SET n = x.n
FROM (SELECT customer_id, created_at,
             row_number() OVER (ORDER BY first_paid, created_at) AS n
      FROM _pay_groups) x
WHERE x.customer_id = g.customer_id AND x.created_at = g.created_at;

UPDATE payments p
SET receipt_number = 'RCT-' || lpad((g.n + (SELECT last_value FROM receipt_number_seq)
                                       + CASE WHEN (SELECT is_called FROM receipt_number_seq) THEN 0 ELSE -1 END)::text, 6, '0')
FROM _pay_groups g
WHERE p.receipt_number IS NULL AND NOT p.is_reversal
  AND p.customer_id = g.customer_id AND p.created_at = g.created_at;

-- Move the sequence past what was just given out.
SELECT setval('receipt_number_seq',
              GREATEST((SELECT last_value FROM receipt_number_seq),
                       COALESCE((SELECT MAX(substr(receipt_number, 5)::bigint) FROM payments
                                 WHERE receipt_number ~ '^RCT-[0-9]+$'), 0)),
              true);

DROP TABLE _pay_groups;

-- A reversal carries the number of the payment it reverses.
UPDATE payments r SET receipt_number = o.receipt_number
FROM payments o
WHERE r.is_reversal AND r.reverses_payment_id = o.id AND r.receipt_number IS NULL;
