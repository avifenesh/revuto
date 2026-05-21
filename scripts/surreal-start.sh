#!/usr/bin/env bash
# Start SurrealDB for the reviewer (backend: surreal). Persistent surrealkv store.
#
#   scripts/surreal-start.sh                 # 127.0.0.1:8000, data under the vault
#   PORT=8000 SURREAL_DATA=~/reviewer-vault/memory/surreal scripts/surreal-start.sh
#
# Then in reviewer.config.json:
#   "store": { "backend": "surreal",
#              "surreal": { "url": "http://127.0.0.1:8000/rpc", "namespace": "reviewer",
#                           "username": "root", "password": "root" } }
set -euo pipefail
PORT="${PORT:-8000}"
SUSER="${SURREAL_USER:-root}"
SPASS="${SURREAL_PASS:-root}"
DATA="${SURREAL_DATA:-$HOME/reviewer-vault/memory/surreal}"
mkdir -p "$(dirname "$DATA")"
SURREAL_BIN="${SURREAL_BIN:-$HOME/.local/bin/surreal}"
exec "$SURREAL_BIN" start --user "$SUSER" --pass "$SPASS" --bind "127.0.0.1:$PORT" "surrealkv://$DATA"
