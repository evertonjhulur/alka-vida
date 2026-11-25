-- =====================================================================
-- Delivery orders with no round: going forward only (Everton, 25 Nov 2026).
--
-- "For the no round updates, it is giving me passed orders as reminders,
-- the update is for going forward. If they were delivered the date of
-- completion would have likely been done on a round or otherwise."
--
-- Orders still marked Pending from before the alert came in were handled
-- outside the app. The alert (badge, Today panel, Delivery rounds panel,
-- the Orders "Not on a round" reason, the loading warning and the backup
-- phone notification) now counts only orders due on or after this day,
-- plus any order taken off a round on or after it. Change the value here
-- (or in system_settings) to move the start day.
-- =====================================================================

INSERT INTO system_settings (key, value) VALUES ('no_round_from', '2026-11-26')
ON CONFLICT (key) DO NOTHING;
