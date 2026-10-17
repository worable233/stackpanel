#!/bin/sh
set -e

# Plugin/theme frontends are loaded at runtime from the shared data directory
# (`STACKPANEL_DATA_DIR`, mounted as the `stackpanel-data` volume), so the web
# tier no longer rebuilds or restarts on install — it just runs `next start`.
# Ensure the data directory exists (it may be empty on a fresh volume).
mkdir -p "${STACKPANEL_DATA_DIR:-/app/data}"

cd /app/apps/web
exec node node_modules/next/dist/bin/next start -p "${WEB_PORT:-3000}"
