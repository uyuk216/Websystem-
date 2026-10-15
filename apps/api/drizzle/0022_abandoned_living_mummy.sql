CREATE TABLE "access_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"status" integer NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"ua_kind" text NOT NULL,
	"referrer" text,
	"ip_prefix" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_logs" ADD CONSTRAINT "access_logs_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_logs_app_created_idx" ON "access_logs" USING btree ("app_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "access_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "access_logs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY owner_read ON "access_logs" FOR SELECT TO platform_api USING (EXISTS (SELECT 1 FROM apps WHERE apps.id = access_logs.app_id));--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON "access_logs" FROM platform_api;
