# StackPanel

**简体中文** · [English](./README.en.md)

自托管的数字商品与主机业务管理系统。商品、订单、支付、钱包、工单与权限管理都运行在自己的服务器上，数据留在自己手里。

内核只做六件事——用户与 RBAC、插件运行时、主题引擎、事件总线、设置与密钥、审计日志——并把支付编排、钱包账本、汇率、站内通知这类跨插件能力作为内核服务注入插件。商店、工单、支付网关等业务域都是插件，随附的只有运行必需的最小集合，其余按需安装。

## 主要特性

- **插件化业务域。** 插件可以声明自己的路由、权限、后台页、账户页、事件监听与数据模型，也可以扩展其他插件。安装、升级、启用、停用、卸载无需重启 API 进程。
- **API 优先。** 后台界面与开放 API 走同一套接口，界面能完成的操作，脚本同样可以完成。
- **插件前端运行期装载。** 插件自带的界面在安装/升级后即由 web 进程按请求装载，无需重新构建或重启；重复安装、卸载与回退同样即时生效。
- **主题即 ZIP。** 主题是配置化的 ZIP 包；插件前端是类型安全的 React 组件，与内核共用同一份 React 运行时。页面路由、命名布局与类型化取数器由前端包声明，平台负责渲染。
- **凭证权限不超过持有者。** 用户可以自助签发限定范围的 API 凭证，凭证的有效权限始终是持有者当前权限的子集。给某个用户降权，其名下所有凭证同时收窄。
- **自托管、可迁移。** 生产与开发统一使用 PostgreSQL，集群化依赖 Redis 与 S3 兼容对象存储。备份即 `pg_dump` 加资源打包。

## 快速开始

前置条件：已安装 **Docker** 与 **Docker Compose v2**（Linux / macOS / Windows 需 WSL2）。密钥生成优先使用 `openssl`，缺失时回退 `/dev/urandom`。

```bash
# 一键部署：检测 Docker、生成随机密钥、构建并启动
# 默认档拉起 api + worker + web + PostgreSQL + Redis + MinIO（HTTP，http://localhost:3000）
bash scripts/deploy.sh

# 公网 + 自动 HTTPS（需域名 DNS 已指向本机）：
# bash scripts/deploy.sh --domain sp.example.com --email you@example.com

# 集群档（外部 PostgreSQL / Redis / 对象存储）：
# bash scripts/deploy.sh --cluster --image ghcr.io/<owner>/stackpanel@sha256:<digest>
```

首次构建需要拉取基础镜像与依赖，耗时较长。完成后访问 `http://localhost:3000`。初始管理员密码默认随机生成并打印在 `api` 容器日志中；如需固定，先在 `docker/.env` 设置 `STACKPANEL_BOOTSTRAP_EMAIL` 与 `STACKPANEL_BOOTSTRAP_PASSWORD`。

不使用 Docker（本机已有 PostgreSQL 与 Redis，PM2 模式）：

```bash
pnpm install
pnpm build
cp .env.example .env && cp apps/api/.env.example apps/api/.env && cp apps/web/.env.example apps/web/.env
pnpm --filter @stackpanel/db migrate:deploy
pnpm pm2:start
```

开发模式按应用单独启动，均带热重载：

```bash
pnpm --filter @stackpanel/api dev   # Fastify
pnpm --filter @stackpanel/web dev   # Next.js
```

## 文档

