-- Custom SQL migration file, put your code below! --
-- 0011 had ENABLE ROW LEVEL SECURITY swallowed by a comment line. Idempotent repair.
ALTER TABLE "transfer_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transfer_usage" FORCE ROW LEVEL SECURITY;
