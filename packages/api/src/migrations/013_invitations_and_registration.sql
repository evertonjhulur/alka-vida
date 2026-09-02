-- =====================================================================
-- Invitations, and customers asking for an account.
--
-- Two gaps this closes.
--
-- FIRST: when the office created a portal login, it typed the customer's
-- password and had to read it down the phone. That leaves the office knowing
-- a password that can place credit orders, and nothing ever made the customer
-- change it. An invitation replaces that: the account is created with a
-- password nobody can use, and a one-time link lets the customer set their
-- own. The office never knows it.
--
-- SECOND: a prospect who found the business had no way to ask for an account.
-- Registration is deliberately an APPLICATION, not a sign-up: a portal order
-- is a credit order against agreed rates, so somebody has to decide the price
-- tier, the delivery zone and the payment terms before the account can trade.
-- Approving an application is what creates the customer, the login and the
-- invitation, in that order.
-- =====================================================================

-- A one-time link for setting a password.
--
-- Only a HASH of the token is stored, exactly as for a password: a copy of
-- this table must not be a set of working keys to customer accounts. The
-- token itself exists only in the link, and only until it is used.
CREATE TABLE user_invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  -- A link that never expires is a password that never changes.
  expires_at  timestamptz NOT NULL,
  -- One use only. Set the moment the password is set.
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id)
);

CREATE INDEX user_invitations_user_idx ON user_invitations (user_id, created_at DESC);

-- Corporate or individual, because they are asked for different things: a
-- business has a name and a contact person, a person has their own name.
-- Held on the customer as well as the application, so the office can see at
-- a glance which kind of account it is looking at.
ALTER TABLE customers
  ADD COLUMN account_type text NOT NULL DEFAULT 'Corporate'
    CHECK (account_type IN ('Corporate', 'Individual'));

COMMENT ON COLUMN customers.account_type IS
  'Corporate: customers.name is the business and contact_person is the person. '
  'Individual: customers.name is the person''s own name.';

CREATE TABLE customer_applications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_type     text NOT NULL CHECK (account_type IN ('Corporate', 'Individual')),

  -- Corporate answers these two...
  business_name    text,
  contact_person   text,
  -- ...an individual these two. Which pair is required is enforced by the
  -- service, not here: the message a person reads when they leave a box empty
  -- should be written for them, not raised by a constraint.
  first_name       text,
  last_name        text,

  email            text NOT NULL,
  phone            text NOT NULL,
  delivery_address text,
  -- Free text for now. When zones are assigned automatically - from a set of
  -- preset areas, or from the address itself - this is what that will read.
  delivery_zone    text,
  notes            text,

  status           text NOT NULL DEFAULT 'Pending'
                     CHECK (status IN ('Pending', 'Approved', 'Declined')),
  decided_at       timestamptz,
  decided_by       uuid REFERENCES users(id),
  decline_reason   text,
  -- Set when approved: the customer record this application became.
  customer_id      uuid REFERENCES customers(id),

  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX customer_applications_pending_idx
  ON customer_applications (created_at DESC) WHERE status = 'Pending';

-- The same address must not be able to queue twenty applications, and an
-- approved customer must not be able to apply again over the top of itself.
CREATE UNIQUE INDEX customer_applications_one_open_per_email_idx
  ON customer_applications (lower(email)) WHERE status = 'Pending';

COMMENT ON TABLE customer_applications IS
  'A request for a trading account, awaiting the office. Approving it creates '
  'the customer, the portal login and the invitation that carries them in.';
