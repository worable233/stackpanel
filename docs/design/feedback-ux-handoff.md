# 操作反馈体验 · 交接文档（含会话记忆）

> 目的：把「操作反馈 / 错误提示统一」这件事完整交接给下一个会话或下一个人。
>
> 沿革（重要，别搞错归属）：
>
> 1. 本会话完成**审计 + 方案**，产出 `docs/design/feedback-ux-audit.md`（commit `0d13cd5`）。
> 2. 后续提交 `41b4bf1`「fix(feedback): 统一反馈通道与错误码契约」按该方案落地 P0–P4 + 4 个守门测试，已合入 `origin/main`。
> 3. 本会话随后**逐项复核**了落地结果，并补做了本文 §6 的差距盘点（含守门正则漏洞、插件仓库无守门、新功能回退）。
>
> 本文记录：**已经做了什么、怎么验证、还剩什么、以及踩过的坑**。

配套文档：`docs/design/feedback-ux-audit.md`（原始审计报告，逐条 `file:line`，是问题清单的唯一来源）。

---

## 1. 一句话现状

反馈体系现在有**统一契约 + 自动化守门**：插件 toast 走宿主 ABI、错误只按 `code` 查文案、
写操作必须声明 `successFeedback` 或 `silent`、原始英文异常不再上屏。

但插件仓库（`StackPanel-plugins`）的守门测试还没建，所以外部插件仍有残留泄漏（见 §6）。

> **2026-10-26 追补：已补齐。** 插件仓库新增 `scripts/check-feedback.mjs` +
> `.github/workflows/feedback.yml`（零依赖，CI 不需要 `pnpm install`），并清掉了
> 全部 15 处 `*.message` 泄漏、ticket 的 5 个无回执 action，以及内核侧 3 处新功能回退。
> 遗留项见 §6 末尾的「仍未做」。

---

## 2. 问题是怎么发现的（记忆里的根因）

用户原话：「很多操作完按钮后面的反馈直接就生硬地显示在屏幕上，没有接入系统通知」。
审计确认这不是「某个提示写得不好」，而是**三套互不相通的反馈通道并存**：

| 通道                                 | 位置                             | 实际效果                              |
| ------------------------------------ | -------------------------------- | ------------------------------------- |
| 宿主 sonner `<Toaster />`            | `apps/web/src/app/layout.tsx:94` | 唯一真正会弹的通道                    |
| 插件自带 sonner                      | 插件 bundle 内                   | **永远不会弹**（第二份 `ToastState`） |
| 内联 `<p role="alert">` / `setError` | 各处                             | 生硬、常带英文原文                    |

关键证据：`sonner` 不在宿主 ABI 槽，构建时被 esbuild 打进插件 bundle。
`packages/plugins/login/frontend/dist/admin.runtime.js` 当时含 13 处 `ToastState`
——插件自建了第二个 React toast store，和宿主 `<Toaster />` 毫无连接。

---

## 3. 已落地的改动（commit `41b4bf1`，已在 `origin/main`）

### P0 静默失败 / 技术文本泄漏

| 项                       | 落点                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| sonner 升为宿主 ABI 槽   | `packages/spec/src/frontend-abi.ts`（`'sonner'` + `sonner: '2.0.8'`）<br>`scripts/build-frontend.mjs`（`--external:sonner` + `--alias:sonner=/api/frontend-abi/sonner`）<br>`apps/web/src/components/frontend-abi-bridge.tsx`（客户端发布）<br>`apps/web/src/lib/frontend-host-abi.ts`（RSC 侧发布）<br>`apps/web/src/app/api/frontend-abi/[...slot]/route.ts`（白名单） |
| 修重复 plugin-id 404     | `login` → `/api/plugins/login/admin/config`；`smtp` → `/api/plugins/smtp/admin/config`、`/smtp/admin/test`                                                                                                                                                                                                                                                               |
| 超长错误不再静默丢弃     | `action-feedback-toaster.tsx`：>256 字符改为预览 + `<details>` 展开，去掉 `MAX_ACTION_ERROR_LENGTH` 直接丢弃                                                                                                                                                                                                                                                             |
| 通知已读失败不再假装成功 | `notification-bell.tsx` / `notification-inbox.tsx` 检查 `response.ok`，失败 toast                                                                                                                                                                                                                                                                                        |
| 错误不再回退服务端原文   | `apps/web/src/lib/api-errors.ts`：只查 `error.<code>`，未命中 → 调用方 fallback；原文只进 `console.error`                                                                                                                                                                                                                                                                |
| 去掉 `{error}` 插值      | 12 处 `*serviceUnavailable` 模板改为「XX 服务不可用」+ 重试                                                                                                                                                                                                                                                                                                              |

