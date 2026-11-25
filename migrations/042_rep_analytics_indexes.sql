-- 042_rep_analytics_indexes.sql
-- Rep Analytics reads messages / rep_conversions / leads by date range.
-- Without these, a 30–90 day range scans the whole messages table.
CREATE INDEX idx_msg_created ON messages (created_at);
CREATE INDEX idx_rc_converted ON rep_conversions (converted_at);
CREATE INDEX idx_leads_assigned_created ON leads (assigned_to, created_at);
