#!/usr/bin/env bash
# Start SurrealDB for the reviewer (backend: surreal). Persistent surrealkv store.
#
#   scripts/surreal-start.sh                 # 127.0.0.1:8000, data under the vault
#   PORT=8000 SURREAL_DATA=~/revuto/memory/surreal scripts/surreal-start.sh
#
# The root password is REVUTO_SURREAL_PASSWORD, read the way revuto reads it: the
# environment first, else the first non-empty REVUTO_SURREAL_PASSWORD= line of
# ~/.config/revuto/env (trimmed, surrounding quotes removed). A new store with no
# password gets a random one, saved there (mode 0600). An existing store with no
# password stops here: see "Storage backend" in docs/configuration.md to move it
# off the old root/root login. Browsers are refused (--allow-origin) and embedded
# scripting is off: revuto uses neither.
set -euo pipefail
PORT="${PORT:-8000}"
SUSER="${SURREAL_USER:-root}"
DATA="${SURREAL_DATA:-$HOME/revuto/memory/surreal}"
ENV_FILE="${REVUTO_ENV_FILE:-$HOME/.config/revuto/env}"

# Same rules as loadRevutoEnv in agents/common/src/config.ts.
read_env_value() {
  local file=$1 want=$2 line key val
  [[ -f "$file" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" || "$line" == \#* || "$line" != *=* ]] && continue
    key="${line%%=*}"
    key="${key%"${key##*[![:space:]]}"}"
    [[ "$key" == "$want" ]] || continue
    val="${line#*=}"
    val="${val#"${val%%[![:space:]]*}"}"
    if [[ ${#val} -ge 2 && ( ( "$val" == \"*\" ) || ( "$val" == \'*\' ) ) ]]; then val="${val:1:${#val}-2}"; fi
    # An empty value does not count: revuto lets a later line fill it, and so does this.
    [[ -n "$val" ]] || continue
    printf '%s' "$val"
    return 0
  done < "$file"
  return 1
}

if [[ -z "${REVUTO_SURREAL_PASSWORD:-}" ]]; then
  REVUTO_SURREAL_PASSWORD="$(read_env_value "$ENV_FILE" REVUTO_SURREAL_PASSWORD || true)"
fi
if [[ -z "${REVUTO_SURREAL_PASSWORD:-}" ]]; then
  if [[ -e "$DATA" ]]; then
    echo "surreal-start: $DATA exists but REVUTO_SURREAL_PASSWORD is not set." >&2
    echo "A store created before this script generated passwords still has its old root login;" >&2
    echo "follow the migration in docs/configuration.md, then put the password in $ENV_FILE." >&2
    exit 1
  fi
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
