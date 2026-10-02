#!/bin/sh
set -e

# Ensure the shared data directory exists so the supervisor can read/write the
# frontend-apply signal files (mounted as the `stackpanel-data` volume).
mkdir -p "${STACKPANEL_DATA_DIR:-/app/data}"

# The supervisor runs `next start` and, when the kernel requests it, rebuilds
# the frontend registry + Next bundle and restarts. Set
# STACKPANEL_FRONTEND_AUTOBUILD=0 to fall back to a plain `next start`.
exec node /app/scripts/frontend-supervisor.mjs
