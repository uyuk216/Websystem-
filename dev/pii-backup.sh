#!/bin/sh
# 個人情報 DB のバックアップ（開発用）。テーブルのコメントが 'backup:exclude' のテーブル（student_id_blobs）は、
# 定義だけを残してデータを含めない。使い方: dev/pii-backup.sh [出力ファイル|-] [データベース名]
set -eu
OUT="${1:--}"
DB="${2:-pii}"
CONTAINER="${PII_CONTAINER:-ys-pii-db}"
OWNER="${PII_OWNER_USER:-pii_owner}"
EXCLUDES=""
for t in $(docker exec "$CONTAINER" psql -U "$OWNER" -d "$DB" -At -c \
  "SELECT c.relname FROM pg_class c JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = 0 WHERE d.description = 'backup:exclude' AND c.relkind = 'r'"); do
  EXCLUDES="$EXCLUDES --exclude-table-data=$t"
done
# shellcheck disable=SC2086
if [ "$OUT" = "-" ]; then
  docker exec "$CONTAINER" pg_dump -U "$OWNER" -d "$DB" --no-owner $EXCLUDES
else
  docker exec "$CONTAINER" pg_dump -U "$OWNER" -d "$DB" --no-owner $EXCLUDES > "$OUT"
fi
