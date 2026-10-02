#!/usr/bin/env bash
#
# StackPanel 运维级物理备份（ADR-0018）。
#
# 产出与平台内自助导出一致的归档布局：
#   <BACKUP_DIR>/<时间戳>/manifest.json  版本、时间、engine、includes、成员校验和
#   <BACKUP_DIR>/<时间戳>/database.dump  pg_dump 自定义格式（pg_dump -Fc）
#   <BACKUP_DIR>/<时间戳>/media.tar      运行时数据目录（插件/主题/上传/前端信号）
#   <BACKUP_DIR>/<时间戳>/checksums.txt  各成员 sha256（coreutils 格式）
#
# 用法：
#   bash scripts/backup.sh                       # 整实例（全部域）
#   INCLUDE_DOMAINS=content,media bash scripts/backup.sh   # 选择性导出（ADR-0018 §7）
#   INCLUDE_SECRETS=1 bash scripts/backup.sh     # 含加密密钥（需本机 SETTINGS_ENCRYPTION_KEY）
#   BACKUP_RETENTION_DAYS=14 bash scripts/backup.sh        # 备份后清理超过 14 天的旧目录
#   DATABASE_URL=postgresql://... BACKUP_DIR=/srv/backups bash scripts/backup.sh
#
# 存储引擎唯一为 PostgreSQL（ADR-0019）；口径见 ADR-0018。恢复见 scripts/restore.sh。
#
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backup-common.sh"

load_env
require_database_url
require_tool pg_dump

INCLUDE_DOMAINS_RAW="${INCLUDE_DOMAINS:-}"
INCLUDE_SECRETS="${INCLUDE_SECRETS:-0}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-0}"

# 选择性导出：整实例时 includes 为全部域，selective=false。
SELECTIVE=0
if [[ -n "$INCLUDE_DOMAINS_RAW" ]]; then
  DOMAINS_CSV="$(normalize_domains "$INCLUDE_DOMAINS_RAW")"
  SELECTIVE=1
else
  DOMAINS_CSV="${ALL_DOMAINS[*]}"
  DOMAINS_CSV="${DOMAINS_CSV// /,}"
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="$BACKUP_DIR/$STAMP"
mkdir -p "$OUT_DIR"
DB_FILE="$OUT_DIR/database.dump"
MEDIA_FILE="$OUT_DIR/media.tar"
MANIFEST="$OUT_DIR/manifest.json"
CHECKSUMS="$OUT_DIR/checksums.txt"

APP_VERSION="$(node -e "try{process.stdout.write(require('$ROOT_DIR/package.json').version||'0.0.0')}catch(e){process.stdout.write('0.0.0')}" 2>/dev/null || echo '0.0.0')"
SCHEMA_VERSION="$(ls -1 "$ROOT_DIR/packages/db/prisma/migrations" 2>/dev/null | grep -E '^[0-9]{14}_' | sort | tail -1 || true)"
SCHEMA_VERSION="${SCHEMA_VERSION:-unknown}"

# ---- 备份数据库 -------------------------------------------------------------
# 选择性导出只保留所选域的表数据（表结构完整保留，恢复仍是普通 pg_restore）。
DUMP_ARGS=(--format=custom --no-owner --no-privileges)
while IFS= read -r arg; do
  [[ -n "$arg" ]] && DUMP_ARGS+=("$arg")
done < <(exclude_table_data_args "$DOMAINS_CSV" "$INCLUDE_SECRETS")

echo "==> 备份 PostgreSQL -> ${DB_FILE}（域：${DOMAINS_CSV}）"
pg_dump "${DUMP_ARGS[@]}" --file="$DB_FILE" "$DATABASE_URL"

# ---- 归档运行时数据目录 -----------------------------------------------------
if domains_include_media "$DOMAINS_CSV"; then
  if [[ -d "$DATA_DIR" ]]; then
    echo "==> 备份运行数据 $DATA_DIR -> $MEDIA_FILE"
    tar cf "$MEDIA_FILE" -C "$DATA_DIR" .
  else
    warn "未找到运行数据目录 ${DATA_DIR}，生成空归档。"
    tar cf "$MEDIA_FILE" --files-from /dev/null
  fi
else
  echo "==> 未选择 media 域，生成空归档。"
  tar cf "$MEDIA_FILE" --files-from /dev/null
fi

# ---- 校验和 + 清单 ----------------------------------------------------------
DB_SUM="$(sha256_of "$DB_FILE")"
MEDIA_SUM="$(sha256_of "$MEDIA_FILE")"
printf '%s  %s\n%s  %s\n' "$DB_SUM" database.dump "$MEDIA_SUM" media.tar > "$CHECKSUMS"

EXPORTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SECRETS_BOOL="false"; [[ "$INCLUDE_SECRETS" == "1" ]] && SECRETS_BOOL="true"
SELECTIVE_BOOL="false"; [[ "$SELECTIVE" == "1" ]] && SELECTIVE_BOOL="true"
INCLUDES_JSON="$(printf '"%s"' "${DOMAINS_CSV//,/\",\"}")"

cat > "$MANIFEST" <<JSON
{
  "formatVersion": 1,
  "appVersion": "$APP_VERSION",
  "schemaVersion": "$SCHEMA_VERSION",
  "exportedAt": "$EXPORTED_AT",
  "engine": "postgresql",
  "includes": [$INCLUDES_JSON],
  "selective": $SELECTIVE_BOOL,
  "secretsIncluded": $SECRETS_BOOL,
  "checksums": {
    "database.dump": "$DB_SUM",
    "media.tar": "$MEDIA_SUM"
  }
}
JSON

echo "完成。备份目录：$OUT_DIR"
ls -lh "$OUT_DIR"

prune_backups "$BACKUP_DIR" "$RETENTION_DAYS"
