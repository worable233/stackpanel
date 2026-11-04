# 更新日志

本文件记录 StackPanel 内核的公开变更。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.3] - 2026-11-04

**首屏瘦身 + 可靠性修复版**：这一版的主线是「页面为什么慢」——实测服务端 HTML
只要 46 ms，真正的瓶颈是浏览器侧首屏 1028 KB（gzip）/ 31 个 chunk，其中大部分
是 web 自己从不使用、却被桶导入拖进来的重依赖。三轮拆分把首屏压到 **705 KB**
（-31%），zod 与 recharts 完全从首屏消失。

同时修掉一批「本地能跑、生产会咬人」的问题：插件签名校验可被一份照抄的
`.env.example` 关掉、集群下平台信息永不跨副本失效、macOS 上所有运行时插件加载
失败。

### 性能（首屏）

- **图表组件拆出 UI 桶**：`MetricsExplorer` / `UsageTrendChart` 移到独立 ABI 槽
  `@stackpanel/ui/charts`。它们依赖 recharts（未压缩 559 KB），而 Turbopack 会把
  同一批 client 组件合并进一个 chunk —— 任何页面用 `Button` / `Select` 都会连带
  下载图表库。首屏 3360 KB → 2987 KB（未压缩）。
- **zod 拆出首屏**：`frontend-abi-bridge` 静态 `import * as sdk` 把 zod（911 KB）
  拖进**每个页面**（这个 bridge 挂在根 layout 上）。改成惰性 `import()`，并给
  `formatMinorCurrency` 等四个纯格式化函数加 `@stackpanel/sdk/currency` 子路径。
- **lucide 惰性化**：`import * as lucide from 'lucide-react'` 把整个图标库
  （614 KB，1700+ 图标）打进首屏。web 自己用的是按名导入（会被 tree-shake），
  只有插件需要完整命名空间。
- **修掉一个把收益抵消回去的静态导入**：服务端 ABI 曾静态导入 charts 真实组件，
  让 recharts（373 KB）出现在 **45 个页面**的共享 chunk 里。改用链接期桩后，
  `/login` 从 815 KB 回到 **705 KB**。
- 请求级去重：`pinInSnapshot`（`AsyncLocalStorage.enterWith`）**不跨渲染阶段**，
  实测去重无效；改用 React `cache()`。内核请求数：`/platform/info` 2x → 1x、
  `/platform/brand` 2x → 1x、`/permissions/check` 2x → 1x。
- `/plugins/frontends` 加代际缓存：p95 **8.9 s → 毫秒级**。
- `/platform/info` 进程内缓存：稳定 0.7 ms（此前每次查 Setting 表）。
- 插件设置区块并行解析；审计写入改为 fire-and-forget，不再阻塞渲染。

### 新增

- **路由级骨架屏**：每个页面有与自身布局同构的 `loading.tsx`，切换时不再是空白。
- **部分唯一索引**：`ModelIndex.where?: { kind: 'notNull' }`，让
  `UNIQUE (col) WHERE col IS NOT NULL` 成为可声明的能力。`tableHash` 与
  `sameIndex` 都纳入谓词 —— 否则「加谓词」不触发重建，库里留旧索引且无报错。
  迁移允许**放宽**型重建（drop + create），收紧仍拒绝。
- **品牌图标**：支持 `.ico`；`STACKPANEL_BRAND_DIR` 成为受支持的部署能力（显式
  配置优先、不回退）；logo 圆角可配置。
- **Agent**：运行详情默认只回尾部步骤（不再传整个 50 MB）；「思考强度」控件
  终于影响执行；审批审计补上参数快照。
- **后台**：OS 风格更新中心、统一插件市场、内容画布样式。

### 修复（权限系统）