开发文档发布在 **[Wiki](https://github.com/worable233/stackpanel/wiki)**，分为五部分：

| 分组 | 内容 |
| --- | --- |
| [核心开发](https://github.com/worable233/stackpanel/wiki/Core-Prepare) | 环境准备、运行、构建、架构、项目结构、站内通知 |
| [插件开发](https://github.com/worable233/stackpanel/wiki/Plugin-Introduction) | 清单、生命周期、路由、扩展点、事件、密钥、依赖、权限、履约、打包 |
| [主题开发](https://github.com/worable233/stackpanel/wiki/Theme-Introduction) | 主题结构、清单、CSS Token、设置、前端包、打包 |
| [前端包开发](https://github.com/worable233/stackpanel/wiki/Frontend-Getting-Started) | 页面路由、布局、Finder、后台扩展、样式约定、排查 |
| [RESTful API](https://github.com/worable233/stackpanel/wiki/Api-Introduction) | 认证、路由参考、SDK 客户端、错误处理 |

接口契约以 [`packages/spec`](./packages/spec) 为单一来源（内核 API 版本与 OpenAPI 投影）。

## 架构

```
                    内核
   六件事：用户与 RBAC · 插件运行时 · 主题引擎
           事件总线 · 设置与密钥 · 审计日志
   能力服务：支付编排 · 钱包账本 · 汇率 · 通知
                       |
        +--------------+--------------+
        |              |              |
      商店           工单/网关        内容 …
     （插件）        （插件）       （插件）
        |              |              |
        +--------------+--------------+
                       |
                 同一套 REST API
        +--------------+--------------+
        |              |              |
       Web 后台       开放 API        第三方客户端
```

## 插件执行与信任模型

插件执行模式由清单的 `execution` 字段决定：

- **`isolated`**：生产环境第三方插件的默认模式。入口在独立 Node 子进程中运行，API 进程只保留清单、路由代理与 RPC 桥；`ctx.*` 经带协议版本、插件身份校验、1 MiB 消息上限、64 并发上限与 10 秒双向超时的 IPC RPC 暴露。worker 退出会把插件置为 `failed` 并清理其路由、模型与任务；累计达到 3 次后打开熔断，需要重新注册修复后的插件包才能恢复。
- **`trusted`**：内置插件在各环境、非生产环境下的插件都可以使用，插件直接在 API 进程内运行并拥有该进程的权限；生产环境的第三方插件不允许请求该模式。

`permissions` 与路由 `permission` 是**路由准入与前端可见性**控制，不等同于 OS 沙盒，`isolated` 也不是完整的容器。需要同步返回值的 `ctx.events.intercept()` 与 `ctx.events.waterfall()` 无法跨进程表达，在 isolated 模式下会明确报错；原始流式路由与无法转为 JSON Schema 的自定义模型会在 worker 启动时被拒绝。`PluginContext` 不提供数据库句柄，插件只能经 Extension 引擎读写自己声明的模型。

详见 [插件安全与信任模型](https://github.com/worable233/stackpanel/wiki/Plugin-Security)。

## 项目结构

```
StackPanel/
├── apps/
│   ├── api/     # Fastify 服务，承载全部业务 API
│   └── web/     # Next.js 渲染与 BFF 转发（不含业务逻辑）
└── packages/
    ├── sdk/            # 类型安全 API 客户端与插件契约
    ├── spec/           # 契约单一来源：内核 API 版本与 OpenAPI 投影
    ├── ui/             # 共享组件
    ├── db/             # Prisma schema、迁移与客户端
    ├── net-guard/      # 共享网络防护原语（SSRF 判定等）
    ├── plugins/        # 内置插件：认证、商店及商品类型、钱包、应用市场
    ├── themes/         # 配置化主题
    └── mcp/            # MCP Server（stdio / HTTP）
```

## 开发

| 依赖 | 版本 |
| --- | --- |
| Node.js | >= 22（见 [`.nvmrc`](./.nvmrc)） |
| pnpm | 11.5.1（由 `packageManager` 字段锁定） |
| PostgreSQL | 16 |
| Redis | 7 |

推送前请与 CI 保持一致地跑一遍：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

完整的本地环境、代码规范与提交流程见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 安全

漏洞请通过 GitHub 私密漏洞报告通道提交，不要开公开 issue。流程与范围见 [SECURITY.md](./SECURITY.md)。

## 依赖与合规

第三方组件及其许可证见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)，许可证全文位于 [`licenses/`](./licenses/)。CI 的 `pnpm license:check` 会拒绝任何未在其中备案的 copyleft 依赖。

## 参与贡献

欢迎 issue 与 PR。请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md) 与[行为准则](./CODE_OF_CONDUCT.md)。版本变更记录见 [CHANGELOG.md](./CHANGELOG.md)。

## 许可证

[MIT](./LICENSE)
