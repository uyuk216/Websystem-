CREATE TABLE "transfer_usage" (
	"app_id" uuid NOT NULL,
	"month" text NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"notified_80" boolean DEFAULT false NOT NULL,
	CONSTRAINT "transfer_usage_app_id_month_pk" PRIMARY KEY("app_id","month"),
	CONSTRAINT "transfer_usage_month_format_check" CHECK ("transfer_usage"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
ALTER TABLE "transfer_usage" ADD CONSTRAINT "transfer_usage_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;