# 更新日志

本文件记录 StackPanel 内核的公开变更。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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

## [0.2.0] - 2026-10-07

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
