# @stackpanel/updater

独立升级执行器（PLAN-github-distribution-and-updates §5、§11）。

## 定位

默认部署中的 `updater` 服务，用**独立、预构建镜像**运行，内置固定版本的 Docker/Compose
客户端、验签器与 PostgreSQL 备份恢复工具。它：

- **不依赖待升级内核启动**——内核升级失败时仍能提供独立恢复入口（§5.1）。
- 是唯一持有 Docker socket 的进程；API、Worker、插件都不得取得该权限。
- 只操作**安装时绑定的 Compose project、允许的服务与受管卷**；不执行包内任意
  compose / shell hook 或 Release 正文。
- 通过实例私有、带身份认证的通道取得 API 提交的**声明式升级任务**，不向公网暴露
  Docker 代理或通用命令执行。

## 代码边界

本包把状态机、持久日志、执行权与任务通道变成**可注入假实现、可单测**的核心；真实
宿主交互（Docker/Compose、pg 备份、一次性迁移、恢复）全部藏在 `DeploymentAdapter`
契约后，因此可以在不碰真实 Docker 的情况下覆盖推进、断电续跑与失败恢复。

| 文件                          | 职责                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/journal.ts`              | 独立持久卷上的**权威操作日志**：append-only、单调 seq、容忍断电半行、不倒退（§5.2、§5.3）                                  |
| `src/executor-lock.ts`        | 有所有者的执行代次 + 跨进程互斥；失联可被接管，被接管后 `assertOwned()` 立即停手（§5.2）                                   |
| `src/deployment-adapter.ts`   | 宿主交互契约：§5.4 的 9 个步骤 + 失败恢复，每步返回完成凭据                                                                |
| `src/engine.ts`               | 状态机驱动器：记录输入摘要与凭据、断点续跑、失败走 `recovering → recovered / recovery_failed`（§5.3、§5.4）                |
| `src/task-channel.ts`         | 任务通道契约 + 文件系统实现（投递 / 认领 / 结果回写），生产可换成带认证的内部端点                                          |
| `src/command.ts`              | 宿主命令执行抽象：`SpawnCommandRunner` 用白名单 + **非 shell** 参数数组调用 docker/pg 客户端；测试注入假 runner            |
| `src/compose-config.ts`       | 绑定部署配置：project 目录、compose 文件、服务名、镜像注入变量、数据库、探针；从 `UPDATER_*` 装配并校验                    |
| `src/deployment-pointer.ts`   | 部署指针：当前 digest + generation，切换成功递增并保留上一代供回退（§5.2、§5.4-6）                                         |
| `src/snapshot-store.ts`       | 最近成功备份的引用，供失败恢复判断（§5.4-4、§6）                                                                           |
| `src/compose-adapter.ts`      | **真实** Docker/Compose 适配器：九步落到绑定 project，切换用镜像环境变量 + `up -d` 拉到同一 release 集合                   |
| `src/status.ts`               | 只读状态投影（代次 / digest / 进行中任务 / 最近结果），供内核更新中心读取（§5.2）                                          |
| `src/self-update.ts`          | 自更新交接：候选先验证协议与日志格式兼容，旧实例释放执行权后接管；不兼容即拒绝（§5.2）                                     |
| `src/self-update-executor.ts` | 自升级**执行**：无在途任务时切换 updater 镜像、记录回退点、请求交接；候选自确认提交，候选超时未确认由守护者回退（§5.2）    |
| `src/recovery-entry.ts`       | 独立恢复入口：固定恢复页 + 独立 bearer 认证的受限动作（重试 / 回退 / 对账），默认只回环（§5.2）                            |
| `src/recovery-actions.ts`     | 恢复入口动作接线：重试=以新幂等键**重新投递**已归档任务（不绕过执行权）、回退/对账经适配器受限方法，不假报成功（§5.2、§6） |
| `src/main.ts`                 | 组装轮询循环；绑定配置齐全时用真实适配器，否则用**未配置即拒绝**的默认适配器；写自更新状态、处理交接、挂恢复入口           |
| `src/artifact/layout.ts`      | 产物载体布局：`/opt/stackpanel/{current,releases,bin}` 与 `/var/lib/stackpanel/{data,logs,backups,update}`（ADR-0025）     |
| `src/artifact/adapter.ts`     | 产物载体适配器：下载/校验 tar.zst、原子 symlink 切换、PM2 重建、快照、迁移、探针与回滚                                     |
| `src/artifact/main.ts`        | 宿主 oneshot 入口：`--drain` / `--request` / `--rollback` / `--reconcile` / `--requeue`（systemd path 触发，无常驻进程）   |

两种载体的执行者（ADR-0025）：

- `oci`：本包的 `src/main.ts` + `src/compose-adapter.ts`，运行在独立 updater 容器中。
- `artifact`：`src/artifact/main.ts` + `src/artifact/adapter.ts`，作为宿主 systemd
  oneshot 运行；不依赖 Docker。用法与目录见 `docs/ARTIFACT-UPGRADES.md`。

状态机（§5.3）：

```text
queued → resolving → downloading → verified → preflight
  → quiescing → snapshotting → migrating → switching → verifying
  → committed → cleanup

