# 审计报告：全站性能 + zjmf-upstream 上游插件缺陷 + 绑定上游服务设计漏洞

- 站点：`https://www.inferyun.com`（StackPanel **0.1.2**，`ghcr.io/worable233/stackpanel:0.1.2`）
- 部署：`/opt/stackpanel`（docker compose，无 1Panel 本地应用打包）
- 服务器：Debian 13，4 核 / 7.8G，OpenResty + 1Panel，PG18 `1Panel-postgresql-ILyJ`，Redis `1Panel-redis-pKCB`
- 审计时间：2026-11-03
- 本报告来源：线上实测（日志 / DB / 直连上游接口），不是推测。凡标「证据」的均为可直接复现的观测。

---

## 0. 一句话结论

| 维度 | 结论 |
|---|---|
| 服务器性能 | **不是瓶颈**：load 0.13、内存空闲 4.5G、容器 CPU <1%、DB 最大表 408KB、最长查询 7.6ms |
| 页面慢 | **架构性缺缓存 + 串行请求**：每页固定触发 5~6 个无缓存 API；`/plugins/frontends` 每次请求对 23 个插件做全量文件系统扫描，p95 **8.9s**、max **10.0s** |
| 上游慢 | 上游 `GET /api/product/list` 单次 **1.8~2.3s / 4.47MB（1890 商品）**，插件每次页面渲染都同步回源，零缓存 |
| 插件功能 | 内核有 **owner_id 传播缺陷**（写插件数据时 owner 恒 NULL）→ 上游列表空、服务详情 404、账号配置假成功 |
| 同步 | 同步"成功"但 `created/updated/skipped` 全 0，**商品一个都没入库**（静默空转） |
| 设计漏洞 | 后台可**绕过商品直接绑定上游服务**，产生 `bound-<sha256>` 幽灵实例 → 用户侧 404、无法续费/退款/对账 |

---

## 1. 性能问题清单

### P0-1 `/plugins/frontends` 无缓存 + 每次全量扫盘（本报告最严重项）

**证据（api 日志按 reqId 关联 responseTime 聚合，共 25,106 行日志）**

```
   n     p50ms    p95ms    maxms    avgms  url
 379       160     8892    10025     1619  /plugins/frontends
```

**代码**：`apps/api/src/routes/plugin.ts:43`

```ts
app.get('/plugins/frontends', async () => {
  for (const plugin of app.pluginRuntime.list()) {
    if (plugin.state !== 'active') continue;
    const packageDir = pluginPackageDir(plugin.id);
    const repaired = await ensureRuntimeAdminBundle(packageDir).catch(() => false);  // 每次 stat + 可能写文件
    const manifest = await readFrontendManifest(packageDir);                          // 每次读 manifest.json
    const pointer = await readCurrentRevision(packageDir);                            // 每次读 current.json
    const current = pointer && !repaired && (await isRevisionComplete(packageDir, pointer.revision))
      ? pointer
      : await ensureCurrentRevision(packageDir).catch(() => null);                    // 可能触发重建
    ...
```

- 23 个 active 插件 × 每个 3~5 次文件系统操作 = 每次请求 70~120 次 IO，**没有任何进程内缓存 / ETag / Cache-Control**。
- 响应体 389,171 B（未登录态实测；登录态更大），且每个页面渲染都要拉。
- 峰值 10s 的来源：与插件 isolate 重建 / 同步任务叠加时的 IO 抖动。

**修复建议**
1. 结果进程内缓存：key = `sorted(activePluginId + revision + adminBundleStamp)`，插件 activate/deactivate/升级/前端重编译时失效（`pluginRuntime` 已有事件源）。
2. 响应加 `ETag` + `Cache-Control: private, max-age=30, stale-while-revalidate=300`，命中 304。
3. 更彻底：与 `/themes/active`、`/nav/public`、`/catalog/categories` 合并成**一个 `/bootstrap`**，页面只拉一次。

**验收**：冷启后 `/plugins/frontends` p95 < 50ms、max < 200ms；同一页面重复刷新 304 比例 > 90%。

