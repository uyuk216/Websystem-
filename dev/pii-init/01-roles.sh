#!/bin/sh
# 個人情報 DB の初期化（開発専用のダミーパスワード。本番では使わない）。ボリュームの初回作成時だけ走る。
set -eu
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -v admin_pw="${PII_ADMIN_PASSWORD:-pii_admin}" -v ingest_pw="${PII_INGEST_PASSWORD:-pii_ingest}" <<'SQL'
CREATE ROLE pii_admin LOGIN PASSWORD :'admin_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE pii_ingest LOGIN PASSWORD :'ingest_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
SQL
