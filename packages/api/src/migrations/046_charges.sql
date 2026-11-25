-- =====================================================================
-- Charges and services as products (Everton, 25 Nov 2026):
-- "In the creation of products, its all tied to bottles at the moment. So
-- if we only want to charge for packaging because arrangements changed we
-- are unable to do this."
--
-- The example is BML's coolant: BML makes the raw material, Alka Vida gives
-- the labour and the case packaging, and the invoice carries a packaging
-- charge only. Other charges (a delivery fee and the like) work the same way.
--
-- A charge is a product with `is_charge` set. It is priced per unit (its
-- `charge_unit`: case, delivery, each...), with price lists and special
-- prices like any product, and GCT as normal. It is never stock: it is not
-- made on Production, counted, loaded on a truck or handed over as goods,
-- and nothing of ours comes off the shelf when it is sold. A charge on a
-- client's brand is seen only by that client; one on our brand by anyone.
-- The office adds charges; they are kept off the portal and the website.
--
-- Numbered 046: 045 is the complimentary-water update of 24 Nov 2026.
-- =====================================================================

ALTER TABLE products ADD COLUMN is_charge boolean NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN charge_unit text;

-- A charge is counted in whole units, never cases of bottles, and is not
-- a returnable bottle.
ALTER TABLE products ADD CONSTRAINT products_charge_shape CHECK (
  NOT is_charge OR (bottles_per_case = 0 AND NOT is_returnable AND NOT is_bottle_charge)
);