---

### P0-2 页面渲染串行拉多个 API（首页最快只是调用少）

**证据（每页固定调用与耗时）**

| 端点 | 调用次数 | p50 | p95 | max |
|---|---|---|---|---|
| `/themes/active` | 1111 | 136ms | 586ms | 922ms |
| `/themes/atlas/frontend` | 540 | 342ms | 787ms | 1004ms |
| `/plugins/frontends` | 379 | 160ms | 8892ms | 10025ms |
| `/catalog/categories` | 171 | 228ms | 1335ms | 1930ms |
| `/seo/meta` | 369 | 55ms | 388ms | 668ms |
| `/nav/public` | 192 | 30ms | 266ms | 431ms |

**页面 TTFB 实测（公网，gzip）**

```
/                 ttfb 1.379s / 1.674s / 0.344s / 0.251s   （首个请求冷，之后 0.25~0.34s）
/login            ttfb 1.681s
```

单页最坏情况 = 136 + 342 + 1619(avg) + 315 + 55 + 30 ≈ **2.5s 纯 API 等待**，串行叠加在 RSC 渲染里；`/plugins/frontends` 抽风时直接 8~10s。

**修复建议**
1. 服务端渲染阶段 `Promise.all` 并发拉取（现在多处是顺序 `await`）。
2. 合并 `/bootstrap`（见 P0-1），一个 RTT 拿全部首屏数据。
3. 非首屏数据（catalog、nav）走客户端 `stale-while-revalidate`。
4. Next 侧对公共只读数据启用 `unstable_cache` / `revalidate`，别全 `no-store`。

**验收**：首页 TTFB（冷）< 400ms；`/account/*`、`/admin/*` 首屏 < 800ms（P95）。

---

### P0-3 上游代理路由零缓存 + 阻塞式回源

**证据**

```
8785ms  GET /admin/users/<cuid>/upstream-services
8581ms  GET /services/bound-<hash>/metrics
6984ms  GET /services/bound-<hash>
6915ms  GET /services/bound-<hash>/metrics
6673ms  GET /services/bound-<hash>
4710ms  GET /services/bound-<hash>/resource-kinds
```

**上游实测（从服务器直连 moebun.com，使用 API 密钥登录）**

| 上游接口 | 耗时 | 体积 |
|---|---|---|
| `POST /zjmf_api_login` | ~250ms | 481B jwt |
| `GET /host/list` | 248ms | 4.7KB |
| `GET /api/product/list` | **1814~2298ms** | **4,474,277B（1890 商品）** |

结论：一次页面渲染串行叠加 2~4 次上游调用，其中商品列表单次就 2s/4.4MB，**全程无缓存**。

**修复建议**
1. 上游响应读穿缓存：`cache key = upstreamId + path + 参数`，TTL 默认 300s，同步/写操作后按 `upstreamId` 失效；商品列表 TTLC 600s。
2. 每个上游调用打点 `upstream_ms`、`upstream_bytes`、`cache_hit`，超 2s 告警。
3. 超时降级：5s 超时后返回"本地缓存 + stale 标记"，**不要阻塞整页**；页面对 stale 数据展示"数据可能不是最新"。
4. `product/list` 4.4MB 不适合每次全量：同步时落库（见 Z-3），页面只读本地。

**验收**：`/services/*` 系列 P95 < 400ms；上游不可用时页面仍可打开（降级态），不是 502/空白。

---

### P1-1 插件前端产物过大（客户端负担）

**证据（容器内实测）**

```
8.4M  llm-gateway/frontend/dist     4.1M  store/frontend/dist
2.9M  captcha/frontend/dist         2.8M  smtp/frontend/dist
2.4M  storage / store-wallet        2.3M  market          2.2M login
合计 12M（仅 *.js 打包产物）
```

虽然按路由按需加载，但单个插件包 4~8MB，弱网下首屏交互明显延迟。

