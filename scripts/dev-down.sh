#!/usr/bin/env bash
# 開発環境を止める。 --purge でボリューム(データ)も削除。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PURGE=0
for a in "$@"; do
  case "$a" in
    --purge) PURGE=1 ;;
    *) echo "不明なオプション: $a" >&2; exit 2 ;;
  esac
done

if command -v k3d >/dev/null 2>&1; then
  for name in platform tenant; do
    if k3d cluster list 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "$name"; then
      k3d cluster delete "$name"
    fi
  done
fi

if [ "$PURGE" -eq 1 ]; then
  docker compose -f dev/compose.yaml down -v
else
  docker compose -f dev/compose.yaml down
fi
