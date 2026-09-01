-- =====================================================================
-- Counter sale becomes its own fulfilment type, distinct from pickup.
--
-- The two were conflated: choosing "Pickup" ran the counter-sale path, which
-- raises the invoice and takes the payment on the spot. So a customer who
-- ordered ahead to collect on Friday could not be recorded at all - the sale
-- was billed and paid the moment it was typed.
--
-- They are now genuinely different:
--   Counter - a walk-in. Order, invoice and payment in one motion.
--   Pickup  - a real order, invoiced when the customer actually COLLECTS it.
--             The same rule as delivery, at the plant instead of in a van.
--
-- Backfill: every existing Pickup order that already carries an invoice went
-- through the counter-sale path, so that is what it was. Any Pickup order
-- with no invoice is left alone - it is a genuine order awaiting collection.
-- =====================================================================

ALTER TABLE customer_orders DROP CONSTRAINT customer_orders_delivery_mode_check;

ALTER TABLE customer_orders ADD CONSTRAINT customer_orders_delivery_mode_check
  CHECK (delivery_mode IN ('Delivery','Pickup','Counter'));

UPDATE customer_orders o
   SET delivery_mode = 'Counter'
 WHERE o.delivery_mode = 'Pickup'
   AND EXISTS (SELECT 1 FROM invoice_orders io WHERE io.order_id = o.id);