**建议**：按路由 code-split、`manualChunks` 拆第三方依赖、移除 sourcemap 与重复 polyfill；对 account/admin 两套入口分别产出，避免互相携带。

---

### P1-2 worker 空转轮询（浪费 CPU + 日志噪音）

**证据（`pg_stat_user_tables`）**

```
outbox_events        seq_scan = 169,098   idx_scan = 231,605   rows = 601
event_cursors        seq_scan = 158,949   idx_scan = 5,859     rows = 11
agent_dispatches     seq_scan =  63,793   idx_scan = 0         rows = 0
agent_oauth_grants   seq_scan =  31,900   idx_scan = 0         rows = 0
permissions          seq_scan =  12,393   idx_scan = 1,409     rows = 38
```

对 11 行 / 0 行的表做了十几万次全表扫描 = 忙轮询。

**建议**：outbox 改 `LISTEN/NOTIFY` 或指数退避（上限 5s）；空表任务加 `idle backoff`；补 `(status, available_at)` 复合索引。

---

### P1-3 缺少性能可观测性

现状：只有 pino `responseTime` 行，没有任何按路由的 P50/P95 面板、没有上游调用耗时、没有慢请求告警。这次审计靠临时脚本聚合日志才拿到数据。

**建议**：`/metrics` 暴露 `http_request_duration_seconds{route}` 与 `upstream_request_duration_seconds{plugin,upstream}`；慢请求（>1s）结构化日志带 `reqId`、`userId`、`route`。

---

### P2 其他

- 静态资源头正确：`cache-control: public, max-age=31536000, immutable` + ETag + gzip ✅
- API JSON 全 `no-store`：对只读公共数据（themes/nav/catalog）应加短 TTL + ETag，减少重复传输。
- DB 目前不是瓶颈（最大表 408KB、最长查询 7.6ms），但插件 scoped 查询一律 `WHERE owner_id = $1`，将来数据量上来需要 `(owner_id, <排序键>)` 复合索引。

---

## 2. zjmf-upstream 上游插件缺陷

### Z-1【P0】内核写插件数据时 `owner_id` 恒为 NULL（系统性）

**证据（全表空 owner 统计，`owner_id IS NULL`）**

```
ext_zjmf-upstream_upstream     total=3  null_owner=3     ← 用户"添加了上游"，列表却空
ext_store_service-instance     total=1  null_owner=1     ← 用户点实例链接 404
ext_llm-gateway_account        total=4  null_owner=4     ← "保存成功但又失败"
ext_llm-gateway_user-setting   total=1  null_owner=1
ext_storage_config             total=1  null_owner=1
ext_referral_config            total=1  null_owner=1
```

**读侧**（`apps/api` 扩展客户端，chunk `chunk-7AH2UQAT.js`）：

```js
// listPage
const clauses = [IS_DELETED];
if (registered.table.scoped && this.options.ownerId) { params.push(this.options.ownerId); clauses.push(`"owner_id" = $${params.length}`); }
// get
if (registered.table.scoped && this.options.ownerId) { clauses.push(`"owner_id" = ${push(this.options.ownerId)}`); }
```

**写侧**：`ownerValue(scoped, explicit)` 返回 `this.options.ownerId`，在 **server action / admin action（`frontend.action.execute`、`/admin/...` 插件写接口）** 路径下该值为 `null` → 行写入 `owner_id = NULL` → 之后任何用户都查不到（`WHERE owner_id = '<user>'` 不匹配）。

**后果（⚠ 2026-11-03 复核：本条的因果链不成立，见下方「复核结论」）**

创建成功但列表空、详情 404、配置"假成功"。

#### 复核结论（实施会话核对源码后修正）

上面那条「NULL owner → 列表空 / 详情 404」的链条**断在中间**：

1. **全仓库没有任何插件声明 `scoped: true`**（内核源码 + `data/plugins/*/dist` 均已确认）。
   `ModelDefinition.scoped` 默认 `false`（`packages/sdk/src/models.ts:44`）。
