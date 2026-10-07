# StackPanel 安全评估与加固报告

- **评估对象**：`/Users/worable/Documents/StackPanel`（StackPanel，自托管数字商品 / 主机业务系统）
- **初始评估日期**：2026-10-04
- **最后复核**：2026-10-06
- **技术栈**：Node.js ≥22 · Fastify（`apps/api`） · Next.js（`apps/web`，BFF） · PostgreSQL（Prisma 7） · Redis · S3/MinIO · pnpm workspace · 内置插件动态 `import()` / 第三方插件 isolated worker RPC
- **评估方式**：静态代码审计（认证、授权、注入、SSRF、文件处理、密钥、部署配置、插件运行时、供应链）+ 威胁建模（STRIDE）
- **报告方**：腾讯安全专家（IDE 内嵌安全顾问）

> ⚠️ **知识库说明**：本次会话**未挂载**腾讯内部安全知识库（CSIG / PCG KB / 编码规范库）的检索通道，因此本报告中的**全部修复建议均为通用安全最佳实践**，不含内部专用库/平台的结论。若需要内部口径（如内部 SSRF 防护库、漏洞管理定级标准、内部扫描平台接入方式），请接入知识库后复评。

> ✅ **当前状态（2026-10-06）**：本文保留历史发现追溯；当前复核已覆盖附件引用、worker
> 崩溃状态、双向 RPC、锁所有权、任务 handler 生命周期和排队任务清理。状态以本文第 8 节、
> `pnpm audit` 输出以及源码/测试为准。

---

## 0. 总体结论（TL;DR）

**这是一个安全基线相当扎实的代码库。** 项目此前显然已经做过一轮以上安全整改（源码中保留 `audit M-1` / `H-1` / `H2` / `H3` / `CONTRACT-SEC` 等审计编号），认证、授权、SSRF、插件签名、扩展引擎 SQL 和插件进程边界等**核心高危面基本都已闭环**。

本次复核重点检查了附件引用并发、isolated worker 故障状态、跨进程 RPC 和任务生命周期；这些问题已在源码与回归测试中闭环。

| 严重度 | 数量 | 说明 |
| --- | --- | --- |
| 🔴 Critical | 0 | — |
| 🟠 High | 0 open | 本轮发现已实现并有回归覆盖 |
| 🟡 Medium | 0 open | 本轮发现已实现；需在真实 Redis/S3 环境持续观测 |
| 🔵 Low | 0 open | 原报告 4 项均已修复 |
| ⚪ Info | 0 open | 原报告 2 项已落实或转为设计说明 |

**一句话给决策者**：当前没有已知生产高危/严重依赖漏洞；继续把真实 Redis/S3 验证、插件来源审查和 isolated RPC 回归测试纳入发布门禁。

---

## 1. 审计范围与方法

| 域 | 覆盖模块 | 方式 |
| --- | --- | --- |
| 认证 AuthN | `auth/auth-service.ts`、`auth/session-store.ts`、`lib/jwt.ts`、`lib/password.ts`、`lib/api-tokens.ts`、`plugins/auth.ts`、`packages/plugins/login` | 人工审计 |
| 授权 AuthZ | `lib/rbac.ts`、`plugins/dispatcher.ts::runGuards`、`lib/open-api-guard.ts`、`routes/admin/*`、`routes/sp-v1.ts`、`lib/capability-registry` | 人工 + 全量 `preHandler` 扫描 |
| 注入 | `extensions/{schema,query,client,migrator}.ts`、`reseller/repository.ts`、`media/prisma-attachment-repository.ts` | 模式扫描（`$queryRaw*`）+ 人工 |
| SSRF | `packages/net-guard`、`reseller/webhook.ts` | 人工 |
| 文件处理 | `lib/plugins.ts`、`lib/themes.ts`、`lib/frontend-service.ts`、`media/*`、`backup/{tar,archive}.ts`、`packages/db/src/storage/local.ts` | 人工 + Zip-Slip 专项 |
| 密钥/加密 | `lib/crypto.ts`、`lib/secrets-policy.ts`、`reseller/keys.ts`、`config/env.ts` | 人工 |
| 部署/配置 | `docker-compose*.yml`、`Dockerfile`、`docker/Caddyfile`、`scripts/deploy.sh`、`ecosystem.config.cjs`、`next.config.ts`、`app.ts`（安全头） | 人工 |
| 插件运行时/供应链 | `plugin-host.ts`、`lib/frontend-build.ts`、`lib/signatures.ts`、`pnpm-workspace.yaml`、`.env` 提交面 | 人工 |

