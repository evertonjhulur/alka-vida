-- =====================================================================
-- Tomorrow's round: remind customers to order (Everton, 7 Oct 2026).
--
-- The evening before a round, the office goes down the customers whose
-- delivery day it is and who have not ordered yet, and sends each one a
-- WhatsApp message (one tap each, from the screen) or an email. This table
-- remembers who has been reminded for which day, so the list ticks itself
-- off and nobody gets the same nudge twice.
-- =====================================================================

CREATE TABLE order_reminders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  uuid NOT NULL REFERENCES customers(id),
  -- The delivery day the reminder was about.
  for_date     date NOT NULL,
  channel      text NOT NULL CHECK (channel IN ('WhatsApp','Email')),
  sent_by      uuid REFERENCES users(id),
  sent_by_name text,
  ok           boolean NOT NULL DEFAULT true,
  detail       text,
  sent_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_reminders_day_idx ON order_reminders(for_date, customer_id);

INSERT INTO system_settings (key, value) VALUES
  ('reminder_template',
   'Good day {name}, our truck is in {zone} {when}. {ask} Reply here or order online: {link}')
ON CONFLICT (key) DO NOTHING;