- **超级管理员被插件的开放 API 一律 403**：内核自己的资源在治理表里逐条写了
  `platform.admin`，看起来「超权自动生效」，其实只是**手工枚举**的结果。插件
  资源是运行期聚合的，只填插件自己声明的权限键（`gateway ->
  ['llm-gateway.use', 'llm-gateway.admin']`），没有 `platform.admin`。于是
  `scopeSatisfied('user:read', ['platform.admin'])` 为 true，而
  `scopeSatisfied('gateway:read', ['platform.admin'])` 为 false —— 管理员访问
  插件开放 API 被 403，访问自己的内核 API 正常。修法：`platform.admin` 满足
  所有 refined scope（它只收窄内部的 `route.permission` 门，超权持有者本来就
  过得了那道门）。非 refined scope 保持精确匹配，否则就是真提权。
- **`capability.scope` 可以放宽访问**：`runtime.ts` 原本无条件用
  `capability.scope` 替换 `route.permission`。语义上 refined scope 只能收窄，
  实现上却能放宽 —— 抄错成 `user.basic` 就让普通用户能访问管理端点，而内部
  门禁已被丢弃。现在只有 `资源:read|write` 形式才替换，其他形式保留
  `route.permission`。

- **`capability.scope` 写成权限键**（13 个插件）：alipay、altcha、captcha、
  catalog、epay、invoice、notice、referral、smtp、ticket、wechatpay、
  wecom-mail、zjmf-compat 把它写成了 `epay.admin` 这类权限键，而不是规范的
  `资源:read|write`。错写法「看起来能跑」纯属巧合（非 refined scope 走精确
  匹配，恰好等于自己的 `route.permission`）。已全部整改：12 个改成
  `资源:read|write` 并给 `permissions` 补上 `{ key, scope }`（否则 API token
  拿不到 refined scope，会凭空丢失访问能力）；referral 借用 store 插件的
  `store.admin`，不能自造资源，改为删掉 `capability.scope`、回到
  `route.permission` 单一门禁（与内置 store 插件写法一致）。
- **内核现在校验 `capability.scope` 格式**：只接受 `资源:read|write`，插件
  激活时即报错并给出修法。此前 `permissions` 有校验、`capabilities` 完全裸奔
  —— 这正是上面那个写法错误能长期存在的原因。内核自己的 `CAPABILITIES` 不受
  影响（由内核治理，确实用权限键形式）。

### 修复（升级即崩，只在已部署的库上暴露）

这一批的共同点：**本地新建库完全看不出来**，只有从 0.1.x 升级上来的库才会中招。
任意一个都让 0.1.3 的 API 启动即崩。

- **索引声明位置导致所有编号整体后移**：索引名由**声明位置**生成
  （`idx_${tableName}_${position+1}`），迁移器按**名字**匹配。给
  `store/service-instance` 加 `providerServiceId` 唯一索引时插在了
  `expiresAtMs` 之前，于是库里的 `_7`（`f_expiresAtMs`，非唯一）对上声明的
  `_7`（`f_providerServiceId`，唯一 + 谓词），被判定「定义已变更」。而这是
  **收紧**唯一性，`isRelaxation` 只放行「唯一 → 唯一 + 谓词」，于是抛
  `extension.unsupported_migration`。修法：新索引追加到末尾；声明处写明
  「`indexes` 只允许追加」。
- **部分索引查重把 NULL 行算成重复**：`assertNoDuplicates` 的 SQL 只有
  `WHERE deleted_at IS NULL`，没带 `whereNotNull` 谓词。而
  `UNIQUE (col) WHERE col IS NOT NULL` **根本不约束 NULL 行**。本地库 4 条
  service-instance 里 3 条 `providerServiceId IS NULL`（普通购买本来就没有
  上游编号），被当成「3 条重复」直接拒绝 —— 数据完全合法。修法：谓词与
  `createIndexSql` 保持一致。
- **建表路径跳过唯一索引查重**：`createTableSql` 用 `IF NOT EXISTS`，所以
  「没有元数据行」不等于「没有表」。原实现只在 `applyDiff` 里查重，建表分支
  直接 `CREATE UNIQUE INDEX`，有重复数据就撞 PostgreSQL 原始 `23505`：
  `could not create unique index "..."` —— 既没有 `code` 也没说清哪个模型，
  而 `applyDiff` 早就给出可读的「存在重复值，无法建立唯一索引 X」。两条路径
  现在共用同一查重函数。