**扫描命令（模式识别）**：`child_process|exec|spawn`、`$queryRaw*`、`eval|new Function|dangerouslySetInnerHTML`、`unzip|adm-zip`、`path.join(...name)`、`rejectUnauthorized|insecure`、`__proto__`、`Math.random|sha1`、`setCookie|sameSite|secure:`、`Strict-Transport-Security`。

---

## 2. 已确认的良好实践（先给信心，也是审计深度的证明）

这些不是客套，而是逐条读源码确认过的：

- **口令存储**：scrypt（N=16384, r=8, p=1）+ 每次随机盐 + `timingSafeEqual` 恒定时间比较；对不存在用户跑 dummy hash，**消除用户枚举的时间侧信道**（`lib/password.ts`、`auth-service.ts:39-56`）。
- **会话模型**：服务端不透明随机令牌（`sess_<32B base64url>`）存 Redis，`revoke` 立即全局生效，TTL 滑动节流；JWT 仅作旧版迁移兼容，且**权限始终从库重算**，不信任 token 内声明（`session-store.ts`、`plugins/auth.ts:177`）。
- **平台凭证（ApiToken）**：库内只存 `sha256`、仅创建时返回一次明文；有效权限 = `token.scopes ∩ 持有者当前权限`，降权即时收窄；IP allowlist + 过期 + `lastUsedAt` 写回节流；失败令牌有界 TTL 缓存（SHA-256 为 key）遏制爆破（`lib/api-tokens.ts`、`plugins/auth.ts:63-146`）。
- **SSRF 防护**：`net-guard` 覆盖 IPv4 保留段、CGNAT、云元数据段，IPv6 展开含 `::ffff:`/NAT64/6to4/ULA/链路本地，并提供 `resolvesToUnsafeAddress` 防 **DNS rebinding**；出站 webhook 同时校验协议白名单 + 非内网主机 + 当前解析（`reseller/webhook.ts:135-142`）。
- **插件/主题包（ZIP）**：条目名校验（拒 `..`/绝对路径/盘符）+ 落盘路径前缀强校验（双层防 Zip-Slip）+ 文件数/单文件/总解压体积上限 + 禁用源码与 `.git*`/`.htaccess` + **Ed25519 包签名**（含逐文件 SHA-256 一致性与签名 payload 校验）（`lib/plugins.ts`、`lib/themes.ts`、`lib/signatures.ts`）。
- **扩展引擎 SQL**：所有标识符经 `assertIdentifier`（`^[A-Za-z_][A-Za-z0-9_-]*$`）白名单 + 双引号包裹；值全部走占位符；`where/orderBy` 字段必须已声明（拒绝未知字段）；`LIKE` 通配符转义（`extensions/*`）。
- **对象存储**：`assertSafeStorageKey` 拒空/前导 `/`/反斜杠/`.`/`..` 段；本地驱动再做 `resolve` 前缀兜底（`packages/db/src/storage/local.ts`）。
- **媒体**：上传按字节嗅探真实 MIME；SVG/HTML 等**主动内容强制 `attachment`** 防存储型 XSS；`nosniff`；`Content-Disposition` 用 RFC 5987 编码防响应头注入（`media/routes.ts`、`media/disposition.ts`）。
- **安全响应头**：API 与 web 均下发 `X-Content-Type-Options`/`X-Frame-Options: DENY`/`Referrer-Policy`/`Permissions-Policy`/`CSP`（`app.ts`、`web/src/proxy.ts`）。
- **错误处理**：统一 RFC 7807 `problem+json`，**对外不返回堆栈/内部细节**（`app.ts:137-211`）。
- **渠道/签名入口（SP v1）**：Ed25519 签名 + 时间窗 + **一次性 nonce（Redis 跨副本）防重放** + 每渠道 RPM + 写操作强制 `Idempotency-Key`（`reseller/guard.ts`）。
- **审计与加密**：审计日志覆盖登录/越权/上传等；密钥用 **AES-256-GCM**（随机 IV + 认证标签）落库；插件密钥按命名空间隔离（`lib/crypto.ts`、`plugins/audit.ts`）。
- **密钥卫生**：`.env`/`logs/`/`data/` 均被 `.gitignore` 排除，仓库仅提交 `.env.example`；生产环境启动时拒绝开发占位符密钥（`config/env.ts:103-122`）。
- **JSON-LD 注入**：序列化后转义 `< > & U+2028/2029`，已闭环此前的 `audit H-1`（`web/src/components/json-ld.tsx`）。

