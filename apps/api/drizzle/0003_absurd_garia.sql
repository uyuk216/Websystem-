ALTER TABLE "email_challenges" ADD COLUMN "scan_token" text;--> statement-breakpoint
ALTER TABLE "email_challenges" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_challenges" ADD COLUMN "requester_device_label" text;