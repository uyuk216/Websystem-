CREATE TABLE "security_audit" (
	"seq" bigint PRIMARY KEY NOT NULL,
	"incident_id" uuid NOT NULL,
	"action" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"prev_hash" text DEFAULT '' NOT NULL,
	"hash" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"app_id" uuid,
	"account_id" uuid,
	"ip_hash" text,
	"reason_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"released_by" uuid,
	"release_note" text,
	CONSTRAINT "security_blocks_target_check" CHECK ((
    ("security_blocks"."target_kind" = 'app' AND "security_blocks"."app_id" IS NOT NULL AND "security_blocks"."account_id" IS NULL AND "security_blocks"."ip_hash" IS NULL) OR
    ("security_blocks"."target_kind" = 'account' AND "security_blocks"."account_id" IS NOT NULL AND "security_blocks"."app_id" IS NULL AND "security_blocks"."ip_hash" IS NULL) OR
    ("security_blocks"."target_kind" = 'ip' AND "security_blocks"."ip_hash" IS NOT NULL AND "security_blocks"."app_id" IS NULL AND "security_blocks"."account_id" IS NULL)
  ))
);
--> statement-breakpoint
CREATE TABLE "security_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"source_event_id" text NOT NULL,
	"rule_version" text NOT NULL,
	"severity" text NOT NULL,
	"target_kind" text NOT NULL,
	"app_id" uuid,
	"account_id" uuid,
	"ip_hash" text,
	"reason_code" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence_digest" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_incidents_target_check" CHECK ((
    ("security_incidents"."target_kind" = 'app' AND "security_incidents"."app_id" IS NOT NULL AND "security_incidents"."account_id" IS NULL AND "security_incidents"."ip_hash" IS NULL) OR
    ("security_incidents"."target_kind" = 'account' AND "security_incidents"."account_id" IS NOT NULL AND "security_incidents"."app_id" IS NULL AND "security_incidents"."ip_hash" IS NULL) OR
    ("security_incidents"."target_kind" = 'ip' AND "security_incidents"."ip_hash" IS NOT NULL AND "security_incidents"."app_id" IS NULL AND "security_incidents"."account_id" IS NULL)
  ))
);
--> statement-breakpoint
CREATE TABLE "security_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"effect_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_outbox_effect_key_unique" UNIQUE("effect_key")
);
--> statement-breakpoint
ALTER TABLE "security_blocks" ADD CONSTRAINT "security_blocks_incident_id_security_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."security_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_blocks" ADD CONSTRAINT "security_blocks_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_blocks" ADD CONSTRAINT "security_blocks_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_blocks" ADD CONSTRAINT "security_blocks_released_by_operators_account_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."operators"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_incidents" ADD CONSTRAINT "security_incidents_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_incidents" ADD CONSTRAINT "security_incidents_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_outbox" ADD CONSTRAINT "security_outbox_incident_id_security_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."security_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "security_blocks_active_idx" ON "security_blocks" USING btree ("target_kind",coalesce("app_id"::text, "account_id"::text, "ip_hash"),"reason_code") WHERE "security_blocks"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "security_blocks_app_idx" ON "security_blocks" USING btree ("app_id") WHERE "security_blocks"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "security_blocks_ip_idx" ON "security_blocks" USING btree ("ip_hash") WHERE "security_blocks"."released_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "security_incidents_source_event_idx" ON "security_incidents" USING btree ("source","source_event_id");--> statement-breakpoint
CREATE INDEX "security_incidents_app_idx" ON "security_incidents" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "security_outbox_due_idx" ON "security_outbox" USING btree ("next_attempt_at") WHERE "security_outbox"."done_at" IS NULL;
--> statement-breakpoint
-- ---- 権限と行レベルの制限（手書き部分） ----
-- 書くのはシステム（owner ロール、withSystem）だけ。platform_api は自分のアプリ / アカウントの事件の要約を読めるだけで、証拠（evidence）の列は読めない。
REVOKE ALL ON "security_incidents", "security_blocks", "security_outbox", "security_audit" FROM platform_api;--> statement-breakpoint
REVOKE ALL ON "security_incidents", "security_blocks", "security_outbox", "security_audit" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ("id", "source", "severity", "target_kind", "app_id", "account_id", "reason_code", "status", "occurred_at", "created_at", "updated_at") ON "security_incidents" TO platform_api;--> statement-breakpoint
GRANT SELECT ON "security_incidents", "security_blocks", "security_outbox", "security_audit" TO platform_admin;--> statement-breakpoint
ALTER TABLE "security_incidents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "security_incidents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "security_blocks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "security_blocks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "security_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "security_outbox" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "security_audit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "security_audit" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY own_incidents ON "security_incidents" FOR SELECT TO platform_api
  USING (account_id = app_account_id() OR (app_id IS NOT NULL AND EXISTS (SELECT 1 FROM apps a WHERE a.id = security_incidents.app_id)));--> statement-breakpoint