- **多列声明部分索引被静默降级成全表唯一索引**：`compileTable` 里
  `fields.length === 1 ? { whereNotNull: true } : {}` —— 多列时谓词被**静默
  丢掉**。声明 `UNIQUE (a,b) WHERE a IS NOT NULL`（NULL 行不参与），实际建的
  是 `UNIQUE (a,b)`（NULL 行也参与），语义正好反过来，而且不报错。改为多列 +
  `where.notNull` 直接报错。

用真实 0.1.2 库验证过完整升级：`_1`..`_8` 编号原样保留，新增 `_9`（唯一 +
谓词），3 条 NULL 数据全部保留，迁移错误 0。反向（真有重复数据）仍正确拒绝。

### 修复

- **照抄 `.env.example` 会关掉插件签名校验**：根目录那份是「公钥为空 +
  `PACKAGE_SIGNATURE_REQUIRED=false`」，而 `docker/.env.example` 是 `true`。
  照抄前者等于完全跳过验签，compose 的 `:-true` 兜不住（变量已被定义）。
- **集群下平台信息永不跨副本失效**：`platform-info` 缓存**无 TTL**，只在本副本
  写入时替换。集群默认 2 副本，A 改名后 B 一直显示旧名直到重启。接入既有
  `coherence` 广播（`kind: 'config'`），`source-config` 同样问题一并处理。
- **macOS 上所有运行时插件加载失败**：ABI shim 编码成 `data:` URL，React 命名
  空间 50+ 导出 → 约 2.9 KB，超过 macOS 单路径 1024 字节上限，`import()` 抛
  `ENAMETOOLONG`，整页 500。改为写临时文件（`file://` 无长度限制）。Linux 上限
  高得多，所以这个问题只在 macOS 暴露 —— 「本地全挂、CI 全绿」的典型盲区。
- **`unhandledRejection` 处理器重复注册**：`server.ts` 里同一段代码出现两次
  （合并时引入），每条未捕获 rejection 打印两遍。
- **`server-cache` 是无界 Map**：过期条目只在被再次读取时才替换。加 500 条上限
  + 插入时清过期 + LRU 淘汰。
- **内存会话存储无清扫**：只在 `get()` 里惰性过期，而登出后那个 token 再没人
  访问 —— 记录永久留存。加阈值触发清扫。
- **`/account` 问候语空邮箱**：并行化取数时把 `email` 设成了空串。
- **worker 定时任务抢跑死信**：根因是启动顺序 —— `initJobs()` 之后 `runtime.start()`
  立刻消费，而插件 `onActivate`（注册 handler）要等 `syncEnabledPlugins()`。
  改为插件激活后再 `startJobConsumption()`。
- **同步「空成功」**：`listBoundProducts()` 返回空时循环零次，却无条件记
  SUCCEEDED。新增 `isProductiveSync()`，并区分三种「没干活」的原因。
- **幽灵服务实例**：无商品映射时旧代码会隐式建档，产出无商品/无订单/无凭证的
  实例，不能续费/退款/对账却计入 ACTIVE。改为 `product_unmapped` 409，绝不隐式
  建档；已存在的打 `origin=admin-migration` 标记（不删除）。
- **重复上游**：按 `name` 与（归一化地址 + 协议）查重 → 409。
- **上游零缓存**：`listProducts` 加 60 s 快照缓存，**同时**按上游复用 client
  （原每次 `new ZJMFClient(...)`，只加缓存等于白加）。
- **插件错误被压成「服务器开小差」**：内核 raw 路由的 catch 把插件的 502 /
  code / detail 全部压成 500。
- **api 抖动时把人踢出登录**：会话三态 —— 只有内核明确 401/403 才算 anonymous，
  5xx / 超时 / 网络错误 → unavailable（503）。
