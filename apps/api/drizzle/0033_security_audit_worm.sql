-- WORM（Object Lock）配送の記録。配送した範囲・digest・保管先の版・保持期限・checkpoint の版だけを持つ（内容は持たない）。
CREATE TABLE audit_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 stream text NOT NULL CHECK (stream IN ('security', 'admin')),
 from_seq bigint NOT NULL CHECK (from_seq >= 1), to_seq bigint NOT NULL,
 prev_batch_digest text NOT NULL CHECK (prev_batch_digest ~ '^[a-f0-9]{64}$'),
 digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
 object_key text NOT NULL, object_version text, retain_until timestamptz, checkpoint_version text,
 created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz,
 attempts integer NOT NULL DEFAULT 0, failure_code text,
 CHECK (to_seq >= from_seq),
 UNIQUE (stream, from_seq), UNIQUE (stream, to_seq)
);
--> statement-breakpoint
ALTER TABLE audit_deliveries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_deliveries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON audit_deliveries FROM platform_api, platform_admin, PUBLIC;
--> statement-breakpoint
GRANT SELECT ON audit_deliveries TO platform_admin;
--> statement-breakpoint
CREATE POLICY admin_read ON audit_deliveries FOR SELECT TO platform_admin USING (true);
--> statement-breakpoint
-- 配送記録は消せず、範囲・digest・前 digest・key は変えられない（版・保持・配送時刻・失敗回数だけ更新できる）。
CREATE FUNCTION audit_deliveries_guard() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'audit_deliveries is append-only' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NEW.stream <> OLD.stream OR NEW.from_seq <> OLD.from_seq OR NEW.to_seq <> OLD.to_seq OR NEW.digest <> OLD.digest
     OR NEW.prev_batch_digest <> OLD.prev_batch_digest OR NEW.object_key <> OLD.object_key THEN
    RAISE EXCEPTION 'audit_deliveries range is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.delivered_at IS NOT NULL AND (NEW.object_version IS DISTINCT FROM OLD.object_version OR NEW.checkpoint_version IS DISTINCT FROM OLD.checkpoint_version OR NEW.delivered_at IS DISTINCT FROM OLD.delivered_at) THEN
    RAISE EXCEPTION 'delivered record is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_deliveries_guard BEFORE UPDATE OR DELETE ON audit_deliveries FOR EACH ROW EXECUTE FUNCTION audit_deliveries_guard();
--> statement-breakpoint
CREATE TRIGGER audit_deliveries_no_truncate BEFORE TRUNCATE ON audit_deliveries FOR EACH STATEMENT EXECUTE FUNCTION audit_deliveries_guard();
