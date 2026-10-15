#!/usr/bin/env bash
# 開発環境を起動する。 --no-k8s で k3d を飛ばす。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NO_K8S=0
for a in "$@"; do
  case "$a" in
    --no-k8s) NO_K8S=1 ;;
    *) echo "不明なオプション: $a" >&2; exit 2 ;;
  esac
done

if [ "$NO_K8S" -eq 1 ]; then
  bash scripts/doctor.sh --no-k8s
else
  bash scripts/doctor.sh
fi

if [ ! -f .env.development ]; then
  cp .env.development.example .env.development
  echo ".env.development を作成しました"
fi

docker compose -f dev/compose.yaml up -d --wait

if [ "$NO_K8S" -eq 0 ]; then
  for name in platform tenant; do
    if k3d cluster list 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "$name"; then
      echo "k3d クラスタ $name は作成済み"
    else
      k3d cluster create --config "dev/k3d/$name.yaml"
    fi
  done
fi

if [ -f apps/api/package.json ]; then
  pnpm --filter api db:migrate
else
  echo "apps/api がまだ無いので db:migrate をスキップします"
fi

echo "開発環境の起動が完了しました"
