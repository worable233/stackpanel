# 存储提供方（Storage Provider）插件 · 设计定稿

> 状态：设计定稿，待评审 → 实施
> 目标读者：实施者（人或 agent）、评审者
> 本文件所有结论均以仓库源码为证据，标注文件与位置。

## 一、目标

让站长通过**插件**把用户上传资源（媒体、图片变体、品牌文件、备份归档）落到任意后端：
外接图床、S3 兼容存储桶（MinIO / Cloudflare R2 / 阿里云 OSS / AWS）、或服务器本地盘。
切换存储后端**不需要改内核代码、不需要重启整站**，且**不得引入内核特权通道**
（即：必须走标准扩展点，不能加只有特定插件能用的内核后门）。

### 非目标（本期不做）

- 多租户 / 按用户或按资源类型拆分到不同后端（"媒体走图床、备份走本地"是二期）。
- 存储后端之间的**在线数据迁移**（换后端后历史对象不自动搬迁；本期只保证新写入走新后端，旧对象仍需原后端可读——见 §10）。
- CDN 回源、边缘缓存策略。
- 对象加密 / 客户端加密（沿用后端自身能力）。
- 改动现有 `StorageDriver` 方法签名（`packages/db/src/storage/types.ts` 是冻结接口，ADR-0014）。

## 二、现状（证据）

### 2.1 存储是内核单例 + 环境变量

- 接口：`packages/db/src/storage/types.ts:26` 的 `StorageDriver`
  （`put/get/delete/exists/stat/list/url/signedUrl`）。
- 两个实现：`LocalDiskDriver`（`packages/db/src/storage/local.ts:18`）、
  `S3Driver`（`packages/db/src/storage/s3.ts:26`，S3/MinIO/R2/OSS 通用）。
- 选择逻辑：`createStorageDriver(config)`（`packages/db/src/storage/index.ts:18`），
  `config` 由 `readInfraConfig()`（`packages/db/src/config.ts:115`）从**环境变量**解析。
- 全局单例：`apps/api/src/infra.ts:37` 的 `getStorage()`，懒加载、进程内缓存。
- 生产约束：`packages/db/src/config.ts:124` 强制 `STORAGE_DRIVER=s3`，本地盘在生产被拒。
- 本地落盘：`<data-dir>/storage/`，媒体 key 方案 `media/<yyyy>/<mm>/<att_id>/<name>.<ext>`
  （`apps/api/src/media/keys.ts:76`）。

### 2.2 所有字节都经 API 代理，从不暴露对象 key

- 上传：`POST /media`（raw body）→ `AttachmentService.ingest()`
  （`apps/api/src/media/service.ts:98`）→ `storage.put(key, data, {public:false})`（:110）。
- 变体：`apps/api/src/media/service.ts:168` 与 `worker.ts:103` 各自 `storage.put`。
- 下载：统一 `GET /media/:id/content` → `readContent()`（`service.ts:230`）→ `storage.get(key)`
  （:249）→ API `reply.send(Buffer)`（`routes.ts:240`）。
- 品牌：`apps/api/src/lib/platform-brand.ts:69/79` 走 `getStorage().put/get`。
- 备份：`apps/api/src/backup/service.ts:192/227` 走 `getStorage().put/get`。
- **`url()` 与 `signedUrl()` 在 `apps/` 全仓库没有任何调用点**（已 grep 确认）；
  `signedUrl` 只有单测覆盖（`packages/db/tests/storage-signed-url.test.ts`）。

### 2.3 没有存储扩展点

- `PluginContext`（`packages/sdk/src/plugin.ts:571`）只有 `ctx.media`
  （`MediaReferenceService`，`:600`），只能登记附件引用关系，**不能接管存储**。
- 已注册内核扩展点（`apps/api/src/plugins/extension-points.ts`）：
  `routes / auth.provider / payment.provider / payment.settlement / event.listener /
  web.nav / ui.admin.dashboard / llm.provider`——**不含 storage**。
- `EXTENSION_POINTS`（`packages/sdk/src/plugin.ts:414`）同样没有 storage。

### 2.4 "无特权"的标杆：`llm.provider` 模式

