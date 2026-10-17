#!/usr/bin/env bash
#
# StackPanel 运维级物理恢复（ADR-0018）。
#
# 用法：
#   bash scripts/restore.sh <备份目录>        # 如 backups/20260930-120000
#   bash scripts/restore.sh <dump 文件> [<media.tar>]
#
# 说明：
#   - 目录形态会校验 manifest.json 的 engine 与 checksums.txt 的 sha256，损坏拒绝恢复。
#   - 恢复会 **覆盖** 目标库中的同名对象（pg_restore --clean --if-exists），
#     并在覆盖前用 pg_dump 对现场做一次安全快照（可选，见 SKIP_SAFETY_DUMP=1）。
#   - media 会写回实际存储：S3 驱动逐对象 PUT 回桶（scripts/storage-tar.mjs），
#     local 驱动解压覆盖 $DATA_DIR（选择性导出未含 media 时跳过）。
#   - S3 备份还会带 data.tar（数据卷里的插件/主题/前端信号），一并写回。
#   - 运行形态与 backup.sh 相同：自动识别 compose 栈，可用 SP_BACKUP_MODE 强制。
#   - 归档含加密密钥时提示：导入方需持有同一 SETTINGS_ENCRYPTION_KEY。
#   - 存储引擎唯一为 PostgreSQL（ADR-0019）；见 ADR-0018。
#
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backup-common.sh"

load_env

# ---- 运行形态：宿主机直跑 vs docker compose（口径同 backup.sh）-------------
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
  require_tool pg_restore
  STORAGE_DRIVER_IN_STACK="${STORAGE_DRIVER:-local}"
  if [[ "$STORAGE_DRIVER_IN_STACK" == "s3" ]]; then
    require_tool node "S3 恢复需要 Node.js 才能写回对象存储。"
  fi
fi

if [[ $# -lt 1 ]]; then
  echo "用法：bash scripts/restore.sh <备份目录>" >&2
  exit 1
fi

BASE="$1"
DB_DUMP=""
MEDIA_FILE=""
DATA_FILE=""
OUT_DIR=""
MANIFEST_JSON=""

if [[ -d "$BASE" ]]; then
  OUT_DIR="$BASE"
  [[ -f "$OUT_DIR/database.dump" ]] && DB_DUMP="$OUT_DIR/database.dump"
  [[ -f "$OUT_DIR/media.tar" ]] && MEDIA_FILE="$OUT_DIR/media.tar"
  [[ -f "$OUT_DIR/data.tar" ]] && DATA_FILE="$OUT_DIR/data.tar"
  [[ -f "$OUT_DIR/manifest.json" ]] && MANIFEST_JSON="$OUT_DIR/manifest.json"
elif [[ -f "$BASE-stackpanel.pg.dump" ]]; then
  DB_DUMP="$BASE-stackpanel.pg.dump"
  [[ -f "$BASE-stackpanel-data.tar.gz" ]] && MEDIA_FILE="$BASE-stackpanel-data.tar.gz"
elif [[ -f "$BASE" ]]; then
  DB_DUMP="$BASE"
else
  echo "错误：找不到备份 $BASE" >&2
  exit 1
fi

if [[ -z "$DB_DUMP" ]]; then
  echo "错误：备份目录中缺少 database.dump" >&2
  exit 1
fi

# ---- 校验完整性 -------------------------------------------------------------
if [[ -n "$OUT_DIR" ]]; then
  # manifest.json 与 checksums.txt 是归档契约的一部分：目录形态必须两者齐备，
  # 缺失即拒绝恢复（此前缺失 checksums.txt 会静默跳过校验，E-7）。
  if [[ -z "$MANIFEST_JSON" ]]; then
    echo "错误：备份目录缺少 manifest.json，拒绝恢复。" >&2
    exit 1
  fi
  if ! grep -q '"engine"[[:space:]]*:[[:space:]]*"postgresql"' "$MANIFEST_JSON"; then
    echo "错误：manifest.json 的 engine 非 postgresql，拒绝恢复。" >&2
    exit 1
  fi
  if grep -q '"selective"[[:space:]]*:[[:space:]]*true' "$MANIFEST_JSON"; then
    warn "归档为选择性导出（部分域），仅这些域的数据会被恢复，其余表保持原样。"
  fi
  if grep -q '"secretsIncluded"[[:space:]]*:[[:space:]]*true' "$MANIFEST_JSON"; then
    warn "归档含加密密钥（AES-256-GCM 密文），需本实例 SETTINGS_ENCRYPTION_KEY 与之相同才能解密。"
    if [[ -z "${SETTINGS_ENCRYPTION_KEY:-}" ]]; then
      warn "当前环境未设置 SETTINGS_ENCRYPTION_KEY，相关密文将无法解密。"
    fi
  fi
  if [[ ! -f "$OUT_DIR/checksums.txt" ]]; then
    echo "错误：备份目录缺少 checksums.txt，无法校验完整性，拒绝恢复。" >&2
    exit 1
  fi
  echo "==> 校验 sha256"
  checksum_seen=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^([0-9a-f]{64})[[:space:]]+\*?(.+)$ ]] || continue
    sum="${BASH_REMATCH[1]}"
    name="${BASH_REMATCH[2]}"
    checksum_seen=1
    target="$OUT_DIR/$name"
    [[ -f "$target" ]] || { echo "错误：缺少成员 $name" >&2; exit 1; }
    actual="$(sha256_of "$target")"
    if [[ "$actual" != "$sum" ]]; then
      echo "错误：$name 校验失败（期望 ${sum}，实际 ${actual}）" >&2
      exit 1
    fi
    # manifest 声明的校验和若存在，必须与实际一致（防止 manifest 被单独篡改）。
    declared_hash="$(grep -o "\"$name\"[[:space:]]*:[[:space:]]*\"[0-9a-f]\{64\}\"" "$MANIFEST_JSON" 2>/dev/null | grep -o '[0-9a-f]\{64\}' | head -1 || true)"
    if [[ -n "$declared_hash" && "$declared_hash" != "$sum" ]]; then
      echo "错误：manifest.json 中 $name 的校验和与 checksums.txt 不一致，拒绝恢复。" >&2
      exit 1
    fi
  done < "$OUT_DIR/checksums.txt"
  if [[ "$checksum_seen" == "0" ]]; then
    echo "错误：checksums.txt 无有效条目，拒绝恢复。" >&2
    exit 1
  fi
