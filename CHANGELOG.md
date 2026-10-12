# 更新日志

本文件记录 StackPanel 内核的公开变更。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

暂无。

## [0.2.0] - 2026-10-07

### 新增

- 插件隔离运行时：生产环境第三方插件默认以 `execution: "isolated"` 在独立 Node 子进程中运行，
  通过带协议版本、插件身份校验、消息大小上限、并发上限与双向超时的 IPC RPC 暴露 `PluginContext`；
  worker 连续三次崩溃后熔断，插件置为 `failed` 并清理其路由、模型与任务。
- SDK 新增上游请求的 URL 安全判定原语与相关类型，供插件在声明上游时复用 SSRF 防护。
- 前端包新增区域地图相关组件与构建脚本。

### 变更

- 插件错误与内核错误统一携带稳定的错误码，跨进程边界传递时保留原始错误信息。
- 插件状态读写接口收敛，前端清单契约同步调整。
- 内核 API 版本随本次升级递增（`packages/spec` 为契约单一来源）。

### 修复

- 收紧请求与模型数据的净化逻辑，修复若干输入校验缺口。

## [0.1.0] - 2026-10-02

### 新增

- StackPanel 内核首个公开版本：API-first、微内核插件化的数字商品与主机业务管理系统。
- `apps/api`：Fastify + Prisma（PostgreSQL）内核服务，含 RBAC、钱包账本、SP v1 渠道接口、
  插件宿主与周期任务。
- `apps/web`：Next.js 后台与前台；插件前端经 BFF 通用代理访问。
- `packages/spec`：对外契约（OpenAPI 能力注册表与版本单一来源）。
- `packages/sdk`：插件开发 SDK（错误品牌、路径、签名等原语）。
- `packages/net-guard`：出站请求 SSRF 防护共享原语。
- `packages/db` / `packages/ui` / `packages/mcp`：数据层、组件库与 MCP 服务端。
- `packages/plugins`：运行时必需的内置插件（login、store 系列、wallet）。
- `packages/themes`：内置主题。
- Docker Compose 与 PM2 两套部署方式；备份、恢复与一键部署脚本。

### 修复

- 部署脚本不再硬依赖 `openssl`：缺失时回退 `/dev/urandom` 生成密钥。
- 修正 bootstrap 占位符被当作真实密钥使用的问题（会导致初始管理员密码可预测）。

---

本仓库历史为重建后的单一初始提交，之前的开发历史与临时调试产物未纳入。
