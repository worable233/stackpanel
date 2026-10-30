#!/usr/bin/env bash
#
# 首次安装 / 手工切换到「产物载体」部署（ADR-0025，非 Docker）。
#
# 与 scripts/install.sh（源码构建 + PM2）并列：本脚本只接受**已构建的自包含产物**，
# 目标机不需要源码、pnpm 或构建器。
#
# 用法：
#   sudo bash scripts/install-artifact.sh \
#     --kernel stackpanel-0.3.0-kernel-linux-x64.tar.zst \
#     --migrate stackpanel-0.3.0-migrate-linux-x64.tar.zst \
#     --runner stackpanel-upgrade.mjs \
#     [--dir /opt/stackpanel] [--state-dir /var/lib/stackpanel] \
#     [--instance stackpanel] [--user stackpanel] \
#     [--site-url https://panel.example.com] \
#     [--manifest stackpanel-0.3.0-linux-x64.artifacts.json] \
#     [--skip-systemd] [--skip-pm2] [--allow-reinstall]
#
# 首装流程（零配置文件自举，审计 R1–R9）：
#   1. 校验产物与前置依赖，创建目录、业务用户
#   2. 解包内核产物到 releases/<version>，原子切换 current
#   3. **保留完整的迁移产物**到 migrate/<version>（不执行迁移：此刻还没有数据库）
#   4. 生成根密钥与认领令牌写入 <state>/stackpanel.env（0640，属主=业务用户）
#      已存在有效配置时默认拒绝覆盖（--allow-reinstall 才继续）
#   5. 写 bootstrap/state.json = needs_infra，启动 API + Web（不启动 worker）
#   6. 安装 systemd 单元：升级 path/service + 自举 path/service
#
# 之后操作员打开 Web 的 /setup 填写数据库/Redis/S3；runner 预检、迁移、
# 导入配置并首次启动 worker，然后由 /setup 创建首个管理员。
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_ROOT="/opt/stackpanel"
STATE_DIR="/var/lib/stackpanel"
INSTANCE_ID="stackpanel"
SERVICE_USER="stackpanel"
SITE_URL=""
KERNEL_PACK=""
MIGRATE_PACK=""
RUNNER_PACK=""
MANIFEST=""
SKIP_SYSTEMD=0
SKIP_PM2=0
ALLOW_REINSTALL=0

info() { printf '\033[1;36m[stackpanel]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[stackpanel]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[stackpanel]\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --kernel) KERNEL_PACK="${2:-}"; shift 2 ;;
    --migrate) MIGRATE_PACK="${2:-}"; shift 2 ;;
    --runner) RUNNER_PACK="${2:-}"; shift 2 ;;
    --dir) INSTALL_ROOT="${2:-}"; shift 2 ;;
    --state-dir) STATE_DIR="${2:-}"; shift 2 ;;
    --instance) INSTANCE_ID="${2:-}"; shift 2 ;;
    --user) SERVICE_USER="${2:-}"; shift 2 ;;
    --site-url) SITE_URL="${2:-}"; shift 2 ;;
    --manifest) MANIFEST="${2:-}"; shift 2 ;;
    --skip-systemd) SKIP_SYSTEMD=1; shift ;;
    --skip-pm2) SKIP_PM2=1; shift ;;
    --allow-reinstall) ALLOW_REINSTALL=1; shift ;;
    -h|--help) sed -n '2,/^set -euo pipefail/p' "$0" | sed '$d'; exit 0 ;;
    *) fail "未知参数：$1" ;;
  esac
done

[[ -n "${KERNEL_PACK}" ]] || fail "缺少 --kernel <tar.zst>"
[[ -f "${KERNEL_PACK}" ]] || fail "内核产物不存在：${KERNEL_PACK}"
[[ -n "${RUNNER_PACK}" ]] || fail "缺少 --runner <stackpanel-upgrade.mjs>"

# ---- 0. 前置检查（审计 R9） --------------------------------------------------
# 只声明支持的范围：Linux x64 + Node 22+ + 外部 PostgreSQL/Redis/S3。
# 不做"看起来能装、实际跑不起来"的降级。
[[ "$(uname -s)" == "Linux" ]] || fail "仅支持 Linux（当前 $(uname -s)）"
[[ "$(uname -m)" == "x86_64" ]] || fail "首期仅支持 x86_64（当前 $(uname -m)）"

