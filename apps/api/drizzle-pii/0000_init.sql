-- 個人情報 DB 専用のマイグレーション（本体 DB の apps/api/drizzle とは別。適用は packages/platform の pii:migrate）。
-- 本体 DB と共有する ID は account_id / upload_id の UUID だけ。外部キーは張らない（別 DB）。
DO $$
BEGIN
  BEGIN
    CREATE ROLE pii_admin NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
  END;
  BEGIN
    CREATE ROLE pii_ingest NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
  END;
END
$$;
--> statement-breakpoint
CREATE TABLE "student_id_blobs" (
  "upload_id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "ciphertext" bytea NOT NULL,
  "size_bytes" integer NOT NULL CHECK ("size_bytes" > 0),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX "student_id_blobs_expires_idx" ON "student_id_blobs" ("expires_at");
--> statement-breakpoint
CREATE INDEX "student_id_blobs_account_idx" ON "student_id_blobs" ("account_id");
--> statement-breakpoint
CREATE TABLE "verification_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "upload_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "operator_id" uuid NOT NULL,
  "result" text NOT NULL CHECK ("result" IN ('approved', 'rejected')),
  "reviewed_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "verification_reviews_upload_idx" ON "verification_reviews" ("upload_id");
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO pii_admin, pii_ingest;
--> statement-breakpoint
-- 取り込み口（pii_ingest）：暗号文の追記のみ。SELECT / UPDATE / DELETE は付けない（書いた行も読めない）。
GRANT INSERT ON "student_id_blobs" TO pii_ingest;
--> statement-breakpoint
-- 管理画面（pii_admin）：暗号文の読み取りと削除、審査の記録の追記。審査の記録は書き換え・削除できない。
GRANT SELECT, DELETE ON "student_id_blobs" TO pii_admin;
--> statement-breakpoint
GRANT SELECT, INSERT ON "verification_reviews" TO pii_admin;
