-- =====================================================================
-- Delivery orders with no round (Everton, 25 Nov 2026): "an order is taken
-- off and not reassigned a round in time ... and then forgotten, so it
-- would be best if an alert is created the moment a delivery order has no
-- round" - a quiet count beside Delivery rounds and on Today that clears
-- itself once the order is on a round.
--
-- The count is worked out live (services/noround.ts). These two columns
-- only remember WHY an order came off its round, so the list can say so:
-- "Taken off the Boulevard round for Tue 24 Nov by Jane", "Its Boulevard
-- round for Tue 24 Nov was deleted". Cleared when it goes on a round again.
-- =====================================================================

ALTER TABLE customer_orders ADD COLUMN off_round_at timestamptz;
ALTER TABLE customer_orders ADD COLUMN off_round_note text;

-- The email log's list of kinds. "ZoneSet" is new: the "Your delivery day
-- is..." email to a customer who signed up "Not sure" of their zone, once
-- the office places them. "DeliveryDay" (an approved delivery day, 15 Oct)
-- and "ConfirmEmail" (sign-up email check, 31 Oct) were never added to this
-- list, so those emails went out but could not be logged, and the code
-- treated them as failed. Found while building this (25 Nov 2026).
ALTER TABLE auto_emails DROP CONSTRAINT auto_emails_kind_check;
ALTER TABLE auto_emails ADD CONSTRAINT auto_emails_kind_check
  CHECK (kind IN ('Statement','Reminder','CycleInvoice','OrderPlaced','OrderDelivered',
                  'OrderCancelled','OrderRescheduled','OrderPartDelivered','AccountApproved',
                  'DeliveryDay','ConfirmEmail','ZoneSet'));
