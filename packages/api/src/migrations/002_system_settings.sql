-- =====================================================================
-- Per-install settings, and with them a per-install token signing key.
--
-- WHY THIS EXISTS
--   Tokens used to be signed with a constant fallback secret whenever
--   JWT_SECRET was unset - which is every double-click launch. A constant
--   secret means a token outlives the database it was minted against:
--   "Reset Alka Vida data" wipes .data, the users are reseeded with new
--   ids, and a browser holding the old token still passes signature
--   verification as a person who no longer exists. Every write then died
--   on audit_log's foreign key at the very last statement, after document
--   numbers had already been drawn from their sequences.
--
--   The key now lives in the database, so wiping the data wipes the key
--   and every token minted against it stops verifying. JWT_SECRET, when
--   set, still wins - that is the production path.
-- =====================================================================

CREATE TABLE system_settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
