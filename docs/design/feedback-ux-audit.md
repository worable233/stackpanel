# 操作反馈体验审计与统一方案

> 审计范围：内核 Web（`apps/web`）+ 6 个内置插件前端 + 10 个外部插件前端。
> 结论：**反馈体系不是「没做好」，而是根本没有统一契约**——同一件事在项目里有 5 种呈现方式，
> 其中一种（插件 `sonner`）在宿主里**永远不会显示**。

## 0. 一句话结论

| 指标 | 现状 |
| --- | --- |
| 内核 `toast.*` 调用 | 17 处 |
| 内核内联 `role="alert"` / `setError` | 19 / 40 处 |
| 内置插件 `setError` | 28 处 |
| 外部插件 `setError` | 37 处 |
| 声明了 `successFeedback` 的插件 action | **1 / 40**（只有 `zjmf-upstream.sync`） |
| 拥有 i18n catalog 的外部插件 | **1 / 10**（只有 referral） |
| 写了 `import { toast } from 'sonner'` 的插件 | 3 个（login / smtp / epay），**全部不显示** |

---

## 1. P0 — 功能性缺陷（不是体验问题，是坏的）

### 1.1 插件 `sonner` toast 永远不渲染

`sonner` **不在**宿主 ABI 槽里（`packages/spec/src/frontend-abi.ts:29-39`），
构建时被 esbuild 打进插件自己的 bundle，于是插件拿到的是**另一份** `ToastState`，
和宿主 `<Toaster />`（`apps/web/src/app/layout.tsx:83`）没有任何连接。

证据：`packages/plugins/login/frontend/dist/admin.runtime.js` 内含 13 处 `ToastState`，
并从 `/api/frontend-abi/react` 导入 React——即插件自建了第二个 React toast store。

受影响：`login/frontend/src/admin.tsx:22,25`、`smtp/frontend/src/index.tsx:29,30`、
`epay/frontend/src/admin.tsx:67,70,73`。用户看到的：**点保存后毫无反应**。

### 1.2 三个插件把插件 id 重复拼进路径 → 必然 404

BFF 约定是 `/api/plugins/<内核绝对路径>`（`apps/web/src/app/api/plugins/[...path]/route.ts:19-31`），
插件 id **不是**路径前缀。但：

| 前端调用 | 内核实际路由 | 结果 |
| --- | --- | --- |
| `/api/plugins/login/login/admin/config` | `/login/admin/config` | 404 |
| `/api/plugins/smtp/smtp/admin/config` | `/smtp/admin/config` | 404 |
| `/api/plugins/smtp/smtp/admin/test` | `/smtp/admin/test` | 404 |

**SMTP 配置根本存不进去**，而且因为 1.1，连报错都看不到。

### 1.3 ticket 工单页整页崩溃

`packages/ui/src/ticket-workspace.tsx:151` 把 `labels` 定义为**必填**，但
`ticket/frontend/src/index.tsx:122,126,130` 与 `admin.tsx:36,59` 都没传。
运行时 `labels.statuses` 抛 `TypeError`，被
`apps/web/src/components/runtime-admin-page.tsx:113-115` 捕获后把
**原始英文异常**直接渲染到页面上。

### 1.4 长错误被静默吞掉

`apps/web/src/components/action-feedback-toaster.tsx:8,23,28`：`?error=` 超过 256 字符
**直接丢弃**。store 的 `approvalErrorMessage` 经常超过这个长度，
于是「对账失败 / 恢复失败」这类最需要解释的失败**什么提示都没有**。

### 1.5 通知已读操作静默失败

`notification-bell.tsx:107-116` 与 `notification-inbox.tsx:121-138` 都不检查 `response.ok`，
`catch {}` 直接忽略，然后**本地乐观地标记为已读**。服务端失败时界面显示已读，
刷新后又变回未读——用户会认为系统丢数据。

---

## 2. P1 — 原始技术文本泄漏给用户

### 2.1 根因：`apiErrorMessage` 的兜底就是原文

```ts
// apps/web/src/lib/api-errors.ts:31,39
return lookupTranslation(locale, `error.${error.code}`) ?? (error.message || resolvedFallback);
...
if (error instanceof Error && error.message) return error.message;
```

`error.<code>` 只覆盖了 17 个顶层分组，插件/业务码大量缺失，于是回落到服务端英文
`title`/`detail`，最终用户看到 `fetch failed`、`Internal Server Error`、`SignatureDoesNotMatch`。

### 2.2 12 个文案模板主动把 `{error}` 拼进去

`apps/web/src/i18n/messages/zh-CN.json` 中 12 处 `"XX服务不可用：{error}"`，
典型输出：**「日志服务不可用：fetch failed」**。

涉及页面：audit、themes、plugins、settings、updates、developer、developer/webhooks、
developer/audit、developer/resellers/[id]、plugins/[id]、notification、rbac。

### 2.3 插件侧同样的路径

