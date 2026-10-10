-- =====================================================================
-- Everton's round of 10 Oct 2026. His rulings are final; HANDOFF.md has
-- the detail.
--
--   * A payment taken on a stop already delivered: recorded on the stop
--     when it has none yet, otherwise as its own "Payment only" stop that
--     points back at the delivery (after_stop_id). Either way it is only a
--     record until the office settles the round (invariant 2).
--   * Collection stops: empties, returned goods and supplier pick-ups
--     (round_collections). Collecting a payment is the existing
--     "Payment only" stop. These have no order and, for a supplier, no
--     customer, so they live beside delivery_stops rather than in it: every
--     query over delivery_stops joins customers and expects money logic.
--   * Truck loading and returns (round_loads, round_load_lines). Loading
--     moves finished goods warehouse -> truck; deliveries on a loaded round
--     come off the truck (not the warehouse again); what comes back goes
--     back to the warehouse. Loaders are employees.
--   * Settings: the bank details / disclaimer printed on every invoice and
--     statement PDF, and whether we take card payments (default: no).
-- =====================================================================

-- ------------------------------------------------ payment after delivery

ALTER TABLE delivery_stops
  ADD COLUMN after_stop_id uuid REFERENCES delivery_stops(id) ON DELETE CASCADE;

-- ------------------------------------------------------- stock ledger

ALTER TABLE inventory_transactions DROP CONSTRAINT inventory_transactions_reference_type_check;
ALTER TABLE inventory_transactions ADD CONSTRAINT inventory_transactions_reference_type_check
  CHECK (reference_type IN ('PurchaseOrder','ProductionBatch','CustomerOrder','Manual',
    'BottleReturn','BottleWash','Adjustment','Sale','TruckLoad','TruckReturn','CustomerReturn'));

-- ------------------------------------------------------------ loading

-- One per round. Saved when the driver (or office) confirms the loading
-- before the round starts; the returns half is filled at the end.
CREATE TABLE round_loads (
  delivery_sheet_id uuid PRIMARY KEY REFERENCES delivery_sheets(id) ON DELETE CASCADE,
  loaded_at         timestamptz NOT NULL DEFAULT now(),
  loaded_by         uuid REFERENCES users(id),
  loaded_by_name    text,
  -- Who physically loaded the truck: employees, one or more.
  loader_ids        uuid[] NOT NULL DEFAULT '{}',
  loader_names      text[] NOT NULL DEFAULT '{}',
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- Returns: confirmed once every stop has an outcome.
  returned_at       timestamptz,
  returned_by_name  text,
  empties_back      integer CHECK (empties_back >= 0),
  return_notes      text
);

-- Per product, in BOTTLES (a case of 24 is 24). ordered = from the round's
-- orders when loaded; extra = what the driver added on top; loaded = what
-- actually went on (normally ordered + extra).
CREATE TABLE round_load_lines (
  delivery_sheet_id uuid NOT NULL REFERENCES round_loads(delivery_sheet_id) ON DELETE CASCADE,
  product_id        uuid NOT NULL REFERENCES products(id),
  ordered_bottles   integer NOT NULL DEFAULT 0 CHECK (ordered_bottles >= 0),
  extra_bottles     integer NOT NULL DEFAULT 0 CHECK (extra_bottles >= 0),
  loaded_bottles    integer NOT NULL DEFAULT 0 CHECK (loaded_bottles >= 0),
  returned_bottles  integer CHECK (returned_bottles >= 0),
  PRIMARY KEY (delivery_sheet_id, product_id)
);

-- --------------------------------------------------------- collections

CREATE TABLE round_collections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_sheet_id uuid NOT NULL REFERENCES delivery_sheets(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('Empties','Returns','Supplier')),
  customer_id       uuid REFERENCES customers(id),
  supplier_id       uuid REFERENCES suppliers(id),
  purchase_order_id uuid REFERENCES purchase_orders(id),
  -- Office-planned ones start Pending; the driver records what happened.
  status            text NOT NULL DEFAULT 'Pending'
                      CHECK (status IN ('Pending','Collected','Not collected')),
  -- Empties: how many (planned, then actually collected).
  empties_count     integer NOT NULL DEFAULT 0 CHECK (empties_count >= 0),
  -- Returns: [{productId, name, bottlesPerCase, cases, looseBottles}]
  -- Supplier: [{poLineId, rawMaterialId, name, unit, quantity}]
  lines             jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason            text,
  -- Supplier: what was collected, in words (always allowed, PO or not).
  description       text,
  notes             text,
  sequence_no       integer NOT NULL DEFAULT 0,
  added_by          uuid REFERENCES users(id),
  added_by_name     text,
  added_at          timestamptz NOT NULL DEFAULT now(),
  collected_at      timestamptz,
  collected_by_name text,
  -- Settling the round: empties go into the pool; returned goods get the
  -- office's decision on a credit note and on putting them back in stock.
  settled_at        timestamptz,
  credit_decision   text CHECK (credit_decision IN ('Credit note','No credit note')),
  credit_note_id    uuid REFERENCES invoices(id),
  restock           boolean NOT NULL DEFAULT false,
  decided_by_name   text,
  -- A supplier pick-up is received on its PO by the office.
  received_at       timestamptz,
  CHECK ((kind = 'Supplier') = (supplier_id IS NOT NULL)),
  CHECK (kind = 'Supplier' OR customer_id IS NOT NULL)
);
CREATE INDEX round_collections_sheet_idx ON round_collections(delivery_sheet_id);
CREATE INDEX round_collections_po_idx ON round_collections(purchase_order_id);

-- ------------------------------------------------------------ settings

INSERT INTO system_settings (key, value) VALUES
  ('take_card_payments', 'false'),
  ('document_footer', E'Invoice payable to 1506 Investments Limited.\nElectronic Transfers:\nBank: JMMB\nAccount Holder: 1506 Investments Limited\nAccount: 000300249266\nBranch: Knutsford Boulevard branch\n11 Knutsford Boulevard\nKingston 5, Jamaica\nNote to customer\n1506 Investments Limited will not assume liability for goods damaged after receipt.')
ON CONFLICT (key) DO NOTHING;