`apps/api/src/lib/llm-provider.ts` 是本仓库"通用扩展点"的标准范式：

> 内核只消费 `LlmProvider` 契约；插件通过 `ctx.registerExtension(EXTENSION_POINTS.llmProvider, impl)`
> 提供实现；内核用 `resolveLlmProvider()` 按**固定顺序**解析：
> 扩展点 → 兜底配置 → `null`（`:275`）。扩展点实现用 `ExtensionLlmProvider` 包装，**原样透传**调用。

存储插件应复用**同一套机制**：新增 `EXTENSION_POINTS.storageProvider`，这不是特权，是通用能力。

### 2.5 隔离插件（第三方）的硬限制

- 生产环境第三方插件**必须** `execution: 'isolated'`（`apps/api/src/lib/plugins.ts:236`）。
- 隔离插件是**独立子进程**，与宿主通过 RPC 通信（`apps/api/src/plugins/isolated/host.ts`、
  `worker.ts`），协议常量在 `protocol.ts`：
  - **单条 RPC 消息上限 `RPC_MAX_BYTES = 1 MiB`**（`protocol.ts:3`）
  - 单条 RPC 超时 `RPC_TIMEOUT_MS = 10_000`（`protocol.ts:2`）
  - 并发上限 `RPC_MAX_IN_FLIGHT = 64`（`protocol.ts:4`）
  - 二进制值经 base64 编码（`encodeWire`，`protocol.ts:33`）
- 隔离插件调用扩展点方法走 `workerProxy` → `invokeWorker('service', ...)`
  （`host.ts:517/527`），字节会整体进 RPC 消息。
- 上传上限默认 **25 MiB**（`MEDIA_MAX_UPLOAD_BYTES`，`apps/api/src/config/env.ts:69`）。

### 2.6 启动时序

`apps/api/src/server.ts:24` 在 `buildApp()` **之前**就 `await initInfra()`，而
`initInfra()`（`infra.ts:58`）会 `getStorage()` 并对 S3 调 `ensureBucket()`。
插件则在更晚的 `app.ready()` + `pluginHost.syncEnabledPlugins()`（`server.ts:61-62`）才激活。
**但**：媒体/品牌/备份路由都是在**请求时**才调用 `getStorage()`（如 `routes.ts:86` 的
`buildService()`），因此动态解析在运行期可行，只是 `initInfra()` 那一刻还拿不到插件实现。

## 三、核心矛盾

三个诉求不能同时成立：

| 诉求 | 来源 |
|---|---|
| 存储驱动**全局替换**，所有资源统一走插件 | 用户决策 |
| **任意**第三方插件都能当存储后端（外接图床/桶） | 用户决策 |
| **不得引入内核特权**（走标准扩展点） | 用户约束 |

矛盾点：**方案 A/B/C 的分界在于"字节"怎么跨进/跨出隔离插件进程**。

- 若 provider 实现必须处理字节，而它又是 isolated 插件，则一次 25 MiB 上传会被
  §2.5 的 1 MiB 单消息上限直接打死（base64 后更糟），10s 超时也扛不住大对象。
- 这不是"权限"问题，是**能力边界**的硬限制。因此我们不在字节通道上假装零成本。

**用户已选定方案 C：控制面与字节面分离。**

## 四、方案 C：扩展点只管控制面，字节走独立通道

### 4.1 分层

```
┌─────────────────────────────────────────────────────────────┐
│ 内核：AttachmentService / brand / backup（调用方，不变）        │
│         ↓ 只依赖 StorageDriver 契约（冻结，不改）              │
├─────────────────────────────────────────────────────────────┤
│ KernelStorageRouter（新增，实现 StorageDriver）                │
│   - 控制面：delete/exists/stat/list/url/signedUrl             │
│   - 字节面：put/get —— 按 provider 声明的 byteMode 路由         │
├──────────────┬──────────────────────────────────────────────┤
│ 控制面 RPC    │ 字节面（三选一，见 §4.2）                       │
│ （小消息，    │                                               │
│  走扩展点）   │                                               │
├──────────────┴──────────────────────────────────────────────┤
│ StorageProvider（插件实现，isolated 或 trusted）               │
│   - 声明 byteMode                                             │
│   - 控制操作 + 提供 byte 通道的 handle/URL                     │
└─────────────────────────────────────────────────────────────┘
```

