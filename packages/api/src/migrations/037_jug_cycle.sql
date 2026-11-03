-- The 5-gallon jug cycle as the plant runs it (Everton, 29 Oct and 3 Nov 2026).
--
--   empties at the plant ─production (wash + fill)─▶ full, in stock
--        ▲                                               │ delivered / collected
--        └──────────── empties back ◀── out with customers
--
-- There are no clean empty jugs: once washed, a jug is filled. Empties are
-- returns plus new jugs bought (on a PO or by hand), and every 5-gallon run
-- draws on them. Lost or scrapped jugs are a business loss.
--
-- Each figure has ONE home, so the Bottle pool screen and Stock can never
-- disagree:
--   empties at the plant = the raw material ticked as the returnable jug
--                          ("5 Gal (19L) Bottle")
--   full, in stock       = finished goods of the returnable products
--   out with customers   = the customer accounts (our bottles on loan)
--   lost or scrapped     = the customer accounts' losses + jugs scrapped
-- The old pool boxes (clean / with customer / awaiting wash) are no longer
-- read or written; the table stays only so old history still resolves.
--
-- Cost (3 Nov 2026 ruling): a jug's price is recorded once, on its purchase.
-- Filling it adds no jug cost to the water, and the empties move as a count
-- only - so the jug material keeps no open FIFO layers.

ALTER TABLE raw_materials
  ADD COLUMN is_returnable_jug boolean NOT NULL DEFAULT false;

-- Only one material can be the jug.
CREATE UNIQUE INDEX raw_materials_one_jug ON raw_materials (is_returnable_jug)
  WHERE is_returnable_jug;

-- The live app's jug: "5 Gal (19L) Bottle". Ticked by name if there is
-- exactly one live match; otherwise left for an administrator to tick.
UPDATE raw_materials SET is_returnable_jug = true
 WHERE id = (SELECT id FROM raw_materials
              WHERE retired_at IS NULL
                AND lower(name) LIKE '5 gal%bottle%')
   AND (SELECT COUNT(*) FROM raw_materials
         WHERE retired_at IS NULL AND lower(name) LIKE '5 gal%bottle%') = 1;

-- The jug is costed on purchase only: close its open layers. The count it
-- carries (quantity_on_hand) is untouched - that is the 3 Nov count.
UPDATE material_batches SET quantity_remaining = 0, status = 'Consumed'
 WHERE raw_material_id IN (SELECT id FROM raw_materials WHERE is_returnable_jug)
   AND status = 'Open';

-- Jugs found unusable on a production run.
ALTER TABLE production_batches
  ADD COLUMN jugs_scrapped integer NOT NULL DEFAULT 0 CHECK (jugs_scrapped >= 0);

-- New movement kinds on the stock ledger.
ALTER TABLE inventory_transactions DROP CONSTRAINT inventory_transactions_reference_type_check;
ALTER TABLE inventory_transactions ADD CONSTRAINT inventory_transactions_reference_type_check
  CHECK (reference_type IN ('PurchaseOrder','ProductionBatch','CustomerOrder','Manual',
    'BottleReturn','BottleWash','Adjustment','Sale','TruckLoad','TruckReturn','CustomerReturn',
    'JugsBought','JugsScrapped'));
