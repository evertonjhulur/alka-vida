-- =====================================================================
-- Emailing from the send screen (Everton, 28 Oct 2026): every "Email..."
-- opens a screen in a new tab with the email written, the document attached,
-- To / Cc / Bcc, and room for other files, the way QuickBooks and Zoho do.
--
-- cc_emails: copy addresses saved on a customer's account (a corporate
-- client's accounts clerk and manager, say). They fill in the Cc box on the
-- send screen and go on the automatic emails too. Comma-separated.
--
-- The default wording of each kind of email lives in system_settings under
-- 'email_wording' (JSON), written from Settings > Emails & ordering.
-- =====================================================================

ALTER TABLE customers ADD COLUMN cc_emails text;
