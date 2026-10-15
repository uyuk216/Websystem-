CREATE TABLE "apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'static' NOT NULL,
	"publish_dir" text DEFAULT '' NOT NULL,
	"active_deployment_id" uuid,
	"github_repo" text,
	"github_branch" text,
	"github_installation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apps_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"source_key" text NOT NULL,
	"site_key" text,
	"total_bytes" bigint,
	"file_count" integer,
	"message" text,
	"findings" jsonb,
	"commit_sha" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_created_by_accounts_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "apps_owner_idx" ON "apps" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "deployments_app_idx" ON "deployments" USING btree ("app_id","created_at");--> statement-breakpoint
-- SECURITY DEFINER so the owner/team lookup is not itself subject to the owners/team_members policies.
CREATE FUNCTION app_can_access_owner(owner uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT EXISTS (
  SELECT 1 FROM owners o WHERE o.id = owner AND (
    (o.kind = 'account' AND o.account_id = app_account_id()) OR
    (o.kind = 'team' AND EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = o.team_id AND m.account_id = app_account_id()))
  )
) $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_can_access_owner(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_can_access_owner(uuid) TO platform_api;
--> statement-breakpoint
ALTER TABLE "apps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "apps" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "deployments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "deployments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY owner_rows ON "apps" FOR ALL TO platform_api USING (app_can_access_owner(owner_id)) WITH CHECK (app_can_access_owner(owner_id));--> statement-breakpoint
-- Deployments follow their app: the subquery is filtered by the apps policy.
CREATE POLICY app_rows ON "deployments" FOR ALL TO platform_api
  USING (EXISTS (SELECT 1 FROM apps WHERE apps.id = deployments.app_id))
  WITH CHECK (EXISTS (SELECT 1 FROM apps WHERE apps.id = deployments.app_id));
