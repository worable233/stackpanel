#!/usr/bin/env bash
#
# StackPanel 运维级物理备份（ADR-0018）。
#
# 产出与平台内自助导出一致的归档布局：
#   <BACKUP_DIR>/<时间戳>/manifest.json  版本、时间、engine、includes、成员校验和
#   <BACKUP_DIR>/<时间戳>/database.dump  pg_dump 自定义格式（pg_dump -Fc）
#   <BACKUP_DIR>/<时间戳>/media.tar      媒体对象与运行时资源（见下）
#   <BACKUP_DIR>/<时间戳>/checksums.txt  各成员 sha256（coreutils 格式）
#
# 用法：
#   bash scripts/backup.sh                       # 整实例（全部域）
#   INCLUDE_DOMAINS=content,media bash scripts/backup.sh   # 选择性导出（ADR-0018 §7）
#   INCLUDE_SECRETS=1 bash scripts/backup.sh     # 含加密密钥（需本机 SETTINGS_ENCRYPTION_KEY）
#   BACKUP_RETENTION_DAYS=14 bash scripts/backup.sh        # 备份后清理超过 14 天的旧目录
#   DATABASE_URL=postgresql://... BACKUP_DIR=/srv/backups bash scripts/backup.sh
#   SP_BACKUP_MODE=compose bash scripts/backup.sh          # 强制走 compose 容器
#
# 运行形态自动识别：
#   - 检测到运行中的 docker compose 栈（docker/.env 存在且有容器）时，在
#     api/postgres 容器内执行 —— compose 不发布 PG 端口，宿主机的 pg_dump 连不上。
#   - 否则按宿主机直连处理（PM2 / 手动部署）。
#   - `SP_BACKUP_MODE=host|compose` 可强制指定；显式传入 DATABASE_URL 时默认
#     host（备份演练会这样指向临时库）。
#
# media.tar 的内容随存储驱动而变：
#   - STORAGE_DRIVER=s3：桶内全部对象（附件、品牌图、备份归档），由
#     scripts/storage-tar.mjs 流式导出。这是 compose 默认档的形态。
#   - STORAGE_DRIVER=local：$DATA_DIR（默认 ./data）下的运行数据，含
#     storage/ 与 plugins/themes 资源。
#
# S3 部署还会额外产出 data.tar —— 已安装的插件/主题与前端构建信号在数据卷里，
# 不在桶里；缺了它，恢复后的实例会有指向不存在包的数据。
#
# 存储引擎唯一为 PostgreSQL（ADR-0019）；口径见 ADR-0018。恢复见 scripts/restore.sh。
#
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backup-common.sh"

load_env

# ---- 运行形态：宿主机直跑 vs docker compose --------------------------------
# compose 部署不向宿主机发布 PostgreSQL 端口，且默认档把上传对象放在 MinIO
# 卷里。宿主机上的 pg_dump / tar 两者都看不到，所以改为在容器内执行。
# 仅当 DATABASE_URL 不是由调用方显式给出时才自动判定（备份演练会显式指向
# 临时库，绝不能误连生产栈）。
COMPOSE=""
if [[ "${SP_BACKUP_MODE:-}" != "host" ]]; then
  COMPOSE="$(compose_file || true)"
fi
MODE="$(resolve_mode "$COMPOSE")"
if [[ "$MODE" == "compose" && -z "$COMPOSE" ]]; then
  echo "错误：SP_BACKUP_MODE=compose，但未检测到运行中的 compose 栈。" >&2
  echo "      请先 \`docker compose up -d\`，或改用 SP_BACKUP_MODE=host。" >&2
  exit 1
fi
[[ "$MODE" == "compose" ]] || COMPOSE=""

if [[ "$MODE" == "compose" ]]; then
  log "检测到运行中的 compose 部署：$(basename "$COMPOSE")"
  DATABASE_URL="$(compose_database_url "$COMPOSE")"
  [[ -n "$DATABASE_URL" ]] || {
    echo "错误：compose 配置中未找到 api 的 DATABASE_URL。" >&2
    exit 1
  }
  STORAGE_DRIVER_IN_STACK="$(compose_service_env "$COMPOSE" api STORAGE_DRIVER)"