CREATE POLICY admin_read ON "security_incidents" FOR SELECT TO platform_admin USING (true);--> statement-breakpoint
CREATE POLICY admin_read ON "security_blocks" FOR SELECT TO platform_admin USING (true);--> statement-breakpoint
CREATE POLICY admin_read ON "security_outbox" FOR SELECT TO platform_admin USING (true);--> statement-breakpoint
CREATE POLICY admin_read ON "security_audit" FOR SELECT TO platform_admin USING (true);--> statement-breakpoint
-- ---- システム用監査連鎖（admin_audit_log と同じ作り・別の連鎖） ----
CREATE FUNCTION security_audit_row_hash(p_seq bigint, p_prev text, p_incident uuid, p_action text, p_detail jsonb, p_at timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE AS
$$ SELECT encode(sha256(convert_to(concat_ws('|', p_seq::text, p_prev, p_incident::text, p_action, p_detail::text, (extract(epoch from p_at) * 1000000)::bigint::text), 'UTF8')), 'hex') $$;
--> statement-breakpoint
CREATE FUNCTION security_audit_chain() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE last_seq bigint; last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('security_audit'));
  SELECT seq, hash INTO last_seq, last_hash FROM security_audit ORDER BY seq DESC LIMIT 1;
  NEW.seq := coalesce(last_seq, 0) + 1;
  NEW.prev_hash := coalesce(last_hash, repeat('0', 64));
  NEW.hash := security_audit_row_hash(NEW.seq, NEW.prev_hash, NEW.incident_id, NEW.action, NEW.detail, NEW.created_at);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER security_audit_chain BEFORE INSERT ON "security_audit" FOR EACH ROW EXECUTE FUNCTION security_audit_chain();
--> statement-breakpoint
CREATE FUNCTION security_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION 'security_audit is append-only' USING ERRCODE = 'insufficient_privilege'; END $$;
--> statement-breakpoint
CREATE TRIGGER security_audit_no_update_delete BEFORE UPDATE OR DELETE ON "security_audit" FOR EACH ROW EXECUTE FUNCTION security_audit_immutable();
--> statement-breakpoint
CREATE TRIGGER security_audit_no_truncate BEFORE TRUNCATE ON "security_audit" FOR EACH STATEMENT EXECUTE FUNCTION security_audit_immutable();
--> statement-breakpoint
CREATE FUNCTION security_audit_verify() RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE r record; expect_seq bigint := 1; expect_prev text := repeat('0', 64);
BEGIN
  FOR r IN SELECT * FROM security_audit ORDER BY seq LOOP
    IF r.seq <> expect_seq OR r.prev_hash <> expect_prev
       OR r.hash <> security_audit_row_hash(r.seq, r.prev_hash, r.incident_id, r.action, r.detail, r.created_at) THEN
      RETURN r.seq;
    END IF;
    expect_seq := expect_seq + 1;
    expect_prev := r.hash;
  END LOOP;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION security_audit_verify() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION security_audit_verify() TO platform_admin;
