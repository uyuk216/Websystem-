DROP INDEX security_blocks_active_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX security_blocks_active_idx ON security_blocks (incident_id, reason_code) WHERE released_at IS NULL;
--> statement-breakpoint
-- Task 1 coalesced same-code events into one active reason. Restore each still-open incident before releases are enabled.
INSERT INTO security_blocks (incident_id, target_kind, app_id, account_id, ip_hash, reason_code)
SELECT id, target_kind, app_id, account_id, ip_hash, reason_code FROM security_incidents i
WHERE status = 'open' AND severity IN ('medium', 'high')
AND NOT EXISTS (SELECT 1 FROM security_blocks b WHERE b.incident_id = i.id AND b.released_at IS NULL);
--> statement-breakpoint
ALTER TABLE security_outbox ADD COLUMN priority integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE security_appeals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), incident_id uuid NOT NULL REFERENCES security_incidents(id),
 account_id uuid NOT NULL REFERENCES accounts(id), message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 2000), created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX security_appeals_account_idx ON security_appeals(account_id, created_at);
--> statement-breakpoint
CREATE TABLE security_notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id), incident_id uuid NOT NULL REFERENCES security_incidents(id),
 effect_key text NOT NULL UNIQUE, audience text NOT NULL, subject text NOT NULL, body text NOT NULL, mailed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE security_appeals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE security_appeals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE security_notifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE security_notifications FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON security_appeals, security_notifications FROM platform_api, platform_admin;
--> statement-breakpoint
GRANT SELECT (id, account_id, incident_id, audience, subject, body) ON security_notifications TO platform_api;
--> statement-breakpoint
CREATE POLICY own_security_notifications ON security_notifications FOR SELECT TO platform_api
USING (account_id = app_account_id() AND audience = 'owner');
