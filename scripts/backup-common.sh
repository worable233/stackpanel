#!/usr/bin/env bash
#
# Shared helpers for the StackPanel backup scripts (ADR-0018).
#
# Source it, do not execute it:
#   source "$(dirname "${BASH_SOURCE[0]}")/backup-common.sh"
#
# Owns three things that every script needs and must not drift:
#   1. resolving DATABASE_URL / DATA_DIR from the environment and .env;
#   2. the selective-export domain -> table map (mirrors
#      apps/api/src/backup/domains.ts — keep the two in lockstep);
#   3. small utilities (sha256, timestamp, logging, retention pruning).
#
set -euo pipefail

# ---- Locations --------------------------------------------------------------

BACKUP_COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$BACKUP_COMMON_DIR/.." && pwd)"

load_env() {
  # Capture externally-set values first so an explicit env var beats .env.
  local ext_database_url="${DATABASE_URL:-}"
  local ext_data_dir="${STACKPANEL_DATA_DIR:-}"
  local ext_backup_dir="${BACKUP_DIR:-}"
  # Whether DATABASE_URL came from the caller's environment (e.g. the drill
  # pointing at a scratch database) rather than from a `.env` file. Compose
  # auto-detection must never override an explicit override.
  DATABASE_URL_FROM_ENV=0
  [[ -n "$ext_database_url" ]] && DATABASE_URL_FROM_ENV=1
  if [[ -f "$ROOT_DIR/.env" ]]; then
    set -a; . "$ROOT_DIR/.env"; set +a
  fi
  DATABASE_URL="${ext_database_url:-${DATABASE_URL:-}}"
  DATA_DIR="${ext_data_dir:-${STACKPANEL_DATA_DIR:-$ROOT_DIR/data}}"
  BACKUP_DIR="${ext_backup_dir:-${BACKUP_DIR:-$ROOT_DIR/backups}}"
  export DATABASE_URL DATA_DIR BACKUP_DIR DATABASE_URL_FROM_ENV
}

require_database_url() {
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "错误：未设置 DATABASE_URL。请配置 .env 或通过环境变量传入 postgresql://..." >&2
    exit 1
  fi
}

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    local hint="${2:-请安装 PostgreSQL 客户端（postgresql-client）。}"
    echo "错误：未找到 $1。$hint" >&2
    exit 1
  fi
}

# ---- Utilities --------------------------------------------------------------

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

log() { echo "==> $*"; }
warn() { echo "警告：$*" >&2; }

# ---- Docker Compose deployments ---------------------------------------------
#
# A compose deployment publishes no PostgreSQL port to the host and keeps media
# objects in the bundled MinIO (S3) bucket, not in a host directory. Host-side
# `pg_dump` / `tar` therefore cannot see either. When a running compose stack is
# detected, the backup/restore scripts exec into the containers instead.

# Print the compose file backing a running stack, or fail when there is none.
compose_file() {
  local f
  [[ -f "$ROOT_DIR/docker/.env" ]] || return 1
  for f in docker-compose.yml docker-compose.cluster.yml; do
    [[ -f "$ROOT_DIR/$f" ]] || continue
    if (cd "$ROOT_DIR" && docker compose -f "$f" --env-file docker/.env ps -q 2>/dev/null | grep -q .); then
      echo "$ROOT_DIR/$f"
      return 0
    fi
  done
  return 1
}

# compose_exec <compose-file> <service> <cmd...>
compose_exec() {
  local file="$1" service="$2"
  shift 2
  (cd "$ROOT_DIR" && docker compose -f "$file" --env-file docker/.env exec -T "$service" "$@")
}

# The database URL as seen *inside* the stack (service DNS names), if declared.
compose_database_url() {
  local file="$1"
  compose_service_env "$file" api DATABASE_URL
}

# Read one environment value of a service from the resolved compose config.
# Mirrors what the container actually sees (including defaults and interpolation)
# without starting anything. Docker-only hosts may have no Node, so fall back to
# asking the running container (the value is already materialised there).
compose_service_env() {
  local file="$1" service="$2" key="$3"
  if command -v node >/dev/null 2>&1; then
    (
      cd "$ROOT_DIR" &&
        docker compose -f "$file" --env-file docker/.env config --format json 2>/dev/null
    ) | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let config;
  try { config = JSON.parse(input); } catch { process.exit(1); }
  const env = (config.services?.[process.argv[1]]?.environment) ?? {};
  const value = env[process.argv[2]];
  process.stdout.write(value == null ? "" : String(value));
});
' "$service" "$key"
    return 0
  fi
  compose_exec "$file" "$service" printenv "$key" 2>/dev/null || true
}