关键：`StorageProvider` **契约与 `StorageDriver` 不同**——它不直接收/发裸字节，
只返回**字节通道的描述**；内核负责实际的字节搬运。这样隔离插件永远不接触大 buffer。

### 4.2 三种 byteMode（provider 声明其一）

| byteMode | 上传（put） | 下载（get） | 适用 | 隔离插件可用？ |
|---|---|---|---|---|
| `redirect` | provider 返回一个**预签名 PUT URL**（或一次性上传端点），内核把字节直接 PUT 出去 | provider 返回**预签名 GET URL**，API 对浏览器发 `302` | S3/R2/OSS、支持预签名的图床 | ✅ 纯控制面消息，字节不经插件 |
| `spool` | 内核把字节写进**共享临时目录**（同机子进程可读），把文件路径交给 provider；provider 读走并删除 | provider 把对象**写进共享临时目录**并返回路径，内核读取后发送 | 支持本地文件、或愿意接受路径的图床；isolated 子进程与宿主同机 | ⚠️ 需约定共享目录，且信任插件读该目录 |
| `proxy` | 内核把字节**分块流式**喂给 provider | provider 分块回流 | 自定义 HTTP 图床（无预签名能力）、trusted 内置实现 | ❌ 隔离插件需新增流式原语（见 §4.4，本期不做） |

**决策建议**：
- 内置 `storage` 插件（`stackpanel.builtin`，trusted）提供 `local` 与 `s3` 两种 provider，
  优先用 **`redirect`（S3）** 与 **`spool`（本地）**。
- 自定义 HTTP 图床：若支持预签名/一次性上传 URL → `redirect`；否则只能 `proxy`，
  而 `proxy` 需要 §4.4 的流式原语 —— **本期先不覆盖纯 proxy 的隔离插件**，
  在文档与 UI 里明确标注为"需 trusted 安装"。

### 4.3 复用现有 `signedUrl` 语义

`StorageDriver` 已经预留了下载侧的字节旁路：`signedUrl()`（`types.ts:57`）。
方案 C 的 `redirect` 下载直接落地为：`GET /media/:id/content` 在 provider `byteMode='redirect'`
且对象可公开/可签名时，改发 `302 Location: <signedUrl>`，字节零经过内核。
这与 S3 驱动 `url()` 返回直连对象 URL 的既有语义一致（`s3.ts:149`）。

> 注：现有设计"从不暴露对象 key"（`service.ts` 头注释）会被 redirect 模式部分放宽——
> 暴露的是**签名 URL**（有时效，ADR-0014 §2 已认可），不是裸 key。私有对象仍受控。

### 4.4 `proxy` 模式的流式原语（标记为二期）

若未来要让任意 isolated 插件支持 `proxy`，需给隔离宿主增加**拉取式字节流**原语，
参照现有 raw route 的 pull/backpressure 机制（`host.ts:548` 起 `RAW_CHUNK_BYTES` /
`RAW_WINDOW_BYTES` / `RAW_MAX_QUEUE_BYTES`）。这是一次 RPC 协议改造，
本期明确**不做**，登记为已知缺口。

## 五、SDK 契约

新增 `packages/sdk/src/storage.ts`：

