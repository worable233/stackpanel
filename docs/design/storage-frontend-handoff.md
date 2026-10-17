# 存储插件前端交接文档

> 目的：把「存储类插件」的**前端**部分交接给另一个会话继续做。
> 后端与契约已端到端落地并验证（见 `docs/design/storage-provider-plugin.md`），前端已有一个可用的管理页骨架；本文说明**现状、契约、落点、待办与验收方式**。

---

## 1. 一句话背景

站长可在后台把对象存储从内核默认驱动切换为：

- **服务器本地盘**（`local`）
- **S3 兼容存储**（MinIO / R2 / OSS / AWS，`s3`）
- **自定义 HTTP 图床**（无预签名，走内核分块 proxy 通道，`http`）
- 或**跟随环境变量**（`env`，插件不接管）

切换后，媒体/品牌/备份的**新对象**统一走此后端；历史对象靠读回退兜底，不做在线迁移。

前端只负责**一个管理页**：配置后端类型与参数、保存、错误提示。字节面（上传/读取）全部在后端，前端不碰。

---

## 2. 已存在的文件与职责

| 文件 | 作用 |
| --- | --- |
| `packages/plugins/storage/frontend/src/index.tsx` | 前端包入口：声明 `finders` + `ui.adminRoutes` + `ui.actions`（保存动作）。**元数据声明**，无交互逻辑。 |
| `packages/plugins/storage/frontend/src/admin.tsx` | `'use client'` 交互式管理页组件（`adminPages['admin/storage']`）。表单本体在这里。 |
| `packages/plugins/storage/frontend/src/schemas.ts` | finder 响应 zod schema（`adminConfigSchema`）。**必须与后端 `toView` 逐字对齐**。 |
| `packages/plugins/storage/frontend/manifest.json` | **生成物**，不要手改。由 `scripts/build-frontend.mjs` 依据编译产物 + `frontend` 导出重建。 |
| `packages/plugins/storage/frontend/dist/{index,admin}.js` | **编译产物**。改完 `src/*` 必须重新构建。 |

后端契约来源：

- `packages/plugins/storage/src/index.ts`：路由 `GET/POST /storage/admin/config`、`POST /storage/admin/test`，以及 `toView()`（响应字段的唯一真相）。
- `packages/plugins/storage/src/data.ts`：配置模型与默认值。

---

## 3. 数据/接口契约（别再猜，照这个来）

### 3.1 读取配置 — finder `storage.adminConfig`

- 前端：`ctx.api.get('/storage/admin/config', adminConfigSchema)`
- 经 BFF 转发到内核，自动带插件命名空间（后端路由实际前缀 `/storage/...`）。
- 页面通过 `ui.adminRoutes[].data` 声明：`{ finder: 'storage.adminConfig', as: 'storageConfig' }`，
  运行时从 `props.data.storageConfig` 取。

响应（`toView`，密钥永不下发）：

```ts
{
  config: {
    kind: 'env' | 'local' | 's3' | 'http';
    localRoot: string;
    s3Endpoint: string;
    s3Region: string;
    s3Bucket: string;
    s3ForcePathStyle: boolean;
    publicBaseUrl: string;
    httpUploadUrl: string;
    httpPublicBaseUrl: string;
    httpMethod: 'PUT' | 'POST';
    httpFieldName: string;
    httpHeaders: string;              // 多行文本，每行 "Header: value"
    httpDeleteUrlTemplate: string;
    hasCredentials: boolean;          // 是否已存过 S3 密钥
    secretsAvailable: boolean;        // 内核是否配了 SETTINGS_ENCRYPTION_KEY
  }
}
```

> ⚠️ **对齐铁律**：`schemas.ts` 的 `adminConfigSchema`、后端 `toView()`、`data.ts` 默认值三者字段必须完全一致。
> BFF 的 finder 会 `schema.parse`，多/少一个字段页面就读不到数据。