### P1 原始异常文本

- 不再渲染 `cause.message`：`notification-settings` / `account-settings` / `users-manager` /
  `plugin-manager` / `theme-manager` / `cart-checkout`
- 登录页消费 `?error=oauth`（`login/page.tsx` → `login-form.tsx` 的 `oauthError` prop）
- `frontend-render-boundary.tsx` / `runtime-admin-page.tsx` 不再显示 `error.message`
- 新增 `apps/web/src/app/(admin)/error.tsx`（此前后台崩溃会落到 Next 默认英文错误页）

### P2 回执 / 确认 / 枚举 / 金额

- SDK `PluginActionDefinition` 新增 `silent?: boolean`（`packages/sdk/src/frontend.ts:575`）
- 内核 + 内置插件共 23 个写 action 补 `successFeedback` 或 `silent`
- 插件/主题删除改用 `AlertDialog` 二次确认
- `store-wallet` 充值记录状态、`store` 购物车 `unavailableReason`、`store` 退款状态走枚举→文案映射
- `store` 退款列表金额改用 `money()`（此前直接渲染 minor units）

### P3 / P4 去重 + 契约

- `ActionFeedbackToaster` 提到**根布局**：此前只在 `backend-shell`，公开商店/账户中心的
  插件回执根本不会弹 toast
- 移除 `frontend-route.tsx` / `account-plugin-page.tsx` 的 `?error=` 内联重复横幅
- `notification-settings` 保存失败只走 toast，不再双报
- **修复 `agentErrorText` 查错命名空间**：API 转发的 `agent.*` 问题码在 `error.*` 下，
  原先命中失败会把上游英文原文透给用户
- 补齐 **104 个**此前无翻译的错误码（`error.*` 现有 274 个）
- 补齐所有插件/主题的 i18n catalog（含 zh-TW / zh-HK），`scan-i18n-literals` baseline 归零

### 守门测试（`apps/web/tests/`）

| 文件                                | 断言                                                                                                                                          | 当前             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `feedback-no-raw-message.test.ts`   | `toast.*` / `setError(...)` 里不得出现错误味标识符的 `.message`（含 `loadError` 这类驼峰绑定；`result.message` 仍允许），匹配器另有 10 条自测 | 4 文件 11 例全绿 |
| `feedback-sonner-abi.test.ts`       | sonner ABI **五个接线点**缺一即红                                                                                                             | 同上             |
| `feedback-success-feedback.test.ts` | 每个 `POST/PATCH/DELETE` action 必须 **恰好** 有 `successFeedback` xor `silent`                                                               | 同上             |
| `error-code-coverage.test.ts`       | 每个抛出的 `code` 在 4 个 locale 都有翻译                                                                                                     | 同上             |

---

## 4. 关键设计决策（不要再走回头路）

1. **sonner 必须是宿主 ABI 槽，不是插件依赖。**
   任何「让插件自己装 sonner」的方案都会退回到「toast 永不显示」。
   五个接线点必须同时存在——这正是 `feedback-sonner-abi.test.ts` 守的东西。

2. **错误展示只认 `code`。**
   `code` 是契约（ADR-0012），界面拥有文案（ADR-0016）。
   服务端 `title`/`detail` 永不直接上屏，只进日志。这条不能为了「方便排查」放宽。

3. **`successFeedback` xor `silent`，不是「两个都行」。**
   `silent` 的语义是「该包自己给了回执（内联结果 / redirect / 自己的 toast）」。
   两者同时存在会导致重复提示；都没有则是静默成功——这是审计的主要投诉。

