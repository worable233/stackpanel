#!/usr/bin/env bash
# License gate for the whole workspace. Mirrors the CI step of the same name.
#
# The real work lives in scripts/check-licenses.mjs: it walks the installed
# dependency tree (optional dependencies included, which is where the
# platform-native binaries live) and then scans pnpm-lock.yaml so the result
# does not depend on the host OS. Any copyleft-family license must be
# documented there and in THIRD-PARTY-NOTICES.md.
set -euo pipefail

cd "$(dirname "$0")/.."
exec node scripts/check-licenses.mjs
