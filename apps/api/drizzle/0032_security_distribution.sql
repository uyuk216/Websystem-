CREATE TABLE security_distribution_samples (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
 day text NOT NULL, file_hash text NOT NULL CHECK (file_hash ~ '^[a-f0-9]{64}$'),
 bytes bigint NOT NULL CHECK (bytes > 0), external boolean NOT NULL, observed_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX security_distribution_window ON security_distribution_samples(app_id, observed_at);
--> statement-breakpoint
ALTER TABLE security_distribution_samples ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE security_distribution_samples FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON security_distribution_samples FROM platform_api, platform_admin;
