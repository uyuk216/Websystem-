ALTER TABLE "email_challenges" ADD COLUMN "opener_device_key" text;--> statement-breakpoint
-- Least privilege for platform_api: pre-auth tables are reachable only through the owner role (withSystem).
REVOKE ALL ON "email_challenges", "recovery_requests", "recovery_attempts", "webauthn_challenges" FROM platform_api;
--> statement-breakpoint
-- SECURITY DEFINER so the lookup is not itself subject to the team_members policy.
CREATE FUNCTION app_shares_team(other uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT EXISTS (SELECT 1 FROM team_members a JOIN team_members b ON a.team_id = b.team_id WHERE a.account_id = app_account_id() AND b.account_id = other) $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_shares_team(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_shares_team(uuid) TO platform_api;
--> statement-breakpoint
ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "accounts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "owners" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "owners" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY own_row ON "accounts" FOR ALL TO platform_api USING (id = app_account_id()) WITH CHECK (id = app_account_id());--> statement-breakpoint
-- Teammates' display names are visible (read-only) to fellow team members.
CREATE POLICY teammate_select ON "accounts" FOR SELECT TO platform_api USING (app_shares_team(id));--> statement-breakpoint
CREATE POLICY own_rows ON "owners" FOR ALL TO platform_api
  USING ((kind = 'account' AND account_id = app_account_id()) OR (kind = 'team' AND app_is_team_member(team_id)))
  WITH CHECK ((kind = 'account' AND account_id = app_account_id()) OR (kind = 'team' AND app_is_team_member(team_id)));
