-- =====================================================================
-- Addresses in parts, and delivery zones as a managed list.
--
-- ADDRESSES. A delivery address was one free-text box. A driver needs the
-- street on one line and the town on another, and the office needs to be able
-- to group a round by parish - neither of which you can do with a single
-- string somebody typed however they felt that day.
--
-- delivery_address STAYS, and stays authoritative for everything that already
-- reads it: the delivery stop copies it, the invoice PDF prints it. It is now
-- composed from the parts rather than typed, so nothing downstream has to
-- change and no existing address is lost. Where only the old single line
-- exists, it keeps working exactly as before.
--
-- ZONES. The round a customer belongs to was free text, which meant "Kingston"
-- and "kingston " were two rounds that never grouped. A managed list makes the
-- zone a choice rather than a spelling, and gives automatic zone assignment
-- something real to assign TO when it arrives - matching a parish or an area
-- to a zone needs the zones to exist first.
-- =====================================================================

CREATE TABLE delivery_zones (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  -- Free text for now: the note that tells the office which areas this round
  -- covers. It is what automatic assignment will eventually read.
  covers     text,
  retired_at timestamptz,
  sort_order int NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Everything already in use becomes a zone, so no customer loses their round.
INSERT INTO delivery_zones (name)
SELECT DISTINCT btrim(delivery_zone) FROM customers
WHERE delivery_zone IS NOT NULL AND btrim(delivery_zone) <> '';

-- Tidy the customers themselves onto the trimmed spelling now that the list
-- is the authority: "Kingston " and "Kingston" must be the same round.
UPDATE customers SET delivery_zone = btrim(delivery_zone)
WHERE delivery_zone IS NOT NULL AND delivery_zone <> btrim(delivery_zone);

ALTER TABLE customers
  ADD COLUMN address_line1 text,
  ADD COLUMN address_line2 text,
  ADD COLUMN city          text,
  ADD COLUMN parish        text;

ALTER TABLE customer_applications
  ADD COLUMN address_line1 text,
  ADD COLUMN address_line2 text,
  ADD COLUMN city          text,
  ADD COLUMN parish        text;

-- An address entered before this migration has only the single line. Putting
-- it in line 1 rather than trying to parse it apart: a bad guess at which
-- half is the town would be worse than leaving it whole for somebody to
-- correct when they next open the record.
UPDATE customers
SET address_line1 = delivery_address
WHERE delivery_address IS NOT NULL AND btrim(delivery_address) <> '';

UPDATE customer_applications
SET address_line1 = delivery_address
WHERE delivery_address IS NOT NULL AND btrim(delivery_address) <> '';

COMMENT ON COLUMN customers.delivery_address IS
  'The whole address on one line, composed from address_line1/2, city and '
  'parish. Kept because the delivery stop and the invoice PDF both read it; '
  'write it through the service so the parts and the whole cannot disagree.';

COMMENT ON TABLE delivery_zones IS
  'The rounds deliveries are grouped into. A managed list rather than free '
  'text, so a round cannot be created by a typo.';
