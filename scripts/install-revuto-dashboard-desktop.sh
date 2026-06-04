#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
service_src="${repo_root}/deploy/revuto-dashboard.service"
service_dst="${HOME}/.config/systemd/user/revuto-dashboard.service"
app_dst="${HOME}/.local/share/applications/revuto-watch.desktop"
desktop_dst="${HOME}/Desktop/revuto-watch.desktop"
icon_path="${repo_root}/dashboard/static/favicon.svg"
open_script="${repo_root}/scripts/revuto-dashboard-open.sh"

cd "$repo_root"

npm run dashboard:build

mkdir -p "${HOME}/.config/systemd/user" "${HOME}/.local/share/applications"
install -m 0644 "$service_src" "$service_dst"
systemctl --user daemon-reload

if command -v fuser >/dev/null 2>&1; then
  pids="$(fuser 5180/tcp 2>/dev/null || true)"
  for pid in $pids; do
    cmd="$(ps -p "$pid" -o args= 2>/dev/null || true)"
    case "$cmd" in
      *"/dashboard/node_modules/.bin/vite"*|*"vite --host 127.0.0.1 --port 5180"*)
        kill "$pid" 2>/dev/null || true
        ;;
    esac
  done
fi

systemctl --user enable --now revuto-dashboard.service

cat > "$app_dst" <<EOF
[Desktop Entry]
Type=Application
Name=Revuto Watch
GenericName=Local Revuto Dashboard
Comment=Open the local Revuto observability dashboard
Exec=${open_script}
Icon=${icon_path}
Terminal=false
Categories=Development;
StartupNotify=true
EOF
chmod 755 "$app_dst"

if [[ -d "${HOME}/Desktop" ]]; then
  install -m 0755 "$app_dst" "$desktop_dst"
  if command -v gio >/dev/null 2>&1; then
    gio set "$desktop_dst" metadata::trusted true >/dev/null 2>&1 || true
  fi
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "${HOME}/.local/share/applications" >/dev/null 2>&1 || true
fi

printf 'Revuto Watch installed.\n'
printf 'Service: systemctl --user status revuto-dashboard.service\n'
printf 'Icon: %s\n' "$app_dst"
if [[ -d "${HOME}/Desktop" ]]; then
  printf 'Desktop icon: %s\n' "$desktop_dst"
fi
