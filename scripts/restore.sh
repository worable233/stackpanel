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
#   - media 会解压覆盖现有运行数据目录（选择性导出未含 media 时跳过）。
#   - 归档含加密密钥时提示：导入方需持有同一 SETTINGS_ENCRYPTION_KEY。
#   - 存储引擎唯一为 PostgreSQL（ADR-0019）；见 ADR-0018。
#
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backup-common.sh"

load_env
require_database_url
require_tool pg_restore

if [[ $# -lt 1 ]]; then
  echo "用法：bash scripts/restore.sh <备份目录>" >&2
  exit 1
fi

BASE="$1"
DB_DUMP=""
MEDIA_FILE=""
OUT_DIR=""
MANIFEST_JSON=""

if [[ -d "$BASE" ]]; then
  OUT_DIR="$BASE"
  [[ -f "$OUT_DIR/database.dump" ]] && DB_DUMP="$OUT_DIR/database.dump"
  [[ -f "$OUT_DIR/media.tar" ]] && MEDIA_FILE="$OUT_DIR/media.tar"
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
  if ! pg_dump --format=custom --no-owner --file="$SNAP_DIR/database.dump" "$DATABASE_URL"; then
    echo "错误：恢复前安全快照失败，已中止恢复。确认无需回滚可用 SKIP_SAFETY_DUMP=1 跳过。" >&2
    exit 1
  fi
fi

# ---- 恢复数据库 -------------------------------------------------------------
echo "==> 恢复 PostgreSQL $DB_DUMP -> $DATABASE_URL"
pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$DATABASE_URL" "$DB_DUMP"

# ---- 解压运行数据 -----------------------------------------------------------
# 空归档（选择性导出未含 media）不应覆盖现场，故仅在有实际成员时展开。
if [[ -n "$MEDIA_FILE" && -f "$MEDIA_FILE" ]] && tar tf "$MEDIA_FILE" 2>/dev/null | grep -q .; then
  echo "==> 恢复运行数据 $MEDIA_FILE -> $DATA_DIR"
  mkdir -p "$DATA_DIR"
  tar xf "$MEDIA_FILE" -C "$DATA_DIR"
else
  warn "未找到配套的运行数据归档（或为空），跳过。"
fi

echo "完成。"
