# 更新日志

本文件记录 StackPanel 内核的公开变更。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.2] - 2026-11-01

**镜像可用性修复版**：0.1.0 / 0.1.1 的官方镜像无法开箱跑通——0.1.0 缺前端静态资源，
0.1.1 首页恒 500；即使绕过这两条，全新实例还会被「没有信任根」和「isolated 插件
worker 打错入口」拦住。这个版本修掉四条阻断项，并把「拉官方镜像跑一遍」变成发布门禁。

### 修复（阻断级）

- **镜像漏打 `.next/static`**：`Dockerfile` 现在把 `apps/web/.next/static`（及 `public/`）
  拷进 standalone 目录（内核产物打包脚本一直有这一步，镜像没有）。此前 `/_next/static/*`
  全部 404：页面 200 但没有样式、也不 hydrate。
- **isolated 插件 worker 不是构建入口**：`apps/api/tsup.config.ts` 增加
  `plugins/isolated/worker` 入口，`host.ts` 改从 `./plugins/isolated/worker.js` fork。
  此前子进程被指引到同名的**任务** worker，任何 M2 插件安装都报
  `isolated plugin X exited before ready`。
- **首页 500（0.1.1 回归）**：公开页面不再把运行时解析出来的组件传给客户端组件
  （React 禁止跨客户端边界传函数），改回服务端 `createElement` 渲染；后台两条
  客户端渲染路径的 toast 包装保留。
- **全新实例没有信任根**：首启幂等写入默认 `trust/keyring.json`（`catalog-2026` /
  `pkg-2026-11` / `kernel-2026-11`），已存在的文件绝不覆盖。市场安装因缺 keyId 失败时
  现在返回 `market.trustRootMissing`（422）而不是笼统的「验签失败」。

### 新增

- `GET /version`：版本、提交号、构建时间、生效的反代信任配置、信任根各用途公钥数量。
  启动日志也打同样的横幅，「容器里跑的是哪一次构建」不再靠行为猜。
- **发布前冒烟** `scripts/release/smoke-image.mjs`：拉官方镜像起一套 compose，断言首页
  静态资源、`/health` `/ready`、无浏览器初始化管理员、market 装插件（isolated）激活、
  装主题后首页可渲染。
- 反代模板：`docker/proxy/nginx.conf.example`、`docker/proxy/traefik.yml.example`
  （含 API 的 13 个路径前缀与真实 IP 配置）；`docker/README.md` 补「必须备份的路径」、
  headless 初始化、健康检查端点说明。

### 变化

- `API_TRUST_PROXY` 在 compose 里默认 `loopback,linklocal,uniquelocal`（所有 RFC1918
  私网），不再写死 `172.28.0.0/16`——1Panel / 宝塔等环境的 `172.18.x` 网段从此也认得出
  访客真实 IP；公网伪造的 `X-Forwarded-For` 依旧无效。
- compose 的 Web / API 宿主端口可覆盖（`STACKPANEL_WEB_PORT` / `STACKPANEL_API_PORT`），
  同机跑多实例与冒烟都不再撞端口。
- isolated 插件子进程的 stderr 进日志（环形缓冲 200 行 / 8 KB），启动失败的错误里带
  最近 20 行；再也不会只剩一句 `exited before ready`。
- 未安装验证码提供方时，Web 侧对 `/captcha/policy` 的缓存窗口从 30 秒延长到 5 分钟
  （装了提供方的实例保持 30 秒，后台改配置仍然即时生效）。

## [0.1.1] - 2026-11-01

应用市场与插件动作在真机上的可用性修复版。契约版本 `KERNEL_API_VERSION` 仍为 `0.4.0`，
插件无需改代码即可装上；`PluginActionResult` 是**新增**导出，旧插件不受影响。

### 修复

- **插件动作成功后不再被界面报成失败。** 动作处理器过去用 `redirect(...)` 表达「成功」，
  那条路径会变成导航异常，界面只能统一按失败渲染——于是「保存成功」弹出红色错误。
  现在处理器返回结构化结果 `PluginActionResult { ok, message?, error?, requestId? }`
  （`@stackpanel/sdk` 导出），经 `useActionState` 原样透传，成功与失败各有独立回执；
  仍返回 `redirect` 的旧包按「已完成」处理，不误报。
- **市场页的安装回执改为持久行内回执。** 原来是一次性 toast：刷新或切标签就消失，失败
  又只有一句「安装失败」。现在成功是 `text-success` 行、失败是 `text-warning` 行 + 请求
  编号，并显示条目来源（内置 / 本地来源 / 已签名目录）以及是否需要二次点击确认覆盖。
