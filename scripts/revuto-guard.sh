#!/usr/bin/env bash
set -euo pipefail

services=(
  revuto-surreal.service
  revuto-embedder.service
  revuto.service
)

for service in "${services[@]}"; do
  if ! systemctl --user is-active --quiet "$service"; then
    systemctl --user restart "$service"
  fi
done
