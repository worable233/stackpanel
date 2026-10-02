#!/bin/sh
set -e

# Background worker (S6 / ADR-0013): consumes the BullMQ queue and runs kernel
# sweeps + plugin jobs. It owns no HTTP port and does not run migrations — the
# api entrypoint already applies them. It does need the same plugin data
# (`STACKPANEL_DATA_DIR`) and Redis/DB as the API.
exec node apps/api/dist/worker.js
