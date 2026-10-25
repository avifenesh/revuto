#!/usr/bin/env bash
# Start SurrealDB for the reviewer (backend: surreal). Persistent surrealkv store.
#
#   scripts/surreal-start.sh                 # 127.0.0.1:8000, data under the vault
#   PORT=8000 SURREAL_DATA=~/revuto/memory/surreal scripts/surreal-start.sh
#
# The root password is REVUTO_SURREAL_PASSWORD. When it is unset and not in
# ~/.config/revuto/env, a random one is generated and saved there (mode 0600);
# revuto reads the same file. Browsers are refused (--allow-origin), and embedded
# scripting is off: revuto uses neither.
set -euo pipefail
PORT="${PORT:-8000}"
SUSER="${SURREAL_USER:-root}"
DATA="${SURREAL_DATA:-$HOME/revuto/memory/surreal}"
ENV_FILE="${REVUTO_ENV_FILE:-$HOME/.config/revuto/env}"
if [[ -z "${REVUTO_SURREAL_PASSWORD:-}" && -f "$ENV_FILE" ]]; then
  REVUTO_SURREAL_PASSWORD="$(sed -n 's/^REVUTO_SURREAL_PASSWORD=//p' "$ENV_FILE" | tail -n 1)"
fi
if [[ -z "${REVUTO_SURREAL_PASSWORD:-}" ]]; then
  REVUTO_SURREAL_PASSWORD="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  mkdir -p "$(dirname "$ENV_FILE")"
  umask 077
  printf 'REVUTO_SURREAL_PASSWORD=%s\n' "$REVUTO_SURREAL_PASSWORD" >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "generated a SurrealDB root password in $ENV_FILE" >&2
fi
mkdir -p "$(dirname "$DATA")"
SURREAL_BIN="${SURREAL_BIN:-$HOME/.local/bin/surreal}"
# The credentials go through the environment, not argv, so `ps` does not show them.
export SURREAL_USER="$SUSER" SURREAL_PASS="$REVUTO_SURREAL_PASSWORD"
exec "$SURREAL_BIN" start --allow-origin http://127.0.0.1 --deny-scripting \
  --bind "127.0.0.1:$PORT" "surrealkv://$DATA"