- **Agent 假成功**：运行没起来时用「消息已保存」盖住；轮询连续失败静默放弃；
  会话路径的幂等键从未生效（重试会建出第二条运行）。
- **favicon 404 真正根因**：种子找不到内置图，不是缓存。
- **outbox 忙轮询**：改为自适应退避（有交付 2 s，空转封顶 30 s），并补
  `[publishedAt, parkedAt, nextAttemptAt]` 索引。
- **新迁移被测试库静默跳过**；会话清理补排序索引。
- **`cart-checkout` 测试跟上 Checkbox 组件化**（`onCheckedChange(boolean)` 而非
  DOM 事件）。

### 修复（发布前全流程体检）

- **单端口部署下 `/api/public/*` 被错误转给内核**：`apps/web/src/app/api/public/`
  （模型服务的同源统计代理）不在 `WEB_BFF_PREFIXES` 里，单端口模式会把请求转发
  给 API 然后 404。`single-port-routing.test.ts` 正是防这类漂移的守卫。
- **CI 的 Lint 门禁会直接失败**：`pnpm lint` 有 29 个错误。其中 24 个是重构后的
  未使用导入/参数；3 类是真问题 —— effect 里同步 `setState`（三个组件初值本就
  是 loading，首屏那次纯多余且触发级联渲染）、`admin-nav-manager` 在 effect 里
  重置 state（改成官方推荐的 key 重置）、`users/page.tsx` 把 JSX 写在
  try/catch 里（改成只包取数）。
- **6 个测试失败其实是版本号升级引入的**：fixtures 硬编码
  `kernel: '>=0.1.0 <0.2.0'`，升到 0.1.3 后这些 catalog entry 变得不兼容，
  plan 里没有该 package。改成不设上界；`market-catalog` 里那条**故意不兼容**
  的用例改成 `>=9.0.0`，不会再被下一次版本号撞上。
- **测试隔离**：`storage-plugin` 的鉴权用例依赖执行顺序（插件配置跨用例留存）；
  `outbox-event-bus` 的 4 处 `configure` 不指定 `instanceId`，同进程多实例共用
  主机名游标，并行时互相推进；`outbox-replica-identity` 从不启动消费循环，靠
  `publish` 内部偶然的 catchUp 侥幸通过 —— 改为由测试显式驱动两侧 `catchUp`。

### 修复（兼容性）

- **`capability.scope` 不合规不再拒绝激活，改为警告 + 安全降级**：上一轮把它做成
  硬失败，结果**用户升级后装不上任何旧插件**（发布冒烟从市场装 `captcha` 直接
  409）。改成：非 refined 形式的 `capability.scope` 不参与鉴权，`route.permission`
  照旧作为门禁 —— 旧插件行为与修复前等价（它们本来就恰好和自己的
  `route.permission` 相同），只是不再享受 refined scope 的细粒度收益。安全性不受
  影响：门禁只多不少。

### 修复（静默丢事件）

- **副本消费游标会静默丢事件**：`event_cursors` 的 `(lastAt, lastId)` 复合游标
  依赖「同一毫秒内 id 递增」，但 `id` 是 cuid —— 跨进程并发写同一毫秒时后插入的
  行可能拿到**更小**的 id。实测生产库 601 行里有 **36 组逆序**。游标一旦越过
  逆序对中 id 较大的那条，另一条就永远满足不了 `id > lastId`，事件丢失且无任何
  报错。`normal-start.ts` 与 `worker.ts` 都会启动游标消费，所以**单副本也受
  影响**（每次进程重启都用游标补齐），不只是集群。改用 `seq BIGSERIAL` 做续位：
  插入时由序列赋值，单调且与提交顺序一致；加列时 Postgres 按物理顺序回填，
  实测回填后逆序数 0。旧列保留供滚动升级，一个发布周期后可删。

### 修复（发版阻断）

