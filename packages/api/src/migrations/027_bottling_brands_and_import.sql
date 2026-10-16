-- =====================================================================
-- Third-party bottling brands, and bringing customers across from
-- QuickBooks (Everton, 16 Oct 2026).
--
-- BOTTLED BRANDS
--   "We do not sell third party products directly and such should not be
--   available to our customers outside of those specific customers we
--   provide the bottling service for." Alka Lyfe (Alka Lyfe and Sky Drops),
--   Melkleen (Cool Cool) and Living Hope (Living Water) are bottled for.
--
--   * customer_brands links a customer to the Third-Party Co-Pack brands
--     bottled for them - any number, because Alka Lyfe has two. The old
--     single customers.brand_id could not say that; it is kept for history
--     and a co-pack brand already in it is copied across below.
--   * customers.buys_own_brand: false for a customer who buys only their own
--     bottled brands (Melkleen and Living Hope "so far"), so Alka Vida's own
--     products are kept off their order screens and portal too.
--   * A product of an Owned brand (or with no brand) is for everybody who
--     buys_own_brand; a product of a co-pack brand only for the customers
--     linked to that brand. services/brands.ts holds that rule.
--   * brands.active, so a brand no longer bottled can be retired, and one
--     name per brand.
--
-- OPENING BALANCES
--   Only what is owed moves across, not the order history ("if no balance
--   exist it is safe to assume it is zero"). An open QuickBooks invoice
--   comes in as an invoice with no lines, is_opening_balance, carrying its
--   QuickBooks number, date and due date so ageing and reminders read true;
--   an unapplied QuickBooks payment (a credit) comes in as an unattached
--   payment, so it sits as credit on the account like any other.
-- =====================================================================

ALTER TABLE brands ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
CREATE UNIQUE INDEX IF NOT EXISTS brands_name_key ON brands (lower(name));

CREATE TABLE IF NOT EXISTS customer_brands (
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  brand_id    uuid NOT NULL REFERENCES brands(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, brand_id)
);
CREATE INDEX IF NOT EXISTS customer_brands_brand_idx ON customer_brands(brand_id);

INSERT INTO customer_brands (customer_id, brand_id)
SELECT c.id, c.brand_id
FROM customers c JOIN brands b ON b.id = c.brand_id
WHERE b.type = 'Third-Party Co-Pack'
ON CONFLICT DO NOTHING;

ALTER TABLE customers ADD COLUMN IF NOT EXISTS buys_own_brand boolean NOT NULL DEFAULT true;
-- When and from what a customer was brought across (the upload screen).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS imported_at timestamptz;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_opening_balance boolean NOT NULL DEFAULT false;
-- The QuickBooks invoice number, as printed on what the customer already has.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS opening_reference text;