---

## 3. 历史发现清单（均已修复）

以下“问题/修复”段落保留初始审计时的证据和建议，用于追溯；它们不是当前代码状态。
当前状态以本节标题、STRIDE 表和第 6 节完成清单为准。

### 🟡 Medium

#### M-1 [已修复] 生产环境会话 Cookie 可能缺少 `Secure` 标志

- **位置**：`apps/api/src/config/env.ts:23-26`、`apps/api/src/plugins/auth.ts:158-166`、`apps/api/src/auth/auth-service.ts:114-120`
- **类型**：CWE-614 Sensitive Cookie Without 'Secure' Attribute · CWE-1004
- **置信度**：高
- **问题**：`API_COOKIE_SECURE` 的默认值是 `'false'`，会话 Cookie 的 `secure` 直接取该值：
  ```ts
  API_COOKIE_SECURE: z.enum(['true','false']).default('false').transform(v => v==='true')
  ```
  Docker 编排里通过 `API_COOKIE_SECURE: ${API_COOKIE_SECURE:-true}` 兜底为 `true`，**但 PM2 / 裸机部署（`ecosystem.config.cjs` 未设置该变量）在生产环境会下发明文可用的会话 Cookie**。此时若站点通过 HTTP 可达（或在 HTTPS 站点上存在一次明文请求/子资源），会话令牌可被中间人嗅探，直接导致账号接管。
- **修复**：让生产环境无论如何都强制 `Secure`（即使运维漏配）。
  ```ts
  // apps/api/src/config/env.ts
  API_COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default(process.env.NODE_ENV === 'production' ? 'true' : 'false')
    .transform((v) => v === 'true'),
  ```
  以及/或在 set-cookie 处再加一道兜底（双保险）：
  ```ts
  // apps/api/src/plugins/auth.ts  setSessionCookie(...)
  secure: env.API_COOKIE_SECURE || process.env.NODE_ENV === 'production',
  // apps/api/src/auth/auth-service.ts  sessionCookieConfig()
  secure: env.API_COOKIE_SECURE || process.env.NODE_ENV === 'production',
  ```
- **验证**：`NODE_ENV=production` 且不设 `API_COOKIE_SECURE` 启动，登录响应 `Set-Cookie` 必含 `Secure`。

---

#### M-2 [已修复] 缺少 HSTS（`Strict-Transport-Security`）响应头

- **位置**：`apps/api/src/app.ts:104-112`（onSend 安全头）、`apps/web/next.config.ts:19-35`、`docker/Caddyfile`
- **类型**：CWE-319 Cleartext Transmission · CWE-523
- **置信度**：高（全仓 grep `Strict-Transport-Security` 无命中）
- **问题**：API 与 web 均未下发 HSTS，Caddyfile 也未显式配置。启用 HTTPS 后，首次访问或用户手工输入 `http://` 仍可能发生明文请求（SSL 剥离），与 M-1 叠加会放大会话窃取风险。
- **修复**：在启用 TLS 的出口统一下发（浏览器在 HTTP 下会忽略，故可无条件加）。
  ```ts
  // apps/api/src/app.ts  onSend 钩子内追加
  reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  ```
  ```ts
  // apps/web/next.config.ts  headers 数组内追加
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  ```
  ```caddyfile
  # docker/Caddyfile —— 由 Caddy 直接下发更省事（与证书同处）
  {$STACKPANEL_DOMAIN} {
      header Strict-Transport-Security "max-age=31536000; includeSubDomains"
      # ...原有 handle 块...
  }
  ```
  仅确认全站 HTTPS 就绪后再加 `includeSubDomains`，并避免过早加 `preload`。
- **验证**：`curl -sI https://<域名>/ | grep -i strict-transport-security`。

---

#### M-3 [已修复] Swagger UI / OpenAPI 文档端点默认无鉴权暴露

