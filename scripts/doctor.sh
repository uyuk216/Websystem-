#!/usr/bin/env bash
# 開発に必要なツールの有無を確認する。--no-k8s のとき k3d は不要。
set -euo pipefail

NEED_K8S=1
for a in "$@"; do
  [ "$a" = "--no-k8s" ] && NEED_K8S=0
done

OS="$(uname -s)"
MISSING=0

hint() { # $1=mac, $2=linux
  if [ "$OS" = "Darwin" ]; then echo "    インストール: $1"; else echo "    インストール: $2"; fi
}

ng() { echo "[NG] $1 が見つかりません / $1 not found"; hint "$2" "$3"; MISSING=1; }

if command -v docker >/dev/null 2>&1; then
  echo "[OK] docker $(docker --version 2>/dev/null | head -n1)"
  if ! docker info >/dev/null 2>&1; then
    echo "[NG] docker デーモンに接続できません。Docker を起動してください"
    MISSING=1
  fi
else
  ng docker "brew install --cask docker (Docker Desktop)" "https://docs.docker.com/engine/install/ubuntu/"
fi

if command -v node >/dev/null 2>&1; then
  NV="$(node -v | sed 's/^v//')"
  MAJOR="${NV%%.*}"
  if [ "$MAJOR" -ge 22 ]; then
    echo "[OK] node v$NV"
  else
    echo "[NG] node v$NV (22 以上が必要)"
    hint "brew install node@22" "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
    MISSING=1
  fi
else
  ng node "brew install node@22" "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
fi

if command -v pnpm >/dev/null 2>&1; then
  echo "[OK] pnpm $(pnpm -v)"
else
  ng pnpm "brew install pnpm" "corepack enable && corepack prepare pnpm@10 --activate"
fi

if [ "$NEED_K8S" -eq 1 ]; then
  if command -v k3d >/dev/null 2>&1; then
    echo "[OK] k3d $(k3d version | head -n1)"
  else
    ng k3d "brew install k3d" "curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash"
  fi
else
  echo "[--] k3d: --no-k8s のためスキップ"
fi

if [ "$MISSING" -ne 0 ]; then
  echo "足りないツールがあります。上の手順で入れてください。"
  exit 1
fi
echo "doctor: すべて揃っています"
echo '[NOT INSTALLED] Phase 6 Falco/Linux driver: disabled; no collector/runtime visibility verified'
echo '[NOT INSTALLED] Phase 6 runtime metrics and mandatory egress proxy: disabled; bypass prevention unverified'
echo '[NOT INSTALLED] Phase 6 Safe Browsing and durable distribution collector: no external URL inspection; new publication held'
echo '[NOT INSTALLED] Phase 6 IP anonymity data (VPN/proxy/Tor): no data; protected actions return 503 in enforce, nothing is blocked in observe'
echo '[NOT INSTALLED] Phase 6 honeytoken values and DB audit extension: decoys not configured; no decoy reads are observed'
echo '[NOT INSTALLED] Phase 6 Object Lock audit storage: audit rows stay only in the DB chain; delivery and tamper checks are unproven'
echo '[INCOMPLETE] Phase 6 production defense: every part above must be installed and in enforce mode (see docs/security/phase6-operations.md; run: pnpm --filter api security:status)'