- **未设 `STACKPANEL_BRAND_DIR` 时整栈起不来**：`3f38dd4`（自定义品牌图标）在主
  compose 里写了 `${STACKPANEL_BRAND_DIR:+...}`，注释断言「只有变量非空才产生这一
  项」—— 实际 compose 短语法在空值时把整项展开成空字符串，**仍然是一个列表项**，
  于是 `docker compose up` 报 `invalid empty volume spec`。默认值就是空，所以这是
  绝大多数部署的路径，不是边缘情况。可选挂载改为独立的
  `docker-compose.brand.yml`，由 `deploy.sh` 检测到变量非空时叠加。

### 验证

- **真实插件前端的装载与渲染**（此前是发版前的功能盲区）：新增
  `apps/web/tests/plugin-frontend-render.test.ts`，一路跑到
  `renderToStaticMarkup` —— 装载 store/catalog/ticket/notice 四个真实插件产物，
  确认导出 `pages`/`pageComponents`，并把 store 的三个页面组件真的渲染出 HTML
  （`shop` 1727 字符，另两个是正常的 `NEXT_REDIRECT`）。之前只验证到「ABI
  adapter 返回 200」，完全没碰插件真正的产物。
- **生产库副本升级演练**：把 `stackpanel` 库（94 表、真实数据）完整复制，
  回退到 0.1.2 状态（删 `_9` 索引、还原 `definitionHash`）、额外插入 3 条
  `providerServiceId IS NULL` 的行，再让 0.1.3 升级：`_1`..`_8` 原样保留、
  `_9` 正确建出带 `WHERE ("f_providerServiceId" IS NOT NULL)` 谓词、7 行数据
  全保留、0 错误。再构造真重复（两条同 `providerServiceId`）验证被友好拒绝
  （「存在重复值，无法建立唯一索引 …」），**没有裸 SQL `23505`**，服务拒绝
  启动而不是带病运行。

### 内部

- 新增 `stackpanel_upstream_request_duration_seconds{plugin,upstream,outcome}` 指标。
- `docs/design/frontend-bundle-slimming.md`：首屏瘦身的完整设计、实测数据、
  以及三个踩过的坑（`esbuild --alias` 前缀匹配、probe 阶段 alias 指向具体文件、
  re-export 无法阻止 Turbopack 合并 chunk）。
- `docs/MIGRATION-0.1.3-data-cleanup.sql`：数据清理脚本（只读段先跑，删除类语句
  全部注释，需人工确认）。
- 新增 `scripts/measure-request-fanout.py`：数单次渲染打了多少个内核请求。
- `extensions` 集成测试自清理：在用例内部临时 `defineModel` 出来的表必须在用例里
  删掉（元数据行 + 物理表），`afterAll` 的保留策略名单只覆盖顶层声明的模型。

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

### 反向代理（本次的重点）

线上四条事故里有三条的症状都伪装成了别的问题（「请求来源无效」「操作太频繁」
「插件坏了」），所以这批改动的目标不是「再给一份模板」，而是把「反代配得对不对」
从**靠读文档 + 猜症状**变成**一条命令生成、一条命令自检、错误在后台一眼可见**。

- **模板里一条正则都没有了**。面板（1Panel / 宝塔 / 群晖）会生成
  `location ^~ / { include proxy/*.conf; }`，nginx 的 `^~` 命中后不再尝试正则 ——
  旧模板的 `location ~ ^/(api/v1|mcp|…)` 因此**静默失效**，`/api/v1/*`、`/themes/*`、
  `/plugins/*`、`/callbacks/*` 全部落到 Web 上游 → 404，而页面完全正常。现在全部改用
  `^~` 前缀，并把手写/面板两种来源合并成 `docker/proxy/sp-common.conf` 单一真源。
  `apps/web/tests/proxy-template-routing.test.ts` 会真起 nginx + 一个「面板形态」的
  server，逐条断言 16 个前缀的归属 —— 改回正则 CI 立刻红。
- **协议的兜底不再用 `$scheme`**：`map $http_x_forwarded_proto` 优先透传上游写的值，
  缺失时才按对外协议兜底。TLS 在 CDN/面板终止时 `$scheme` 恒为 `http`，浏览器
  `Origin` 是 `https`，同源守卫必然 403（界面文案「请求来源无效」，**后台所有 POST
  失效**，GET 不受影响所以页面看着是好的）。
