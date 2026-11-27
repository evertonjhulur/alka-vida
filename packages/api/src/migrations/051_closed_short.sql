-- =====================================================================
-- Delivered short, nothing more to come (Everton, 27 Nov 2026: Imperial
-- Optical's order was delivered short on today's round, and instead of being
-- closed it is asking for another round).
--
-- The driver's "Delivered (they took less, nothing more to come)" left the
-- order Partially Delivered, so it waited for a round for the rest. Now such
-- an order is closed short: it reads Delivered, what was handed over is what
-- is invoiced, and the rest never goes on a round. The office can also close
-- an order short from Orders, or when correcting a stop at settlement.
-- =====================================================================

ALTER TABLE customer_orders
  ADD COLUMN closed_short_at timestamptz,
  ADD COLUMN closed_short_note text;
