-- =====================================================================
-- Deliveries recorded on a later day (Everton, 23 Oct 2026): "we need to be
-- able to enter invoices for prior days". A sale or delivery that went out
-- but was never entered is recorded with the day it really happened: the
-- order, the invoice, its due date and any payment taken are dated that day.
--
-- Office staff may go back up to backdate_days days (3 for now; he plans to
-- bring it down to 1); administrators may enter any date.
--
-- recorded_late marks the order: it never goes on a delivery round (the
-- round has been and gone), and for customers invoiced weekly or monthly it
-- waits for the invoice of the week or month it was delivered in.
-- =====================================================================

ALTER TABLE customer_orders ADD COLUMN recorded_late boolean NOT NULL DEFAULT false;

INSERT INTO system_settings (key, value) VALUES ('backdate_days', '3')
ON CONFLICT (key) DO NOTHING;
