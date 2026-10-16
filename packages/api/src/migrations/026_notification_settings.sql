-- =====================================================================
-- Managing notifications (Everton, 15 Oct 2026): a switch for each kind,
-- quiet hours, the devices list, and an admin setting them for others.
--
--   notify_orders     new online orders (office and admins)
--   notify_decisions  Needs a decision (admins), push
--   decision_emails   Needs a decision (admins), email   (migration 025)
--   notify_load       something added to my load (drivers)
--   quiet_from/to     no buzzing between these times (Jamaica, 'HH:MM');
--                     what comes in is held and arrives when they end
-- =====================================================================

ALTER TABLE users
  ADD COLUMN notify_orders    boolean NOT NULL DEFAULT true,
  ADD COLUMN notify_decisions boolean NOT NULL DEFAULT true,
  ADD COLUMN notify_load      boolean NOT NULL DEFAULT true,
  ADD COLUMN quiet_from       text CHECK (quiet_from ~ '^[0-2][0-9]:[0-5][0-9]$'),
  ADD COLUMN quiet_to         text CHECK (quiet_to ~ '^[0-2][0-9]:[0-5][0-9]$');

-- A note held back by quiet hours has not been knocked for yet.
ALTER TABLE staff_notifications ADD COLUMN knocked_at timestamptz;
UPDATE staff_notifications SET knocked_at = created_at;