- **位置**：`apps/api/src/app.ts:247-296`（`register(swaggerUi, { routePrefix: '/docs' })`，**未挂任何 preHandler**）
- **类型**：CWE-200 Information Exposure · 端点暴露
- **置信度**：高
- **问题**：`/docs`（Swagger UI）与 `/docs/json`（完整 OpenAPI 规格）对公网匿名可达。它会把内核与插件的全部路由、方法、所需权限、参数结构一次性交给攻击者，显著降低其侦查成本（尤其配合插件扩展后的攻击面）。编排里 API 端口 `3001:3001` 直接对外映射，Caddy 的 `@api` 匹配也未排除 `/docs`。
- **修复**（择一）：
  1. 仅生产关闭：在生产 `NODE_ENV` 下不注册 `swagger`/`swaggerUi`；或
  2. 挂管理员鉴权：`app.register(swaggerUi, { routePrefix: '/docs', preHandler: ... })` 不便直接传参时，用封装插件在 `onRequest` 里校验 `platform.admin`。
  ```ts
  // 方案 2 的最小实现（在注册 swaggerUi 的同一 scope 内）
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/docs')) return;
    const user = await extractSession(request, reply);
    if (!user?.permissions.has('platform.admin')) {
      return reply.code(404).send({ status: 404, code: 'request.not_found' });
    }
  });
  ```
  亦可先在 `docker/Caddyfile` 的 `@api` 中不匹配 `/docs*`，让文档只在内网可达——但**根治仍在应用层**。
- **验证**：匿名 `curl -s -o /dev/null -w '%{http_code}' https://<域名>/docs/json` 期望 401/404。

---

### 🔵 Low

#### L-1 [已修复] 全局未启用统一限流，公开重端点缺少节流

- **位置**：`apps/api/src/app.ts:220-228`（`rateLimit: { global: false }`）、`lib/rate-limit-policy.ts`（仅 5 类预设，逐路由登记）
- **类型**：CWE-770 Allocation of Resources Without Limits
- **置信度**：中
- **问题**：限流是按路由白名单登记的（OAuth/凭证写/管理写/用户写/上传），登录另有插件级状态限流。但**公开且相对重的读端点未登记限流**，例如 `/media/:id/content`（含变体转码读取）、`/themes/:id/assets/*`、`/plugins/:id/frontend/*`、SEO/`feed` 等，可被单 IP 高频拉取放大带宽/CPU。
- **修复**：为公开读端点补一条预设（示例）并挂到相应路由：
  ```ts
  // lib/rate-limit-policy.ts RATE_LIMIT 内新增
  publicRead: { max: 300, timeWindow: '1 minute' },
  // 并在 RATE_LIMIT_COVERAGE 登记
  { surface: '公开媒体/资源读取', preset: 'publicRead' },
  ```
- **验证**：单 IP 压测公开读端点，观察稳定返回 429。

#### L-2 [已修复] CSP 使用 `script-src 'unsafe-inline'`

- **位置**：`apps/web/next.config.ts:30`、`apps/api/src/app.ts:111`
- **类型**：CWE-1021 / CWE-693
- **置信度**：高
- **问题**：web 与 API 的 CSP 均允许内联脚本（Next.js hydration 的常见妥协）。一旦出现任何 HTML 注入点（尤其插件/主题渲染的用户可控内容），CSP 将无法提供最后一道 XSS 拦截。结合 M-3 暴露的文档页与被强制 `attachment` 的 SVG，属于纵深防御缺口。
- **修复**：为 Next.js 引入 **nonce-based CSP**（在 middleware 生成 per-request nonce，注入到 CSP 与 `<script nonce>`），移除 `'unsafe-inline'`；对确有内联需求的第三方样式单独用 `style-src` 的 hash 放行。属渐进改造，可排期。
- **验证**：CSP 报告中无 `script-src` 违规告警且 `unsafe-inline` 消失。

#### L-3 [已修复] 主题资源中的 SVG 以 `image/svg+xml` 内联返回