### 3.2 保存配置 — action `storage.save-config`

- `POST /storage/admin/config`，权限 `storage.admin`。
- 表单字段即 action `input`（见 `index.tsx`，与 `manifest.json` 的 `actions[0].input` 一致）。
- 关键字段名：`kind`、`localRoot`、`s3Endpoint`、`s3Region`、`s3Bucket`、`s3ForcePathStyle`、
  `publicBaseUrl`、`httpUploadUrl`、`httpPublicBaseUrl`、`httpMethod`、`httpFieldName`、
  `httpHeaders`、`httpDeleteUrlTemplate`、`accessKeyId`、`secretAccessKey`。
- **密钥写入即不可读回**：`accessKeyId` / `secretAccessKey` 只写不读。留空 = 不修改（后端 `?? current`）。
- 保存前后端会用候选配置构造 provider **校验**（SSRF/元数据端点会在此 422 硬拒）；
  `ensureReady?()`（建桶等）失败只 warn，不阻塞保存，首写重试。
- 错误码：`400` 无效配置；`409` 密钥存储不可用（未配 `SETTINGS_ENCRYPTION_KEY`）；`422` 后端不可用。

### 3.3 连接测试 — `POST /storage/admin/test`（**目前前端未接**）

- 返回 `{ ok: boolean, error?: string }`，永不抛。
- 便于做「测试连接」按钮。**待办项**。

### 3.4 action 执行语义（**关键，决定怎么做反馈**）

页面 URL 是 `/admin/plugin/storage/storage`（即 `/admin/plugin/{pluginId}/{route.path}`），
导航项由 `ui.adminRoutes[].nav`（label 存储 / group 系统 / order 100）生成。

插件 action 的执行器是服务端 action（`apps/web/src/lib/frontend-plugin-action-executor.ts`），
**它不是返回值的**，而是：

- **成功**：`revalidatePath(returnPath)` 刷新当前路由数据，页面**静默刷新**（`Promise<void>` 兑现，不 redirect）。
  → 目前存储页保存成功后用户看不到任何「已保存」提示。
- **失败**：`redirect(`${path}?action=<id>&error=<message>`)`。宿主页
  （`app/(admin)/admin/plugin/[pluginId]/[...slug]/page.tsx` + `components/admin-plugin-page.tsx`）
  会把 `?error=` 渲染成一个 **destructive 横幅 alert**，位于插件组件**上方**。

所以：

- **错误提示已由宿主提供**（400/409/422 都会以 `error` 横幅出现），前端**无需**自己解析错误——
  但错误文案来自后端 / BFF 的 `apiErrorMessage`。
- **成功提示需要前端自己做**：因为成功后只是 `revalidatePath` + 静默兑现。
  可行做法：用 `useActionState`/`useFormStatus` 包一层，在提交后本地置一个「已保存」态；
  但注意 `redirect` 会 reject server-action promise，**不要**用 `await action(formData)` 的 try/catch
  去判失败（见 executor 源码 L70–80 的注释与 `INTERFACES.md §3.4`）。判断是否成功最稳妥的方式是
  观察 `props.data` 是否刷新（配置回显与表单一致），或比较提交前后配置值。

---

## 4. 前端渲染管线（构建/注册机制）

理解这套机制，改前端才不会踩坑：

1. 运行根 `node scripts/build-frontend.mjs`：
   - 用 esbuild 编译 `frontend/src/index.tsx` → `dist/index.js`；
   - 若存在 `src/admin.tsx`，额外编译 → `dist/admin.js`（客户端交互组件）；
   - 生成 `manifest.json`（含 `revision`、`files`、`pages`、`finders`、`adminRoutes`、`actions`）；
   - 把产物拷到 `data/plugins/storage/frontend/`，并重生成 `apps/web/src/lib/frontend-registry.ts` 与
     `frontend-client-registry.ts`。
