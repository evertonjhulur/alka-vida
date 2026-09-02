-- =====================================================================
-- User administration: when each login was last used.
--
-- Until now every login in the system came from the seed file. There was no
-- way to add a member of staff, change what someone is allowed to do, or
-- take access away from someone who has left - the `active` column existed
-- and was honoured at login, but nothing ever set it. In practice that meant
-- the whole business shared four accounts whose passwords are printed on the
-- sign-in page.
--
-- The columns needed to fix that were already here. The one thing missing
-- was any way to tell a live account from an abandoned one, which is the
-- first question anyone reviewing access asks. Hence last_login_at.
--
-- NOT NULL is deliberately avoided: null means "has never signed in", which
-- is a real and useful state - a new account nobody has used yet, or one
-- created for someone who never started.
-- =====================================================================

ALTER TABLE users ADD COLUMN last_login_at timestamptz;

COMMENT ON COLUMN users.last_login_at IS
  'Set on every successful login. NULL means the account has never been used.';

COMMENT ON COLUMN users.active IS
  'Cleared to withdraw access. Checked at login AND on every authenticated '
  'request, so switching it off takes effect at once rather than when the '
  'token expires. Users are never deleted - audit_log rows reference them.';
