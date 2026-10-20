CREATE TABLE "usage_states" (
	"owner_id" uuid PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"paid" boolean DEFAULT false NOT NULL,
	"valid_until" timestamp with time zone,
	"suspend_on" timestamp with time zone,
	"next_evaluate_at" timestamp with time zone,
	"rereg_notified_for" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_states" ADD CONSTRAINT "usage_states_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_states_next_idx" ON "usage_states" USING btree ("next_evaluate_at");--> statement-breakpoint
ALTER TABLE "usage_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "usage_states" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- 利用者側（platform_api）は自分が見えるオーナーの状態を読むだけ。書くのはシステム（owner ロール）と管理側（withAdmin の中）だけ。
REVOKE ALL ON "usage_states" FROM platform_api;--> statement-breakpoint
GRANT SELECT ON "usage_states" TO platform_api;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "usage_states" TO platform_admin;--> statement-breakpoint
CREATE POLICY own_select ON "usage_states" FOR SELECT TO platform_api USING (EXISTS (SELECT 1 FROM owners o WHERE o.id = usage_states.owner_id));--> statement-breakpoint
CREATE POLICY admin_read ON "usage_states" FOR SELECT TO platform_admin USING (true);--> statement-breakpoint
CREATE POLICY admin_insert ON "usage_states" FOR INSERT TO platform_admin WITH CHECK (app_operator_id() IS NOT NULL);--> statement-breakpoint
CREATE POLICY admin_update ON "usage_states" FOR UPDATE TO platform_admin USING (app_operator_id() IS NOT NULL) WITH CHECK (app_operator_id() IS NOT NULL);
