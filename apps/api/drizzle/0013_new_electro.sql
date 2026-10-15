CREATE TABLE "github_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_installation_links" (
	"account_id" uuid NOT NULL,
	"installation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_installation_links_account_id_installation_id_pk" PRIMARY KEY("account_id","installation_id")
);
--> statement-breakpoint
CREATE TABLE "github_oauth_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_installation_links" ADD CONSTRAINT "github_installation_links_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_oauth_states" ADD CONSTRAINT "github_oauth_states_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_oauth_states_expires_idx" ON "github_oauth_states" USING btree ("expires_at");