fi

# ---- 覆盖前安全快照 ---------------------------------------------------------
# 安全快照是「恢复失败可回滚」的唯一保障：它失败就**中止**恢复，除非运维显式
# 声明 SKIP_SAFETY_DUMP=1（知道自己没有回滚退路）。此前失败仅 warn 就继续，
# 会制造经典的不可回滚场景（E-8）。
if [[ "${SKIP_SAFETY_DUMP:-0}" != "1" ]]; then
  SNAP_DIR="$BACKUP_DIR/$(date +%Y%m%d-%H%M%S)-prerestore"
  echo "==> 恢复前安全快照 -> $SNAP_DIR"
  mkdir -p "$SNAP_DIR"
  snap_ok=0
  if [[ -n "$COMPOSE" ]]; then
    compose_exec "$COMPOSE" api pg_dump --format=custom --no-owner --dbname="$DATABASE_URL" \
      > "$SNAP_DIR/database.dump" && snap_ok=1
  else
    pg_dump --format=custom --no-owner --file="$SNAP_DIR/database.dump" "$DATABASE_URL" \
      && snap_ok=1
  fi
  if [[ "$snap_ok" != "1" ]]; then
    rm -f "$SNAP_DIR/database.dump"
    echo "错误：恢复前安全快照失败，已中止恢复。确认无需回滚可用 SKIP_SAFETY_DUMP=1 跳过。" >&2
    exit 1
  fi
fi

# ---- 恢复数据库 -------------------------------------------------------------
echo "==> 恢复 PostgreSQL $DB_DUMP -> $DATABASE_URL"
if [[ -n "$COMPOSE" ]]; then
  # Stream the dump into the container: the file lives on the host, and the
  # stack publishes no PostgreSQL port for a host-side pg_restore.
  compose_exec "$COMPOSE" api pg_restore --clean --if-exists --no-owner --no-privileges \
    --dbname="$DATABASE_URL" < "$DB_DUMP"
else
  pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$DATABASE_URL" "$DB_DUMP"
fi

# ---- 恢复对象存储 -----------------------------------------------------------
# 空归档（选择性导出未含 media）不应覆盖现场，故仅在有实际成员时展开。
if [[ -n "$MEDIA_FILE" && -f "$MEDIA_FILE" ]] && tar tf "$MEDIA_FILE" 2>/dev/null | grep -q .; then
  if [[ "$STORAGE_DRIVER_IN_STACK" == "s3" ]]; then
    echo "==> 恢复对象存储（S3/MinIO）$MEDIA_FILE"
    if [[ -n "$COMPOSE" ]]; then
      compose_exec "$COMPOSE" api node scripts/storage-tar.mjs import < "$MEDIA_FILE"
    else
      node "$ROOT_DIR/scripts/storage-tar.mjs" import < "$MEDIA_FILE"
    fi
  elif [[ -n "$COMPOSE" ]]; then
    echo "==> 恢复容器内运行数据卷 $MEDIA_FILE -> /app/data"
    compose_exec "$COMPOSE" api tar xf - -C /app/data < "$MEDIA_FILE"
  else
    echo "==> 恢复运行数据 $MEDIA_FILE -> $DATA_DIR"
    mkdir -p "$DATA_DIR"
    tar xf "$MEDIA_FILE" -C "$DATA_DIR"
  fi
else
  warn "未找到配套的运行数据归档（或为空），跳过。"
fi

# ---- 恢复运行数据目录（S3 部署的插件/主题）----------------------------------
# 旧归档没有这个成员，缺失时静默跳过；选择性导出未含 media 时也不写。
if [[ -n "$DATA_FILE" && -f "$DATA_FILE" ]] && tar tf "$DATA_FILE" 2>/dev/null | grep -q .; then
  if [[ -n "$COMPOSE" ]]; then
    echo "==> 恢复容器内运行数据卷 $DATA_FILE -> /app/data"
    compose_exec "$COMPOSE" api tar xf - -C /app/data < "$DATA_FILE"
  else
    echo "==> 恢复运行数据 $DATA_FILE -> $DATA_DIR"
    mkdir -p "$DATA_DIR"
    tar xf "$DATA_FILE" -C "$DATA_DIR"
  fi
fi

echo "完成。"
