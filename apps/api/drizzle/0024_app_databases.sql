CREATE TABLE "app_databases" (
	"app_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'creating' NOT NULL,
	"password_enc" text NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"write_mode" text DEFAULT 'normal' NOT NULL,
	"notified_level" integer DEFAULT 0 NOT NULL,
	"notified_month" text,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_databases" ADD CONSTRAINT "app_databases_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_databases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app_databases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY app_rows ON "app_databases" FOR ALL TO platform_api USING (EXISTS (SELECT 1 FROM apps WHERE apps.id = app_databases.app_id)) WITH CHECK (EXISTS (SELECT 1 FROM apps WHERE apps.id = app_databases.app_id));
