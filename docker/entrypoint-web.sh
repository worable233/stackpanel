#!/bin/sh
set -e

# Web tier. Since ADR-0025 the build emits `output: 'standalone'`, so the server
# entry is a self-contained `server.js` instead of `next start` reading `.next`
# through `node_modules/next`. Both the container and the kernel artifact run
# the same entrypoint.
#
# Plugin/theme frontends are still loaded at runtime from the shared data
# directory (`STACKPANEL_DATA_DIR`), so installing one does not restart web.
mkdir -p "${STACKPANEL_DATA_DIR:-/app/data}"

cd /app/apps/web/.next/standalone/apps/web
exec node server.js