2. 读侧的过滤条件是 `if (scoped && ownerId)`（`extensions/client.ts:251/280/300/368/424`）——
   `scoped` 为假时**完全不加 owner 条件**。所以 NULL owner 不会让列表变空。
3. 写侧对 scoped 模型是 **fail-closed 抛错**（`client.ts:221/539`），NULL 根本写不进去。
4. `store/service-instance` 的用户侧读取**不看 owner_id**：
   - 列表：`listServicesByUser` 按 **spec.userId** 过滤（`repository.ts:595`）
   - 详情：`getService(id)` 是 `extensions().get(model, id)`，零 owner 过滤（`repository.ts:603`）
   - 越权判定在应用层：`service.userId !== userId → 404`（`fulfillment.ts:671`、`changes.ts:253`）

所以「加了上游却显示没有」的真实原因是 **Z-2**（`not_ready` 让所有 GET 失败，前端把
错误渲染成空态），而「服务详情 404」是 **§3 幽灵实例**（`productId` 里存的是上游商品 id）。

**用户回填 owner + 装触发器后「能打开了」，是因为同时重启了 api/worker（清掉 Z-2 的
坏上下文），不是因为 owner 变了。**

**因此 Z-1 的优先级应下调**：它是「防御性加固」而非现场症状的根因。真正该先做的是
Z-2（已修）、Z-3（已修）、§3（已修）。

⚠ 另外提醒：用户安装的 `trg_sp_default_owner` 会给所有 `ext_*` 表塞默认 owner。若将来
某模型改成 `scoped`，这些行会全部归属到那个默认用户 —— 加 scoped 之前必须先清掉它。

**修复（内核）**
1. 写路径统一注入 owner：`ExtensionClientImpl` 构造时若无 user 上下文，禁止写 `scoped` 模型（fail-closed），或显式传入 `ownerId`（admin 写用户资源时用目标 `userId`）。
2. `create/update` 时对 `scoped` 表强制 `owner_id NOT NULL`（DB 级 `NOT NULL` + 应用层校验），杜绝静默 NULL。
3. 读不到但存在同 id 行时（owner 不匹配）应返回明确错误码（如 `resource.owner_mismatch`），不要伪装成"不存在"。

**验收**：任何插件写接口创建的资源，`owner_id` 非空且等于执行者/目标用户；`SELECT count(*) FROM ext_% WHERE owner_id IS NULL` = 0。

---

### Z-2【P0】`onDeactivate` 清空插件上下文 → 所有接口 `zjmf.not_ready`

**证据（api 日志，每次刷新页面一屏）**

```
GET /zjmf-upstream/admin/upstreams → Error: zjmf.not_ready
  at reviveWireError (/app/apps/api/src/plugins/isolated/protocol.ts:180)
```

**插件代码**（`/app/data/plugins/zjmf-upstream/dist/index.js`）

```js
onDeactivate: (ctx2) => { service = null; resetContext(); ctx2.logger.info("zjmf-upstream: deactivated"); }
// resetContext(): ctx/extensionClient/transactionRunner/productRead/productUpdate = null
// extensions(): if (!extensionClient) throw new Error("zjmf.not_ready")
```

内核在**每次"添加上游"之后**都会调 `onDeactivate`，但没有重新 `onActivate` → 上下文永久 null → 列表/详情/同步全部 500，前端把错误渲染成空态「还没有上游。」（用户看到的就是"永远空"）。

**临时处置（已上线）**：把插件 `dist/index.js` 的 `onDeactivate` 改为不清理上下文，备份 `index.js.orig`，重启 api/worker。
**正式修复（内核）**：查清为何 action 后触发 deactivate 且不重新 activate；保证 `deactivate → activate` 成对，或让 isolate 重建时重跑 `bindContext`。

**验收**：连续执行 10 次"添加上游 / 编辑 / 同步"后，`extensions()` 不再抛 `not_ready`；插件日志不出现 deactivate 后接请求的情况。

---

### Z-3【P0】同步"空成功"：SUCCEEDED 但 0 商品入库

**证据（`ext_zjmf-upstream_sync-run` 最新两条）**

