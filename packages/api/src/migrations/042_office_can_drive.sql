-- =====================================================================
-- Office staff and administrators who also drive (Everton, 18 Nov 2026).
--
-- A login has one role. Until now only a driver login could be put on a
-- round, confirm its load and reconfirm additions, so somebody who works
-- in the office and sometimes drives needed two logins.
--
-- can_drive lets an office or administrator login do the driver's part as
-- well: they can be assigned a round, get My route, confirm the load and
-- reconfirm additions. Ignored for driver and customer logins.
--
-- His ruling on the loading check (10 Oct 2026: office logs the load, the
-- driver confirms it): when one person does both, it is ALLOWED, and the
-- round is flagged "loaded and confirmed by the same person" on the round
-- page, the settlement and the End of day report, and in the audit log.
-- The flag is worked out from round_loads / round_load_additions (who
-- logged it, who loaded it, who confirmed it), so nothing extra is stored.
-- =====================================================================

ALTER TABLE users ADD COLUMN can_drive boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN users.can_drive IS
  'An office or administrator login that can also be the driver on a round '
  '(18 Nov 2026). Ignored for driver and customer logins.';