| 文件 | 现象 |
| --- | --- |
| `packages/plugins/storage/src/index.ts:142` | 测试连接把 AWS SDK 原文当 `error` 返回 → `getaddrinfo ENOTFOUND` |
| `store/frontend/src/admin.tsx:626-627` | `setError(cause.message)`，上游英文直出 |
| `epay/frontend/src/admin.tsx:217-223` | `body.detail` 原文 + `保存失败（${body.code}）` |
| `cms/frontend/src/admin.tsx`（11 处） | `setError(e.message ?? "加载失败")` |
| `zjmf-upstream/frontend/src/instances.tsx:112-120` | 直接渲染上游 `error.message`（可能含 HTML） |

### 2.4 渲染边界把异常当文案

`frontend-render-boundary.tsx:24,35-37`、`runtime-admin-page.tsx:60-62,113-115`、
`pluginPage.loadFailed` 模板：React 崩溃信息 / JSON 解析错误原样上屏。

---

## 3. P2 — 反馈缺失（成功无回执、失败无原因）

### 3.1 成功几乎从不确认

40 个插件 action 里只有 1 个声明了 `successFeedback`。所有 `form action={...}`
成功后只有 `revalidatePath` 带来的数据变化，用户无法确认操作是否生效，于是**重复提交**。

高风险例子：
- `store-wallet` 取消充值单（`index.tsx:284-291`）——无确认、无 pending、无回执。
- `referral` 调账（`admin.tsx:244,305`）——资金操作，无 pending、无回执。
- `llm-gateway` 删除上游账号 / API Key（`admin.tsx:257-267`、`index.tsx:871-881`）——无二次确认。
- `invoice` 删除发票（`admin.tsx:1294-1302`）——裸 form，误点即删。
- `notice` 删除公告（`admin.tsx:107-117`）——同上。
- `catalog` 拖拽排序（`admin.tsx:359-370`）——`void` 火并即忘，失败无感知。
- 内核 `theme-manager.tsx:140-148` 删除主题——无确认、无反馈。

### 3.2 失败只有「失败」两个字

`catch { setError(tr('settings.store.failed')) }` 之类，丢失 `cause`，用户不知道
是权限、网络还是数据冲突。

### 3.3 内核里最危险的静默

| 文件 | 现象 |
| --- | --- |
| `users-manager.tsx:171-183` | 启停用户 / 代登录**丢弃** action 返回的 `{error}`，失败完全静默 |
| `plugin-manager.tsx:55-64` | 启停/删除插件丢弃返回值，成功失败都无提示 |
| `theme-manager.tsx:42-49,104-112` | 退出预览/预览无 try-catch；预览失败**仍跳转** `/preview` |
| `cart-checkout.tsx:327-335` | `try/finally` 无 `catch`，结算失败无提示 |
| `currency-settings.tsx:126-136` | 切换币种成功无回执 |
| `oauth/.../callback/route.ts:65` | 登录失败重定向 `?error=oauth`，但 `login/page.tsx` **不读**该参数 |

---

## 4. P3 — 重复与过度提示

| 文件 | 现象 |
| --- | --- |
| `notification-settings.tsx:133-135` | 同一错误同时 `setError` + `toast.error` |
| `frontend-route.tsx:89-98` + `action-feedback-toaster.tsx` | 插件 action 失败既顶部红条又 toast |
| `llm-gateway/frontend/src/admin.tsx:476-485` | `await action()` 后 catch 兜底，与宿主 toast 重复 |
| `store/frontend/src/admin.tsx:1506-1514` | 自建 `showFeedback` 往 URL 塞原文，重复实现宿主能力 |

---

## 5. P4 — i18n 与枚举泄漏

- 外部插件 10 个里 9 个没有 catalog，TSX 内硬编码中文（catalog 22 行、cms 109 行、
  invoice 94 行、llm-gateway 107 行、zjmf-upstream 82 行）。
- 枚举原样上屏：`store-wallet/index.tsx:265` 输出 `PENDING`/`SUCCEEDED`；
  `store/index.tsx:1747` 输出 `out_of_stock`；`store/admin.tsx:1631` 输出 `row.state`；
  `ticket/admin.tsx:84` 输出 `OPEN`（而列表页显示「待处理」）。
- 金额单位错误：`store/admin.tsx:1627` 直接渲染 minor units（`5000 CNY` 而非 `50.00 CNY`）。
- 缺 key：`settings.store.refunds`（store 侧边栏显示原始 key）、market `settings.*` 18 个键。
- `scripts/scan-i18n-literals.mjs` 当前报告 55 处新字面量（baseline 为 0），说明这个门禁
  现在**是红的**。

---

## 6. 统一方案

### 6.1 反馈三层契约（写进文档并加守门测试）

| 场景 | 通道 | 要求 |
| --- | --- | --- |
| mutation 成功/失败 | **toast** | 一句结论 + 可选一行原因；不阻塞页面 |
| 字段校验 | **inline** | 紧贴字段，`aria-invalid` + `role="alert"` |
| 页面级加载失败 | **Alert + 重试按钮** | 不显示原始异常 |
| 长任务（更新/构建/同步） | `toast.loading` → `success`/`error` | 同一 id 原地替换 |
| 后台轮询失败 | **静默**（连续 N 次后降级为角标） | 不闪屏 |