```ts
/** 字节通道模式：provider 声明它如何收/发大对象，内核据此路由字节。 */
export type StorageByteMode = 'redirect' | 'spool'; // 'proxy' 预留，二期

export interface StorageObjectStat {
  key: string;
  size: number;
  lastModified?: string;
}

export interface StoragePutTarget {
  /** 'redirect'：内核把字节 PUT 到此 URL。 */
  uploadUrl?: string;
  /** redirect 上传需要的额外请求头（如预签名要求）。 */
  headers?: Record<string, string>;
  /** 'spool'：内核把字节写入此绝对路径后调用 confirmPut。 */
  spoolPath?: string;
}

/** 插件提供的存储后端：只处理控制面 + 字节通道描述，不直接收发裸字节。 */
export interface StorageProvider {
  readonly id: string;
  readonly name: string;
  readonly byteMode: StorageByteMode;

  /** 开写：内核据返回值决定怎么把字节送出去。 */
  beginPut(input: {
    key: string;
    contentType?: string;
    public?: boolean;
    size: number;
  }): Promise<StoragePutTarget>;
  /** 'spool' 模式：内核写完后通知 provider 字节已在 spoolPath。 */
  confirmPut?(input: { key: string; spoolPath: string }): Promise<void>;
  /** 提交完成（两种模式都调用一次，便于登记元数据 / 触发 CDN 刷新）。 */
  commitPut?(input: { key: string }): Promise<void>;
  /** 放弃本次写入（失败回滚）。 */
  abortPut?(input: { key: string }): Promise<void>;

  /** 'redirect' 下载：返回可 302 的 URL；'spool' 下载：把对象写入路径并返回。 */
  prepareGet(key: string, expiresInSeconds?: number): Promise<{ url: string } | { spoolPath: string }>;

  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  stat(key: string): Promise<StorageObjectStat | null>;
  list(prefix?: string): Promise<StorageObjectStat[]>;
  /** 浏览器可用的公开 URL（可公开对象）。 */
  url(key: string): string;
  /** 探活（健康检查用，见 §9）。 */
  ping?(): Promise<boolean>;
}
```

在 `packages/sdk/src/plugin.ts` 的 `EXTENSION_POINTS` 增加：

```ts
/** 存储后端供给：内核经此把对象存储交给插件实现（ADR-0014 扩展）。 */
storageProvider: 'storage.provider',
```

并在 `packages/sdk/src/index.ts` 导出相关类型。

**设计要点**：`StorageProvider` 刻意**不等于** `StorageDriver`。驱动是内核面向调用方的
冻结契约；provider 是插件面向内核的**控制面**契约。中间的桥接（`KernelStorageRouter`）
由内核拥有——这保证"通用机制、无特权"：任何插件实现同一个 provider 契约即可，
内核不为任何厂商加特判。

## 六、内核接入

### 6.1 `KernelStorageRouter`（`apps/api/src/storage/router.ts`，新增）

实现 `StorageDriver`，内部持有一个 `StorageProvider` + 一个兜底的 env 驱动：

```ts
class KernelStorageRouter implements StorageDriver {
  constructor(private provider: StorageProvider, private fallback: StorageDriver) {}
  readonly kind = 'provider' as const; // 新增 kind，见 §6.3
  // put: 按 provider.byteMode 走 redirect / spool，同时用 fallback 处理历史对象的读
  // get: 先问 provider.stat(key)；命中则 prepareGet；未命中回退 fallback.get(key)
  // delete/exists/stat/list/url/signedUrl: 优先 provider，未命中回退 fallback
}
```

**关键行为**：路由必须支持"provider 未命中则回退兜底驱动"，否则换后端后历史对象读不到（§10）。
兜底驱动始终是 `createStorageDriver(getInfraConfig().storage)`（即为 env 配置那套）。

### 6.2 解析顺序（对齐 `resolveLlmProvider`）

`apps/api/src/storage/resolve.ts`：

```ts
export async function resolveStorageDriver(
  runtime: { getExtensions<T>(pointId: string): T[] },
  fallback: StorageDriver,
): Promise<StorageDriver> {
  const provider = runtime.getExtensions<StorageProvider>(EXTENSION_POINTS.storageProvider)[0];
  return provider ? new KernelStorageRouter(provider, fallback) : fallback;
}
```

固定顺序：**扩展点 → env 兜底**。与 `llm-provider.ts:275` 完全一致。
只取第一个实现（同 `commerce.ts` / `llm-provider.ts` 的既有约定）。

### 6.3 `getStorage()` 改造（`apps/api/src/infra.ts`）

现状 `getStorage()` 是懒加载单例并缓存在模块级 `storage` 变量（`infra.ts:26/37`）。
插件在 `initInfra()` 之后才激活，所以需要在**插件激活后**刷新单例。