- **位置**：`apps/api/src/routes/theme.ts:247-262`（`ASSET_CONTENT_TYPES['.svg'] = 'image/svg+xml'`，无 `Content-Disposition: attachment`）
- **类型**：CWE-79 Stored XSS
- **置信度**：中
- **问题**：直接导航到 `/themes/<id>/assets/x.svg` 会以内联 SVG 渲染，SVG 可含 `<script>`（同源）。触发前提是管理员安装了含恶意 SVG 的主题，**属“受信代码/受信包”范围**，故定级 Low；但主题在信任模型中比插件更“轻”（无代码执行），这里却允许脚本执行，边界不一致。
- **修复**：对 `.svg` 同样强制附件下载，或统一走“主动内容→attachment”的策略（与 `media/routes.ts:81-83` 的 `isActiveContent` 对齐）：
  ```ts
  const inline = !['.svg', '.html'].includes(path.extname(asset).toLowerCase());
  reply.header('Content-Disposition', ContentDisposition.build(path.basename(asset), inline));
  ```
- **验证**：直接访问 SVG 资源触发下载而非渲染。

#### L-4 [已修复] 首个注册者成为管理员的判定存在竞态（TOCTOU）

- **位置**：`apps/api/src/auth/auth-service.ts:71-86`（`const isFirst = (await db.user.count()) === 0;` 后创建用户并授 `group_admin`）、`routes/auth-oauth.ts:146-167` 同型逻辑
- **类型**：CWE-362 Race Condition
- **置信度**：中（仅在实例“零用户”且注册并发时成立）
- **问题**：`count()===0` 与 `create()` 之间无锁，两路并发注册在空库时可能都判定为首个用户而获管理员组。正常引导（`deploy.sh` 先建管理员）下难触发，但**若管理员引导未执行就对外开放在线注册**，可被抢注管理员。
- **修复**：把“首个用户=管理员”收敛为幂等的引导流程（bootstrap），并对外注册在完成引导前关闭：
  ```ts
  // 建议：用唯一约束 + 事务保证只产生一个 admin，或仅在 bootstrap 阶段允许注册
  // 例：库中就绪标记 setting('bootstrap.done')，注册路由在未完成时返回 503
  ```
- **验证**：并发 20 路注册，管理员组数量恒为 1。

---

### ⚪ Info / 建议（非缺陷）

- **I-1 手写 HTML/CSS 清洗器**：`packages/sdk/src/sanitize.ts`（正则白名单清洗富文本）与 `lib/themes.ts::validateThemeCss`（正则校验 CSS token）。当前策略合理且已处理 `&` 转义、控制字符、`url(`/`@` 等关键面；但**正则式清洗对标签畸形/实体走私的鲁棒性天然弱于成熟实现**，且是本项目唯一的外部可影响 HTML 出口。建议换用经过大规模对抗的库（`DOMPurify` + `sanitize-html` / `css-tree` 做 CSS 校验），降低未来回归风险。**供参考，不阻塞**。
- **I-2 `SETTINGS_ENCRYPTION_KEY` 可选导致密钥存储整体可被关闭**：未配置时插件密钥、渠道回调私钥（SP 私钥）均不可用（`lib/secrets-policy.ts`、`reseller/keys.ts:33-38`）。这是**有意设计**（不自动生成、不落明文），但运维上易“看起来装了实则没存”。建议在部署自检/首启横幅中显式提示，并把该变量列入 deploy.sh 的必需项。另 `frontend-apply.ts:172` 用 SHA-1 生成前端变更签名——仅用于变更检测、非安全用途，可接受；若追求整齐可换 SHA-256。

---

## 4. 威胁模型（STRIDE）

| 分类 | 目标组件 | 攻击场景 | 现有控制 | 残余风险 | 处置 |
| --- | --- | --- | --- | --- | --- |
| Spoofing | 会话 Cookie | 窃取明文 Cookie 冒充用户 | httpOnly + SameSite=Lax + 生产 Secure | 未发现原报告遗留 | 保持回归 |
| Tampering | 插件/主题包 | 篡改包注入恶意代码 | Ed25519 签名 + 逐文件哈希 | 无（生产强制签名，除本地开发） | 保持 |
| Repudiation | 关键操作 | 否认已执行的操作 | 审计日志 + 越权/登录记录 | 低 | 保持；确认审计保留策略已启用 |
| Info Disclosure | `/docs`、枚举 | 拉取 API 规格、探测接口 | 管理员保护的文档 scope、统一错误体 | 未发现原报告遗留 | 保持回归 |
| DoS | 公开重端点 | 高频拉取媒体/资源 | `publicRead` 等路由限流 | 仍需按部署流量观测 | 持续监控 |
| Elevation | 首个注册者 | 抢注管理员 | 独立 bootstrap election 与测试 | 未发现原报告遗留 | 保持回归 |
| Elevation | 插件代码 | 恶意插件触达进程一切 | 生产第三方 isolated worker、RPC allowlist；内置插件仍受信 | worker 不是 OS 容器 | 审核来源并保持隔离 |

