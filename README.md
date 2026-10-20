<p align="center">
  <img src="apps/api/assets/brand/logo.png" width="104" alt="StackPanel 标志">
</p>

<h1 align="center">StackPanel</h1>

<p align="center">面向数字商品和主机业务的自托管插件化业务平台，由 AI Agent 驱动</p>

<p align="center">
  <a href="https://github.com/worable233/stackpanel/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/worable233/stackpanel/ci.yml?branch=main&style=flat-square&label=CI" alt="CI 状态"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/worable233/stackpanel?style=flat-square" alt="MIT 许可证"></a>
</p>

<p align="center">
  <strong>简体中文</strong> · <a href="./README.en.md">English</a>
</p>

<p align="center">
  <a href="#从目标到执行">Agent</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#文档与运维">文档</a> ·
  <a href="./CONTRIBUTING.md">贡献</a> ·
  <a href="./SECURITY.md">安全</a>
</p>

---

> [!TIP]
> StackPanel 仍处于早期开发阶段。版本迭代可能包含破坏性更改，升级前请阅读发行说明并备份数据。欢迎提交 Issue、讨论设计与 Pull Request，共同完善项目。

StackPanel 是面向数字商品和主机业务的自托管插件化业务平台。插件化内核统一订单、支付、交付、工单与服务管理能力；内置 Agent 将这些能力编排为可执行的工作流，让你从目标出发推进业务，而不是逐页操作后台。

## 从目标到执行

| 能力 | 它解决的问题 |
| --- | --- |
| **以 Agent 发起工作** | 说明你要达成的目标。Agent 读取上下文、调用可用能力、保留执行记录，并在需要时把工作交给人确认。 |
| **以插件扩展业务** | 插件可声明路由、权限、页面、事件、数据模型与能力项。商店、工单和支付网关只是开始，平台随业务持续演进。 |
| **以治理保持可控** | Agent 的有效权限始终不超过发起人；预算、步骤数和模型可由管理员限制，危险写操作进入审批，所有执行均可审计。 |
| **以 API 连接生态** | 后台控制台、Agent、自动化脚本和第三方客户端共享 REST API 与类型化契约；已审核的 MCP 工具和隔离动作可扩展执行面。 |
| **以自托管保留控制权** | 数据与部署在自己的服务器上。使用 PostgreSQL，集群场景配合 Redis 和 S3 兼容对象存储；备份覆盖数据库与运行数据。 |

## 快速开始

以下步骤适用于用宝塔或 1Panel 管理的 Linux 服务器。面板负责域名、HTTPS 和反向代理；StackPanel 自己会启动数据库、Redis 和对象存储，无需另行安装。

1. 在面板中确认 Docker 已安装并运行，然后打开服务器的“终端”。
2. 将域名的 A 记录指向这台服务器。稍后会在面板里为这个域名创建反向代理和 HTTPS 证书。
3. 在终端执行以下命令：

```bash
git clone https://github.com/worable233/stackpanel.git
cd stackpanel

# 启动 StackPanel，并自动生成所需密钥
bash scripts/deploy.sh
```

4. 第一次启动会下载并构建组件。完成后，编辑项目中的 `docker/.env`，将以下两项中的域名替换为自己的域名：

```dotenv
STACKPANEL_PUBLIC_URL=https://panel.example.com
STACKPANEL_API_PUBLIC_URL=https://panel.example.com
```

5. 在同一目录重新执行 `docker compose --env-file docker/.env up -d`。然后在宝塔或 1Panel 为该域名创建反向代理，目标填 `http://127.0.0.1:3000`，并申请 HTTPS 证书。
6. 用 `https://你的域名` 打开 StackPanel，按页面引导创建第一个管理员。终端显示“初始化令牌”时，把它填入引导页面；它也保存在 `docker/.env`，认领管理员后会失效。

未使用宝塔或 1Panel 时，可以让 StackPanel 的内置 Caddy 自动配置 HTTPS；使用自己的数据库、发布镜像或集群部署时，请继续阅读 [Docker 文档](./docker/README.md)。

```bash
# 不经由宝塔或 1Panel，使用内置 Caddy 自动配置 HTTPS
bash scripts/deploy.sh --domain sp.example.com --email you@example.com

# 使用外部 PostgreSQL、Redis 和对象存储的集群部署
bash scripts/deploy.sh --cluster --image ghcr.io/<owner>/stackpanel@sha256:<digest>
```

集群模式需要先配置 `docker/.env` 中的 `DATABASE_URL`、`REDIS_URL` 与 `STORAGE_S3_*`。生产环境需要 Redis 和 S3 兼容对象存储。

## 它如何工作

```text
            目标 ──────> 内置 Agent
                                │
                    权限 · 预算 · 审批 · 审计
                                │
 Web 控制台 · 开放 REST API ──> 能力注册表 <── MCP / 隔离动作
                                │
  内核：RBAC · 插件运行时 · 主题引擎 · 事件总线 · 设置与密钥
                                │
     内核服务：支付编排 · 钱包账本 · 汇率 · 站内通知
                                │
              ┌───────────────────────┼───────────────────────┐
              │                       │                       │
            商店                     工单 / 网关               其他业务域
           （插件）                    （插件）                 （插件）
```

内核负责平台能力，插件负责业务变化；Agent 与 Web、API 客户端使用同一套已授权能力。管理员配置并开启 AI 后，Agent 才可执行工作。生产环境的第三方插件默认运行在独立 Node 子进程中；内置插件与非生产插件可以使用受信任运行模式。权限字段用于路由准入和前端可见性，并不是操作系统沙盒。完整边界请阅读 [插件安全与信任模型](https://github.com/worable233/stackpanel/wiki/Plugin-Security)。

## 文档与运维

| 你想做什么 | 从这里开始 |
| --- | --- |
| 部署、使用发布镜像或验证签名 | [Docker 文档](./docker/README.md) |
| 备份与恢复 | `bash scripts/backup.sh` 与 `bash scripts/restore.sh`；归档内容和恢复要求见脚本说明。 |
| 浏览与安装官方插件 | [StackPanel 官方插件仓库](https://github.com/worable233/stackpanel-plugins) |
| 开发内核、插件、主题或前端包 | [开发者 Wiki](https://github.com/worable233/stackpanel/wiki) |
| 查阅 API 契约 | [`packages/spec`](./packages/spec) 是内核 API 版本与 OpenAPI 投影的单一来源。 |
| 本地开发与代码规范 | [贡献指南](./CONTRIBUTING.md) |
| 排查生产运行问题 | [运维手册](./docs/OPERATIONS-RUNBOOK.md) |

本地开发需要 Node.js 22+、pnpm 11.5.1、PostgreSQL 16 和 Redis 7。详细环境配置在 [贡献指南](./CONTRIBUTING.md)；常用校验与 CI 保持一致：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## 参与项目

提交问题前，请先搜索现有 issue。Bug 报告请提供可复现步骤、部署方式、版本与已脱敏日志；功能提案请说明要解决的业务问题和预期结果。提交 Pull Request 前请阅读 [贡献指南](./CONTRIBUTING.md)，其中包含测试、契约、文档和许可证要求。

安全漏洞请勿公开提交。请使用 [GitHub 私密漏洞报告](https://github.com/worable233/stackpanel/security/advisories/new)，流程与响应范围见 [SECURITY.md](./SECURITY.md)。

## 许可证

[MIT](./LICENSE)。第三方组件及许可证见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。
