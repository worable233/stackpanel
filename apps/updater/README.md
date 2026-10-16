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

| 文件                        | 职责                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/journal.ts`            | 独立持久卷上的**权威操作日志**：append-only、单调 seq、容忍断电半行、不倒退（§5.2、§5.3）                   |
| `src/executor-lock.ts`      | 有所有者的执行代次 + 跨进程互斥；失联可被接管，被接管后 `assertOwned()` 立即停手（§5.2）                    |
| `src/deployment-adapter.ts` | 宿主交互契约：§5.4 的 9 个步骤 + 失败恢复，每步返回完成凭据                                                 |
| `src/engine.ts`             | 状态机驱动器：记录输入摘要与凭据、断点续跑、失败走 `recovering → recovered / recovery_failed`（§5.3、§5.4） |
| `src/task-channel.ts`       | 任务通道契约 + 文件系统实现（投递 / 认领 / 结果回写），生产可换成带认证的内部端点                           |
| `src/main.ts`               | 组装轮询循环；默认装配**未配置即拒绝**的适配器，避免未绑定 project 时误操作宿主                             |

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
pnpm --filter @stackpanel/updater build      # tsup 产出 dist/main.js（ESM，node22）
pnpm --filter @stackpanel/updater typecheck
pnpm --filter @stackpanel/updater test       # 假适配器：状态推进 / 续跑 / 恢复 / 停手
```

生产镜像在 `dist/main.js` 之外预置 Docker/Compose 客户端与 pg 备份恢复工具；执行器通过
`node:child_process` 调用它们（`tsup` 不打包这些外部工具）。运行时环境变量：

| 变量                       | 说明                                                |
| -------------------------- | --------------------------------------------------- |
| `UPDATER_STATE_DIR`        | updater 独立持久卷根（日志 / 锁 / 通道 / 工作目录） |
| `UPDATER_INSTANCE_ID`      | 绑定实例 ID；updater 只服务该实例                   |
| `UPDATER_COMPOSE_PROJECT`  | 该实例绑定的 Compose project                        |
| `UPDATER_POLL_INTERVAL_MS` | 轮询间隔，默认 `5000`                               |

三项均为必填；缺任一项则 `loadConfig` 直接抛错，进程不启动。

## 尚未实现（后续 §13 切片）

- **真实 `DeploymentAdapter`**：Docker/Compose 下载与切换、PG 备份与恢复、一次性迁移、
  维护态探针、以及 §6 失败兜底矩阵。当前 `main.ts` 装配的是拒绝执行的占位适配器。
- **updater 自更新与真实接管测试**（§5.2）：候选 updater 先验证日志协议兼容，旧实例停止
  并释放执行权后才接管；不能只靠 restart 策略宣称完成。
- **恢复入口服务**（§5.2）：固定恢复页 + 独立认证的恢复 API，默认仅管理网可达。
- 断点续跑目前重建自属主内存中的 `held`；跨进程接管后的现场对账将随真实适配器补齐。