建议：

```ts
export function getStorage(): StorageDriver {
  if (!storage) storage = createStorageDriver(getInfraConfig().storage); // 兜底，行为不变
  return storage;
}

/** 由插件宿主在激活/停用 storage.provider 后调用，重建路由。 */
export function refreshStorageProvider(runtime: PluginRuntime): void {
  const fallback = createStorageDriver(getInfraConfig().storage);
  // 同步解析（getExtensions 是同步的），命中则替换单例，否则回落 env 驱动。
  const provider = runtime.getExtensions<StorageProvider>(EXTENSION_POINTS.storageProvider)[0];
  storage = provider ? new KernelStorageRouter(provider, fallback) : fallback;
}
```

`refreshStorageProvider` 在 `syncEnabledPlugins()` 之后、以及插件 activate/deactivate 的
生命周期钩子里调用（挂到与 `runtime/coherence.ts` 相同的"运行期一致性"点，使多副本一致，
参照 `server.ts:65`）。注意 worker 进程（`apps/api/src/worker.ts`）也加载同样的插件，
必须同样刷新，保证 API 与 worker 用同一个 provider。

**新增 `kind`**：`StorageDriver.kind` 目前是 `'local' | 's3'`（`types.ts:28`）。
`KernelStorageRouter` 若直接用 `'local' | 's3'` 会误导健康检查（`health.ts:45-48` 按
`kind === 's3'` 决定是否 `ping`）。建议把 `kind` 放宽为 `'local' | 's3' | 'provider'`，
并让健康检查改为"有 `ping()` 就调用"（`health.ts:46` 的 `'ping' in driver` 已是此形态）。
**这是对冻结接口的一处最小放宽**，需在评审时确认：只扩展联合类型，不改方法签名。

## 七、配置与密钥

- **配置数据**：provider 的选择与参数（endpoint、bucket、region、byteMode 偏好等）
  放**自定义模型** `storage/config`（单行），后台配置页写入。
  参照 referral 插件的 `referral/config`（`docs/design/referral-plugin.md` §4.2/§5.4）——
  因为 `PluginContext` 后端读不到插件设置 UI，两套真相会导致"改了不生效"。
- **密钥**：access key / secret 等敏感值走 `ctx.secrets`（AES-256-GCM，`plugin.ts:160`），
  **绝不**进自定义模型或日志。参照 `llm-provider.ts` 把 key 放 `Secret` 表（`:92`）的做法。
- **SSRF**：自定义图床的 endpoint 在真实请求前必须过 `@stackpanel/net-guard` 的公网地址校验，
  且 `redirect: 'error'` 不跟随重定向——完全复用 `llm-provider.ts:194/206` 的 SSRF 双闸。

## 八、内置 storage 插件

`packages/plugins/storage/`（`stackpanel.builtin = true`，因此可信、可 trusted 执行）：

- provider 实现两个内置后端：
  - `local`：`byteMode: 'spool'`，直接写服务器本地盘（等价现有 `LocalDiskDriver` 的落点）。
  - `s3`：`byteMode: 'redirect'`，用预签名 PUT/GET（等价现有 `S3Driver` 的能力）。
- 后台配置页：选择后端、填 S3/R2/OSS 参数与密钥、测试连通性（调 `ping()`）。
- **默认不启用**：未启用时 `getStorage()` 行为与今天完全一致（env 驱动），零回归。

> 注意：内置插件的 provider 会在**进程内**运行（builtin → trusted）。这与"无特权"不冲突——
> 它走的是同一个 `storage.provider` 扩展点，第三方插件若提供 `redirect`/`spool` 实现，
> 无需任何内核改动即可生效。

## 九、健康检查与可观测性

- `GET /health/ready`（`apps/api/src/routes/health.ts:44`）的 storage 检查改为：
  若当前驱动有 `ping()` 则调用（`health.ts:46` 已是 `'ping' in driver` 形态），
  否则视为 `ok`。provider 的 `ping()` 探活其上游。
- 日志：provider 替换、回退、上游错误都要带 `provider.id` 与 `key`（不含密钥）。
- 指标：沿用现有 observability（ADR-0015），新增 provider 维度的 put/get 计数与耗时（可选）。