4. **`?error=` 仍传已本地化的短文本，不是错误码。**
   上一版方案曾计划改成 `?errorCode=`，实际落地保留了文本传递（`actionFailure` 传
   `apiErrorMessage` 结果）。这是**已知的妥协**：文本已经过本地化，且长文本已改为
   可展开，风险可控。若要彻底码化，需要同步改 `frontend-plugin-action-executor.ts`、
   `action-feedback-toaster.tsx` 和所有插件的回执解析。

5. **`ActionFeedbackToaster` 必须在根布局。**
   放到 `backend-shell` 会让公开页面（商店、账户中心）的插件回执失效。

6. **轮询失败不加 toast。** `agent-workspace` 每 5s 轮询，失败提示会刷屏。

---

## 5. 怎么验证（记忆里踩过的命令坑）

```bash
# ✅ Web 单测 / typecheck（vitest 只装在 apps/web，根目录没有）
cd apps/web
./node_modules/.bin/vitest run                  # 44 文件
./node_modules/.bin/tsc --noEmit -p tsconfig.test.json

# ✅ i18n 字面量门禁（必须 baseline=0）
cd /Users/worable/Documents/StackPanel
node scripts/scan-i18n-literals.mjs --check

# ✅ 只跑反馈相关守门
cd apps/web
./node_modules/.bin/vitest run \
  tests/feedback-no-raw-message.test.ts \
  tests/feedback-sonner-abi.test.ts \
  tests/feedback-success-feedback.test.ts \
  tests/error-code-coverage.test.ts
```

**坑（记下来，别重犯）**：

- 根目录**没有** `node_modules/.bin/vitest`，`node node_modules/vitest/vitest.mjs` 会
  `MODULE_NOT_FOUND`。必须 `cd apps/web && ./node_modules/.bin/vitest`。
- 别用 `node apps/web/node_modules/.bin/vitest`——那是 shell 包装脚本，node 直接跑会
  `SyntaxError: missing ) after argument list`。要么 `./` 直接执行，要么走 pnpm。
- `--include=*.tsx` 在 zsh 下会 glob 展开失败（`no matches found`）。用
  `grep -rn pattern path` 或给 glob 加引号。
- 本机没有 `rg`；`psql` 也没有，DB 走 `docker exec sp-pg psql -U stackpanel -d stackpanel`。

---

## 6. 差距盘点

> **2026-10-26 追补状态**：P1、P2、P3 已完成，P4 的 `window.confirm` 部分已完成；
> 下面原文保留，作为问题背景与验收口径。
>
> 已完成的内容：
>
> | 项                  | 落点                                                                                                                                                                                                   |
> | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
> | 修守门正则洞        | `apps/web/tests/feedback-no-raw-message.test.ts`：改成「错误味标识符 + `.message`」匹配（`loadError` / `saveError` / `fetchError` 全部命中），并自带 8 条必须命中 / 2 条必须放过的匹配器自测           |
> | 插件仓库守门        | `StackPanel-plugins/scripts/check-feedback.mjs`（零依赖，纯文本 + manifest 检查，规则与内核同源）+ `.github/workflows/feedback.yml` + `pnpm feedback:check`                                            |
> | 清残留 `*.message`  | cms 11 处、llm-gateway 3 处、smtp 2 处 → 统一走 `failure(cause, localizedMessage)`：原文进 `console.error`，界面只显示 `tr(...)` 文案                                                                  |
> | smtp 回执被刷新吞掉 | `window.location.reload()` → `router.refresh()`（`<Toaster />` 在根布局，刷新不再销毁 toast）                                                                                                          |
> | ticket 5 个 action  | `create` → `silent: true`（有 `redirect` 回执）；`reply` / `close` / `remind` / `update` → `successFeedback`，并补 `feedback.*` 四语文案                                                               |
> | P3 新功能回退       | `seo-page-manager` / `admin-nav-manager` / `api-token-manager` 全部改走宿主 `toast`：成功有回执、失败 toast，内联 `text-destructive` 提示已删；补 8 个 `action.*` 文案（含 zh-TW/zh-HK）               |
> | P2 插件字面量门禁   | `StackPanel-plugins/scripts/scan-i18n-literals.mjs`（内核同规则副本，扫描根改为插件包）+ CI 装 `typescript`；清掉 llm-gateway / zjmf-upstream 两处硬编码中文，`pnpm i18n:check` 现包含 `i18n:literals` |
> | P4 确认框           | `@stackpanel/ui` 新增 `ConfirmDialog`（AlertDialog 语义）；`admin-user-detail` 与 `store` 审批页的 3 处 `window.confirm` 全部替换                                                                      |
>
> 验收：`node scripts/check-feedback.mjs` → `ok 12 个前端包`；内核 `vitest run` 43 文件 / 304 例全绿；
> `scan-i18n-literals --check` baseline 0；`check-package-catalogs` 无问题；
> `apps/web` 的 `tsc --noEmit` 也全绿（前提是 `packages/sdk` 与 `packages/ui` 先 build —— 旧 dist 会报 15 条假错）。

