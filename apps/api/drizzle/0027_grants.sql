CREATE TABLE "grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"suspend_on" timestamp with time zone,
	"reason" text DEFAULT '' NOT NULL,
	"approved_by" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grants_period_check" CHECK ("grants"."ends_at" > "grants"."starts_at")
);
--> statement-breakpoint
CREATE INDEX "grants_target_idx" ON "grants" USING btree ("target_kind","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "grants_starter_once_idx" ON "grants" USING btree ("target_id") WHERE "grants"."kind" = 'starter';--> statement-breakpoint
CREATE UNIQUE INDEX "grants_student_active_idx" ON "grants" USING btree ("target_kind","target_id") WHERE "grants"."kind" = 'student' AND "grants"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- 利用者側（platform_api）は読むだけ。書くのはシステム（owner ロール）と管理側（platform_admin、withAdmin の中）だけ。
REVOKE ALL ON "grants" FROM platform_api;--> statement-breakpoint
GRANT SELECT ON "grants" TO platform_api;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "grants" TO platform_admin;--> statement-breakpoint
-- 自分のアカウント宛て、自分が見えるオーナー宛て、自分が見えるアプリ宛て（owners / apps の RLS がそのまま効く）。
CREATE POLICY own_select ON "grants" FOR SELECT TO platform_api USING (
  (target_kind = 'account' AND target_id = app_account_id())
  OR (target_kind = 'owner' AND EXISTS (SELECT 1 FROM owners o WHERE o.id = grants.target_id))
  OR (target_kind = 'app' AND EXISTS (SELECT 1 FROM apps a WHERE a.id = grants.target_id))
);--> statement-breakpoint
CREATE POLICY admin_read ON "grants" FOR SELECT TO platform_admin USING (true);--> statement-breakpoint
CREATE POLICY admin_insert ON "grants" FOR INSERT TO platform_admin WITH CHECK (app_operator_id() IS NOT NULL);--> statement-breakpoint
CREATE POLICY admin_update ON "grants" FOR UPDATE TO platform_admin USING (app_operator_id() IS NOT NULL) WITH CHECK (app_operator_id() IS NOT NULL);