2. 服务端渲染：`frontend-registry.ts` 按 `plugins/storage` 键拿到 `frontend` 导出（`default`），
   渲染 `pageComponents`/`finders`。
3. 客户端交互：`frontend-client-registry.ts` 按同一键拿到 `dist/admin.js` 的 `adminPages`，
   用于 `'use client'` 页面。
4. **外部依赖靠 `--external`**：`react`、`react-dom`、`next/*`、`@stackpanel/sdk`、`@stackpanel/ui`、
   `zod`、`lucide-react` 都是外置的（见 `scripts/build-frontend.mjs`）。这些必须在 web app 的
   `node_modules` 可解析。

**因此：**

- 用手改 `manifest.json` / `dist/*` **无效**——会被重建覆盖。
- 用 `packages/plugins/storage/frontend/package.json` 的 `build`（tsup）只产 `dist`，**不产 manifest，
  也不拷到 `data/`**。正式构建一律用根 `scripts/build-frontend.mjs`。

---

## 5. 当前页面长什么样（`admin.tsx`）

- `KIND_OPTIONS`：`env` / `local` / `s3` / `http` 四个下拉项。
- `ConfigForm`：`useState(config.kind)` 控制条件渲染分支：
  - `env`：提示「由内核环境变量决定，本插件不接管」。
  - `local`：`localRoot`（本地根目录）、`publicBaseUrl`（公开访问前缀）。
  - `s3`：`secretsAvailable === false` 时顶部黄条警告「密钥存储不可用」；`s3Endpoint`、`s3Region`、
    `s3Bucket`、`s3ForcePathStyle`（Path-style/Virtual-hosted 下拉）、`accessKeyId`、`secretAccessKey`
    （`type=password`，`hasCredentials` 时 placeholder「已配置（留空则不修改）」）、`publicBaseUrl`。
  - `http`：说明文案 + `httpUploadUrl`、`httpPublicBaseUrl`、`httpMethod`（PUT/POST）、`httpFieldName`、
    `httpHeaders`（`<textarea>` 每行一个）、`httpDeleteUrlTemplate`。
- 表单 `<form action={action}>`，`action = props.actions?.['storage.save-config']`；无 action 时显示
  「当前无法保存配置（缺少权限或未登录）」。
- `StorageAdminPage`：从 `props.data.storageConfig` 取配置，配 `PageHeader`。
- UI 组件来自 `@stackpanel/ui`：`Button/Card/CardContent/CardDescription/CardHeader/Input/Label/
  PageHeader/SectionTitle/Select`；图标来自 `lucide-react`。

### 页面 URL 与宿主渲染

- 访问 URL：`/admin/plugin/storage/storage`（`/admin/plugin/{pluginId}{route.path}`）。
- 导航项来自 `ui.adminRoutes[].nav`：label「存储」、group「系统」、order 100。
- 宿主链路（如需深入）：`app/(admin)/admin/plugin/[pluginId]/[...slug]/page.tsx` →
  `components/admin-plugin-page.tsx`（客户端，从 `frontend-client-registry.ts` 取 `admin.js` 的
  `adminPages[component]`）→ 你的 `StorageAdminPage`。
- `data` 由 `lib/admin-frontend.ts` 的 `resolvePluginAdminRoute` 用 finder 解析后传入；
  `actions` 由 `lib/frontend-plugin-actions.ts` 绑定（§3.4）。

---

## 6. 待办（这是交接的主体）

按优先级：

### P0 — 保存反馈与校验

1. **保存成功提示**：失败已有宿主 `?error=` 横幅（§3.4），**只需补成功态**。
   - 简单做法：提交后本地置「已保存」文案若干秒；或对比 `props.data.storageConfig` 与表单值是否
     已同步（`revalidatePath` 会刷新 finder 数据）来判断成功。
   - ⚠️ **不要** `try { await action(formData) } catch` 判失败：`redirect`（失败路径）会让
     server-action promise reject，而成功路径是静默兑现——直接 await+catch 会把「重定向刷新」
     误判成错误。参见 `frontend-plugin-action-executor.ts` L70–80 的注释。