command -v node >/dev/null 2>&1 || fail "未找到 node（需要 Node 22 或 24）"
command -v tar >/dev/null 2>&1 || fail "未找到 tar"
command -v zstd >/dev/null 2>&1 || fail "未找到 zstd（解包 .tar.zst 需要；Debian: apt install zstd）"
NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
NODE_MINOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[1]))')"
[[ "${NODE_MAJOR}" -ge 22 ]] || fail "需要 Node.js 22+，当前为 $(node -v)"
# 产物按 nodeMajor 构建；Node 26 尚未验收，明确拒绝而不是"碰运气"。
[[ "${NODE_MAJOR}" -le 24 ]] || fail "尚未验收 Node $(node -v)；请使用 Node 22 或 24"
NODE_MAJOR_MINOR="${NODE_MAJOR}.${NODE_MINOR}"

if [[ "${SKIP_SYSTEMD}" -eq 0 ]]; then
  command -v systemctl >/dev/null 2>&1 || fail "未找到 systemctl；无 systemd 的环境请加 --skip-systemd 并自行管理进程"
  # 非默认实例需要一整套 stackpanel-upgrade@<instance> 模板单元；本期没有提供，
  # 与其"装上去但 path unit 永远盯着另一个目录"，不如明确拒绝（审计 R9）。
  if [[ "${INSTANCE_ID}" != "stackpanel" ]]; then
    fail "非默认 --instance（${INSTANCE_ID}）暂不支持自动安装 systemd 单元。
请使用默认实例名，或加 --skip-systemd 并自行编写 stackpanel-upgrade@.path / stackpanel-bootstrap@.path。"
  fi
fi
if [[ "${SKIP_PM2}" -eq 0 ]]; then
  command -v pm2 >/dev/null 2>&1 || fail "未找到 pm2（npm i -g pm2）；或加 --skip-pm2 自行启动"
fi

# 产物摘要校验（ADR-0025 清单规则）：默认要求 --manifest，除非显式跳过。
# 之所以默认强制，是因为「解包成功」不能证明拿到的是构建机产出的那个包；
# 传输截断/中间人替换都会得到语法合法但内容不同的产物。
if [[ -n "${MANIFEST}" ]]; then
  [[ -f "${MANIFEST}" ]] || fail "清单文件不存在：${MANIFEST}"
elif [[ -z "${SKIP_MANIFEST_CHECK:-}" ]]; then
  fail "缺少 --manifest <artifacts.json>；仅在你已用其他方式核对摘要时才设置 SKIP_MANIFEST_CHECK=1"
fi

verify_digest() {
  local file="$1" role="$2"
  [[ -n "${MANIFEST}" ]] || return 0
  local expected
  expected="$(node -e '
    const fs = require("node:fs");
    const [manifest, role, file] = process.argv.slice(1);
    const data = JSON.parse(fs.readFileSync(manifest, "utf8"));
    const base = require("node:path").basename(file);
    const hit = (data.artifacts || []).find((a) => a.role === role && a.file === base);
    if (!hit) { console.error(`清单中没有 ${role}/${base}`); process.exit(2); }
    process.stdout.write(String(hit.sha256));
  ' "${MANIFEST}" "${role}" "${file}")" || fail "无法从清单读取 ${role} 的摘要"
  local actual
  actual="$(node -e '
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(process.argv[1]));
    process.stdout.write(hash.digest("hex"));
  ' "${file}")"
  if [[ "${actual}" != "${expected}" ]]; then
    fail "摘要不匹配：${file}
  期望 ${expected}
  实际 ${actual}
产物可能被截断或替换，拒绝安装。"
  fi
  info "摘要校验通过：$(basename "${file}")"
}

verify_digest "${KERNEL_PACK}" kernel
[[ -z "${MIGRATE_PACK}" ]] || verify_digest "${MIGRATE_PACK}" migrate

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

# ---- 1. 用户与目录 -----------------------------------------------------------
if id "${SERVICE_USER}" >/dev/null 2>&1; then
  SERVICE_GROUP="$(id -gn "${SERVICE_USER}")"