### P1 — 插件仓库缺守门测试 ✅ 已建

`feedback-*.test.ts` 与 `error-code-coverage.test.ts` **只扫内核仓库**的
`packages/plugins/*/frontend/src`，扫不到 `/Users/worable/Documents/StackPanel-plugins`。
所以外部插件里还留着审计点名的问题：

> 下表每一行都已在 2026-10-26 修复（保留作背景）：`*.message` 走 `failure()`、
> `window.confirm` 换 `ConfirmDialog`、ticket 补回执、storage 只回 `ok`、
> smtp / login 的 `reload()` 改 `router.refresh()`。

| 文件                                                                   | 残留                                                                                                               | 说明                                                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `cms/frontend/src/admin.tsx`                                           | **11 处** `setError(x instanceof Error ? x.message : ...)`                                                         | 变量名是 `loadError`/`saveError`/`deleteError`/`publishError`/`historyError`/`revisionError`/`actionError` |
| `llm-gateway/frontend/src/admin.tsx`                                   | **3 处**（:395 `cause.message`、:452 `cause.message`、:779 `fetchError.message`）                                  | —                                                                                                          |
| `smtp/frontend/src/index.tsx`                                          | **2 处** `toast.error(e instanceof Error ? e.message : ...)`（:92, :108）                                          | —                                                                                                          |
| `smtp/frontend/src/index.tsx:90`                                       | toast 后紧接 `window.location.reload()`                                                                            | toast 被刷新销毁                                                                                           |
| `login/frontend/src/admin.tsx:36`                                      | 同上                                                                                                               | 同上                                                                                                       |
| `ticket` manifest                                                      | **5 个** action `ticket.create` / `reply` / `close` / `remind` / `update` **既无 `successFeedback` 也无 `silent`** | 全部违反契约                                                                                               |
| `store/frontend/src/admin.tsx:1530,1548` + `admin-user-detail.tsx:530` | `window.confirm`                                                                                                   | 与全站 AlertDialog 视觉割裂                                                                                |
| `storage/src/index.ts:142` → `storage/frontend/src/admin.tsx:138`      | 后端 `testConnection` 返回 `String(error.message)`，前端 `result.error \|\| tr('test.failed')` 直接渲染            | **即使前端改好也会透英文**（`SignatureDoesNotMatch` 等）；应改为稳定 code，前端查表                        |

#### ⚠️ 守门正则本身有个洞（自查发现，尚未修）

`apps/web/tests/feedback-no-raw-message.test.ts:18-19`：

```ts
const RAW_MESSAGE_CALL =
  /(?:toast\.[A-Za-z]+|setError)\s*\([^;\n]*(?:cause|error|err|failure|exception|e)\.message/;
```

alternation 里的 `error` 是**小写字面量**，匹配不到 `loadError.message` / `saveError.message` /
`fetchError.message` —— 因为首字母是大写 `E`。实测：