任何步骤失败        → recovering → recovered / recovery_failed
不满足策略或兼容性  → blocked（保留原部署）
```

## 构建与运行

```bash
pnpm --filter @stackpanel/updater build      # tsup 产出 dist/main.js 与 dist/artifact/main.js（ESM，node22）
pnpm --filter @stackpanel/updater typecheck
pnpm --filter @stackpanel/updater test       # 假适配器：状态推进 / 续跑 / 恢复 / 停手
```

生产镜像（`apps/updater/Dockerfile`）是**独立、预构建**镜像：只复制 `dist/main.js`，
不带源码 / pnpm / 构建器，内置固定来源的 Docker CLI + Compose v2 插件与
`postgresql-client-16`（§5.1）。`@stackpanel/spec` 被内联进产物，运行时无需任何
workspace node_modules。

```bash
docker build -f apps/updater/Dockerfile -t stackpanel-updater .
```

运行时环境变量：

| 变量                             | 说明                                                               |
| -------------------------------- | ------------------------------------------------------------------ |
| `UPDATER_STATE_DIR`              | updater 独立持久卷根（日志 / 锁 / 通道 / 指针 / 备份）             |
| `UPDATER_INSTANCE_ID`            | 绑定实例 ID（同时作为 Compose project 名）；updater 只服务该实例   |
| `UPDATER_COMPOSE_PROJECT`        | 绑定的 Compose project 目录（命令工作目录）                        |
| `UPDATER_COMPOSE_FILES`          | compose 文件（逗号分隔），默认 `docker-compose.yml`                |
| `UPDATER_ENV_FILE`               | `--env-file` 路径，compose 默认 `docker/.env`；缺了它密钥会被插值成空串 |
| `UPDATER_IMAGE_REPOSITORY`       | 目标镜像仓库（不含 digest），如 `ghcr.io/worable233/stackpanel`    |
| `UPDATER_IMAGE_ENV`              | 承载镜像引用的环境变量名，默认 `STACKPANEL_IMAGE`                  |
| `UPDATER_SERVICE_API/WORKER/WEB` | 受管服务名，默认 `api` / `worker` / `web`                          |
| `UPDATER_SERVICE_MIGRATE`        | 一次性迁移服务名，默认 `migrate`（`restart: "no"` + `entrypoint-migrate`） |
| `UPDATER_DB_SERVICE/USER/NAME`   | 数据库服务名与凭据                                                 |
| `UPDATER_READINESS_URL`          | 维护态 readiness 探针，默认 `http://api:3001/health`               |
| `UPDATER_LOGIN_PROBE_URL`        | 登录/权限探针（可选）                                              |
| `UPDATER_WEB_URL`                | Web 资源探针（可选）                                               |
| `UPDATER_MIN_FREE_BYTES`         | 磁盘下限（可选；不足则在停服前失败，§5.4-1）                       |
| `UPDATER_POLL_INTERVAL_MS`       | 轮询间隔，默认 `5000`                                              |
| `UPDATER_SELF_SERVICE`           | updater 自身服务名（自升级切换它），默认 `updater`                 |
| `UPDATER_SELF_IMAGE_ENV`         | 承载 updater 镜像引用的环境变量名，默认 `STACKPANEL_UPDATER_IMAGE` |

缺 `UPDATER_STATE_DIR` / `UPDATER_INSTANCE_ID` / `UPDATER_COMPOSE_PROJECT` /
`UPDATER_IMAGE_REPOSITORY` 任一项则拒绝启动（`main.ts` 用**未配置即拒绝**的默认
适配器，绝不误操作宿主）。

## 尚未实现 / 未验收（后续 §13 切片）

- **真实运行验收**：Docker/Compose 适配器、自更新交接与恢复入口均已有可测核心（假
  runner / 注入依赖覆盖成功、失败与不兼容分支），但「干净机器从旧发行版自动升级」
  的端到端证据属 §13-7，需真实 Docker/PG 与发布版镜像，**仍未执行**。
- **集群执行与跨主机对账**（§9、ADR-0017 §5）：单机 Compose 的恢复入口动作已接线到
  真实适配器；多副本/跨主机的节点执行器与对账仍属后续。