elif [[ "${SKIP_SYSTEMD}" -eq 0 ]]; then
  # 有 systemd 时自动建一个不可登录的系统用户；这是安装器的职责，
  # 让操作员手工建用户是"看似成功、其实权限全错"的常见来源。
  info "创建系统用户 ${SERVICE_USER}…"
  useradd --system --create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
  SERVICE_GROUP="$(id -gn "${SERVICE_USER}")"
else
  fail "用户 ${SERVICE_USER} 不存在；请先创建，或改用 --user"
fi

install -d -m 0755 "${INSTALL_ROOT}" "${INSTALL_ROOT}/releases" "${INSTALL_ROOT}/bin" \
  "${INSTALL_ROOT}/.staging" "${INSTALL_ROOT}/migrate"
install -d -m 0750 "${STATE_DIR}" "${STATE_DIR}/data" "${STATE_DIR}/logs" "${STATE_DIR}/backups" \
  "${STATE_DIR}/bootstrap" "${STATE_DIR}/bootstrap/inbox" "${STATE_DIR}/bootstrap/claimed" \
  "${STATE_DIR}/update" "${STATE_DIR}/update/inbox/${INSTANCE_ID}" \
  "${STATE_DIR}/update/claimed/${INSTANCE_ID}" "${STATE_DIR}/update/results/${INSTANCE_ID}" \
  "${STATE_DIR}/update/downloads" "${STATE_DIR}/update/work"

# 解包到与 releases/ 同文件系统的暂存目录：rename 才是原子的，跨文件系统 mv 不是。
STAGING="${INSTALL_ROOT}/.staging/unpack-$$"
rm -rf "${STAGING}"
mkdir -p "${STAGING}"
info "解包内核产物（${KERNEL_PACK}）…"
tar --zstd -xf "${KERNEL_PACK}" -C "${STAGING}" --no-same-owner --no-same-permissions
[[ -f "${STAGING}/RELEASE.json" ]] || fail "产物缺少 RELEASE.json"
VERSION="$(node -e 'const r=require(process.argv[1]);process.stdout.write(r.version)' "${STAGING}/RELEASE.json")"
PKG_NODE_MAJOR="$(node -e 'const r=require(process.argv[1]);process.stdout.write(String(r.nodeMajor))' "${STAGING}/RELEASE.json")"
PKG_PLATFORM="$(node -e 'const r=require(process.argv[1]);process.stdout.write(String(r.platform||""))' "${STAGING}/RELEASE.json")"
[[ "${PKG_NODE_MAJOR}" == "${NODE_MAJOR}" ]] || fail "产物要求 Node ${PKG_NODE_MAJOR}，当前为 ${NODE_MAJOR}"
# 产物的 platform 必须与实际一致：交叉构建会产出坏的原生模块（sharp/prisma/.node）。
if [[ -n "${PKG_PLATFORM}" && "${PKG_PLATFORM}" != "linux-x64" ]]; then
  fail "产物平台为 ${PKG_PLATFORM}，与目标机 linux-x64 不一致"
fi
info "内核版本 ${VERSION}（Node ${NODE_MAJOR}）"

# ---- 2. 落版本目录并原子切换 current -----------------------------------------
RELEASE_DIR="${INSTALL_ROOT}/releases/${VERSION}"
if [[ -d "${RELEASE_DIR}" && "${ALLOW_REINSTALL}" -eq 0 ]]; then
  # 同版本重装会把正在运行的文件换掉（历史上是 delete + 重建）。
  warn "releases/${VERSION} 已存在：保留原目录，仅刷新 current"
  rm -rf "${STAGING}"
else
  rm -rf "${RELEASE_DIR}"
  mv "${STAGING}" "${RELEASE_DIR}"
  chmod 0755 "${RELEASE_DIR}"
fi
# 后续步骤统一从这里读内核自描述：STAGING 在"同版本已存在"分支里已被删除，
# 继续引用 STAGING 会在迁移包校验时读到不存在的文件。
KERNEL_RELEASE_JSON="${RELEASE_DIR}/RELEASE.json"
[[ -f "${KERNEL_RELEASE_JSON}" ]] || fail "版本目录缺少 RELEASE.json：${KERNEL_RELEASE_JSON}"