**禁止**：`window.alert/confirm`、`location.reload()` 后弹 toast、把 `?error=` 当文案传输、
在 UI 里渲染 `Error.message`。

### 6.2 基础设施改造

1. **把 `sonner` 升为宿主 ABI 槽**
   - `packages/spec/src/frontend-abi.ts`：加入 `'sonner'` 槽 + 版本（2.0.8）
   - `scripts/build-frontend.mjs`：`--external:sonner` + `--alias:sonner=/api/frontend-abi/sonner`
   - `apps/web/src/components/frontend-abi-bridge.tsx`：发布 `sonner` 命名空间
   - `apps/web/src/app/api/frontend-abi/[...slot]/route.ts`：加入白名单
   - `apps/web/src/lib/frontend-host-abi.ts`：服务端 ABI 同步
   - 收益：**一次性修好所有现有和未来的插件 toast**，无需改插件代码。

2. **`@stackpanel/ui` 提供 `<Feedback>` 契约组件**
   `InlineError` / `InlineSuccess` / `PageError`（带重试），统一间距、图标、`role`。
   插件不再各自写 `<p className="text-sm text-destructive">`。

3. **`api-errors.ts` 收口**
   - 只按 `code` 查表；未命中 → `common.operationFailed`；
   - 原始异常仅 `console.error`（dev 下可附带 `requestId`）；
   - 新增 `errorCodeCatalog` 守门测试：内核 + 插件抛出的每个 `code` 必须有翻译，
     缺失即 CI 失败（和上一轮「发出即声明」同构）。

4. **`?error=` 改传错误码**
   `actionFailure` 写 `?errorCode=<code>`，toaster 本地化；保留 `?error=` 兼容期
   但只用于已本地化的短文本，并去掉 256 字符静默丢弃（改为截断 + 折叠详情）。

5. **成功回执统一走 `successFeedback`**
   40 个 action 全部补声明；守门测试：`method !== 'GET'` 且 `redirect` 为空的 action
   必须声明 `successFeedback` 或显式 `silent: true`。

### 6.3 分阶段实施

**Phase 1（P0，先止血，1 天）**
1. `sonner` ABI 槽（6.2-1）
2. 修 3 个重复路径的 fetch（login / smtp）
3. `TicketWorkspace` 给 `labels` 默认值（ui 包内置中文/英文默认）
4. `action-feedback-toaster` 去掉 256 静默丢弃
5. notification bell/inbox 检查 `ok` + 失败回滚 + toast
6. `api-errors` 停止泄漏 `message`
7. 12 个 `serviceUnavailable` 模板去掉 `{error}`

**Phase 2（P1，内核，1–2 天）**
8. 内核 40 处 `setError` 逐项归类：toast / inline / page-error
9. `users-manager`、`plugin-manager`、`theme-manager`、`cart-checkout` 补错误处理
10. OAuth `?error=oauth` 在登录页消费
11. `frontend-render-boundary` / `runtime-admin-page` 不再渲染 `error.message`
12. 补 `(admin)/error.tsx`

**Phase 3（P2，插件，2–3 天）**
13. 全部 action 补 `successFeedback`
14. 高风险删除操作加 `AlertDialog`
15. 枚举 → 文案映射（store-wallet / store / ticket）
16. 金额用 `toMinorUnits` / `money()`

**Phase 4（P3/P4，收尾）**
17. 去重（notification-settings、frontend-route、store showFeedback）
18. 9 个外部插件补 i18n catalog，跑绿 `scan-i18n-literals.mjs --check`

### 6.4 守门测试（防止回退）

| 测试 | 断言 |
| --- | --- |
| `feedback-no-raw-message.test.ts` | `apps/web/src` 与插件 `frontend/src` 不得出现 `toast.*(.message)` / `setError(*.message)` |
| `feedback-no-sonner-import.test.ts` | 插件源码只能从宿主 ABI 拿 toast（或禁止直接 import sonner，改由 ABI 提供） |
| `feedback-success-feedback.test.ts` | 每个写操作 action 必须声明 `successFeedback` 或 `silent` |
| `error-code-coverage.test.ts` | 所有抛出的 `code` 在 `zh-CN` / `en-US` 有对应 key |
| `i18n-literals`（已有） | baseline 保持 0 |

---

## 7. 明确不做的（避免过度设计）

- 不把纯校验错误（如「请输入邮箱」）改成 toast——贴近字段更合理。
- 不给后台轮询加 toast——会刷屏。
- 不给已经可见的状态变化（如开关自身状态）额外加 toast——只在该操作**失败**时提示。
- 不为「加载中」加全局遮罩——保留局部 skeleton。
- 不强行统一插件文案语气到同一句话——只统一**通道**和**错误码契约**。
