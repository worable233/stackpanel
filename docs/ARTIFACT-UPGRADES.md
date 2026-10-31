# 产物载体内核升级（ADR-0025，非 Docker / PM2）

本文档说明 `/opt/stackpanel` + `/var/lib/stackpanel` 布局下的内核升级执行者
`stackpanel-upgrade`。它只处理 `artifact` 载体；Docker 部署的 `oci` 载体仍由
`apps/updater` 的独立容器执行。

## 目录

```
/opt/stackpanel/
├── current -> releases/<version>        # 原子切换点（symlink + rename）
├── releases/<version>/                  # 解包后的内核产物（至少保留上一版）
└── bin/stackpanel-upgrade               # runner，位于版本目录之外

/var/lib/stackpanel/
├── data/  logs/                         # 运行期状态，绝不放进版本目录
├── backups/<ts>-<version>/              # 指针 + 可选 database.dump
└── update/
    ├── inbox/<instance>/*.json          # API 提交（systemd path 监听点）
    ├── claimed/  results/  archived/
    ├── downloads/<key>/                 # 已校验的 tar.zst 与解包暂存
    ├── update-journal.jsonl             # 权威日志（append-only）
    ├── executor.lock                    # 执行权（跨进程互斥）
    ├── deployment-pointer.json          # 当前 generation / digest / 上一代
    └── status.json                      # 更新中心读取的投影
```

## 安装

```bash
# 1. 构建并打包（发布机执行；产物必须在目标平台构建）
pnpm --filter @stackpanel/spec build        # 其余包从这里消费契约与 KERNEL_VERSION
pnpm --filter @stackpanel/api build
pnpm --filter @stackpanel/web build          # 需 output: 'standalone'
# --version 必须等于 KERNEL_VERSION（产物 /health 汇报的是编译进包的常量）
node scripts/release/build-kernel-artifact.mjs \
  --version 0.3.0 --platform linux-x64 --out dist-artifacts
pnpm --filter @stackpanel/updater build
node scripts/release/build-upgrade-runner.mjs --out dist-artifacts

# 2. 目标机安装（root 执行，首次安装）
#    必须提供 --manifest：安装器按清单校验 sha256，并交叉核对
#    kernel/migrate 的 role / version / platform / nodeMajor。
sudo bash scripts/install-artifact.sh \
  --kernel   dist-artifacts/stackpanel-0.3.0-kernel-linux-x64.tar.zst \
  --migrate  dist-artifacts/stackpanel-0.3.0-migrate-linux-x64.tar.zst \
  --runner   dist-artifacts/stackpanel-upgrade.mjs \
  --manifest dist-artifacts/stackpanel-0.3.0-linux-x64.artifacts.json \
  --site-url https://panel.example.com   # 可选
```

安装脚本会创建目录/业务用户、**保留完整 migrate 解包根**到
`migrate/<version>/`（首装不执行迁移——此时还没有数据库）、生成根密钥与
一次性初始化令牌写入 `/var/lib/stackpanel/stackpanel.env`（`0640`，属主=业务用户）、
原子切换 `current`、把 runner 放在 `bin/`（不随版本替换）、启动 API+Web
（**不启动 worker**）并启用 `stackpanel-upgrade.path` 与 `stackpanel-bootstrap.path`。

已有实例默认**拒绝**重新初始化（防止覆盖 `JWT_SECRET` / `SETTINGS_ENCRYPTION_KEY`）；
确实要覆盖需显式 `--allow-reinstall`。密钥只在缺失时生成，重复安装不轮换。

安装脚本用 `sudo -u … env … pm2 start` 拉起进程，并且**先 `cd` 到版本目录**再执行：
PM2 守护进程会继承当时的工作目录，若在 `/root` 里执行安装，守护进程随后 spawn
子进程只会得到 `spawn /usr/local/bin/node EACCES`——进程表看起来建好了，实际一个
都没起来。

产物平台名有两个来源：`RELEASE.json` 写的是**契约名**（`linux/amd64`），tar 与清单
命名用的是**产物名**（`linux-x64`）。安装器两者都接受，只认其一会让每一份合法产物
都装不上。

## 首次自举（零配置文件）

1. 用 HTTPS 或 SSH 隧道打开 `/setup`（例如 `ssh -L 3000:127.0.0.1:3000 <user>@<host>`），
   不要在公网明文 HTTP 上填写数据库密码。
2. 填入数据库 / Redis / S3 与初始化令牌（`grep '^STACKPANEL_SETUP_TOKEN=' /var/lib/stackpanel/stackpanel.env`）。
3. 提交后 API 先做有界预检（PG 版本/DDL 权限/迁移状态、Redis 读写、S3 私有前缀读写删），
   通过才写不可变候选 `bootstrap/config.candidate-<generation>.env` 并发布任务，返回 `202`。
4. `stackpanel-bootstrap.path` 唤醒 `stackpanel-upgrade --bootstrap`：抢同一把实例锁 →
   认领任务（移出 inbox，失败不会反复触发）→ 迁移 → 合并提升配置 → `pm2 delete/start/save` →
   探针 → 阶段到 `needs_admin`。