2. **前端前置校验**（提交前，给出即时反馈，减少一次 `error` 往返）：
   - `kind==='s3'`：`s3Bucket` 必填、`s3Endpoint` 若填写需为 http(s) URL。
   - `kind==='http'`：`httpUploadUrl`、`httpPublicBaseUrl` 建议必填并校验 http(s) 前缀
     （内核仍会兜底 SSRF，但前端即时反馈体验更好）；`httpMethod==='POST'` 时 `httpFieldName`
     建议非空（后端有默认值，可不强制）。

### P1 — 连接测试按钮

- 接 `POST /storage/admin/test`（§3.3）。注意该路由**尚未**在前端 `ui.actions`/`manifest.actions` 里声明，
  要先在 `frontend/src/index.tsx` 的 `ui.actions` 增加一条 action（id 如 `storage.test-connection`，
  method `POST`、path `/storage/admin/test`、permission `storage.admin`、无需 input），重建后
  `props.actions['storage.test-connection']` 才可用。
- 加「测试连接」按钮 + loading + 成功/失败文案。
- 该接口读**已保存**的配置，所以按钮语义是「测试当前生效配置」，不是「测试表单里未保存的内容」——
  文案要说清楚，或在 UI 上先保存再测试。

### P2 — 体验完善

- **密钥清除**：目前无法通过 UI 清空已存的 S3 密钥（只有切到 `env` 会清）。如需支持，需后端配合加显式
  「清除密钥」语义，**不要**用「留空」表达清除（留空=不修改）。
- **`httpHeaders` 编辑体验**：多行 textarea 够用；若想更友好可做键值行编辑器，但要保证序列化回
  「每行 `Header: value`」的字符串格式（后端按行解析）。
- **国际化**：本插件文案目前是中文硬编码。若项目有 i18n 约定，补 `locales`（见 `FrontendPackage.locales`）。
- **响应式**：表单已用 `sm:grid-cols-2`，窄屏检查一遍。

### 验收方式（务必真机点一遍，不要只靠单测）

1. `node scripts/build-frontend.mjs`（确保 `plugins/storage` 出现在构建日志里）。
2. 起开发环境（web + api），后台进入「系统 → 存储」页。
3. 依次切换 `env/local/s3/http`，确认字段显隐正确。
4. 保存 `local` → 成功；保存 `s3` 且未配 `SETTINGS_ENCRYPTION_KEY` → 应见黄条 + 保存密钥时 409。
5. 填 `http` 指向 `http://127.0.0.1:19000`（或本地图片服务）→ 保存成功。
6. （P1 做后）点「测试连接」看返回。

---

## 7. 约束与坑（务必读）

- **不要手改生成物**：`manifest.json`、`frontend/dist/*`、`apps/web/src/lib/frontend-*.ts` 都是生成物。
- **改完必须重建**：`node scripts/build-frontend.mjs`；否则页面加载的还是旧 `dist`。
- **`revision`/`files` 是产物哈希**：每次重建都会变，属正常。
- **`schemas.ts` 必须与后端 `toView()` 逐字对齐**（§3.1 铁律）。
- **外部依赖白名单**：新增 npm 依赖前先看 `scripts/build-frontend.mjs` 的 `--external` 列表——
  不在列表里的会被打进 bundle，可能与 web app 的 React/实例不一致。优先用 `@stackpanel/ui` 已有组件。
- **密钥字段只写不读**：`accessKeyId`/`secretAccessKey` 永远不会出现在响应里，别指望回显。
- **`ctx.api` 前缀**：前端用 `/storage/...`（插件相对路径），BFF 负责加命名空间；不要手写内核绝对前缀。
- **权限**：页面与 action 都要 `storage.admin`；`roleTemplates` 里 `ADMIN` 已带该权限（后端已声明）。

