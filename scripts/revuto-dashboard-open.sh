#!/usr/bin/env bash
set -euo pipefail

url="${REVUTO_DASHBOARD_URL:-http://127.0.0.1:5180}"
service="${REVUTO_DASHBOARD_SERVICE:-revuto-dashboard.service}"

notify() {
  if command -v notify-send >/dev/null 2>&1; then
    notify-send "Revuto Watch" "$1" >/dev/null 2>&1 || true
  fi
}

if command -v systemctl >/dev/null 2>&1; then
  if ! systemctl --user start "$service" >/dev/null 2>&1; then
    notify "Could not start ${service}. Check: journalctl --user -u ${service}"
  fi
fi

open_url="$url"
separator='?'
if [[ "$open_url" == *\?* ]]; then
  separator='&'
fi
open_url="${open_url}${separator}open=$(date +%s)"

for _ in $(seq 1 80); do
  if curl -fsS "${url}/api/snapshot" >/dev/null 2>&1; then
    if command -v xdg-open >/dev/null 2>&1; then
      exec xdg-open "$open_url"
    fi
    printf '%s\n' "$open_url"
    exit 0
  fi
  sleep 0.25
done

notify "Dashboard did not become ready at ${url}"
printf 'Revuto Watch did not become ready at %s\n' "$url" >&2
exit 1