```text
setError(cause instanceof Error ? cause.message : …)     → CAUGHT
setError(fetchError instanceof Error ? fetchError.message : …) → MISSED
setError(loadError instanceof Error ? loadError.message : …)   → MISSED
setError(saveError instanceof Error ? saveError.message : …)   → MISSED
```

**修法**：改成 `/\.message\b/` 并在调用点内匹配，或把 alternation 换成
`[A-Za-z_$]*(?:cause|error|err|failure|exception|e)` 并加 `i` 标志。修完后再把该测试
复制到插件仓库，否则外部插件的 16 处 `*.message`（cms 11 + llm-gateway 3 + smtp 2）仍是盲区。

**做法**：把四个守门测试复制到插件仓库（注意它没有 `apps/web`，只能扫
`packages/plugins/*/frontend/src`；catalog 缺 `@stackpanel/web` 的 i18n 依赖，
需要把 `error-code-coverage` 改成读插件自己的 `messages/*.json`）。
或者更省事：在插件仓库 CI 里 checkout 内核仓库，直接复用内核的测试。

> 注意：插件仓库 `.github/workflows/i18n.yml` 目前只有
> `check-package-catalogs.mjs` 和 `i18n-hant.mjs --check`，**没有**字面量门禁。
> 内核 CI 会 clone 插件仓库安装插件（`.github/workflows/ci.yml:196`），
> 但那是**建包 + 装包**，不跑插件前端的静态检查。

### P2 — 插件 i18n 已补但未经门禁验证（仍未做）

10 个外部插件的 `messages/` 目录都已建（catalog/cms/epay/invoice/llm-gateway/
notice/referral/smtp/ticket/zjmf-upstream），但插件仓库没有字面量扫描，
所以「TSX 里还有没有硬编码中文」**没有自动保证**。

### P3 — 新功能往回退 ✅ 已补

审计之后新合入的三处 UI 又回到了旧模式（没有走 toast）：

| commit         | 文件                                            | 现象                                                                                                                                                                 |
| -------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `b0ce9ad` SEO  | `apps/web/src/components/seo-page-manager.tsx`  | 全文 0 处 `toast`；保存/删除成功只 `setOpen(false)` + `router.refresh()`；失败内联 `<p className="text-sm text-destructive">`（:291, :317）                          |
| `8141506` 菜单 | `apps/web/src/components/admin-nav-manager.tsx` | 全文 0 处 `toast`；保存/新增/删除成功只 `router.refresh()`；失败内联                                                                                                 |
| `de4d3bd` 密钥 | `api-token-manager.tsx`                         | 全文 0 处 `toast`；新建靠展示 token 代替回执（可接受），但**更新签名公钥 / 撤销**成功只 `setSigningTarget(null)` + `router.refresh()`，静默成功；失败内联 `setError` |

这三处应该在第一版就按契约接 toast。属于「新代码没遵守已有契约」，值得补一条
**code review checklist** 或 CI 里对 `setError` 出现次数做 ratchet。

### P4 — 仍未统一的小项（`window.confirm` 部分已清）

- ~~`window.confirm` 还剩 3 处~~ **已清**：`@stackpanel/ui` 新增 `ConfirmDialog`
  （`AlertDialog` 语义，`pending` 期间拒关闭，`destructive` 变体，文案全部由调用方传入
  已本地化字符串）。已用于 `admin-user-detail`（服务解绑/删除）与 `store` 审批页
  （继续支付/核验送审）。以后不可逆操作直接 `import { ConfirmDialog } from '@stackpanel/ui'`。
- `@stackpanel/ui` 还没有统一的 `InlineError` / `InlineSuccess` / `PageError` 组件，
  各处仍手写 `<p className="text-sm text-destructive">`。方案 §6.2-2 提过，未做。
- 内联成功提示（`role="status"`）**已清理**（2026-10-26）：`account-settings`
  语言切换的「自动保存/切换中」、改邮箱/改密码的「已保存」、`notification-settings`
  的「自动保存/已保存」、storage 的「✓ 已保存」与连接测试结果 —— 现在只留系统通知
  （toast；sonner 是宿主 ABI 槽）+ 控件自身状态（开关/下拉即回执）。
  剩下的 `role="status"` 都是加载中占位（单元格骨架、上传中、列表加载），不是回执。

