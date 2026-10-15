-- Row Level Security. The API runs each transaction as platform_api (SET LOCAL ROLE) with
-- app.account_id set; the owner role (migrations, withSystem) must be a superuser or BYPASSRLS.
DO $$
BEGIN
  BEGIN
    CREATE ROLE platform_api NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
  END;
  BEGIN
    EXECUTE format('GRANT platform_api TO %I', current_user);
  EXCEPTION WHEN OTHERS THEN NULL; -- already a member (or concurrent grant from a sibling database)
  END;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO platform_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_api;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO platform_api;
--> statement-breakpoint
-- Team deletion removes members while the deleting member is still visible to the teams policy.
ALTER TABLE "team_members" DROP CONSTRAINT "team_members_team_id_teams_id_fk";
--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "team_invites" DROP CONSTRAINT "team_invites_team_id_teams_id_fk";
--> statement-breakpoint
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE FUNCTION app_account_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.account_id', true), '')::uuid $$;
--> statement-breakpoint
-- SECURITY DEFINER so the lookup is not itself subject to the team_members policy (no recursion).
CREATE FUNCTION app_is_team_member(team uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT EXISTS (SELECT 1 FROM team_members WHERE team_id = team AND account_id = app_account_id()) $$;
--> statement-breakpoint
CREATE FUNCTION app_team_is_empty(team uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT NOT EXISTS (SELECT 1 FROM team_members WHERE team_id = team) $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_is_team_member(uuid), app_team_is_empty(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_account_id(), app_is_team_member(uuid), app_team_is_empty(uuid) TO platform_api;
--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "passkeys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "passkeys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "login_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "login_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "teams" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "teams" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_members" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_invites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_invites" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY own_rows ON "sessions" TO platform_api USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());--> statement-breakpoint
CREATE POLICY own_rows ON "passkeys" TO platform_api USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());--> statement-breakpoint
CREATE POLICY own_rows ON "login_events" TO platform_api USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());--> statement-breakpoint
-- A new team is inserted before its first member exists, so inserting needs only an authenticated account.
CREATE POLICY member_select ON "teams" FOR SELECT TO platform_api USING (app_is_team_member(id));--> statement-breakpoint
CREATE POLICY member_update ON "teams" FOR UPDATE TO platform_api USING (app_is_team_member(id)) WITH CHECK (app_is_team_member(id));--> statement-breakpoint
CREATE POLICY member_delete ON "teams" FOR DELETE TO platform_api USING (app_is_team_member(id));--> statement-breakpoint
CREATE POLICY authed_insert ON "teams" FOR INSERT TO platform_api WITH CHECK (app_account_id() IS NOT NULL);--> statement-breakpoint
CREATE POLICY member_rows ON "team_members" FOR ALL TO platform_api USING (app_is_team_member(team_id)) WITH CHECK (app_is_team_member(team_id));--> statement-breakpoint
-- Founding membership: only as the owner of a team that has no members yet.
CREATE POLICY found_team ON "team_members" FOR INSERT TO platform_api
  WITH CHECK (account_id = app_account_id() AND role = 'owner' AND app_team_is_empty(team_id));--> statement-breakpoint
CREATE POLICY member_rows ON "team_invites" FOR ALL TO platform_api USING (app_is_team_member(team_id)) WITH CHECK (app_is_team_member(team_id));
