#!/usr/bin/env bash
# k3d の tenant クラスタの各ノードに gVisor（runsc）を入れ、RuntimeClass "gvisor" を作る。何度実行してもよい。
# 公式の配布物を固定の版で取得し、SHA-512 を確かめてから入れる。Mac 本体には何も入れない。
set -euo pipefail

CLUSTER="${1:-tenant}"
VERSION="${GVISOR_VERSION:-20261012}"
CONTEXT="k3d-$CLUSTER"
NODES=$(docker ps --filter "label=k3d.cluster=$CLUSTER" --format '{{.Names}} {{.Label "k3d.role"}}' | awk '$2=="server"||$2=="agent"{print $1}' | sort | tr '\n' ' ')
NODES="${NODES% }"
[ -n "$NODES" ] || { echo "クラスタ $CLUSTER のノードが見つかりません（先に pnpm dev:up）" >&2; exit 1; }

ARCH=$(docker exec "${NODES%% *}" uname -m)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
URL="https://storage.googleapis.com/gvisor/releases/release/$VERSION/$ARCH/gvisor.tar.bz2"
echo "gVisor $VERSION ($ARCH) を取得: $URL"
curl -fsSL -o "$WORK/gvisor.tar.bz2" "$URL"
curl -fsSL -o "$WORK/gvisor.tar.bz2.sha512" "$URL.sha512"
(cd "$WORK" && shasum -a 512 -c gvisor.tar.bz2.sha512)
mkdir "$WORK/x"
tar -xjf "$WORK/gvisor.tar.bz2" -C "$WORK/x"
printf "[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runsc]\n  runtime_type = \"io.containerd.runsc.v1\"\n" > "$WORK/runsc.toml"

CONF_D=/var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.d
for n in $NODES; do
  docker cp "$WORK/x/runsc" "$n:/bin/runsc"
  docker cp "$WORK/x/containerd-shim-runsc-v1" "$n:/bin/containerd-shim-runsc-v1"
  docker cp "$WORK/x/gvisor-bin" "$n:/bin/gvisor-bin"
  docker exec "$n" sh -c "chmod +x /bin/runsc /bin/containerd-shim-runsc-v1 /bin/gvisor-bin/*; mkdir -p $CONF_D"
  docker cp "$WORK/runsc.toml" "$n:$CONF_D/runsc.toml"
  echo "$n: $(docker exec "$n" runsc --version | head -1)"
done

# containerd に設定を読み込ませるためノードを再起動する（Pod は作り直される）
# shellcheck disable=SC2086
docker restart $NODES >/dev/null
# 再起動直後は API サーバーがまだ応答しないので、応答するまで待つ
for _ in $(seq 1 60); do kubectl --context "$CONTEXT" get nodes >/dev/null 2>&1 && break; sleep 2; done
kubectl --context "$CONTEXT" wait --for=condition=Ready node --all --timeout=120s >/dev/null
printf 'apiVersion: node.k8s.io/v1\nkind: RuntimeClass\nmetadata:\n  name: gvisor\nhandler: runsc\n' | kubectl --context "$CONTEXT" apply -f -
echo "完了: Pod に runtimeClassName: gvisor を付けると gVisor で動きます"
