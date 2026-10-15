-- Custom SQL migration file, put your code below! --ALTER TABLE "transfer_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transfer_usage" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Owner-visible read only (future dashboard): rows follow their app, which is filtered by the apps policy.
CREATE POLICY owner_read ON "transfer_usage" FOR SELECT TO platform_api
  USING (EXISTS (SELECT 1 FROM apps WHERE apps.id = transfer_usage.app_id));--> statement-breakpoint
-- Counters are written only by the static server through the owner role (withSystem).
REVOKE INSERT, UPDATE, DELETE ON "transfer_usage" FROM platform_api;