### P5 — 既有噪声（与本次无关，别误判）

- `apps/api/tests/unit/user-detail.test.ts`、`agent-conversations.test.ts`：TS7022
- `apps/api/tests/integration/audit-idempotency.test.ts`：未使用变量 `userSession`
- `agent-reliability.test.ts` 需要独立的 `stackpanel_agent_audit_*` 库
- `ticket/kernel-tests` 导入不存在的 `../../src/app.ts`
- `alipay` 插件已提交（`7f547ec`），但**尚未装进 `data/plugins`**，与反馈工作无关

---

## 7. 另一个并行任务的记忆（通知偏好）

同一时期还做完了「两级通知偏好」，状态是**已完成并合入**：

- 内核：`apps/api/src/notifications/policy-service.ts`（目录 + 管理员策略 + 用户覆盖）
- 用户接口：`GET/PATCH /notifications/preferences`、`POST /notifications/preferences/reset`
- 管理员接口：`GET/PUT /admin/notifications/policy`
- 前端页面已存在：`(account)/account/notifications`（收件箱）、
  `notification-settings.tsx`（偏好，挂在账户设置里）
- 交接文档：`docs/design/notification-preferences-frontend-handoff.md`

**遗留待确认**（当时留给用户拍板，未见答复）：

1. 是否安装并配置 `smtp` 插件（否则偏好页只有 `inapp` 一列）
   —— `data/plugins/smtp/` 下**只有 `frontend/`**，没有 `dist/` 与 `manifest`，
   即插件后端未安装、不可能 active。要用邮件渠道必须先在后台装 smtp 插件并填 SMTP 凭据
2. `audience: 'admin'` 的类型不可被个人关闭（只能管理员全局关），是否接受
3. `tests/unit/notification-type-coverage.test.ts` 是「发出即声明」守门：
   新增通知发出点必须同时登记类型，否则 CI 红

跑 API 测试务必用独立库避开并发：
`TEST_DATABASE_URL=postgresql://stackpanel:stackpanel@127.0.0.1:5432/stackpanel_test_notif`

---

## 8. 上手检查清单

```bash
# 1. 仓库状态
cd /Users/worable/Documents/StackPanel && git status -sb | head -1
cd /Users/worable/Documents/StackPanel-plugins && git status -sb | head -1

# 1.5 插件仓库反馈契约门禁（零依赖，不用 pnpm install）
cd /Users/worable/Documents/StackPanel-plugins && node scripts/check-feedback.mjs

# 2. 反馈基础设施是否还在（五个接线点）
grep -n sonner packages/spec/src/frontend-abi.ts scripts/build-frontend.mjs \
  apps/web/src/components/frontend-abi-bridge.tsx \
  'apps/web/src/app/api/frontend-abi/[...slot]/route.ts'

# 3. 守门测试是否还绿
cd apps/web && ./node_modules/.bin/vitest run \
  tests/feedback-no-raw-message.test.ts tests/feedback-sonner-abi.test.ts \
  tests/feedback-success-feedback.test.ts tests/error-code-coverage.test.ts

# 4. 插件 dist 是否与源码同步（改动插件的铁律）
for p in login market storage store store-wallet; do
  a=$(md5 -q data/plugins/$p/frontend/dist/admin.runtime.js 2>/dev/null)
  b=$(md5 -q packages/plugins/$p/frontend/dist/admin.runtime.js 2>/dev/null)
  [ "$a" = "$b" ] && echo "$p OK" || echo "$p DRIFT"
done
```

---

## 9. 一句话给下一个人

反馈问题**不是**「多写几个 toast」，而是三件事：
**通道唯一（宿主 ABI）、文案按 code（不泄漏原文）、成功必须有回执（xor silent）**。
三条都有守门测试，而且**内核与外部插件仓库各有一道**（`apps/web/tests/feedback-*.test.ts` /
`StackPanel-plugins/scripts/check-feedback.mjs`）。新写的 UI 一律按契约来，
尤其是「成功也能静默」——那是审计的主要投诉。