```json
{"status":"SUCCEEDED","created":0,"updated":0,"skipped":0,"error":null,
 "upstreamId":"0770ee68-...","completedAt":"2026-11-03T04:16:52Z"}
```

同时：`ext_store_product = 0`、`ext_catalog_product = 0`，而上游 `GET /api/product/list` 返回 **1890 个商品**。

**问题**：同步报告成功却什么都没做（`skipped` 也是 0，即连"跳过"都没统计到），用户无法察觉。这是最典型的"假成功"。

**修复**
1. 同步必须返回明细：`fetched / created / updated / skipped / failed` 且 **`fetched == 0` 视为失败**。
2. `SUCCEEDED` 的判定标准：`created + updated > 0` 或 `skipped > 0 且 skipped 有明确原因分类`。
3. UI 展示上次同步时间、耗时、明细、错误码。
4. 查清商品未入库的真实原因（映射策略？`store.product.update` 扩展点未命中？写失败被吞？）。

**验收**：同步后 `ext_store_product` 数量 ≈ 上游可售商品数；同步记录里 `fetched` 与上游一致。

---

### Z-4【P1】定时同步在 worker 侧死信

**证据**

```
[jobs] job zjmf-upstream.scheduled-sync entered dead letter after 3 attempt(s):
       未知或未声明的自定义模型：zjmf-upstream/upstream
```

worker 执行 `scheduled-sync` 时，插件自己声明的模型没注册进执行上下文 → 任务永远失败，**自动同步等于不存在**。

**建议**：worker 侧同样注册插件 models（或在 job 里走与 api 相同的 model registry）；死信要能看到失败原因与重试次数（现在只有一行日志）。

---

### Z-5【P1】凭证与资源非原子

**证据**：`ext_zjmf-upstream_upstream` 曾有 2 条 moebun，但 `secrets` 里只有 1 条 `plugin.zjmf-upstream.credentials.<id>`。

**建议**：创建上游 = 单事务（资源 + 凭证 + 审计事件），任一步失败整体回滚；编辑凭证失败必须报错，不能 200。

---

### Z-6【P1】前端吞掉上游错误（"服务器开小差了，请稍后重试"）

**证据**：api 返回 `code=zjmf.client.credentials_rejected, status=502, detail="…上游拒绝登录…"`，页面只显示兜底文案。

**建议**：透传 `code / detail / reqId`；上游 4xx/5xx 与本地 5xx 分开文案；提供"查看诊断信息"入口。同一问题也存在于 `action-feedback-toaster` 的 `?error=` 反射（0.1.2 已修 URL 通道，但 detail 仍被吞）。

---

### Z-7【P2】同一上游可无限重复创建

**证据**：一度存在 3 条同名 `moebun`（同 baseUrl），会重复拉取 1890 商品。

**建议**：`(owner_id, spec->>'baseUrl')` 唯一索引 + 前端提示；或允许重复但 `spec.name` 强制唯一。

---

### Z-8【P1，本次实测新发现】moebun 的鉴权方式是"API 密钥当密码"

排查结论（供文档化）：小兔互联（moebun.com，魔方财务 V1）的开放接口要求：

```
POST /zjmf_api_login   username=<账号邮箱或手机>   password=<用户中心 API 管理里的 API 密钥>
→ {"jwt":"…","status":200}

GET  /api/product/list   Authorization: Bearer <jwt>   → 200 + 1890 商品
```

- 用**站内登录密码**登录 → 上游返回 `{"status":400,"msg":"鉴权失败"}`（**即使账号不存在也是同一句**，所以无法从响应区分"密码错"还是"未开 API"）。
- 插件当前把用户填的密码原样提交，没有任何"这是 API 密钥"的引导，也没有"密钥直连"（`Authorization: <key>`）的降级路径。

**建议**：上游配置表单区分「账号 / 登录密码 / API 密钥」三种凭证模式；对魔方财务给出默认推荐「API 密钥模式」，并在保存前做一次连通性探测（登录 + 拉一页商品），失败直接拒绝保存并展示上游原文。

