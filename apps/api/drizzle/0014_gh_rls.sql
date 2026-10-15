ALTER TABLE "github_installation_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "github_installation_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY own_rows ON "github_installation_links" TO platform_api USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());--> statement-breakpoint
ALTER TABLE "github_oauth_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "github_oauth_states" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "github_oauth_states" FROM platform_api;--> statement-breakpoint
ALTER TABLE "github_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "github_deliveries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "github_deliveries" FROM platform_api;