# Resolve the backup/restore mode: prints `compose` or `host`.
#
# Precedence:
#   1. `SP_BACKUP_MODE=host|compose` — explicit operator override.
#   2. An explicitly exported DATABASE_URL — the caller knows what it is doing
#      (the drill points at a scratch database; never hijack it).
#   3. A *running* compose stack — the only case where host-side pg_dump cannot
#      reach PostgreSQL and media live in a container volume.
#   4. Otherwise host mode.
resolve_mode() {
  local file="${1:-}"
  case "${SP_BACKUP_MODE:-}" in
    compose) echo compose; return 0 ;;
    host) echo host; return 0 ;;
    "") ;;
    *) warn "SP_BACKUP_MODE=${SP_BACKUP_MODE} 无效（host|compose），已忽略。" ;;
  esac
  if [[ "${DATABASE_URL_FROM_ENV:-0}" == "1" ]]; then
    echo host
    return 0
  fi
  if [[ -n "$file" ]]; then
    echo compose
    return 0
  fi
  echo host
}

# ---- Selective export domains (ADR-0018 §7) ---------------------------------

ALL_DOMAINS=(content media orders services users wallet settings)

# Domain -> space-separated Prisma @@map table names. Source of truth:
# apps/api/src/backup/domains.ts (the API archive uses the same mapping).
tables_for_domain() {
  case "$1" in
    content)  echo "products categories custom_resources extension_schema" ;;
    media)    echo "attachments" ;;
    orders)   echo "cart_items orders payments" ;;
    services) echo "service_instances delivery_tasks card_codes zjmf_upstreams zjmf_product_mappings zjmf_sync_runs tickets ticket_messages" ;;
    users)    echo "users user_identities permission_groups permissions user_groups group_permissions api_tokens api_token_usage notifications audit_logs" ;;
    wallet)   echo "wallet_accounts wallet_ledger_entries fx_rates" ;;
    settings) echo "settings sales_channels payment_methods gateway_accounts gateway_api_keys gateway_user_settings gateway_usage_logs gateway_model_prices gateway_key_policies plugins themes outbox_events" ;;
    *)        echo "" ;;
  esac
}

is_domain() {
  local candidate="$1" d
  for d in "${ALL_DOMAINS[@]}"; do [[ "$candidate" == "$d" ]] && return 0; done
  return 1
}

# Validate a comma/space separated domain list; prints the canonical CSV.
normalize_domains() {
  local raw="$1" token out=""
  raw="${raw//,/ }"
  for token in $raw; do
    if ! is_domain "$token"; then
      echo "错误：未知导出域 '$token'（可用：${ALL_DOMAINS[*]}）" >&2
      return 1
    fi
    case " $out " in *" $token "*) ;; *) out="${out:+$out,}$token" ;; esac
  done
  if [[ -z "$out" ]]; then
    echo "错误：导出域为空" >&2
    return 1
  fi
  echo "$out"
}

# Skip table names as pg_dump --exclude-table-data args (echo one per line).
exclude_table_data_args() {
  local domains_csv="$1" include_secrets="$2"
  local keep="" selected=() d t
  IFS=',' read -r -a selected <<< "$domains_csv"
  for d in "${selected[@]}"; do
    for t in $(tables_for_domain "$d"); do keep="$keep $t "; done
  done
  local all_tables=""
  for d in "${ALL_DOMAINS[@]}"; do
    for t in $(tables_for_domain "$d"); do all_tables="$all_tables $t "; done
  done
  # Emit excluded kernel tables (dedup by the `keep` set).
  local seen=" "
  for t in $all_tables; do
    case "$seen" in *" $t "*) continue ;; esac
    seen="$seen$t "
    case "$keep " in *" $t "*) ;; *) printf '%s\n%s\n' '--exclude-table-data' "\"$t\"" ;; esac
  done
  # Extension tables belong to `content`; drop their data when it is absent.
  case ",$domains_csv," in
    *,content,*) ;;
    *) printf '%s\n%s\n' '--exclude-table-data' '"ext_*"' ;;
  esac
  if [[ "$include_secrets" != "1" ]]; then
    printf '%s\n%s\n' '--exclude-table-data' '"secrets"'
  fi
}

# Whether the object store / data dir should be packed for this selection.
domains_include_media() {
  case ",$1," in *,media,*) return 0 ;; *) return 1 ;; esac
}

# ---- Retention --------------------------------------------------------------

# Delete backup directories under $1 older than $2 days (0 disables).
prune_backups() {
  local dir="$1" days="$2" removed=0 path
  [[ "$days" =~ ^[0-9]+$ ]] || { warn "BACKUP_RETENTION_DAYS 非数字，跳过清理"; return 0; }
  [[ "$days" -gt 0 ]] || return 0
  [[ -d "$dir" ]] || return 0
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    rm -rf "$path"
    removed=$((removed + 1))
  done < <(find "$dir" -mindepth 1 -maxdepth 1 -type d -mtime "+$days" 2>/dev/null)
  [[ "$removed" -gt 0 ]] && log "清理 $removed 个超过 ${days} 天的备份"
  return 0
}
