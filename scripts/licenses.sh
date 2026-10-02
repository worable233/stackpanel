#!/usr/bin/env bash
# Verify no copyleft licenses across all workspace packages (with the
# documented mariadb/LGPL-2.1 exception). Mirrors the CI gate.
set -euo pipefail

FAILON='GPL-1.0;GPL-1.0-or-later;GPL-2.0;GPL-2.0-only;GPL-2.0-or-later;GPL-3.0;GPL-3.0-only;GPL-3.0-or-later;LGPL-2.0;LGPL-2.1;LGPL-2.1-or-later;LGPL-3.0;LGPL-3.0-only;LGPL-3.0-or-later;AGPL-1.0;AGPL-3.0;AGPL-3.0-only;AGPL-3.0-or-later;MPL-1.0;MPL-1.1;MPL-2.0;EPL-1.0;EPL-2.0;CDDL-1.0;CDDL-1.1'

for pkg in . apps/api apps/web packages/sdk packages/ui; do
  echo "== $pkg =="
  pnpm exec license-checker --start "$pkg" --production \
    --excludePrivatePackages \
    --excludePackages 'mariadb@3.4.5' \
    --failOn "$FAILON"
done

echo "All packages OK (no copyleft beyond the documented mariadb exception)."
