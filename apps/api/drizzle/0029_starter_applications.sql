CREATE TABLE "event_boosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"event_name" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"expected_visits" integer NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"extra_transfer_bytes" bigint,
	"extra_memory_mb" integer,
	"grant_id" uuid,
	"reject_reason" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"restored_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_boosts_period_check" CHECK ("event_boosts"."ends_at" > "event_boosts"."starts_at"),
	CONSTRAINT "event_boosts_name_check" CHECK (char_length("event_boosts"."event_name") between 1 and 100 AND "event_boosts"."expected_visits" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sms_hashes" (
	"hash" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "starter_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"project" text NOT NULL,
	"github_login" text NOT NULL,
	"introduction" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"github_created_at" timestamp with time zone NOT NULL,
	"reject_reason" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"grant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "starter_applications_lengths_check" CHECK (char_length("starter_applications"."project") between 1 and 1000 AND char_length("starter_applications"."github_login") between 1 and 39 AND char_length("starter_applications"."introduction") between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "starter_notices" (
	"grant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "starter_notices_grant_id_kind_pk" PRIMARY KEY("grant_id","kind")
);
--> statement-breakpoint
ALTER TABLE "event_boosts" ADD CONSTRAINT "event_boosts_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_boosts" ADD CONSTRAINT "event_boosts_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_boosts" ADD CONSTRAINT "event_boosts_requested_by_accounts_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_hashes" ADD CONSTRAINT "sms_hashes_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "starter_applications" ADD CONSTRAINT "starter_applications_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "starter_notices" ADD CONSTRAINT "starter_notices_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_boosts_app_idx" ON "event_boosts" USING btree ("app_id","starts_at");--> statement-breakpoint
CREATE INDEX "event_boosts_status_idx" ON "event_boosts" USING btree ("status","ends_at");--> statement-breakpoint
CREATE INDEX "sms_hashes_account_idx" ON "sms_hashes" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "starter_applications_live_idx" ON "starter_applications" USING btree ("account_id") WHERE "starter_applications"."status" IN ('pending', 'approved');--> statement-breakpoint
-- Starter 申請: 本人は読める・pending で作れるだけ。承認／差し戻し（status と審査の列）はシステム側（owner）と管理側だけ。
ALTER TABLE "starter_applications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "starter_applications" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "starter_applications" FROM platform_api;--> statement-breakpoint
GRANT SELECT, INSERT ON "starter_applications" TO platform_api;--> statement-breakpoint
GRANT SELECT, UPDATE ON "starter_applications" TO platform_admin;--> statement-breakpoint
CREATE POLICY own_select ON "starter_applications" FOR SELECT TO platform_api USING (account_id = app_account_id());--> statement-breakpoint
CREATE POLICY own_insert ON "starter_applications" FOR INSERT TO platform_api WITH CHECK (account_id = app_account_id() AND status = 'pending' AND reject_reason IS NULL AND reviewed_by IS NULL AND reviewed_at IS NULL AND grant_id IS NULL);--> statement-breakpoint
CREATE POLICY admin_read ON "starter_applications" FOR SELECT TO platform_admin USING (true);--> statement-breakpoint
CREATE POLICY admin_update ON "starter_applications" FOR UPDATE TO platform_admin USING (app_operator_id() IS NOT NULL) WITH CHECK (app_operator_id() IS NOT NULL);--> statement-breakpoint
-- 電話番号のハッシュと終了予告の記録: owner ロールだけ（platform_api にも platform_admin にも権限なし）。
ALTER TABLE "sms_hashes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sms_hashes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "sms_hashes" FROM platform_api;--> statement-breakpoint
ALTER TABLE "starter_notices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "starter_notices" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "starter_notices" FROM platform_api;--> statement-breakpoint
-- イベントブースト: 本人は自分が見えるアプリのものを読める・requested で申請できるだけ。承認／差し戻しはシステム側と管理側だけ。
ALTER TABLE "event_boosts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "event_boosts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "event_boosts" FROM platform_api;--> statement-breakpoint
GRANT SELECT, INSERT ON "event_boosts" TO platform_api;--> statement-breakpoint
GRANT SELECT, UPDATE ON "event_boosts" TO platform_admin;--> statement-breakpoint
CREATE POLICY own_select ON "event_boosts" FOR SELECT TO platform_api USING (EXISTS (SELECT 1 FROM apps a WHERE a.id = event_boosts.app_id));--> statement-breakpoint
CREATE POLICY own_insert ON "event_boosts" FOR INSERT TO platform_api WITH CHECK (requested_by = app_account_id() AND status = 'requested' AND extra_transfer_bytes IS NULL AND extra_memory_mb IS NULL AND grant_id IS NULL AND reviewed_by IS NULL AND reviewed_at IS NULL AND applied_at IS NULL AND restored_at IS NULL AND EXISTS (SELECT 1 FROM apps a WHERE a.id = event_boosts.app_id AND a.owner_id = event_boosts.owner_id));--> statement-breakpoint
CREATE POLICY admin_read ON "event_boosts" FOR SELECT TO platform_admin USING (true);--> statement-breakpoint
CREATE POLICY admin_update ON "event_boosts" FOR UPDATE TO platform_admin USING (app_operator_id() IS NOT NULL) WITH CHECK (app_operator_id() IS NOT NULL);
