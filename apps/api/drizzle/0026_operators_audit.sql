CREATE TABLE "admin_audit_log" (
	"seq" bigint PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"prev_hash" text DEFAULT '' NOT NULL,
	"hash" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "admin_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "operators" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"tailscale_login" text NOT NULL,
	"role" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operators_tailscale_login_unique" UNIQUE("tailscale_login")
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_dangerous_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_by" uuid NOT NULL,
	"execute_after" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"notified_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_operator_id_operators_account_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_operator_id_operators_account_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operators" ADD CONSTRAINT "operators_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_updated_by_operators_account_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."operators"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_dangerous_actions" ADD CONSTRAINT "scheduled_dangerous_actions_requested_by_operators_account_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."operators"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_sessions_operator_idx" ON "admin_sessions" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "scheduled_dangerous_actions_due_idx" ON "scheduled_dangerous_actions" USING btree ("status","execute_after");--> statement-breakpoint
-- ---- 管理側の権限分離（手書き部分） ----
-- platform_admin: 管理側 API が withAdmin の中でだけ SET LOCAL ROLE する。platform_api からは operators 系の表を一切読めない。
DO $$
BEGIN
  BEGIN
    CREATE ROLE platform_admin NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
  END;
  BEGIN
    EXECUTE format('GRANT platform_admin TO %I', current_user);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO platform_admin;
--> statement-breakpoint
REVOKE ALL ON "operators", "admin_sessions", "admin_audit_log", "platform_settings", "scheduled_dangerous_actions" FROM platform_api;
--> statement-breakpoint
REVOKE ALL ON "operators", "admin_sessions", "admin_audit_log", "platform_settings", "scheduled_dangerous_actions" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON "operators" TO platform_admin;
--> statement-breakpoint
GRANT SELECT, INSERT ON "admin_audit_log" TO platform_admin;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "platform_settings" TO platform_admin;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "scheduled_dangerous_actions" TO platform_admin;
--> statement-breakpoint
ALTER TABLE "operators" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "operators" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admin_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admin_sessions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admin_audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admin_audit_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "platform_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "platform_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scheduled_dangerous_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scheduled_dangerous_actions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE FUNCTION app_operator_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.operator_id', true), '')::uuid $$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_operator_id() TO platform_admin;
--> statement-breakpoint
-- admin_sessions に platform_admin 用の policy は無い（セッションは所有者ロールだけが扱う）。platform_api 用の policy も無い。
CREATE POLICY admin_read ON "operators" FOR SELECT TO platform_admin USING (true);--> statement-breakpoint
CREATE POLICY admin_read ON "admin_audit_log" FOR SELECT TO platform_admin USING (true);--> statement-breakpoint
-- 記録は「いま操作している運営者」の名前でしか書けない（withAdmin が app.operator_id を設定する）。
CREATE POLICY admin_append ON "admin_audit_log" FOR INSERT TO platform_admin WITH CHECK (operator_id = app_operator_id());--> statement-breakpoint
CREATE POLICY admin_read ON "platform_settings" FOR SELECT TO platform_admin USING (true);--> statement-breakpoint
CREATE POLICY admin_insert ON "platform_settings" FOR INSERT TO platform_admin WITH CHECK (updated_by = app_operator_id());--> statement-breakpoint
CREATE POLICY admin_update ON "platform_settings" FOR UPDATE TO platform_admin USING (app_operator_id() IS NOT NULL) WITH CHECK (updated_by = app_operator_id());--> statement-breakpoint
CREATE POLICY admin_read ON "scheduled_dangerous_actions" FOR SELECT TO platform_admin USING (true);--> statement-breakpoint
CREATE POLICY admin_insert ON "scheduled_dangerous_actions" FOR INSERT TO platform_admin WITH CHECK (requested_by = app_operator_id());--> statement-breakpoint
CREATE POLICY admin_update ON "scheduled_dangerous_actions" FOR UPDATE TO platform_admin USING (app_operator_id() IS NOT NULL) WITH CHECK (app_operator_id() IS NOT NULL);
--> statement-breakpoint
-- ---- 追記専用の記録 + ハッシュ連鎖 ----
CREATE FUNCTION admin_audit_row_hash(p_seq bigint, p_prev text, p_operator uuid, p_action text, p_target text, p_detail jsonb, p_at timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE AS
$$ SELECT encode(sha256(convert_to(concat_ws('|', p_seq::text, p_prev, p_operator::text, p_action, p_target, p_detail::text, (extract(epoch from p_at) * 1000000)::bigint::text), 'UTF8')), 'hex') $$;
--> statement-breakpoint
-- seq / prev_hash / hash は必ずここで決める（呼び出し側の値は上書き）。advisory lock で追記を直列化し、seq の順 = 連鎖の順にする。
CREATE FUNCTION admin_audit_chain() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE last_seq bigint; last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('admin_audit_log'));
  SELECT seq, hash INTO last_seq, last_hash FROM admin_audit_log ORDER BY seq DESC LIMIT 1;
  NEW.seq := coalesce(last_seq, 0) + 1;
  NEW.prev_hash := coalesce(last_hash, repeat('0', 64));
  NEW.hash := admin_audit_row_hash(NEW.seq, NEW.prev_hash, NEW.operator_id, NEW.action, NEW.target, NEW.detail, NEW.created_at);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER admin_audit_chain BEFORE INSERT ON "admin_audit_log" FOR EACH ROW EXECUTE FUNCTION admin_audit_chain();
--> statement-breakpoint
CREATE FUNCTION admin_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION 'admin_audit_log is append-only' USING ERRCODE = 'insufficient_privilege'; END $$;
--> statement-breakpoint
CREATE TRIGGER admin_audit_no_update_delete BEFORE UPDATE OR DELETE ON "admin_audit_log" FOR EACH ROW EXECUTE FUNCTION admin_audit_immutable();
--> statement-breakpoint
CREATE TRIGGER admin_audit_no_truncate BEFORE TRUNCATE ON "admin_audit_log" FOR EACH STATEMENT EXECUTE FUNCTION admin_audit_immutable();
--> statement-breakpoint
-- 連鎖の検証：最初に食い違った seq を返す（全部正しければ NULL）。seq の欠番・前のハッシュ・各行のハッシュを確かめる。
CREATE FUNCTION admin_audit_verify() RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE r record; expect_seq bigint := 1; expect_prev text := repeat('0', 64);
BEGIN
  FOR r IN SELECT * FROM admin_audit_log ORDER BY seq LOOP
    IF r.seq <> expect_seq OR r.prev_hash <> expect_prev
       OR r.hash <> admin_audit_row_hash(r.seq, r.prev_hash, r.operator_id, r.action, r.target, r.detail, r.created_at) THEN
      RETURN r.seq;
    END IF;
    expect_seq := expect_seq + 1;
    expect_prev := r.hash;
  END LOOP;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_audit_verify() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_audit_verify() TO platform_admin;
