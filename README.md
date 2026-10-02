# StackPanel

**自托管的数字商品与主机业务系统。** 把商品、订单、支付、钱包、工单和权限管理装进一套自托管系统，数据留在你自己的服务器上。

它不是又一个面板，也不是 SaaS。它更像 WordPress 之于内容、Halo 之于博客——只不过面向的是数字商品与主机业务的经营。你可以只装需要的插件，也可以自己写。

## 为什么是它

现成的解决方案要么是封闭面板，要么把数据锁在别人的云里，要么逼你接受一套改不动的业务逻辑。StackPanel 的选择相反：

- **内核瘦，插件胖。** 内核只做六件事——用户与 RBAC、插件运行时、主题引擎、事件总线、设置与密钥、审计日志——并把跨插件的横切能力（支付编排、钱包账本、汇率、站内通知）做成内核服务注入插件。其余一切都是插件，包括商店、工单、网关这些业务域；内核只随附运行必需的最小插件集，其余按需安装。
- **一切先有 API。** 后台不是特权客户端，它是这套 API 的第一个用户。你能在界面上做的，脚本也能做。
- **数据归你。** 自托管，PostgreSQL 单一存储引擎，备份即 `pg_dump` + 资源打包。想迁走，随时。

## 能力

**插件即装即用，运行时不重启。** 安装、升级、启用、停用、卸载全部即时生效，API 进程不需要重启。插件可以声明自己的路由、权限、后台页、账户页、事件监听，甚至可以扩展其他插件。插件自带的前端界面由 worker 自动构建生效（ADR-0007）：变更后自动执行 `build:frontend` + `next build`，各 web 副本自行重启；仅在关闭 `STACKPANEL_FRONTEND_AUTOBUILD` 时才需手动 `pnpm build`。

**凭证的权限永远不超过主人。** 用户可自助签发 API 凭证并限定授权范围；凭证的有效权限始终是持有者当前权限的子集。给某个用户降权，他手上所有凭证同时随之收窄——不存在平行的鉴权系统。

**主题与前端都是一等公民。** 主题是 ZIP，插件前端是类型安全的 React 组件，与内核共用同一份 React 运行时。页面路由、命名布局、类型化取数器（Finder）都由前端包声明，平台负责渲染。

**插件可以带自己的数据模型。** 不必迁就内核的表结构，插件能定义新的业务对象与界面。

**默认 PostgreSQL。** 生产与开发统一 PostgreSQL（ADR-0019），集群化依赖 Redis 与 S3 兼容对象存储（ADR-0017）。一条命令起全栈：`bash scripts/deploy.sh` 会拉起 api + worker + web + PostgreSQL + Redis + MinIO，自动初始化，装完即用。

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

## 快速开始

```bash
# 一键安装：检测环境、生成密钥、构建并启动（API :3001，Web :3000）
# 本机已有 PostgreSQL/Redis 时用 install.sh；否则用 Docker 一键起全栈：
bash scripts/deploy.sh
```

手动安装：

```bash
pnpm install
pnpm build
cp .env.example .env && cp apps/api/.env.example apps/api/.env && cp apps/web/.env.example apps/web/.env
pnpm --filter @stackpanel/db migrate:deploy
pnpm pm2:start
```

开发模式：

```bash
pnpm --filter @stackpanel/api dev   # Fastify，热重载
pnpm --filter @stackpanel/web dev   # Next.js，热重载
```

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
    ├── plugins/        # 内置插件：认证、商店及商品类型、钱包
    ├── themes/         # 配置化主题
    └── mcp/            # MCP Server（stdio / HTTP）
```

## 文档

开发文档发布在 **[Wiki](https://github.com/worable233/stackpanel/wiki)**，涵盖核心开发、插件、主题、前端包与 RESTful API 五部分：

| 分组 | 内容 |
| --- | --- |
| [核心开发](https://github.com/worable233/stackpanel/wiki/Core-Prepare) | 环境准备、运行、构建、架构、项目结构、站内通知 |
| [插件开发](https://github.com/worable233/stackpanel/wiki/Plugin-Introduction) | 清单、生命周期、路由、扩展点、事件、密钥、依赖、权限、履约、打包 |
| [主题开发](https://github.com/worable233/stackpanel/wiki/Theme-Introduction) | 主题结构、清单、CSS Token、设置、前端包、打包 |
| [前端包开发](https://github.com/worable233/stackpanel/wiki/Frontend-Getting-Started) | 页面路由、布局、Finder、后台扩展、样式约定、排查 |
| [RESTful API](https://github.com/worable233/stackpanel/wiki/Api-Introduction) | 认证、路由参考、SDK 客户端、错误处理 |

仓库内的接口契约以 [`packages/spec`](./packages/spec) 为单一来源（内核 API 版本 + OpenAPI 投影）。

## 许可证

[MIT](./LICENSE)
