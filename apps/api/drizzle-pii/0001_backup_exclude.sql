-- 暗号文はバックアップに含めない。バックアップ用スクリプト（dev/pii-backup.sh）がこの目印を見て除外する。
COMMENT ON TABLE "student_id_blobs" IS 'backup:exclude';