---

## 3. 设计漏洞：「绑定上游服务」= 绕过商品与订单

### 3.1 现状（用户实测触发）

- 入口：`/admin/users/<userId>` → 直接「绑定上游服务」。
- 结果：生成 `ext_store_service-instance` 行：

```json
{"id":"bound-d8a0b2408e7387d229724fe197bd759bcbaed74c9a93634c570d8d0bf2182546",
 "owner_id":null,                       ← 又是 Z-1
 "spec":{"userId":"cmvxm3cps...","productId":"33363","providerServiceId":"33363",
         "state":"ACTIVE","productName":"S93z7tkBNkRxq",
         "runtime":{"origin":"upstream-import","upstreamId":"0770ee68-...","upstreamProductId":"4661"}}}
```

- 代码：`packages/plugins/store/src/operations.ts:353`

```ts
// 注意：product 可以为 undefined —— 没有命中本地商品也照样建实例
const matches = products.filter(p => p.providerId === input.providerId && p.providerProductId === runtime?.upstreamProductId && ...);
if (matches.length > 1) throw new CommerceError('service_already_bound', '…');
const product = matches[0];                        // 可能 undefined
const identity = `bound-${createHash('sha256').update(JSON.stringify([providerId, sourceRef, providerServiceId])).digest('hex')}`;
const service = await createServiceInstance({ userId, orderId: null, productId: product?.id ?? input.productId, ... }, identity);
```

**问题链**
1. 不要求商品存在：`productId` 直接来自调用方（"33363" 是**上游商品 id**，不是本地商品 id）。
2. 不要求订单：`orderId: null`。
3. 实例 id 是 `bound-<sha256>` 合成 id，用户侧路由 `/services/bound-…` 与常规实例处理分支不同。
4. 叠加 Z-1（`owner_id` NULL）→ 用户点进去 **404「服务不存在」**（我们这次已回填 owner_id 让它能开，但这只是掩盖症状）。
5. 这类实例没有商品、没有订单、没有凭证：**不能续费、不能退款、不能对账、不能算业绩**，还会污染统计（`state: ACTIVE` 但从未经过 fulfillment）。

### 3.2 目标模型（建议正式方案）

```
上游(upstream) ──同步──> 本地商品(store.product，含 metadata.upstream{sourceRef, providerProductId})
                              │
                          订单(order) ──> 开通(fulfillment) ──> 实例(service-instance)
                              │                                     ↑
                     用户只能在这里选择「已映射商品的已有实例」
```

**硬性规则**
1. **实例必须属于某个本地商品**：`service.product_id` NOT NULL 且外键到 `store.product`。
2. **实例必须来自订单或显式迁移**：`order_id` 可空，但必须写 `origin ∈ {purchase, upstream-import, admin-migration}`；`origin != purchase` 的实例在续费/退款/发票流程里被显式排除，并在后台标注。
3. **后台"绑定"必须命中已映射商品**：找不到 `product.metadata.upstream.sourceRef == upstreamId && providerProductId == upstreamProductId` 的本地商品 → **409 拒绝**，提示"请先创建/映射商品"，绝不隐式建档。
4. **一个上游服务实例只能被绑定一次**：把 `(providerId, sourceRef, providerServiceId)` 做成唯一索引（现在是应用层 `find` 判重，有并发竞争）。
5. **用户侧只可见自己的、且商品仍在架的实例**：越权/不存在统一 404（防枚举），异常写入审计。
6. **删除后台"直接绑定"入口**，改为三步向导：选商品 → 选该商品映射下的上游实例 → 确认生成（内部走与购买一致的 fulfillment 管线，写 order(pending) + 事件 + 审计）。
7. 迁移清理：现存 `bound-*` 实例要么补建商品/订单（迁移订单），要么标记 `origin=admin-migration` 并在后台可见、禁止前台续费入口。

