#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

node_bin="${NODE_BIN:-/home/avifenesh/.nvm/versions/node/v25.9.0/bin/node}"
if [[ ! -x "$node_bin" ]]; then
  node_bin="$(command -v node)"
fi

if [[ ! -f dashboard/build/index.js ]]; then
  npm run dashboard:build
fi

export NODE_ENV="${NODE_ENV:-production}"
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-5180}"
export ORIGIN="${ORIGIN:-http://${HOST}:${PORT}}"

exec "$node_bin" dashboard/build/index.js