5. 在 `/setup` 创建首个管理员；成功后阶段推进到 `complete`，初始化令牌在此之前一直有效。

阶段：`needs_infra → validating → queued → migrating → starting → needs_admin → complete`，
失败停在 `migration_failed`（可直接修正候选）或 `runtime_failed`（**不**重开配置写接口）。

任务里的 `targetVersion` 由 API 从产物根的 `RELEASE.json` 读取（`dist/server.js`
向上三层到 `<release>/RELEASE.json`）。读不到时只能退化成 `unknown`，runner 就
找不到对应的迁移包——因此解析逻辑集中在 `apps/api/src/bootstrap/release-version.ts`
并有单测钉住层级。

`GET /setup/status` 是未认证的公开投影，只给阶段与失败分类。查看详细诊断（最近一次
runner 结果、三个独立结果）需要带上同一个令牌：

```bash
TOKEN="$(sed -n 's/^STACKPANEL_SETUP_TOKEN="\(.*\)"/\1/p' /var/lib/stackpanel/stackpanel.env)"
curl -s -H "X-Setup-Token: ${TOKEN}" http://127.0.0.1:3001/setup/diagnostics
```

返回内容中的 DSN、密码、token、长密钥都会被脱敏成 `<redacted>`，并做长度截断。

崩溃恢复：`stackpanel-bootstrap.service` 在开机时也会运行，inbox 为空但状态停在
`queued`/`migrating`/`starting` 时会自动续跑；`starting` 只重建进程，不重跑迁移。

逃生门：`stackpanel-upgrade --reset-infra` 仅在失败态可用，会备份配置、轮换令牌、
清空候选与任务通道；**不会**回退已经执行过的数据库迁移。

内核产物内自带 `deploy/systemd/`，因此目标机不需要源码树：安装脚本优先从
`releases/<version>/deploy/systemd` 取单元文件。`/etc/stackpanel/upgrade.env`
只在不存在时创建，升级不会覆盖运维配置。

### 产物必须自带什么

`build-kernel-artifact.mjs` 除了 `apps/` 与依赖闭包，还会把**内置插件与默认主题**
打进 `releases/<version>/packages/{plugins,themes}`（只带 `dist/`、`frontend/`、
`assets/`、`package.json`、`theme.css|json`，不带 `src/`、`node_modules`、
`dist-pack/`）。原因是内核把这两棵目录当作「随内核发布的本地来源」：

- 缺 `packages/themes/default` → 默认主题没被播种，`GET /` 直接 404；
- 缺 `packages/plugins/*` → 市场里没有任何内置插件（`plugins: []`）。

这两种情况在构建机上完全看不出来（构建机有完整源码树），只会在目标机上暴露，
所以构建脚本在没找到任何 `stackpanel.builtin === true` 的插件时直接失败。
插件与主题的前端产物保留裸导入（`@stackpanel/sdk`、`zod`），它们的依赖因此被
并入依赖闭包。

闭包复制会跳过包自带的 `node_modules`/`.bin`：那是构建机的 pnpm 布局，里面的
链接是 `.pnpm/...` 的绝对路径，解包到目标机后全部失效，还会把 typescript、vitest
这类开发依赖一起拖进产物。

### 插件如何解析到内核依赖

插件装在 `<state>/data/plugins/<id>/`，而 `@stackpanel/sdk`、`zod` 在
`<root>/current/node_modules`；数据目录通常在安装根之外（`/var/lib/stackpanel`
vs `/opt/stackpanel`），Node 的 ESM 解析只会**向上**找 `node_modules`，这条路径
永远到不了内核依赖。表现极具误导性：进程正常、安装与自举都报成功，但每个插件
都是 `Skipping invalid plugin: Cannot find package 'zod'`，首页 404、市场为空。

API 启动时会建立**符号链接桥接** `<data>/node_modules -> <root>/current/node_modules`：

- 不复制依赖，因此不会出现第二份 zod 实例（`instanceof` 与 schema 复用都会失效）；
- 目标指向 `current`，升级切换后自动跟随新版本，无需重写；
- 已存在时不介入（开发布局下数据目录本来就有真实 `node_modules`）。

## 升级流程

1. 更新中心（API）求解计划，把声明式任务写到 `inbox/<instance>/<key>.json`。
2. `stackpanel-upgrade.path` 触发 `stackpanel-upgrade --drain`。
3. runner 按九步执行：下载并校验两个产物 → 预检（代次/Node ABI/磁盘/PM2）→
   **全停 api+worker+web**（并 `pm2 save`）→ 快照 → 用新版本自带的 Prisma CLI
   迁移 → `current` 原子切换 → `pm2 delete` + `start` → `/health` `/ready` Web 探针 →
   校验 `/health` 的 `version` 等于计划版本 → 提交（推进 generation）→ 清理超出保留数的 release。
4. 迁移成功后探针失败：切回切换前的 release，并重新拉起进程；迁移前的失败只清理
   候选，不动现网。

## 触发方式