- **目录安装失败按「下一步做什么」给稳定错误码**：`market.notInCatalog`(404)、
  `market.packageBlocked`(422)、`market.packageTooLarge`(413)、
  `market.signatureInvalid` / `market.packageInvalid` / `market.sourceUnavailable`(502)、
  `market.sourceRateLimited`(503，带 `retryAfterSeconds`)、`market.catalogOffline`(409)。
  原来这类失败是普通 `Error`，接口直接 500，运维看不出该查网络、升内核还是换个包。
  限流被包在「下载失败」里再抛出时也能识别（往下看两层 `cause`），界面才能给倒计时。
- **市场状态补「上次检查」与「过期时间」。** 渲染路径零出网（ADR-0027），冷启动时
  「上次检查」是唯一能区分「刚查过、目录本来就这样」与「从没查过」的依据；过期与否
  也单独可见，不再让操作者以为「目录里就是这些」。
- **覆盖安装后新 worker 不再被旧进程的退出回调抹掉**（隔离执行）：装了新版却仍跑旧版，
  且不报任何错。
- **目录条目文件名必须与 `kind`+`id` 一致**：否则 `release:catalog` 会静默产出实例端
  拒绝安装的目录（`entries` 有内容、市场却一个都装不了）。
- 财务概览的「订单」「商品」快捷入口原来指向应用市场（那是插件与主题市场），改为指向
  商店插件的实际页面。

### 新增

- **市场页「刷新目录」按钮**（`POST /market/admin/refresh`，`market.admin` 权限，审计
  `market.catalog.refresh`）。目录快照只活在进程内存里，重启后页面只能停在「正在等待
  首次刷新结果」，而唯一的触发入口藏在 `/admin/updates` 的「检查更新」里。现在页头可
  直接刷新：成功显示行内「目录已刷新」并重拉条目，且与 `/admin/distribution/refresh`、
  `/admin/updates/check` **共用同一冷却**（冷却期内不发网络请求）。
- `MarketStatus.catalog.checkedAt`：目录最后一次成功检查的时间。
- 主题可以打包上目录，与插件共用同一条分发与验签链（`release:pack-theme`）。
- `catalog/entries/` 首批 22 个插件条目：目录不再是空的，市场首次有可装内容。

### 变更

- 前端包单文件上限 1 MiB → 2 MiB：源码压缩后合法但略大的包以前发得出去、装不上。
- 内核的市场健康度类型改为直接复用 `@stackpanel/sdk` 的声明（单一来源），此前内核自己
  抄了一份，内核加字段插件侧看不到。

## [0.1.0] - 2026-11-01

首次公开发布。此前 `0.1.0` / `0.2.0` 只是内部里程碑，从未打过标签、也从未对外发布，
现改标为 `0.0.x 内部里程碑` 保留在下方，公开版本号从本版起算。

### 变更

- 内核产品版本与各包锁定为 `0.1.0`（`packages/spec/src/version.ts` 的 `KERNEL_VERSION`、
  root、`apps/{api,web,updater}`、`packages/{db,ui,net-guard}`）。契约版本
  `KERNEL_API_VERSION` 仍为 `0.4.0`，SDK / 契约包版本不变——两者是独立维度。
- `apps/updater` 纳入产品版本锁定：它是随内核发布的自包含二进制，版本号不得与内核漂移。
- 分发演练不再自带一份写死的内核版本，改为从契约包读取（否则改版本时漏改一处，
  演练就在测旧版本）。

### 新增

- 附件管理台内核端点：`GET /media/admin/attachments`（跨用户分页，支持
  `visibility` / `kind` / `q` / `ownerId` 过滤）、`GET /media/admin/stats`（计数、
  按类型分布、变体状态与**编码器健康**）、`POST /media/admin/variants/rebuild`
  （把终态 `failed` 的变体重排，编码器恢复后用来补生成缩略图）。
  设计与授权链见 `docs/design/media-library-admin.md`。
- 媒体域抽出 `media/kernel-service.ts`，让普通路由与管理路由共用同一条服务装配
  （存储驱动、编码器、队列、actor 映射、错误映射）。
- 图片自动转 WebP：上传就在落盘**之前**完成转换——PNG/GIF/WebP 走无损、JPEG 走
  `quality 82` 有损，**只有变小才替换**原图（转完反而变大的源保留原格式）；转换后
  `mime = image/webp`、`key` 以 `original.webp` 结尾、文件名扩展名改写。
  `MEDIA_WEBP_OPTIMIZE=false` 可全局关闭。
