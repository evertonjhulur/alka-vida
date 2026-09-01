-- =====================================================================
-- Office-raised stop corrections, routed to an admin for approval.
--
-- Correcting a stop rewrites what a driver recorded collecting, delivering
-- and picking up. That is exactly the record a driver would need to alter to
-- cover a shortfall, so correctStopRecord has always been admin-only.
--
-- Office staff are the ones sitting with the paperwork, though, so they must
-- be able to RAISE a correction - they just cannot apply it themselves. The
-- proposed change is parked here until an admin approves it, at which point
-- it is applied exactly as an admin correction would have been.
--
-- payload carries the proposed changes verbatim, so what an admin approves is
-- precisely what was requested - not a re-derivation that could drift.
-- =====================================================================

ALTER TABLE approval_requests DROP CONSTRAINT approval_requests_request_type_check;

ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_request_type_check
  CHECK (request_type IN ('Discount','CreditNote','StopCorrection'));

ALTER TABLE approval_requests ADD COLUMN payload jsonb;

COMMENT ON COLUMN approval_requests.payload IS
  'For StopCorrection: the proposed changes, applied verbatim on approval.';
