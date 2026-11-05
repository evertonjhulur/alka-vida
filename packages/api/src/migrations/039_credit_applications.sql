-- =====================================================================
-- Applying a credit note to an invoice (Everton, 4 Nov 2026).
--
-- A credit note is a negative invoice. It lowered the customer's balance,
-- but nothing ever closed the invoice it was for: Treasure Isle read
-- "J$0.00 open balance" and "J$530.00 overdue" at the same time, and the
-- overdue invoices stayed on reminders, the age analysis and Money owed.
--
-- A credit_application says "this much of credit note X settles invoice
-- Y". It is not money: no payment is created and the customer's balance
-- (customer_balances, the statement) does not move. Only the two documents'
-- own balances do - the invoice's goes down, the credit note's unused part
-- goes down by the same amount.
--
-- invoice_ledger.amount_paid_cents therefore becomes "settled": Confirmed
-- payments plus credit applied to the invoice. For a credit note it is
-- minus what has been applied FROM it, so its balance_cents is the credit
-- still unused (negative, or 0 once all used). The columns, their order and
-- their types are unchanged, so this stays a CREATE OR REPLACE.
-- =====================================================================

CREATE TABLE credit_applications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_note_id  uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  invoice_id      uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  created_by_id   uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (credit_note_id <> invoice_id)
);
CREATE INDEX credit_applications_credit_note ON credit_applications (credit_note_id);
CREATE INDEX credit_applications_invoice ON credit_applications (invoice_id);

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
    WHEN COALESCE(p.paid_cents, 0) >= i.grand_total_cents THEN 'Paid'
    WHEN COALESCE(p.paid_cents, 0) > 0 THEN 'Partial'
    WHEN i.due_date IS NOT NULL AND i.due_date < business_today() THEN 'Overdue'
    WHEN i.lifecycle = 'Sent' THEN 'Sent'
    ELSE 'Open'
  END AS status,
  c.name AS customer_name
FROM invoices i
JOIN customers c ON c.id = i.customer_id
LEFT JOIN (
  SELECT invoice_id, SUM(amount_cents) AS paid_cents
  FROM (
    SELECT invoice_id, amount_cents
    FROM payments
    WHERE status = 'Confirmed' AND invoice_id IS NOT NULL
    UNION ALL
    -- Credit applied TO an invoice settles it like a payment would ...
    SELECT a.invoice_id, a.amount_cents
    FROM credit_applications a
    JOIN invoices cn ON cn.id = a.credit_note_id AND cn.lifecycle <> 'Cancelled'
    JOIN invoices inv ON inv.id = a.invoice_id AND inv.lifecycle <> 'Cancelled'
    UNION ALL
    -- ... and uses up that much of the credit note.
    SELECT a.credit_note_id, -a.amount_cents
    FROM credit_applications a
    JOIN invoices cn ON cn.id = a.credit_note_id AND cn.lifecycle <> 'Cancelled'
    JOIN invoices inv ON inv.id = a.invoice_id AND inv.lifecycle <> 'Cancelled'
  ) settled
  GROUP BY invoice_id
) p ON p.invoice_id = i.id;

-- Credit notes already raised AGAINST an invoice are applied to it now, as
-- new ones will be: oldest credit note first, never more than the invoice
-- still owed after its payments and the credit notes before it.
INSERT INTO credit_applications (credit_note_id, invoice_id, amount_cents, created_at)
SELECT id, inv, LEAST(amt, owed - before), now()
FROM (
  SELECT cn.id, cn.linked_invoice_id AS inv, -cn.grand_total_cents AS amt,
         o.owed,
         COALESCE(SUM(-cn.grand_total_cents) OVER (
           PARTITION BY cn.linked_invoice_id ORDER BY cn.created_at, cn.id
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS before
  FROM invoices cn
  JOIN (
    SELECT i.id, i.customer_id,
           i.grand_total_cents - COALESCE((SELECT SUM(p.amount_cents) FROM payments p
                                           WHERE p.invoice_id = i.id AND p.status = 'Confirmed'), 0) AS owed
    FROM invoices i
    WHERE NOT i.is_credit_note AND i.lifecycle <> 'Cancelled'
  ) o ON o.id = cn.linked_invoice_id AND o.customer_id = cn.customer_id
  WHERE cn.is_credit_note AND cn.credit_status = 'Approved' AND cn.lifecycle <> 'Cancelled'
    AND cn.grand_total_cents < 0
) x
WHERE owed - before > 0;
