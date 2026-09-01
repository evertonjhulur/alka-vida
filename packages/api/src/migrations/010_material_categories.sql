-- =====================================================================
-- Material categories and sizes become data; retiring a material.
--
-- Until now the five categories (Bottle, Cap, Handle, Label, Water) were
-- nailed shut by a CHECK constraint, and the sizes offered for each were a
-- hardcoded list inside the web page. Adding a new kind of material, or a
-- new bottle size, meant a code change. That is the wrong place for it:
-- what the business buys changes far more often than the software does.
--
-- Two things made this safe to open up:
--
--   * NOTHING in the business logic behaves differently based on category.
--     It is a label for grouping and reorder alerts. Costing, production,
--     FIFO and purchasing all work on the material's id, never its category.
--     So a new category cannot break any of them.
--
--   * bom_line_items.component_type only ever copies the material's own
--     category (see Bom.tsx), so it carried the same closed list and has to
--     open up with it, or a recipe using a new category could not be saved.
--
-- The category is still stored on raw_materials as text rather than a
-- foreign key. That keeps every existing query untouched, and it means a
-- material's category reads correctly even if the category is later
-- retired. The price of that choice is that renaming a category has to
-- carry the new name across to its materials and their recipe lines --
-- updateMaterialCategory does exactly that, in one transaction.
--
-- Validity is now enforced by the service against the tables below, which
-- is the only place it can live once the list is something the office edits.
-- =====================================================================

CREATE TABLE material_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  -- Retired keeps the category and everything filed under it, but stops it
  -- being offered for anything new. Deleting a category that materials are
  -- filed under would orphan them.
  retired_at timestamptz,
  sort_order int NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The sizes a category is actually stocked in. A fixed list per category,
-- rather than free text, is what stops "28mm", "28 mm" and "28MM" becoming
-- three materials that never group, never total and never reorder together.
-- A category with no rows here takes a free-text size, which is right for
-- water and handles -- and for a brand new category before its sizes are
-- known.
CREATE TABLE material_sizes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES material_categories(id) ON DELETE CASCADE,
  name        text NOT NULL,
  sort_order  int NOT NULL DEFAULT 100,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category_id, name)
);

CREATE INDEX material_sizes_category_idx ON material_sizes (category_id, sort_order, name);

-- Retiring a material: it keeps its history, its stock value and its place
-- in past purchase orders and production runs, but stops being offered for
-- anything new. This is what "delete" falls back to for a material that has
-- ever been bought or used -- a true delete would tear the cost record out
-- from under work already done.
ALTER TABLE raw_materials ADD COLUMN retired_at timestamptz;

CREATE INDEX raw_materials_live_idx ON raw_materials (category, name) WHERE retired_at IS NULL;

-- The closed lists come off. See the header: the service validates against
-- material_categories now, because the permitted set is no longer static.
ALTER TABLE raw_materials  DROP CONSTRAINT IF EXISTS raw_materials_category_check;
ALTER TABLE bom_line_items DROP CONSTRAINT IF EXISTS bom_line_items_component_type_check;

-- The five that were hardcoded, in the order they were listed.
INSERT INTO material_categories (name, sort_order) VALUES
  ('Bottle', 10), ('Cap', 20), ('Handle', 30), ('Label', 40), ('Water', 50);

-- The sizes that were hardcoded in the web page.
INSERT INTO material_sizes (category_id, name, sort_order)
SELECT c.id, s.name, s.sort_order
FROM material_categories c
JOIN (VALUES
  ('Bottle', '280ml', 10), ('Bottle', '500ml', 20), ('Bottle', '1.5L', 30),
  ('Bottle', '5L',    40), ('Bottle', '5gal',  50),
  ('Cap',    '28mm',  10), ('Cap',    '48mm',  20), ('Cap',    '55mm',  30),
  ('Label',  '280ml', 10), ('Label',  '500ml', 20), ('Label',  '1.5L', 30),
  ('Label',  '5L',    40), ('Label',  '5gal',  50)
) AS s(category, name, sort_order) ON s.category = c.name;

-- Defensive, for a database that already has rows: anything filed under a
-- category or size these lists do not cover is carried in rather than left
-- unselectable. On a fresh install both of these find nothing.
INSERT INTO material_categories (name)
SELECT DISTINCT rm.category FROM raw_materials rm
WHERE rm.category IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM material_categories c WHERE c.name = rm.category);

INSERT INTO material_sizes (category_id, name)
SELECT DISTINCT c.id, rm.size_spec
FROM raw_materials rm
JOIN material_categories c ON c.name = rm.category
WHERE rm.size_spec IS NOT NULL AND rm.size_spec <> ''
  AND NOT EXISTS (
    SELECT 1 FROM material_sizes s WHERE s.category_id = c.id AND s.name = rm.size_spec
  );

COMMENT ON COLUMN raw_materials.retired_at IS
  'Set when a material is withdrawn from use. It keeps all history and stock '
  'value but is not offered for new purchase orders, recipes or usage.';