- **`scripts/proxy-config.mjs` 生成器**：按拓扑（`same-host` / `container` / `cdn` /
  `passthrough`）产出可直接粘贴的完整配置，自动展开各家 CDN 的官方回源段
  （Cloudflare / CloudFront / Fastly / Akamai，15 天缓存 + `--cdn-update` 刷新），
  并在文件头写明该拓扑的陷阱。
- **`scripts/proxy-verify.mjs` 自检**：从外部打你部署好的站点，断言静态资源、API
  前缀、主题前缀、`/version`、`/ready` 的真实 IP、同源判定、SSE 未被缓冲。每条失败
  都给出「根因 → 修复」而不是一句「检查配置」。
- **`GET /api/v1/system/proxy-check`（管理员）+ 系统设置 → 反代自检面板**：把内核
  实际看到的对端地址、转发头、同源判定结果摊开，每条不通过项给出可执行修复与文档
  锚点。判定逻辑**与 Web BFF 是同一份实现**（`@stackpanel/sdk` 的 `checkOrigin`），
  不会出现「诊断说通过、真实请求 403」。面板由浏览器**直接**请求内核，因为要观测的
  正是「浏览器 → 反代 → 内核」这一跳。
- **`/ready` 增加 `proxy` 子项**（`trusted` / `clientIp` / `peer` / `proto`）：不需要
  登录，面板健康检查与同机 curl 都能看到「全员共用一个 IP」。
- **`docs/DEPLOY-REVERSE-PROXY.md`**：三种拓扑、五种面板的插入位置与陷阱、以及一页
  「症状 → 根因 → 修复」速查表（把这次四条事故全部收进去）。
- **`STACKPANEL_SINGLE_PORT=1` 单端口模式**：Web 把内核的机器面前缀也转发，反代只需
  一个 upstream —— 事故 A 那一整类「前缀漏配 / 被 `^~ /` 吞掉」直接消失。默认关闭
  （它移动了两个上游的边界）。

### 修复

- **对象存储镜像换成 Silo**：`minio/minio:RELEASE.2025-09-07T16-13-09Z` 在 v0.1.1
  发版时还能拉，到 v0.1.2 时已被 MinIO 从 Docker Hub / quay / ghcr **全部撤下**
  （许可证变更后不再提供公开镜像，三处实测均 401/403，同网络下 postgres、
  prometheus/node-exporter 等对照仓库均正常）。`docker compose up` 会卡在拉镜像
  这一步，CI 冒烟因此红 —— 而镜像、签名、产物、Release 其实都已发布成功，这种
  「只有一条门禁红、与代码无关」的状态最容易被当成偶发放过。
  现在改用 **Silo**（`pgsty/silo`，PGSTY 维护的 MinIO 分支）：保留 S3 API 与
  `MINIO_*` 环境变量契约，**数据目录、桶、凭据、客户端代码全都不变**，可直接替换；
  需要自建实现时用 `MINIO_IMAGE=<your image>` 覆盖。
- **健康检查修正**：原来 `mc ready local` 里的 `local` 别名是在 `minio-init`
  容器里才 `mc alias set` 的，而健康检查跑在对象存储容器里根本看不到它 —— 那个
  healthcheck 从来没有真正验证过任何东西。改用镜像自带的
  `silo healthcheck ready`。

### 变化

- `API_TRUST_PROXY` 在 compose 里默认 `loopback,linklocal,uniquelocal`（所有 RFC1918
  私网），不再写死 `172.28.0.0/16`——1Panel / 宝塔等环境的 `172.18.x` 网段从此也认得出
  访客真实 IP；公网伪造的 `X-Forwarded-For` 依旧无效。
  `docker/.env.example` 也同步改成这个默认值：它被每个运维复制成 `.env`，写死
  `172.28.0.0/16` 会在反代换到别的网络时**静默失效**（正是事故 C）。
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
