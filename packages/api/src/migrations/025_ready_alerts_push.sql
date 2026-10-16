-- =====================================================================
-- Everton's follow-up of 15 Oct 2026: how staff hear about orders.
--
--  * Every order comes in as PENDING (new). It is READY once the office
--    logs the truck load for the round it is on (round_loads), or when
--    someone marks it ready by hand (a collection, say): ready_at.
--  * A count of new online orders nobody in the office has looked at yet:
--    seen_at, set when the Orders screen shows them.
--  * A delivery day that is not the customer's own is a request, decided
--    under Needs a decision: request type SpecialDayOrder.
--  * Push notifications (web push) to staff phones and computers, and an
--    email to admins for everything that lands in Needs a decision.
-- =====================================================================

ALTER TABLE customer_orders
  ADD COLUMN ready_at      timestamptz,
  ADD COLUMN ready_by_name text,
  ADD COLUMN seen_at       timestamptz,
  -- Why it waits for a decision: SameDay (after the cut-off) or SpecialDay.
  ADD COLUMN review_reason text;

-- Everything already in the system has been seen; only new ones count.
UPDATE customer_orders SET seen_at = created_at;

ALTER TABLE approval_requests DROP CONSTRAINT approval_requests_request_type_check;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_request_type_check
  CHECK (request_type IN ('Discount','CreditNote','StopCorrection','SameDayOrder','PaymentChange','SpecialDayOrder'));

-- One row per browser (phone, tablet, computer) that said yes to notifications.
CREATE TABLE push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    text NOT NULL UNIQUE,
  p256dh      text,
  auth        text,
  device      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_ok_at  timestamptz,
  last_error  text
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions(user_id);

-- What each push says. The push itself carries nothing (so nothing has to be
-- encrypted on the way); the phone wakes, asks for its unread notes, shows them.
CREATE TABLE staff_notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       text NOT NULL,
  body        text NOT NULL DEFAULT '',
  url         text,
  tag         text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  shown_at    timestamptz
);
CREATE INDEX staff_notifications_user_idx ON staff_notifications(user_id, shown_at, created_at);

-- Which events have already been announced, so nothing is announced twice.
CREATE TABLE staff_alerts_sent (
  kind     text NOT NULL,
  ref_id   uuid NOT NULL,
  sent_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, ref_id)
);

-- Admins are emailed about Needs a decision unless they turn it off.
ALTER TABLE users ADD COLUMN decision_emails boolean NOT NULL DEFAULT true;

-- Only events from now on are announced, not the backlog.
INSERT INTO system_settings (key, value) VALUES ('alerts_since', now()::text)
ON CONFLICT (key) DO NOTHING;
