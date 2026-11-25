-- =====================================================================
-- Order reminders by address, not by zone (Everton, 25 Nov 2026).
--
-- "Some of our customers don't actually know the zones and some have
-- multiple addresses which allows them to have multiple delivery days and
-- locations even with the same zone" (Broken Plate Jamaica, Maureen
-- Williams). The reminder names the place(s) the truck is coming to, with
-- the date, and is signed with the first name of whoever sends it.
--
-- Rulings: one message per customer listing every address due that day;
-- the main address gets an optional label like the extra addresses; the
-- usual-order question stays in.
--
--   * customers.address_label   optional name for the main address
--                               ("Head office"); blank = just the address.
--   * customer_addresses.delivery_days   the weekdays this extra delivery
--                               address takes deliveries. An extra address
--                               is reminded only on its own ticked days.
--
-- The reminder wording is replaced with his new wording (the office's
-- reworded version is what he asked to change).
--
-- Numbered 048: 047 is the no-round alert of 25 Nov 2026.
-- =====================================================================

ALTER TABLE customers ADD COLUMN IF NOT EXISTS address_label text;
ALTER TABLE customer_addresses ADD COLUMN IF NOT EXISTS delivery_days text[] NOT NULL DEFAULT '{}';

INSERT INTO system_settings (key, value) VALUES ('reminder_template',
'Good day {name}, it''s {staff} from Alka Vida.

Our truck will be in your area {when}, delivering to {place}. {ask}

Please reply here with your order, or order online: {link}

If you''ve already sent in your order, thank you! You''re all set and we''ll see you then.')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