else
  require_database_url
  require_tool pg_dump
  STORAGE_DRIVER_IN_STACK="${STORAGE_DRIVER:-local}"
  # The S3 export runs host-side with the repo's AWS SDK; Node is also what
  # resolves DATABASE_URL / manifest version above.
  if [[ "$STORAGE_DRIVER_IN_STACK" == "s3" ]]; then
    require_tool node "S3 备份需要 Node.js 才能读取对象存储。"
  fi
fi

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
# Runtime data dir (installed plugins/themes, frontend signal files). Only a
# separate member when the object store lives outside that directory, otherwise
# `media.tar` already contains it.
DATA_FILE="$OUT_DIR/data.tar"
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
if [[ -n "$COMPOSE" ]]; then
  compose_exec "$COMPOSE" api pg_dump "${DUMP_ARGS[@]}" --dbname="$DATABASE_URL" > "$DB_FILE"
else
  pg_dump "${DUMP_ARGS[@]}" --file="$DB_FILE" "$DATABASE_URL"
fi

# ---- 归档媒体对象 -----------------------------------------------------------
# 来源必须按实际存储驱动选择，否则会生成「看起来成功、实际没有附件」的备份：
#   1. s3（compose 或 PM2/宿主机）—— 对象在桶里，用 storage-tar 流式导出。
#   2. compose + local —— 对象在 api 容器的 /app/data 卷里，从容器内 tar。
#   3. 宿主机 + local —— 对象在 local root（默认 $DATA_DIR/storage）以及
#      $DATA_DIR 下的插件/主题/品牌资源。
if domains_include_media "$DOMAINS_CSV"; then
  if [[ "$STORAGE_DRIVER_IN_STACK" == "s3" ]]; then
    echo "==> 备份对象存储（S3/MinIO）-> $MEDIA_FILE"
    if [[ -n "$COMPOSE" ]]; then
      compose_exec "$COMPOSE" api node scripts/storage-tar.mjs export > "$MEDIA_FILE"
    else
      node "$ROOT_DIR/scripts/storage-tar.mjs" export > "$MEDIA_FILE"
    fi
    # Installed plugins/themes and frontend signals live on the data volume, not
    # in the bucket. Without this member an S3 deployment restores a database
    # that references packages the new instance does not have.
    echo "==> 备份运行数据（插件/主题/前端信号）-> $DATA_FILE"
    if [[ -n "$COMPOSE" ]]; then
      compose_exec "$COMPOSE" api tar cf - -C /app/data . > "$DATA_FILE"
    elif [[ -d "$DATA_DIR" ]]; then
      tar cf "$DATA_FILE" -C "$DATA_DIR" .
    else
      warn "未找到运行数据目录 ${DATA_DIR}，生成空归档。"
      tar cf "$DATA_FILE" --files-from /dev/null
    fi
  elif [[ -n "$COMPOSE" ]]; then
    echo "==> 备份容器内运行数据卷 -> $MEDIA_FILE"
    compose_exec "$COMPOSE" api tar cf - -C /app/data . > "$MEDIA_FILE"
  elif [[ -d "$DATA_DIR" ]]; then
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
DATA_CHECKSUM_JSON=""
if [[ -f "$DATA_FILE" ]]; then
  DATA_SUM="$(sha256_of "$DATA_FILE")"
  printf '%s  %s\n' "$DATA_SUM" data.tar >> "$CHECKSUMS"
  DATA_CHECKSUM_JSON=",
    \"data.tar\": \"$DATA_SUM\""
fi

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
    "media.tar": "$MEDIA_SUM"$DATA_CHECKSUM_JSON
  }
}
JSON

echo "完成。备份目录：$OUT_DIR"
ls -lh "$OUT_DIR"

prune_backups "$BACKUP_DIR" "$RETENTION_DAYS"