## 十、迁移与兼容（必须写清）

换后端是**危险操作**，设计上必须防"历史对象读不到"：

1. **读回退**：`KernelStorageRouter` 在 provider 未命中时回退 env 兜底驱动（§6.1）。
   因此"先切 provider，历史对象仍由原 env 驱动服务"是安全的。
2. **不自动迁移**：本期不做在线搬迁。后台配置页在切换时明确提示：
   "历史对象仍从原存储读取，若要完全迁移请先离线复制对象到新后端。"
3. **对象 key 稳定**：key 由附件 id 决定（`media/keys.ts:76`），与后端无关，
   所以只要目标后端能按相同 key 存放，切换就是无缝的。
4. **备份完整性**：备份归档走同一存储（`backup/service.ts`），切后端后新备份落新后端，
   恢复时同理需回退能读到旧归档。

## 十一、安全边界

- 插件**不得**获得内核 `StorageDriver` 的裸句柄（那才是特权）。
  它只拿到 `StorageProvider` 契约，字节通道由内核掌控。
- `redirect` 上游 URL 必须过 SSRF 校验；签名 URL 有时效（默认 15 分钟，`s3.ts:158`）。
- `spool` 模式的共享临时目录要限定：内核给的路径是**一次性、随机、仅本次对象**的，
  且 provider 只能读该路径（内核不把它当通用文件系统能力）。
- 私有对象：`redirect` 只能用**签名 URL**，绝不返回无鉴权的直连地址；
  公开对象才允许 `url()`。

## 十二、需要产出的文件

```
packages/sdk/src/
├── storage.ts                       # StorageProvider / StorageByteMode 契约（新增）
├── plugin.ts                        # EXTENSION_POINTS.storageProvider（改）
└── index.ts                         # 导出 storage 类型（改）

apps/api/src/
├── storage/
│   ├── router.ts                    # KernelStorageRouter implements StorageDriver（新增）
│   └── resolve.ts                   # resolveStorageDriver（新增）
├── infra.ts                         # getStorage 懒加载不变 + refreshStorageProvider（改）
├── plugin-host.ts                   # 激活/停用后调用 refreshStorageProvider（改）
├── worker.ts / runtime/coherence.ts # worker 侧同样刷新（改，保证 API/worker 一致）
├── plugins/extension-points.ts      # 注册 storage.provider 为该内核扩展点（改）
├── routes/health.ts                 # storage 检查改为"有 ping 就调"（改）
└── routes/admin/storage.ts          # 后台读写配置、测试连通（新增，或由插件路由承担）

packages/db/src/storage/types.ts     # kind 联合类型放宽加 'provider'（改，最小放宽）
```

内置插件：

```
packages/plugins/storage/
├── package.json                     # stackpanel.builtin = true
├── src/
│   ├── index.ts                     # definePlugin：注册 storage.provider、路由、模型
│   ├── providers/local.ts           # spool 本地盘
│   ├── providers/s3.ts              # redirect 预签名 S3/R2/OSS
│   ├── config.ts                    # storage/config 模型读写
│   └── secrets.ts                   # ctx.secrets 密钥封装
└── frontend/                        # 后台配置页（选后端、填参、测试）
```

## 十三、实施顺序（建议）

1. **SDK 契约 + 扩展点声明**（`storage.ts` / `plugin.ts` / `index.ts`）——纯类型，可独立评审。
2. **`KernelStorageRouter` + `resolveStorageDriver` + `kind` 放宽**——带单测（路由、回退、byteMode）。
3. **`getStorage()` 动态刷新 + 生命周期接线**（API 与 worker 都要）——验证未装插件时零回归。
4. **健康检查改造**。
5. **内置 storage 插件后端**（先 `local` spool，再 `s3` redirect）。
6. **后台配置页 + 测试连通 + 密钥加密**。
7. **端到端验证**：上传→变体→下载→删除→备份/恢复，分别覆盖 local / s3 / 自定义图床。

## 十四、未决与风险

