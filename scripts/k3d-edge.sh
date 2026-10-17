#!/usr/bin/env bash
# エッジ（apps/static）を k3d の tenant クラスタの ys-system で動かす（開発用）。何度実行してもよい。
# 先に scripts/k3d-registry.sh を実行しておくこと。Mac の http://localhost:8081 にホスト名を付けて届く。
# 設定値は .env.development から作り、DB などの localhost はクラスタから見たホスト（host.k3d.internal）に置き換える。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
CONTEXT="k3d-${1:-tenant}"
IMAGE=localhost:5050/ys/edge:dev
RC="${K8S_RUNTIME_CLASS:-gvisor}"

docker build -q -t "$IMAGE" -f dev/k8s/edge.Dockerfile . >/dev/null
docker push -q "$IMAGE" >/dev/null

# host.k3d.internal（Mac 側の DB・MinIO）を CoreDNS に登録し直す。k3s はノードの再起動でこの行を消すため。
NODE=$(docker ps --filter "label=k3d.cluster=${1:-tenant}" --filter "label=k3d.role=server" --format '{{.Names}}' | head -1)
HOST_IP=$(docker exec "$NODE" nslookup host.docker.internal 2>/dev/null | awk '/^Address/ && $2 !~ /#/ {ip=$2} END {print ip}')
[ -n "$HOST_IP" ] || HOST_IP=$(docker network inspect "k3d-${1:-tenant}" --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}')
HOSTS=$(kubectl --context "$CONTEXT" -n kube-system get cm coredns -o jsonpath='{.data.NodeHosts}')
if ! grep -q 'host.k3d.internal' <<<"$HOSTS"; then
  NEW=$(printf '%s\n%s host.k3d.internal' "$HOSTS" "$HOST_IP")
  kubectl --context "$CONTEXT" -n kube-system patch cm coredns --type merge -p "$(python3 -c 'import json,sys;print(json.dumps({"data":{"NodeHosts":sys.argv[1]}}))' "$NEW")" >/dev/null
  kubectl --context "$CONTEXT" -n kube-system rollout restart deployment/coredns >/dev/null
  kubectl --context "$CONTEXT" -n kube-system rollout status deployment/coredns --timeout=60s >/dev/null
fi

kubectl --context "$CONTEXT" create namespace ys-system --dry-run=client -o yaml | kubectl --context "$CONTEXT" apply -f - >/dev/null
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
grep -E '^[A-Z0-9_]+=' .env.development | sed 's#localhost:#host.k3d.internal:#g; s#//localhost#//host.k3d.internal#g' > "$WORK/env"
echo "K8S_RUNTIME_CLASS=$RC" >> "$WORK/env"
kubectl --context "$CONTEXT" -n ys-system create secret generic ys-edge-env --from-env-file="$WORK/env" --dry-run=client -o yaml \
  | kubectl --context "$CONTEXT" apply -f - >/dev/null
kubectl --context "$CONTEXT" apply -f dev/k8s/edge.yaml >/dev/null
kubectl --context "$CONTEXT" -n ys-system rollout restart deployment/ys-edge >/dev/null
kubectl --context "$CONTEXT" -n ys-system rollout status deployment/ys-edge --timeout=180s
echo "完了: curl -H 'Host: <アプリ名>.localhost' http://localhost:8081/"
