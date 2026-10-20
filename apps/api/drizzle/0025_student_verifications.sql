CREATE TABLE "student_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"school_name" text NOT NULL,
	"school_kind" text NOT NULL,
	"expected_graduation_year" integer NOT NULL,
	"valid_until" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"reject_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_verifications_school_name_check" CHECK (char_length("student_verifications"."school_name") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "verification_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"verification_id" uuid NOT NULL,
	"blob_ref" text,
	"token_hash" text NOT NULL,
	"token_expires_at" timestamp with time zone NOT NULL,
	"token_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_uploads_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "student_verifications" ADD CONSTRAINT "student_verifications_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_uploads" ADD CONSTRAINT "verification_uploads_verification_id_student_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."student_verifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "student_verifications_account_idx" ON "student_verifications" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "verification_uploads_verification_idx" ON "verification_uploads" USING btree ("verification_id");--> statement-breakpoint
ALTER TABLE "student_verifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "student_verifications" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- 本人だけが読める。作る・直せるのは pending の間だけで、承認・差し戻し・期限切れ（status と審査の列）はシステム側（owner）だけが書く。
CREATE POLICY own_select ON "student_verifications" FOR SELECT TO platform_api USING (account_id = app_account_id());--> statement-breakpoint
CREATE POLICY own_insert ON "student_verifications" FOR INSERT TO platform_api WITH CHECK (account_id = app_account_id() AND status = 'pending' AND valid_until IS NULL AND reviewed_at IS NULL AND reject_reason IS NULL);--> statement-breakpoint
CREATE POLICY own_update ON "student_verifications" FOR UPDATE TO platform_api USING (account_id = app_account_id() AND status = 'pending') WITH CHECK (account_id = app_account_id() AND status = 'pending' AND valid_until IS NULL AND reviewed_at IS NULL AND reject_reason IS NULL);--> statement-breakpoint
ALTER TABLE "verification_uploads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "verification_uploads" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- 自分の verification に属する提出だけが見える。取り込み口のトークン消費（token_used_at / blob_ref）はシステム側だけが書く。
CREATE POLICY own_select ON "verification_uploads" FOR SELECT TO platform_api USING (EXISTS (SELECT 1 FROM student_verifications v WHERE v.id = verification_uploads.verification_id));--> statement-breakpoint
CREATE POLICY own_insert ON "verification_uploads" FOR INSERT TO platform_api WITH CHECK (token_used_at IS NULL AND blob_ref IS NULL AND EXISTS (SELECT 1 FROM student_verifications v WHERE v.id = verification_uploads.verification_id AND v.status = 'pending'));