| 项 | 说明 | 建议 |
|---|---|---|
| `proxy` 隔离模式 | 无预签名能力的自定义图床无法在 isolated 下工作 | 本期不做；需 §4.4 流式原语，另开 ADR |
| `kind` 放宽 | `StorageDriver.kind` 是冻结接口的一部分 | 只加联合类型成员，不改签名；评审确认 |
| API/worker 一致性 | 两个进程都要刷新 provider，否则变体落错后端 | 接线到 coherence 点，加集成测试 |
| redirect 暴露签名 URL | 与"从不暴露对象 key"的旧注释冲突 | 更新 `service.ts` 头注释，明确"暴露的是签名 URL 而非裸 key" |
| 单 provider 限制 | 只取第一个实现，无法按资源路由 | 本期单后端；多后端留待需求 |
| spool 目录信任 | isolated 子进程读宿主临时目录 | 路径一次性随机、限定生命周期；文档标注信任边界 |
| 密钥轮换 | 换 key 后旧密文不可解 | 沿用 `ctx.secrets` 既有语义，不新增 |

## 十五、落地实况（与上文的偏差）

实施时对方案做了两处收敛，均已通过单测与边界守护：

1. **内核能力 `ctx.storage`，而非让插件 import `@stackpanel/db`。**
   最早的实现让内置插件直接复用 `@stackpanel/db` 的 `S3Driver`/`LocalDiskDriver`，
   被 `boundary-guard` 测试判为「插件耦合裸 DB」并失败——这正是 ADR-0008 要禁止的
   内核特权。最终改为内核暴露一个**无特权能力** `ctx.storage.backend(spec)`（与
   `ctx.wallet` 同级），由内核侧构造并持有 S3/本地盘的字节与预签名机制；插件只做
   「配置 → 通用后端规格」的翻译。隔离插件经 `storage.backend`/`storage.invoke`
   能力走 IPC 拿到一个**远程序** provider 代理，参数与返回都不含字节。

2. **字节通道由 `beginPut` 的返回**推断，而非 provider 的静态 `byteMode` 字段。**
   这让 provider 能在运行期切换 local/s3 而无需内核重新解析扩展点；`byteMode` 仅作元数据。
   `spool` 的「provider 拥有路径」与「内核临时文件」两种情形分别处理，避免误删就地写入的对象。

实际落地的文件：

```
packages/sdk/src/storage.ts            # StorageProvider / StorageBackendSpec / StorageService（新增）
packages/sdk/src/plugin.ts             # EXTENSION_POINTS.storageProvider + ctx.storage（改）
packages/sdk/src/index.ts              # 导出 storage 类型（改）

apps/api/src/storage/provider-router.ts  # KernelStorageRouter + resolveStorageDriver（新增）
apps/api/src/storage/backend.ts          # 内核通用后端工厂（ctx.storage 的实现，新增）
apps/api/src/infra.ts                    # getStorage 动态解析 + setStorageRuntime/refreshStorageDriver（改）
apps/api/src/plugin-host.ts              # 绑定 runtime + 订阅 plugin.activated/deactivated 刷新（改）
apps/api/src/plugins/extension-points.ts # 注册 storage.provider（改）
apps/api/src/plugins/runtime.ts          # ctx.storage 注入（改）
apps/api/src/plugins/isolated/host.ts    # storage.backend/invoke/release 能力桥（改）
apps/api/src/plugins/isolated/worker.ts  # ctx.storage 远程序代理（改）
apps/api/src/routes/health.ts            # storage 检查改为"有 ping 就调"（改）
packages/db/src/storage/types.ts         # kind 加 'provider'（改）
packages/db/src/storage/s3.ts            # 新增 signedPutUrl（redirect 上传预签名，改）

packages/plugins/storage/                # 内置插件：providers/config/data/context/errors/index
packages/plugins/storage/frontend/       # 后台配置页（admin.tsx 客户端表单 + finder）
apps/api/tests/unit/storage-router.test.ts  # 路由/回退/通道/密钥安全单测（新增）

docs/adr/ 当前不存在；本扩展点建议补 ADR-0018（存储提供方扩展点），与本文互为索引。
```

