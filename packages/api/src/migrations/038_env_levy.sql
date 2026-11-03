-- Environmental Protection Levy (Everton, 3 Nov 2026). The EPL Act moved
-- the levy from 0.5% to 0.85% from 1 Oct 2026; local manufacturers charge
-- it on 75% of the selling price, so a local supplier's invoice carries
-- 0.85% x 75% = 0.6375% (it was 0.5% x 75% = 0.375%). Parkland's invoices
-- already show 0.6375%. Only the untouched old figure is moved; POs already
-- raised keep the levy they were priced with. Settings > Invoices & payments
-- can change it from now on.
UPDATE system_settings SET value = '0.6375'
 WHERE key = 'env_tax_rate_percent' AND value = '0.375';
INSERT INTO system_settings (key, value) VALUES ('env_tax_rate_percent', '0.6375')
ON CONFLICT (key) DO NOTHING;