```bash
# 常规：Web 更新中心提交任务
# 逃生门（Web 不可用时）：
sudo systemctl start stackpanel-upgrade.service

# 直接执行一个任务文件（不经过通道）
/opt/stackpanel/bin/stackpanel-upgrade --request /path/task.json

# 只读对账 / 回退到上一版 / 崩溃后重新入队
/opt/stackpanel/bin/stackpanel-upgrade --reconcile
/opt/stackpanel/bin/stackpanel-upgrade --rollback
/opt/stackpanel/bin/stackpanel-upgrade --requeue

# 首次自举（通常由 stackpanel-bootstrap.path 触发，也可手工执行）
/opt/stackpanel/bin/stackpanel-upgrade --bootstrap

# 受限重置：仅在失败态可用（备份配置 + 轮换令牌，不回退已执行的迁移）
/opt/stackpanel/bin/stackpanel-upgrade --reset-infra
```

## 环境变量

runner 读取 `/etc/stackpanel/upgrade.env`（`deploy/systemd/upgrade.env.example`）：

| 变量                                                    | 说明                                                                                                                    |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `STACKPANEL_ROOT`                                       | 安装根，默认 `/opt/stackpanel`                                                                                          |
| `STACKPANEL_STATE_DIR`                                  | 状态根，默认 `/var/lib/stackpanel`                                                                                      |
| `STACKPANEL_UPDATE_INSTANCE_ID`                         | 实例 ID；必须与 API 的 `DISTRIBUTION_UPDATE_INSTANCE_ID` 一致                                                           |
| `STACKPANEL_PM2_HOME`                                   | 必须与业务进程同一用户、同一 PM2_HOME                                                                                   |
| `DATABASE_URL`                                          | **不在此文件配置**：唯一来源是 `/var/lib/stackpanel/stackpanel.env`（systemd 单元把它放在最后加载；同名键后者覆盖前者） |
| `STACKPANEL_RELEASE_RETENTION`                          | 保留 release 数，默认 2                                                                                                 |
| `STACKPANEL_HEALTH_URL` / `_READINESS_URL` / `_WEB_URL` | 维护态探针地址                                                                                                          |
| `STACKPANEL_DATABASE_BACKUP=off`                        | 备份由外部系统负责时跳过 `pg_dump`                                                                                      |
| `STACKPANEL_ARTIFACT_ALLOW_HTTP=1`                      | 仅离线镜像源/联调时放宽 https 要求                                                                                      |

API 侧需要设置：

```bash
DISTRIBUTION_UPDATE_CARRIER=artifact
DISTRIBUTION_DEPLOY_PLATFORM=linux/amd64     # 与产物平台一致
DISTRIBUTION_UPDATE_CHANNEL_DIR=/var/lib/stackpanel/update
DISTRIBUTION_UPDATE_INSTANCE_ID=stackpanel
DISTRIBUTION_UPDATER_STATUS_FILE=/var/lib/stackpanel/update/status.json
```

`DISTRIBUTION_UPDATE_CARRIER` 缺省为 `oci`：既有镜像部署不会因为一次内核升级被
静默切到产物载体。

## 发布

`release.yml` 在打 tag 时（`v*`）会在 ubuntu runner 上完成闭环：

1. `build-kernel-artifact.mjs --platform linux-x64` 产出 kernel / migrate 两个 tar.zst
   与 `<version>-linux-x64.artifacts.json`；
2. `build-upgrade-runner.mjs` 产出 `stackpanel-upgrade.mjs` + 包装脚本与摘要清单；
3. `build-kernel-manifest.mjs --artifacts …` 把产物摘要并入内核清单后再签名。

清单、两个 tar.zst、runner 与 `.artifacts.json` 都挂在同一个 GitHub Release 上，
`artifacts[].url` 默认指向 `releases/download/<tag>/<file>`，无需额外配置。

**必须在本机平台构建**：打包前会校验原生依赖（`@img/sharp-*`、Prisma
`schema-engine-*`）与目标 OS 一致；在 macOS 上打 `linux-x64` 会直接失败，
而不是产出一个到目标机才崩的包。

## 已知边界

- 只支持 `linux-x64`（首期）；`sharp`/Prisma 引擎按平台绑定。
- 不支持集群：`current` 切换对已启动进程不是原子可见。
- 放行写入后的故障不自动恢复旧快照（与容器路径一致）。
- 迁移只由 runner 执行；API 启动不再自动 `migrate deploy`。
- runner 以 realpath 判定自身入口：安装路径含符号链接（`/tmp`、软链目录）也能正常
  执行，不会出现「退出码 0 但什么都没做」。
- systemd 单元刻意不设 `ProtectHome`：runner 必须与业务进程共用同一 `PM2_HOME`
  （默认 `~/.pm2`）。若要求收紧，请把 `PM2_HOME` 与业务进程一并迁到
  `/var/lib/stackpanel/.pm2` 并加入 `ReadWritePaths`。
- 在 QEMU 模拟的 amd64 环境里做长时间压测时，`ecosystem.config.cjs` 的
  `max_memory_restart`（512M）可能因慢速模拟下的内存峰值反复重启 API。这是模拟
  环境的性能特征，不是安装链路缺陷；真实 amd64 机器上不出现。