info "原子切换 current -> releases/${VERSION}"
# `ln -sfn` 是「先删后建」，中断会留下无 current 的状态（ADR-0025 决策 3）。
ln -s "${RELEASE_DIR}" "${INSTALL_ROOT}/.current.tmp.$$"
node -e "require('node:fs').renameSync(process.argv[1], process.argv[2])" \
  "${INSTALL_ROOT}/.current.tmp.$$" "${INSTALL_ROOT}/current"

# ---- 3. 保留完整迁移产物（审计 R5） ------------------------------------------
# 首次安装时**不执行**迁移：数据库还没有配置。迁移由 bootstrap runner 在
# 操作员提交配置并通过预检后执行。
# 解包根必须完整保留（RELEASE.json / prisma.config.mjs / CLI / engines / 依赖闭包），
# 不能只留 migrate.mjs 与 prisma/ —— 入口会读取配置与 Prisma CLI。
MIGRATE_DIR=""
if [[ -n "${MIGRATE_PACK}" ]]; then
  [[ -f "${MIGRATE_PACK}" ]] || fail "迁移产物不存在：${MIGRATE_PACK}"
  info "解包迁移产物到 ${INSTALL_ROOT}/migrate/${VERSION}…"
  MIGRATE_STAGING="${INSTALL_ROOT}/.staging/migrate-$$"
  rm -rf "${MIGRATE_STAGING}"
  mkdir -p "${MIGRATE_STAGING}"
  tar --zstd -xf "${MIGRATE_PACK}" -C "${MIGRATE_STAGING}" --no-same-owner --no-same-permissions
  for required in migrate.mjs prisma.config.mjs prisma/schema.prisma \
      node_modules/prisma/build/index.js RELEASE.json; do
    [[ -e "${MIGRATE_STAGING}/${required}" ]] || \
      fail "迁移产物不完整：缺少 ${required}（迁移包必须保留完整解包根）"
  done

  # 文件齐全不代表版本对：kernel 与 migrate 必须互相绑定（审计 R5）。
  if ! node - "${MIGRATE_STAGING}/RELEASE.json" "${KERNEL_RELEASE_JSON}" "${VERSION}" "${NODE_MAJOR}" <<'NODE'