---

## 8. 相关文件速查

```
packages/plugins/storage/
├── frontend/
│   ├── src/
│   │   ├── index.tsx      # 前端包入口（finders + ui.adminRoutes + ui.actions）
│   │   ├── admin.tsx      # 'use client' 管理页组件（表单本体）
│   │   └── schemas.ts     # finder 响应 zod schema
│   ├── manifest.json      # 生成物
│   └── dist/              # 生成物
└── src/
    ├── index.ts           # 后端路由 + toView()（契约真相）
    ├── data.ts            # 配置模型 + 默认值
    └── providers.ts       # 动态 provider（proxy 委派）

packages/sdk/src/
├── frontend.ts            # AdminPageComponentProps / FinderProvider / FrontendPackage / actions
└── storage.ts             # 存储 provider 契约（前端不直接用，但了解语义有帮助）

apps/web/src/
├── lib/frontend-plugin-actions.ts          # 插件 action 绑定（§3.4）
├── lib/frontend-plugin-action-executor.ts  # action 执行语义：成功静默、失败 redirect ?error=
├── lib/admin-frontend.ts                   # admin 路由解析 + finder 执行
├── lib/frontend-client-registry.ts         # 生成物：客户端 admin 注册
├── lib/frontend-registry.ts                # 生成物：服务端注册
├── components/admin-plugin-page.tsx        # 宿主：渲染 actionError 横幅 + 插件组件
└── app/(admin)/admin/plugin/[pluginId]/[...slug]/page.tsx  # admin 路由页面

scripts/build-frontend.mjs # 构建入口（编译 + 生成 manifest + 注册）
docs/design/storage-provider-plugin.md       # 后端设计与验证记录
```

---

## 9. 交接边界

- **本文只覆盖前端**。后端（proxy 分块通道、SSRF 守卫、三后端工厂、隔离桥）已在
  `docs/design/storage-provider-plugin.md` 落地并验证，前端如需配合改动请在该文档对应章节确认。
- 本任务全部改动**尚未提交**；接手时先确认工作树里存储相关改动的范围，避免把无关 WIP 一起提交。

## 10. 本轮前端实现（2026-10-17）

按用户确认，存储现在位于 **系统设置 → 存储**，独立入口兼容跳转到该分区。

- SDK 的 `ui.adminRoutes[]` 新增可选 `systemSettings: { label, order? }`，其他插件也可用相同声明接入。
- 宿主只加载已启用插件的静态配置路由，并复用原有 permission、finder 和 action 绑定；不再为该路由生成独立全局菜单。
- 分区 hash 按插件 ID 与完整路径隔离：`/admin/settings#plugin-storage-%2Fstorage`。
- 嵌入时传 `AdminPageComponentProps.embedded`，插件应隐藏独立页面大标题，保留表单分组。
- action 在系统设置中保存后刷新 `/admin/settings`；失败保留分区 hash 并显示宿主错误反馈。
- 表单支持四种后端、分组字段、前置校验、保存中/已保存反馈、已保存配置连接测试，以及深浅色和移动端布局。
- 已声明 `storage.test-connection`；测试通过通用插件 BFF 读取 `{ok,error}`，不会把 HTTP 200 / `ok:false` 当成功。测试有未保存修改时禁用。
- 文本配置字段声明 `default: ''`，明确允许清空；密钥不声明空默认值，留空仍表示不修改。非 S3 后端不提交访问密钥。
- 连接测试只证明后端提供的 `ping` 结果；不等于完整上传、读取、删除链路已验证。

通用接入示例：

```tsx
ui: {
  adminRoutes: [{
    path: '/config',
    component: 'admin/config',
    permission: 'your-plugin.admin',
    systemSettings: { label: '配置名称', order: 100 },
    data: [{ finder: 'your-plugin.config', as: 'config' }],
  }],
}
```

页面和数据仍由插件维护；没有把存储业务配置写入内核设置表。
