#!/usr/bin/env bash
# 動的アプリのイメージ置き場（レジストリ）を作り、k3d の tenant クラスタから取得できるようにする。何度実行してもよい。
# Mac からは localhost:5050 へ push し、クラスタのノードは同じ名前 localhost:5050 をレジストリのコンテナへ向ける。
# 使い方: bash scripts/k3d-registry.sh  →  IMAGE_REGISTRY=localhost:5050 を設定して api / worker を起動する
set -euo pipefail

CLUSTER="${1:-tenant}"
NAME=ys-registry.localhost
CONTAINER="k3d-$NAME"
PORT=5050

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  k3d registry create "$NAME" --port "$PORT"
fi
docker network connect "k3d-$CLUSTER" "$CONTAINER" 2>/dev/null || true

NODES=$(docker ps --filter "label=k3d.cluster=$CLUSTER" --format '{{.Names}} {{.Label "k3d.role"}}' | awk '$2=="server"||$2=="agent"{print $1}' | sort | tr '\n' ' ')
NODES="${NODES% }"
[ -n "$NODES" ] || { echo "クラスタ $CLUSTER のノードが見つかりません（先に pnpm dev:up）" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/registries.yaml" <<EOF
mirrors:
  "localhost:$PORT":
    endpoint:
      - "http://$CONTAINER:5000"
EOF
for n in $NODES; do
  docker exec "$n" mkdir -p /etc/rancher/k3s
  docker cp "$WORK/registries.yaml" "$n:/etc/rancher/k3s/registries.yaml"
done
# shellcheck disable=SC2086
docker restart $NODES >/dev/null
for _ in $(seq 1 60); do kubectl --context "k3d-$CLUSTER" get nodes >/dev/null 2>&1 && break; sleep 2; done
kubectl --context "k3d-$CLUSTER" wait --for=condition=Ready node --all --timeout=120s >/dev/null
echo "完了: IMAGE_REGISTRY=localhost:$PORT で、ビルドしたイメージをクラスタから取得できます"