const fs = require('node:fs');
const [migrateFile, kernelFile, version, nodeMajor] = process.argv.slice(2);
const migrate = JSON.parse(fs.readFileSync(migrateFile, 'utf8'));
const kernel = JSON.parse(fs.readFileSync(kernelFile, 'utf8'));
const problems = [];
if (migrate.role !== 'migrate') problems.push(`migrate role=${migrate.role}`);
if (kernel.role !== 'kernel') problems.push(`kernel role=${kernel.role}`);
if (migrate.version !== version) problems.push(`migrate 版本 ${migrate.version} ≠ ${version}`);
if (kernel.version !== version) problems.push(`kernel 版本 ${kernel.version} ≠ ${version}`);
if (migrate.platform && kernel.platform && migrate.platform !== kernel.platform) {
  problems.push(`平台不一致：kernel ${kernel.platform} / migrate ${migrate.platform}`);
}
if (Number(migrate.nodeMajor) !== Number(nodeMajor)) {
  problems.push(`migrate Node ${migrate.nodeMajor} ≠ 当前 ${nodeMajor}`);
}
if (migrate.databaseMigration !== kernel.databaseMigration) {
  problems.push(
    `迁移终点不一致：kernel ${kernel.databaseMigration ?? '未声明'} / migrate ${migrate.databaseMigration ?? '未声明'}`,
  );
}
if (problems.length > 0) {
  console.error(`产物版本/平台不一致：\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
NODE
  then
    # set -e 会在 node 非零退出时结束脚本；用 if 承接才能给出可操作的信息。
    fail "迁移产物与内核产物不匹配（见上）"
  fi
  MIGRATE_DIR="${INSTALL_ROOT}/migrate/${VERSION}"
  rm -rf "${MIGRATE_DIR}"
  mv "${MIGRATE_STAGING}" "${MIGRATE_DIR}"
  chmod 0755 "${MIGRATE_DIR}"
else
  warn "未提供 --migrate：实例可以在 /setup 提交配置，但迁移会失败。"
  warn "请补装迁移包到 ${INSTALL_ROOT}/migrate/${VERSION} 后重新运行 --bootstrap。"
fi

# ---- 4. 引导配置与根密钥（审计 R4、R6） --------------------------------------
ENV_FILE="${STATE_DIR}/stackpanel.env"
INSTALL_RECORD="${STATE_DIR}/install.json"
BOOTSTRAP_STATE="${STATE_DIR}/bootstrap/state.json"

gen_hex() { node -e 'process.stdout.write(require("node:crypto").randomBytes(Number(process.argv[1])).toString("hex"))' "$1"; }
gen_key() { node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))'; }

# 读取既有值（不 source：文件里的值可能含空格与特殊字符）。
read_env_value() {
  local key="$1" file="$2"
  [[ -f "${file}" ]] || return 0
  node -e '
    const fs=require("node:fs");
    const [key,file]=process.argv.slice(1);
    for (const raw of fs.readFileSync(file,"utf8").split("\n")) {
      const line = raw.endsWith("\r") ? raw.slice(0,-1) : raw;
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const body = t.startsWith("export ") ? t.slice(7).trim() : t;
      const i = body.indexOf("=");
      if (i <= 0) continue;
      if (body.slice(0,i).trim() !== key) continue;
      let v = body.slice(i+1); const lead = v.trimStart();
      if (lead.startsWith("\"") || lead.startsWith("\x27")) {
        const q = lead[0]; const end = lead.lastIndexOf(q);
        v = end > 0 ? lead.slice(1,end) : lead.slice(1);
      } else { v = lead.trimEnd(); }
      process.stdout.write(v);
      break;
    }
  ' "${key}" "${file}" 2>/dev/null || true
}

# 已有实例判定：配置文件里已有业务连接，或安装记录标记为已完成。
EXISTING_DATABASE="$(read_env_value DATABASE_URL "${ENV_FILE}")"
EXISTING_PHASE=""
if [[ -f "${BOOTSTRAP_STATE}" ]]; then
  EXISTING_PHASE="$(node -e 'try{process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).phase||""))}catch{}' "${BOOTSTRAP_STATE}" 2>/dev/null || true)"
fi

if [[ -n "${EXISTING_DATABASE}" && "${ALLOW_REINSTALL}" -eq 0 ]]; then
  fail "检测到已配置的实例（${ENV_FILE} 含 DATABASE_URL）。
本脚本只用于首次安装。已安装实例请：
  - 升级内核：把任务写入 ${STATE_DIR}/update/inbox/${INSTANCE_ID}/；
  - 修配置：编辑 ${ENV_FILE} 后 pm2 restart；
  - 自举失败需要重来：stackpanel-upgrade --reset-infra（会备份配置并轮换令牌）。
确实要覆盖重装，请显式加 --allow-reinstall。"
fi

# 密钥只在「没有有效安装记录」时生成；重复安装绝不覆盖，否则会毁掉
# SETTINGS_ENCRYPTION_KEY 能解开的全部历史密文（审计 R6）。
JWT_SECRET="$(read_env_value JWT_SECRET "${ENV_FILE}")"
SETTINGS_ENCRYPTION_KEY="$(read_env_value SETTINGS_ENCRYPTION_KEY "${ENV_FILE}")"
SETUP_TOKEN="$(read_env_value STACKPANEL_SETUP_TOKEN "${ENV_FILE}")"
DATA_DIR_VALUE="$(read_env_value STACKPANEL_DATA_DIR "${ENV_FILE}")"
[[ -n "${DATA_DIR_VALUE}" ]] || DATA_DIR_VALUE="${STATE_DIR}/data"

GENERATED=""
if [[ -z "${JWT_SECRET}" ]]; then JWT_SECRET="$(gen_hex 48)"; GENERATED="${GENERATED} JWT_SECRET"; fi
if [[ -z "${SETTINGS_ENCRYPTION_KEY}" ]]; then SETTINGS_ENCRYPTION_KEY="$(gen_key)"; GENERATED="${GENERATED} SETTINGS_ENCRYPTION_KEY"; fi
if [[ -z "${SETUP_TOKEN}" ]]; then SETUP_TOKEN="$(gen_hex 32)"; GENERATED="${GENERATED} STACKPANEL_SETUP_TOKEN"; fi

# 写配置：保留已有键，覆盖安装器负责的键。用 node 生成，保证引号与转义
# 与内核/runner 的解析器完全一致（同一个子集，见 config-file.ts）。
STACKPANEL_UPDATE_INSTANCE_ID="${INSTANCE_ID}" \
  node - "${ENV_FILE}" "${DATA_DIR_VALUE}" "${STATE_DIR}" "${JWT_SECRET}" \
  "${SETTINGS_ENCRYPTION_KEY}" "${SETUP_TOKEN}" "${SITE_URL}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [file, dataDir, stateDir, jwt, encKey, token, siteUrl] = process.argv.slice(2);

function parse(content) {
  const out = new Map();
  for (const raw of content.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const body = t.startsWith('export ') ? t.slice(7).trim() : t;
    const i = body.indexOf('=');
    if (i <= 0) continue;
    const key = body.slice(0, i).trim();
    let value = body.slice(i + 1);
    const lead = value.trimStart();
    if (lead.startsWith('"') || lead.startsWith("'")) {
      const q = lead[0];
      const end = lead.lastIndexOf(q);
      value = end > 0 ? lead.slice(1, end) : lead.slice(1);
    } else {
      value = lead.trimEnd();
    }
    out.set(key, value);
  }
  return out;
}

function serialize(entries) {
  const lines = [];
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (value.includes('\n') || value.includes('\r') || value.includes('\0')) {
      throw new Error(`配置值含换行：${key}`);
    }
    if (!value.includes('"')) lines.push(`${key}="${value}"`);
    else if (!value.includes("'")) lines.push(`${key}='${value}'`);
    else throw new Error(`配置值同时含单双引号，无法无损写入：${key}`);
  }
  return `${lines.join('\n')}\n`;
}

const entries = fs.existsSync(file)
  ? parse(fs.readFileSync(file, 'utf8'))
  : new Map();

entries.set('STACKPANEL_DATA_DIR', dataDir);
entries.set('STACKPANEL_STATE_DIR', stateDir);
entries.set('NODE_ENV', 'production');
entries.set('JWT_SECRET', jwt);
entries.set('SETTINGS_ENCRYPTION_KEY', encKey);
entries.set('STACKPANEL_SETUP_TOKEN', token);
if (siteUrl) entries.set('SITE_URL', siteUrl);
if (!entries.has('API_BASE_URL')) entries.set('API_BASE_URL', 'http://127.0.0.1:3001');

// ---- 升级器接线（ADR-0025 决策 3） ----------------------------------------
// 产物载体的通道根是 <状态目录>/update，状态投影是它下面的 status.json。
// 此前这里一个默认值都不写，于是空白安装完成后更新中心永远显示「执行器状态不可读」
// 且基线代次恒为 0——能力齐备但页面空转。仅在用户没有显式配置时补默认值。
if (!entries.has('DISTRIBUTION_UPDATE_CARRIER')) {
  entries.set('DISTRIBUTION_UPDATE_CARRIER', 'artifact');
}
if (!entries.has('DISTRIBUTION_UPDATE_CHANNEL_DIR')) {
  entries.set('DISTRIBUTION_UPDATE_CHANNEL_DIR', path.join(stateDir, 'update'));
}
if (!entries.has('DISTRIBUTION_UPDATER_STATUS_FILE')) {
  entries.set('DISTRIBUTION_UPDATER_STATUS_FILE', path.join(stateDir, 'update', 'status.json'));
}
if (!entries.has('DISTRIBUTION_UPDATE_INSTANCE_ID')) {
  const instanceId = process.env.STACKPANEL_UPDATE_INSTANCE_ID
    ? process.env.STACKPANEL_UPDATE_INSTANCE_ID
    : 'stackpanel';
  entries.set('DISTRIBUTION_UPDATE_INSTANCE_ID', instanceId);
}

const dir = path.dirname(file);
fs.mkdirSync(dir, { recursive: true });
const tmp = path.join(dir, `.stackpanel.env.tmp-${process.pid}`);
fs.writeFileSync(tmp, serialize(entries), { mode: 0o640 });
fs.chmodSync(tmp, 0o640);
fs.renameSync(tmp, file);
NODE
chmod 0640 "${ENV_FILE}"

if [[ -n "${GENERATED}" ]]; then
  info "已生成根密钥：${GENERATED# }"
else
  info "沿用既有根密钥与初始化令牌（重复安装不覆盖）"
fi

# 安装记录：标记"这是由安装器管理的实例"，供后续诊断与 --reset-infra 参考。
node - "${INSTALL_RECORD}" "${VERSION}" "${INSTANCE_ID}" "${MIGRATE_DIR}" <<'NODE'
const fs = require('node:fs');
const [file, version, instanceId, migrateDir] = process.argv.slice(2);
const record = {
  version: 1,
  instanceId,
  kernelVersion: version,
  migrateDir: migrateDir || null,
  installedAt: new Date().toISOString(),
};
fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o640 });
NODE

# 自举状态：只在尚未存在时初始化，绝不把已推进的状态打回 needs_infra。
if [[ ! -f "${BOOTSTRAP_STATE}" ]]; then
  node - "${BOOTSTRAP_STATE}" "${VERSION}" <<'NODE'
const fs = require('node:fs');
const [file, version] = process.argv.slice(2);
const now = new Date().toISOString();
const state = {
  version: 1,
  phase: 'needs_infra',
  configGeneration: 0,
  targetVersion: version,
  createdAt: now,
  updatedAt: now,
};
fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o640 });
NODE
fi

if id "${SERVICE_USER}" >/dev/null 2>&1; then
  chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${INSTALL_ROOT}" "${STATE_DIR}"
fi
chmod 0750 "${STATE_DIR}"
chmod 0640 "${ENV_FILE}" "${INSTALL_RECORD}" "${BOOTSTRAP_STATE}" 2>/dev/null || true

# ---- 5. runner（版本目录之外） ------------------------------------------------
info "安装 runner 到 ${INSTALL_ROOT}/bin…"
install -m 0755 "${RUNNER_PACK}" "${INSTALL_ROOT}/bin/stackpanel-upgrade.mjs"
cat > "${INSTALL_ROOT}/bin/stackpanel-upgrade" <<'EOF'
#!/bin/sh
# StackPanel 产物载体执行者（不随内核版本替换）。
exec ${STACKPANEL_NODE:-node} "$(dirname "$0")/stackpanel-upgrade.mjs" "$@"
EOF
chmod 0755 "${INSTALL_ROOT}/bin/stackpanel-upgrade"

# ---- 6. 启动业务进程（首轮只有 API + Web） -----------------------------------
# 首轮不启动 worker：数据库尚未配置，它只会反复崩溃。ecosystem 自己读取
# 引导配置与阶段，自举完成后 runner 会用同一份文件重建进程并带上 worker。
PM2_HOME_DIR="${STACKPANEL_PM2_HOME:-$(getent passwd "${SERVICE_USER}" | cut -d: -f6)/.pm2}"
if [[ "${SKIP_PM2}" -eq 0 ]]; then
  info "启动 API 与 Web（PM2_HOME=${PM2_HOME_DIR}）…"
  sudo -u "${SERVICE_USER}" env \
    PM2_HOME="${PM2_HOME_DIR}" \
    STACKPANEL_STATE_DIR="${STATE_DIR}" \
    PATH="/usr/local/bin:/usr/bin:/bin:$PATH" \
    pm2 start "${RELEASE_DIR}/ecosystem.config.cjs" --update-env
  sudo -u "${SERVICE_USER}" env PM2_HOME="${PM2_HOME_DIR}" PATH="/usr/local/bin:/usr/bin:/bin:$PATH" pm2 save
else
  warn "跳过 PM2 启动；请以 ${SERVICE_USER} 用户、PM2_HOME=${PM2_HOME_DIR} 执行："
  warn "  pm2 start ${RELEASE_DIR}/ecosystem.config.cjs --update-env && pm2 save"
fi

# ---- 7. systemd 单元 ---------------------------------------------------------
if [[ "${SKIP_SYSTEMD}" -eq 0 ]]; then
  info "安装 systemd 单元…"
  UNIT_SRC="${RELEASE_DIR}/deploy/systemd"
  [[ -d "${UNIT_SRC}" ]] || UNIT_SRC="${ROOT_DIR}/deploy/systemd"
  [[ -d "${UNIT_SRC}" ]] || fail "找不到 systemd 单元（产物内与仓库里都没有 deploy/systemd）"
  install -d -m 0755 /etc/stackpanel
  [[ -f /etc/stackpanel/upgrade.env ]] || install -m 0640 \
    "${UNIT_SRC}/upgrade.env.example" /etc/stackpanel/upgrade.env

  # 单元文件里的路径随 --dir/--state-dir/--user 变化，安装时按实际值渲染。
  render_unit() {
    local src="$1" dst="$2"
    sed \
      -e "s|/opt/stackpanel|${INSTALL_ROOT}|g" \
      -e "s|/var/lib/stackpanel|${STATE_DIR}|g" \
      -e "s|^User=stackpanel$|User=${SERVICE_USER}|" \
      -e "s|^Group=stackpanel$|Group=${SERVICE_GROUP}|" \
      -e "s|^PM2_HOME=/home/stackpanel/.pm2$|PM2_HOME=${PM2_HOME_DIR}|" \
      "${src}" > "${dst}"
    chmod 0644 "${dst}"
  }
  for unit in stackpanel-upgrade.service stackpanel-upgrade.path \
      stackpanel-upgrade@.service stackpanel-bootstrap.service stackpanel-bootstrap.path; do
    [[ -f "${UNIT_SRC}/${unit}" ]] || fail "缺少 systemd 单元：${unit}"
    render_unit "${UNIT_SRC}/${unit}" "/etc/systemd/system/${unit}"
  done
  # upgrade.env 里的默认值也按实际安装路径校正（只补缺，不覆盖用户改动）。
  sed -i \
    -e "s|^STACKPANEL_ROOT=.*|STACKPANEL_ROOT=${INSTALL_ROOT}|" \
    -e "s|^STACKPANEL_STATE_DIR=.*|STACKPANEL_STATE_DIR=${STATE_DIR}|" \
    -e "s|^STACKPANEL_PM2_HOME=.*|STACKPANEL_PM2_HOME=${PM2_HOME_DIR}|" \
    /etc/stackpanel/upgrade.env

  systemctl daemon-reload
  systemctl enable --now stackpanel-upgrade.path stackpanel-bootstrap.path
  info "已启用 stackpanel-upgrade.path 与 stackpanel-bootstrap.path"

  # 开机恢复：PM2 的 startup 单元按业务用户生成，必须与运行实例同一 PM2_HOME。
  if [[ "${SKIP_PM2}" -eq 0 ]]; then
    env PATH="$PATH" pm2 startup systemd -u "${SERVICE_USER}" --hp "$(getent passwd "${SERVICE_USER}" | cut -d: -f6)" >/dev/null
    info "已配置 PM2 开机自启"
  fi
else
  warn "跳过 systemd 安装；请手工安装 deploy/systemd/*.service 与 *.path"
fi

# ---- 8. 收尾提示 -------------------------------------------------------------
info "完成。数据目录 ${STATE_DIR}/data，日志 ${STATE_DIR}/logs，版本 ${RELEASE_DIR}"
info ""
info "下一步："
if [[ -n "${SITE_URL}" && "${SITE_URL}" == https://* ]]; then
  info "  打开 ${SITE_URL}/setup 填写数据库、Redis 与对象存储。"
else
  warn "  必须先通过 HTTPS 或 SSH 隧道访问 /setup，不要在公网明文 HTTP 上填数据库密码："
  warn "    ssh -L 3000:127.0.0.1:3000 <user>@<host>  然后打开 http://127.0.0.1:3000/setup"
  warn "  生产部署请在前面加反向代理并配置 TLS。"
fi
info ""
info "初始化令牌（$(( ${#SETUP_TOKEN} )) 字符）保存在 ${ENV_FILE}："
info "  grep '^STACKPANEL_SETUP_TOKEN=' ${ENV_FILE}"
warn "  该令牌在创建首个管理员之前一直有效；完成后请把该行删除并重启 API。"
info ""
if [[ -z "${MIGRATE_DIR}" ]]; then
  warn "尚未安装迁移产物：请在 ${INSTALL_ROOT}/migrate/${VERSION} 放置完整迁移包，否则 /setup 提交后迁移会失败。"
fi