- `POST /media/admin/optimize`：存量附件的 WebP 批量回填（body `{ attachmentId? }`，
  每批 ≤50 条，转化为 WebP 即离开候选集所以**天然幂等**），返回
  `{ optimized, skipped, savedBytes, ids }`。媒体库控制台新增「无损转 WebP」按钮。
- 旧链接在转换后不需要任何手工修正：媒体 URL 只由 id 寻址，同一条链接在转换前后都
  返回 200。为了让缓存也能跟上，`GET /media/:id/content` 新增弱 `ETag`（内容版本号
  `rev = sha256(key:size:mime)[0..16]`，随字节改写而变）并支持 `If-None-Match` → 304；
  缓存策略改为：私有 → `private, max-age=0, must-revalidate`；公有 + `?v=<当前 rev>` →
  `public, max-age=31536000, immutable`；公有但无 `v`/`v` 过期 → `public, max-age=0,
  must-revalidate`（旧链接下次访问即被更正）。`v` 不参与寻址，传错不会 404。
  附件响应新增 `rev`（原图与每个变体各一份）。
- 账户头像：`POST /auth/avatar`（raw 图片体，PNG / JPEG / GIF / WebP，≤5MB）与
  `DELETE /auth/avatar`。头像本身就是一条普通媒体附件（同一套嗅探、WebP 编码与
  变体阶梯），`users.avatarAttachmentId` 是指向它的软指针，并在
  `attachment_references` 登记 `user/<id>/avatar`，使媒体控制台的删除命中
  `409 media.in_use` 而不是默默孤儿化。`GET /auth/me` 等用户载荷新增派生的
  `avatarUrl`（`/media/<id>/content?variant=thumb&v=<rev>`，换头像即换 URL，缓存不会
  继续显示旧脸）；SDK 的 `User.avatarUrl` 为可选字段，旧内核的响应仍能解析。
  账户设置页新增头像区（上传 / 更换 / 移除），账户与后台外壳同步显示。管理台用户列表
  同样显示头像（整页一次批量解析，不按行读附件）；用户载荷只给派生 `avatarUrl`，
  不暴露 `avatarAttachmentId`。设计见 `docs/design/account-avatar.md`。

### 修复

- Web BFF 的同源校验改用请求自身的 `Host`（含 `x-forwarded-host`/`-proto`）：
  `request.nextUrl.origin` 会被 Next 规范成启动时的 host，导致用 `127.0.0.1` 访问
  `localhost` 配置的开发服务时，**合法的同源上传被 403**（`POST /api/agent/attachments`
  与新增的头像上传都中招）。
- `/api/plugins` 公开资产白名单新增**一条**：`GET /media/<id>/content`（带 `att_` id
  形状校验），让浏览器能加载头像/公有附件；媒体域的列表、元数据、引用、后台接口仍
  在认证后的 action-target 校验内。
- `apps/api/tsconfig.json` 不再为 `sharp` 声明 `paths` 映射：`tsx` 会在**运行时**
  遵循 `paths`，把 `import('sharp')` 解析到 `lib/index.d.ts`，于是图片变体全部落到
  `failed`（`编码未产出字节`）而 vitest 仍为绿。补 `tests/unit/media-tsx-resolution.test.ts`
  作为回归（用真实 `tsx` 跑探针并断言导出是可调用函数）。

## [0.0.2 内部里程碑] - 2026-10-07

### 新增

- 插件隔离运行时：生产环境第三方插件默认以 `execution: "isolated"` 在独立 Node 子进程中运行，
  通过带协议版本、插件身份校验、消息大小上限、并发上限与双向超时的 IPC RPC 暴露 `PluginContext`；
  worker 退出累计达到 3 次后打开熔断（阈值 3），插件置为 `failed` 并清理其路由、模型与任务。
- SDK 新增上游请求的 URL 安全判定原语与相关类型，供插件在声明上游时复用 SSRF 防护。
- 前端包新增区域地图相关组件与构建脚本。

### 变更

- 插件错误与内核错误统一携带稳定的错误码，跨进程边界传递时保留原始错误信息。
- 插件状态读写接口收敛，前端清单契约同步调整。
- 内核 API 版本随本次升级递增（`packages/spec` 为契约单一来源）。

### 修复

- 收紧请求与模型数据的净化逻辑，修复若干输入校验缺口。

## [0.0.1 内部里程碑] - 2026-10-02

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
