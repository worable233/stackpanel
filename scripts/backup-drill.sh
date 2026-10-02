#!/usr/bin/env bash
#
# StackPanel 备份演练（ADR-0018 gap C8）。
#
# 完整跑通「备份 -> 校验拒绝损坏 -> 恢复到临时库 -> 比对行数 -> 清理」，全程不碰
# 生产库：备份取自 $DATABASE_URL，恢复写入一个新的临时库 stackpanel_drill_<pid>。
#
# 用法：
#   bash scripts/backup-drill.sh
#   INCLUDE_DOMAINS=content,users bash scripts/backup-drill.sh
#   DATABASE_URL=postgresql://... bash scripts/backup-drill.sh
#
# 需要本机具备 pg_dump / pg_restore / psql 且 PostgreSQL 可达；缺失时明确失败。
# 演练产物在退出时清理（KEEP_DRILL=1 可保留以便排查）。
#
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backup-common.sh"

load_env
require_database_url
require_tool pg_dump
require_tool pg_restore
require_tool psql

KEEP="${KEEP_DRILL:-0}"
DRILL_WORK="$(mktemp -d "${TMPDIR:-/tmp}/sp-drill-XXXXXX")"
DRILL_DB="stackpanel_drill_$$"
DRILL_URL=""
SCRATCH_DATA="$DRILL_WORK/data"

cleanup() {
  local code=$?
  if [[ "$KEEP" != "1" ]]; then
    # Drop the scratch database (ignore errors: it may never have been created).
    if [[ -n "$DRILL_URL" ]]; then
      psql "$(maintenance_url "$DRILL_URL")" -v ON_ERROR_STOP=0 \
        -c "DROP DATABASE IF EXISTS \"$DRILL_DB\"" >/dev/null 2>&1 || true
    fi
    rm -rf "$DRILL_WORK"
  else
    echo "保留演练目录：$DRILL_WORK"
  fi
  exit "$code"
}
trap cleanup EXIT

# Rewrite the URL's database name, keeping host/user/port.
maintenance_url() {
  local url="$1"
  printf '%s' "$url" | sed -E 's#/[^/?]+(\?|$)#/postgres\1#'
}

db_name_of() {
  local url="$1"
  printf '%s' "$url" | sed -E 's#.*/([^/?]+)(\?.*)?$#\1#'
}

DRILL_URL="$(printf '%s' "$DATABASE_URL" | sed -E "s#/[^/?]+(\?|\$)#/$DRILL_DB\1#")"

echo "==> 演练开始：临时库 ${DRILL_DB}（源：$(db_name_of "$DATABASE_URL")）"

# ---- 1. 备份 ---------------------------------------------------------------
echo "==> [1/5] 生成备份"
BACKUP_DIR="$DRILL_WORK/backups" \
  bash "$ROOT_DIR/scripts/backup.sh" >/dev/null
BACKUP_SUBDIR="$(find "$DRILL_WORK/backups" -mindepth 1 -maxdepth 1 -type d -print -quit)"
[[ -n "$BACKUP_SUBDIR" ]] || { echo "错误：未找到备份产物" >&2; exit 1; }
echo "    产物：$BACKUP_SUBDIR"

# ---- 2. 损坏拒绝 -----------------------------------------------------------
echo "==> [2/5] 校验损坏归档被拒绝"
CORRUPT="$DRILL_WORK/corrupt"
cp -R "$BACKUP_SUBDIR" "$CORRUPT"
# Flip a byte inside database.dump so the sha256 no longer matches.
printf 'x' | dd of="$CORRUPT/database.dump" bs=1 seek=0 count=1 conv=notrunc 2>/dev/null
if DATABASE_URL="$DRILL_URL" SKIP_SAFETY_DUMP=1 SKIP_CREATE=1 \
  bash "$ROOT_DIR/scripts/restore.sh" "$CORRUPT" >/dev/null 2>&1; then
  echo "错误：损坏归档未被拒绝" >&2
  exit 1
fi
echo "    损坏归档已拒绝（退出非零）"

# ---- 3. 建临时库并恢复 -----------------------------------------------------
echo "==> [3/5] 建临时库并恢复"
psql "$(maintenance_url "$DRILL_URL")" -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$DRILL_DB\"" \
  -c "CREATE DATABASE \"$DRILL_DB\"" >/dev/null
mkdir -p "$SCRATCH_DATA"
DATABASE_URL="$DRILL_URL" STACKPANEL_DATA_DIR="$SCRATCH_DATA" SKIP_SAFETY_DUMP=1 \
  bash "$ROOT_DIR/scripts/restore.sh" "$BACKUP_SUBDIR" >/dev/null
echo "    已恢复到 $DRILL_DB"

# ---- 4. 比对行数 -----------------------------------------------------------
echo "==> [4/5] 比对关键表行数"
FAILED=0
count_rows() {
  psql "$1" -tA -c "SELECT count(*) FROM \"$2\"" 2>/dev/null || echo "n/a"
}
# Only compare tables whose data the archive carried (respect selective export).
DOMAINS_CSV="${INCLUDE_DOMAINS:-${ALL_DOMAINS[*]}}"
DOMAINS_CSV="${DOMAINS_CSV// /,}"
SELECTIVE_TABLES=""
for d in ${DOMAINS_CSV//,/ }; do SELECTIVE_TABLES="$SELECTIVE_TABLES $(tables_for_domain "$d")"; done

for table in users orders products settings; do
  case " $SELECTIVE_TABLES " in
    *" $table "*) ;;
    *) continue ;;
  esac
  src="$(count_rows "$DATABASE_URL" "$table")"
  dst="$(count_rows "$DRILL_URL" "$table")"
  if [[ "$src" == "$dst" ]]; then
    echo "    $table: $src = $dst"
  else
    echo "    $table: 源 $src != 目标 $dst" >&2
    FAILED=1
  fi
done
[[ "$FAILED" == "0" ]] || { echo "错误：行数比对不一致" >&2; exit 1; }

# ---- 5. 完成 ---------------------------------------------------------------
echo "==> [5/5] 演练通过"
echo "演练成功：备份 -> 校验 -> 恢复 -> 行数比对 全部通过。"