**验收**
- DB 约束：`service-instance.product_id` 非空、`(providerId, sourceRef, providerServiceId)` 唯一、`owner_id` 非空。
- `/services/bound-*` 这类合成 id 不再产生；历史数据有明确 `origin` 标记。
- 后台在无匹配商品时无法创建实例（409 + 明确文案）。
- 用户侧实例列表 = 自己的订单产生的实例，且数量与订单一致。

---

## 4. 已在线上做的临时修复（0.1.3 必须用正式实现替换）

| # | 临时措施 | 风险 | 正式替代 |
|---|---|---|---|
| 1 | 插件 `dist/index.js` 补丁：`onDeactivate` 不再 `resetContext()`（备份 `index.js.orig`） | 插件升级会被覆盖；语义上禁用插件后仍持有旧 ctx | 内核修 deactivate/activate 配对（Z-2） |
| 2 | DB 触发器 `trg_sp_default_owner`（3 张 zjmf 表）+ `trg_sp_owner_spec_user`（service-instance） | 只在库层兜底，其它表仍会写 NULL | 内核写路径注入 owner（Z-1） |
| 3 | 手工 UPDATE 回填 `owner_id`（upstream 3 条、service-instance 1 条） | 一次性 | 迁移脚本纳入升级 |
| 4 | 手工写 `secrets` 凭证（AES-256-GCM，`SETTINGS_ENCRYPTION_KEY`） | 绕过 UI 校验 | 表单支持「API 密钥模式」+ 保存前连通性探测（Z-8） |
| 5 | `docker compose restart api worker` 重新激活插件 | 治标 | 同上（Z-2） |
| 6 | `brand-assets/favicon.png` 挂载兜底 | 与 `.ico` 支持无关 | 正式支持 `.ico`（见历史 P1 清单） |

> 注意：触发器与补丁都是**临时兜底**，任何一次镜像升级 / 插件升级都可能让症状复发。

---

## 5. 建议的修复顺序（给实施会话）

1. **Z-1 owner 传播**（数据正确性总闸，影响 6+ 张表）。
2. **Z-2 插件上下文生命周期**（否则上游模块整体不可用）。
3. **Z-3 同步空成功**（决定商品能否进库，也是性能 P0-3 的根治前提）。
4. **绑定服务流程重设计**（第 3 节，含 DB 约束与迁移）。
5. **性能 P0-1 / P0-2（/bootstrap + 缓存）** → **P0-3（上游缓存与降级）**。
6. P1：Z-4 定时任务、Z-5 原子性、Z-6 错误透传、客户端拆包、outbox 退避、可观测性。

---

## 6. 附录：复现命令

```bash
# 1) 慢请求聚合（api 日志按 reqId 关联 responseTime）
docker logs stackpanel-api 2>&1 | python3 /tmp/an.py

# 2) owner_id 空值普查
psql -c "DO \$\$ DECLARE r record;t bigint;n bigint; BEGIN FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='public' AND c.relkind='r' AND c.relname LIKE 'ext\_%' AND EXISTS(SELECT 1 FROM information_schema.columns col WHERE col.table_name=c.relname AND col.column_name='owner_id') LOOP EXECUTE format('SELECT count(*), count(*) FILTER (WHERE owner_id IS NULL) FROM %I', r.relname) INTO t,n; IF t>0 THEN RAISE NOTICE '% total=% null=%', r.relname, t, n; END IF; END LOOP; END \$\$;"

# 3) 上游接口耗时/体积（在 api 容器内）
docker exec stackpanel-api node -e "fetch('https://moebun.com/api/product/list',{headers:{Accept:'application/json'}}).then(async r=>{const t=Date.now();const b=await r.text();console.log(r.status, Date.now()-t+'ms', b.length)} )"

# 4) 页面 TTFB
for p in / /login /account/services; do curl -s -o /dev/null -w "$p ttfb=%{time_starttransfer}s\n" https://www.inferyun.com$p; done
```

---

## 7. 关联文档

