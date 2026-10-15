CREATE TABLE "app_env_vars" (
	"app_id" uuid NOT NULL,
	"name" text NOT NULL,
	"value_enc" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_env_vars_app_id_name_pk" PRIMARY KEY("app_id","name")
);
--> statement-breakpoint
ALTER TABLE "app_env_vars" ADD CONSTRAINT "app_env_vars_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_env_vars" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app_env_vars" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY app_rows ON "app_env_vars" FOR ALL TO platform_api USING (EXISTS (SELECT 1 FROM apps WHERE apps.id = app_env_vars.app_id)) WITH CHECK (EXISTS (SELECT 1 FROM apps WHERE apps.id = app_env_vars.app_id));
