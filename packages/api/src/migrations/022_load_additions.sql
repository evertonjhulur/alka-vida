-- =====================================================================
-- Last-minute additions to a confirmed load (Everton, 10 Oct 2026).
--
-- Once the driver has confirmed the load it is locked. If more has to go
-- on, the office logs an ADDITION (add only, with who loaded it), which
-- moves that stock warehouse -> truck straight away, and the driver
-- reconfirms it on My route. The round cannot be settled while an
-- addition is waiting for the driver; the office can cancel one the driver
-- has not confirmed (the stock goes back).
-- =====================================================================

CREATE TABLE round_load_additions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_sheet_id     uuid NOT NULL REFERENCES round_loads(delivery_sheet_id) ON DELETE CASCADE,
  -- [{productId, bottles}]
  lines                 jsonb NOT NULL,
  note                  text,
  added_at              timestamptz NOT NULL DEFAULT now(),
  added_by              uuid REFERENCES users(id),
  added_by_name         text,
  loader_ids            uuid[] NOT NULL DEFAULT '{}',
  loader_names          text[] NOT NULL DEFAULT '{}',
  driver_confirmed_at   timestamptz,
  driver_confirmed_by   uuid REFERENCES users(id),
  driver_confirmed_name text,
  cancelled_at          timestamptz,
  cancelled_by_name     text
);
CREATE INDEX round_load_additions_sheet_idx ON round_load_additions(delivery_sheet_id);

-- What additions put on, per product, kept apart from the original loading
-- so the loadings report credits each loader with what they loaded.
ALTER TABLE round_load_lines
  ADD COLUMN added_bottles integer NOT NULL DEFAULT 0 CHECK (added_bottles >= 0);