### 已验证

- `storage-router.test.ts`：9 项全过（spool 就地写入、redirect PUT、失败回滚、
  空目标回退 env、读回退、spool 读、非法 key 拒绝、解析器选择）。
- `boundary-guard.test.ts` / `builtin-plugins.test.ts`：插件边界与内置清单派生全过。
- `packages/db` 存储测试 14 项全过；`plugin-storage` typecheck/lint 干净。
- 未装插件时 `resolveStorageDriver` 返回 env 驱动，热路径零回归。

### 真实端到端验证（`apps/api/tests/integration/storage-plugin.test.ts`）

上面都是单测（假 provider + 内存驱动）。另有一份**真机集成测试**：`buildApp()`
真启动内核 → `registerPlugins()` 播种内置插件 → `pluginRuntime.activate('storage')`
→ 经插件自己的 `/storage/admin/config` 表单改后端 → 真跑 `/media` 上传，断言字节确实
落在**插件后端**而非 env 默认后端。两个后端都覆盖：

| 用例 | 断言 | 结果 |
|---|---|---|
| local：换后端 | 上传后对象出现在插件 root、**不在** env root；`/media/:id/content` 字节一致 | ✅ |
| local：provider 执行 | 每次 put/delete 都经 provider（零拷贝 spool）；插件 root 文件数增长 | ✅ |
| env：让位 | `kind=env` 时对象回到 env root | ✅ |
| 历史读回退 | env 写入 → 切到全新空插件 root → 老对象仍 200 且字节一致 | ✅ |
| S3（真 MinIO） | 预签名 PUT 上传后，用**独立 S3Driver** 在桶里查到对象、字节一致，`/media` 回读一致 | ✅ |
| 权限 | 匿名 401、无 `storage.admin` 403、管理员 200；GET 不泄露密钥 | ✅ |

**这份测试抓到两个真 bug（单测没覆盖到）：**

1. `ctx.secrets` 的密钥名 `s3.accessKeyId` 含大写，被内核
   `PLUGIN_SECRET_KEY=/^[a-z0-9][a-z0-9._-]{0,63}$/` 拒绝，`kind=env` 保存配置时
   500。**已修**为全小写 `s3.access-key-id` / `s3.secret-access-key`
   （`packages/plugins/storage/src/config.ts`）。这正是「换后端 = 让位 env」这条
   主路径，单测因 mock 掉了 secrets 而漏掉了。
2. 真实字节链路（`/media` → 插件 provider → 预签名 URL → MinIO）此前从未跑过；
   本次证明控制面/字节面分离在真机成立。

复跑命令：

```
# local + 权限 + 历史读回退（无需外部服务）
pnpm --filter @stackpanel/api exec vitest run tests/integration/storage-plugin.test.ts

# 追加 S3（需一个可达的 MinIO/S3；默认跳过）
STORAGE_PLUGIN_S3_ENDPOINT=http://127.0.0.1:19000 \
STORAGE_PLUGIN_S3_BUCKET=sp-test \
pnpm --filter @stackpanel/api exec vitest run tests/integration/storage-plugin.test.ts
```

### 仍未做（诚实边界）

- **隔离（isolated）插件的存储 provider**：worker 侧的远程序代理已在真 worker 进程
  中验证（`isolated-rpc.test.ts` 新增 `/storage` 用例：`ctx.storage.backend` →
  `storage.backend` IPC → 拿回 `{token, methods, values}` 句柄 → `beginPut`/`stat`
  经 `storage.invoke` 回内核）。但**内核 host 端的 `storage.backend/invoke` 处理器**
  在该测试中是协议桩（按协议应答），未跑真实 `createStorageService`；且**没有**把
  一个真隔离 provider 注册到扩展点、再由内核 router 消费的端到端。内置 storage 插件
  是 trusted，走的是进程内路径，不经过这座桥。
- **proxy 模式**（无预签名能力的自定义图床）本期不做。
- **多副本一致性**：只测了单进程；API/worker 两侧刷新驱动未做跨进程验证。
- **前端配置页**只做了 `build:frontend` 产物生成，未在浏览器点过。


