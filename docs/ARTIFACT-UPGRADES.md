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
# 1. 构建并打包（发布机执行）
pnpm --filter @stackpanel/api build
pnpm --filter @stackpanel/web build          # 需 output: 'standalone'
node scripts/release/build-kernel-artifact.mjs \
  --version 0.3.0 --platform linux-x64 --out dist-artifacts
pnpm --filter @stackpanel/updater build
node scripts/release/build-upgrade-runner.mjs --out dist-artifacts

# 2. 目标机安装（root 执行）
sudo bash scripts/install-artifact.sh \
  --kernel   dist-artifacts/stackpanel-0.3.0-kernel-linux-x64.tar.zst \
  --migrate  dist-artifacts/stackpanel-0.3.0-migrate-linux-x64.tar.zst \
  --runner   dist-artifacts/stackpanel-upgrade.mjs
```

安装脚本会创建目录、原子切换 `current`、把 runner 放在 `bin/`（不随版本替换）、
执行一次迁移，并启用 `stackpanel-upgrade.path`。启用后 systemd 只在
`inbox/*.json` 出现时拉起 oneshot，无常驻进程。

## 升级流程

1. 更新中心（API）求解计划，把声明式任务写到 `inbox/<instance>/<key>.json`。
2. `stackpanel-upgrade.path` 触发 `stackpanel-upgrade --drain`。
3. runner 按九步执行：下载并校验两个产物 → 预检（代次/Node ABI/磁盘/PM2）→
   **全停 api+worker+web**（并 `pm2 save`）→ 快照 → 用新版本自带的 Prisma CLI
   迁移 → `current` 原子切换 → `pm2 delete` + `start` → `/health` `/ready` Web 探针 →
   提交（推进 generation）→ 清理超出保留数的 release。
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
```

## 环境变量

runner 读取 `/etc/stackpanel/upgrade.env`（`deploy/systemd/upgrade.env.example`）：

| 变量                                                    | 说明                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------- |
| `STACKPANEL_ROOT`                                       | 安装根，默认 `/opt/stackpanel`                                |
| `STACKPANEL_STATE_DIR`                                  | 状态根，默认 `/var/lib/stackpanel`                            |
| `STACKPANEL_UPDATE_INSTANCE_ID`                         | 实例 ID；必须与 API 的 `DISTRIBUTION_UPDATE_INSTANCE_ID` 一致 |
| `STACKPANEL_PM2_HOME`                                   | 必须与业务进程同一用户、同一 PM2_HOME                         |
| `DATABASE_URL`                                          | 迁移与快照使用                                                |
| `STACKPANEL_RELEASE_RETENTION`                          | 保留 release 数，默认 2                                       |
| `STACKPANEL_HEALTH_URL` / `_READINESS_URL` / `_WEB_URL` | 维护态探针地址                                                |
| `STACKPANEL_DATABASE_BACKUP=off`                        | 备份由外部系统负责时跳过 `pg_dump`                            |
| `STACKPANEL_ARTIFACT_ALLOW_HTTP=1`                      | 仅离线镜像源/联调时放宽 https 要求                            |

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
