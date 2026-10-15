CREATE TABLE "runtime_minutes" (
	"app_id" uuid NOT NULL,
	"minute" timestamp with time zone NOT NULL,
	"containers" integer NOT NULL,
	CONSTRAINT "runtime_minutes_app_id_minute_pk" PRIMARY KEY("app_id","minute")
);
--> statement-breakpoint
CREATE TABLE "runtime_usage" (
	"owner_id" uuid NOT NULL,
	"period" text NOT NULL,
	"minutes" bigint DEFAULT 0 NOT NULL,
	"notified_80" boolean DEFAULT false NOT NULL,
	CONSTRAINT "runtime_usage_owner_id_period_pk" PRIMARY KEY("owner_id","period"),
	CONSTRAINT "runtime_usage_period_format_check" CHECK ("runtime_usage"."period" ~ '^([0-9]{4}-(0[1-9]|1[0-2])|FY[0-9]{4})$')
);
--> statement-breakpoint
ALTER TABLE "runtime_minutes" ADD CONSTRAINT "runtime_minutes_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_usage" ADD CONSTRAINT "runtime_usage_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_minutes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "runtime_minutes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY owner_read ON "runtime_minutes" FOR SELECT TO platform_api USING (EXISTS (SELECT 1 FROM apps WHERE apps.id = runtime_minutes.app_id));--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON "runtime_minutes" FROM platform_api;--> statement-breakpoint
ALTER TABLE "runtime_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "runtime_usage" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY owner_read ON "runtime_usage" FOR SELECT TO platform_api USING (app_can_access_owner(owner_id));--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON "runtime_usage" FROM platform_api;