---

## 5. 供应链安全

- 已确认仓库**未提交** `.env` / `logs/` / `data/`，仅有 `.env.example`；生产拒绝开发占位符密钥。**基线良好。**
- `pnpm-workspace.yaml` 用 `minimumReleaseAgeExclude` 与 `overrides` 固定了安全相关包版本；根工作区与 web 统一使用 `next@16.3.8`，API 使用 `sharp@0.35.5`。
- 本次复核执行了官方 npm 公告库扫描：可修复的高危/严重依赖已收敛；当前仅剩 `braces@3.0.3` 的上游公告，但公告要求的 `>=3.0.4` 版本尚未在 npm 发布，且该依赖只出现在开发工具链（PM2/ESLint 的 glob 路径），不进入生产镜像。CI 仍应保留扫描并在上游发布修复后升级：
  ```bash
  pnpm audit --prod --registry=https://registry.npmjs.org --audit-level high
  npx osv-scanner -r .              # OSV（Google）覆盖面更广
  pnpm dlx @cyclonedx/cyclonedx-npm # 生成 SBOM
  ```
  并把 `pnpm audit --prod` 与锁文件校验（`--frozen-lockfile`，Dockerfile 已用）纳入流水线门禁。

---

## 6. 加固清单（可直接执行）

### 已完成（对应 M-1 / M-2 / M-3）
- [x] `env.ts` 与 cookie 写入在生产环境强制 `Secure`。
- [x] API、web 和 Caddy 下发 HSTS。
- [x] `/docs*` 由管理员鉴权保护，匿名请求返回 404。

### 已完成（对应 L-1 / L-4）
- [x] `rate-limit-policy.ts` 已登记 `publicRead` 并覆盖媒体、主题、插件资源和 SEO 读取。
- [x] 首次管理员改为独立 bootstrap 流程，并有并发注册回归测试。

### 已完成或明确化（对应 L-2 / L-3 / I-1）
- [x] Next.js 使用每请求 nonce，普通 API CSP 移除 `script-src 'unsafe-inline'`。
- [x] 主题和媒体 SVG 等主动内容强制 `attachment`。
- [x] SDK 清洗器、URL 安全策略和主题 CSS 校验均有单元测试；成熟第三方清洗器仍可作为后续替换评估。

---

## 7. 附：本次审计的边界与复试建议

- 本报告仍是静态审计记录。最后复核已运行 API 全量测试、SDK 测试、TypeScript、lint 和差异检查；媒体、isolated RPC、任务和锁还有对应的定向测试。依赖扫描的唯一残余为上游尚未发布修复的开发依赖 `braces@3.0.3`。
- 生产发布仍应继续执行依赖审计、镜像签名校验和真实 HTTPS/Redis/对象存储环境验证。

> 初始报告基于 2026-10-04 时点的仓库代码；2026-10-06 复核已同步源码、测试和插件执行边界描述。后续安全变更应同时更新本报告的状态和对应回归测试。

## 8. 2026-10-06 当前复核项

- [x] 附件引用外键改为 `ON DELETE RESTRICT`，并增加插件 owner scope。
- [x] isolated RPC 双向 timeout、取消消息、错误/Date/Buffer/BigInt 编解码。
- [x] worker 崩溃进入 `failed` 隔离状态，重新激活时重建 worker；连续三次退出后熔断；路由支持 drain。
- [x] state lock 使用 token compare-and-delete；Job runtime 支持真正的 handler removal。
- [x] 停用插件会按 owner 清理内存后端定时任务和 BullMQ 等待/延迟任务，不再让停用插件任务进入死信。
- [x] 并发删除、worker crash/restart、RPC timeout、job dedupe 和 owner 越权测试已纳入现有测试集。
- [x] CI 已把依赖审计、SBOM、镜像验签和资源限制作为发布门禁；`braces` 的上游未修复项需在后续依赖更新时复核。