- `docs/RELEASE-updater-image.md`
- `docs/OPERATIONS-RUNBOOK.md`
- `docs/DEPLOY-REVERSE-PROXY.md`
- 历史修复清单（0.1.2 前后 3 轮审计）见对话记录：referral `useState` shim、llm-gateway `models` 原子保存、favicon `.ico`、server-action 307 透传、epay 公钥配置。

---

## 8. 实施状态（0.1.3）

按本报告落地后的状态。**注意 Z-1 一项的结论已在上方复核中修正。**

| 编号 | 项 | 状态 | 提交 | 说明 |
|---|---|---|---|---|
| P0-1 | `/plugins/frontends` 无缓存 + 全量扫盘 | ✅ 已修 | `a1c6d46` | 代际缓存（`PluginRuntime.combinedGeneration`）+ 30s TTL 兜底 |
| P0-2 | 页面串行拉多个 API | ✅ 部分 | `e05556c` | 进程级 TTL 缓存 + 并发未命中合并；**未做** `/bootstrap` 合并端点 |
| P0-3 | 上游代理零缓存 | ✅ 已修 | `e8dbb4a` | 商品列表 60s 快照 + **按上游复用 client**（原来每次 `new`，缓存无法跨请求生效） |
| P1-1 | 插件前端产物过大 | ⬜ 未做 | — | 需打包侧改分割策略，与本轮缺陷无耦合 |
| P1-2 | worker 空转轮询 | ✅ 已修 | `80bf54f` | catch-up 自适应退避（2s→30s）+ 补 `(publishedAt, parkedAt, nextAttemptAt)` 索引 |
| P1-3 | 缺少性能可观测性 | ✅ 已修 | `80bf54f` | 新增 `stackpanel_upstream_request_duration_seconds`；按路由分位原本就有 |
| Z-1 | owner_id 恒 NULL | ⚠️ **结论修正** | `8b6bc5a` | 因果链不成立（见复核）；actor 传播已做，属防御性加固，非现场根因 |
| Z-2 | `onDeactivate` 清空上下文 | ✅ 已修 | `8b6bc5a` | 改为「先关闸 → 等排空 → 再拆」 |
| Z-3 | 同步「空成功」 | ✅ 已修 | `b1423dd` | 成功需 `created+updated+skipped > 0`；区分三种「没干活」 |
| Z-4 | 定时同步死信 | ✅ 已修 | `80bf54f` | **根因是启动顺序**：消费抢在插件注册 handler 之前。改为插件激活后再 `startJobConsumption()` |
| Z-5 | 凭证与资源非原子 | ✅ 已修 | `530db89` + `522e42c` | 内核新增 `tx.secrets`；插件改为同一事务写入 |
| Z-6 | 上游 502 detail 被吞 | ✅ 已修 | `530db89` | raw 路由 catch 保留插件 status/code/detail（原先一律压成 500） |
| Z-7 | 同一上游可重复创建 | ✅ 已修 | `e8dbb4a` | `name` 唯一索引 + 应用层按名称/地址查重 |
| Z-8 | moebun 要「API 密钥当密码」 | ✅ 已修 | `0ee431b` | 凭证可声明 `apiKey` 模式；失败提示按模式给方向 |
| §3 | 绑定上游服务绕过商品与订单 | ✅ 已修 | `e05556c` | 无映射 409，绝不隐式建档；唯一索引防并发重复绑定（内核新增部分索引能力） |

### 尚未处理（需另行决策）

1. **P1-1 插件前端产物分割** —— 属于构建策略，改动面在打包脚本，与本轮缺陷无关。
2. **`/bootstrap` 合并端点** —— P0-2 只做了缓存，没把 5~6 个端点合并成一个。
   合并需要同时改内核、web 与所有插件的 finder 契约，风险远大于收益。
3. **存量脏数据** —— 见 `docs/MIGRATION-0.1.3-data-cleanup.sql`，需人工确认真实影响后执行。
4. **两个 DB 触发器**（`trg_sp_*`）—— 建议在确认无插件使用 `scoped` 后移除；
   若将来启用 scoped，它们会把历史行全部塞给默认 owner。
