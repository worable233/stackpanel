# 首次配置页 `/setup` 前端交接文档

> 目的：把「首次初始化向导」的**前端视觉/交互**部分交接给另一个会话。
> **后端、契约、部署脚本、测试已端到端落地并验证**（开放模式与令牌模式两套集成测试全绿）。
> 本文只描述**现状、契约、文件落点、验收方式**；页面视觉设计由接手方决定。
>
> ⚠️ 当前已有一个**可用的临时实现**（复用登录用的 `AuthShell`），你需要做的是**替换/美化它**，
> 而不是从零接。契约字段名、路由、错误码是硬约束，视觉层随便改。

---

## 1. 一句话背景

全新实例启动时**不再自动创建管理员、也不再往日志打印随机密码**。运维打开 Web 站点，
在 `/setup` 页面**自己填邮箱 + 密码**（可选再填一次性「初始化令牌」）来认领实例、创建首个管理员。
认领成功后该页面**永久失效**（DB 里已有管理员），访问会自动跳转。

---

## 2. 后端契约（别再猜，照这个来）

### 2.1 `GET /setup/status` — 公开只读

- 无副作用、永不 401，用于判断是否要展示向导。
- 响应（`SetupStatusResponse`）：

```ts
{
  required: boolean;       // true = 实例尚无管理员且向导开启
  tokenRequired: boolean;  // true = 完成认领时必须提供初始化令牌
}
```

判据是「数据库里是否已存在属于 `group_admin` 的用户」——**注意不是** `user.count()===0`，
因为插件可能先建了无管理员的系统账号。

### 2.2 `POST /setup` — 公开写，创建首个管理员

- 限流：`setup` 预设，**5 次/分钟/IP**。
- 请求体：

```ts
{
  email: string;         // 必填，合法邮箱
  password: string;      // 必填，>= 8 位
  setupToken?: string;   // 仅当 status.tokenRequired 时必填
}
```

- 成功 `201`：返回与登录**完全相同**的 `LoginResponse`：`{ token: string; user: User }`。
  `token` 是会话 token，前端拿到后写会话 cookie 并进后台。
- 失败：

| HTTP | `code` | 含义 |
| --- | --- | --- |
| 422 | `validation.invalid` | 参数不合法（邮箱格式 / 密码 <8） |
| 409 | `setup.already_completed` | 实例已被认领（页面应跳登录） |
| 403 | `setup.disabled` | 部署方关闭了向导（`STACKPANEL_SETUP_MODE=disabled`） |
| 401 | `setup.token_invalid` | 令牌错误或缺失 |
| 429 | （限流） | 尝试过于频繁 |

> 错误响应体是统一的 Problem Details：`{ ..., code, detail, title }`。SDK 的 `ApiError.code`
> 直接携带上面的 `code`，`apiErrorMessage()` 会按 `error.<code>` 目录查本地化文案
> （已在 `zh-CN.json` / `en-US.json` 的 `error.setup.*` 下补好）。

### 2.3 旁路（前端须知，避免困惑）

- 未认领时，`/login` 与 `/register` 的**页面**都会 `redirect('/setup')`（已实现）。
- 令牌模式下，`/register`、OAuth 的「首用户成为管理员」选举被后端**拒绝**，返回
  `409 auth.setup_required`（已实现；文案已补 `error.auth.setup_required`）。
- 因此前端**不需要**自己去拼这些跳转——页面已经会跳。

---

## 3. SDK 方法（`@stackpanel/sdk` 的 `ApiClient`，已加好）

```ts
// 读取状态
api.getSetupStatus(): Promise<SetupStatusResponse>

// 认领实例；setupToken 仅在 tokenRequired 时传
api.completeSetup(input: {
  email: string;
  password: string;
  setupToken?: string;
}): Promise<LoginResponse>   // { token, user }
```

类型定义：`packages/sdk/src/types.ts` 的 `SetupStatusResponse` / `CompleteSetupInput`；
schema：`packages/sdk/src/schemas.ts` 的 `setupStatusResponseSchema`。

---

## 4. 已存在的前端文件与职责

| 文件 | 作用 | 你要不要动 |
| --- | --- | --- |
| `apps/web/src/app/(auth)/setup/page.tsx` | **Server Component**：请求状态、门禁、取 platform/brand、渲染表单 | 基本不动（门禁逻辑别删） |
| `apps/web/src/app/(auth)/setup/setup-form.tsx` | `'use client'` 表单组件（当前为最小可用版） | **主要改动点** |
| `apps/web/src/lib/actions.ts` 的 `setupAction` | server action：调 `completeSetup` → 写会话 cookie → `redirect('/admin')` | 基本不动 |
| `apps/web/src/components/auth-shell.tsx` | 登录/注册外壳，已扩展 `mode: 'setup'` | 可用；若你要独立视觉可脱离它 |
| `apps/web/src/i18n/messages/{zh-CN,en-US}.json` | `auth.setup.*`、`error.setup.*`、`error.auth.setup_required` | 文案可改，**key 别删** |

### 4.1 当前门禁逻辑（`page.tsx`，务必保留）

```ts
const status = await api.getSetupStatus().catch(() => null);
if (!status || !status.required) {
  // 已认领 / 向导关闭 / API 不可达 → 跳登录或对应工作台
  const session = await getSessionUser();
  redirect(session ? (session.role === 'ADMIN' ? '/admin' : '/account') : '/login');
}
```

`page.tsx` 还设了 `metadata.robots = { index:false, follow:false }`，别去掉。

### 4.2 当前表单结构（`setup-form.tsx`）

- `useActionState(setupAction, {})` 拿 `[state, action, pending]`。
- 字段：`name="email"`、`name="password"`（带显示/隐藏切换）、
  **仅当 `tokenRequired` 时**渲染 `name="setupToken"`。
- 错误展示：`state.error`（已是本地化文案，直接渲染）。
- 提交按钮：`pending` 时禁用并显示“初始化中…”。

---

## 5. 数据流（理解它才知道怎么接自己的组件）

```
浏览器 /setup
  └─ Server Component page.tsx
       ├─ GET /setup/status            (getApiClient, server→server)
       ├─ GET /platform/info, /platform/brand
       └─ <SetupForm tokenRequired=… platformName=… logoSrc=… />
            └─ <form action={setupAction}>   ← server action
                 └─ POST /setup
                      ├─ 201 → cookies().set(session) → redirect('/admin')
                      └─ 4xx → ApiError → apiErrorMessage() → state.error
```

- `setupAction` 在服务端读 `formData` 并调用 SDK，**不经过**任何浏览器直连 API 的路径；
  CSRF 由 Next server action 的同源校验兜底，你**不需要**自己加 CSRF。
- 会话 cookie：`httpOnly`,`sameSite=lax`,`secure`(prod),`path=/`,`maxAge=SESSION_TTL_SECONDS`——
  与 `loginAction` 一致，别改这些标志。

---

## 6. 你的任务（视觉/交互层）

只在 `setup-form.tsx`（及你新建的展示组件）里做，可选：

1. **替换外壳**：当前复用 `AuthShell mode="setup"`。若要做独立设计，可以不用它，直接渲染自己的布局。
   但 `page.tsx` 传入的 `tokenRequired` 必须驱动「是否显示令牌输入」。
2. **令牌字段体验**：`tokenRequired=false` 时不渲染；`true` 时给出获取提示
   （文案 key `auth.setup.tokenHint` 已写「见部署摘要或 .env 的 STACKPANEL_SETUP_TOKEN」）。
3. **密码强度提示**、错误/成功态、pending 骨架等交互自由发挥。
4. **无障碍**：`label` 关联、`autoComplete`（email / new-password / off），保持现有写法。
5. **样式约束**：遵守 `apps/web/AGENTS.md`——只用 Tailwind utility + shadcn/ui 组件 API，
   **禁止**自定义 CSS 文件与内联 `style`；Base UI 用 `render={<Link …/>}` 而非 `asChild`。

> ❌ 不要改：`setupAction` 的 cookie 写入逻辑、`page.tsx` 的门禁与 `robots`、SDK 方法名与
> 请求/响应字段名、路由 `/setup`、错误码。

---

## 7. 验收方式（务必真机点一遍，不要只靠单测）

后端集成测试已覆盖逻辑，前端要确认的是**接线**：

1. 起开发栈（web :3000 + api :3001），清库或用一个无管理员的库。
2. 访问 `http://localhost:3000/setup`：
   - 无管理员 → 渲染表单；有管理员 → 跳 `/login`。
3. **开放模式**（未设 `STACKPANEL_SETUP_TOKEN`）：只填邮箱+密码 → 应 201，进 `/admin`；
   再访问 `/setup` 应跳 `/login`。
4. **令牌模式**（设了 `STACKPANEL_SETUP_TOKEN`）：表单应多出令牌输入；
   - 填错令牌 → 展示 `初始化令牌无效`（来自 `error.setup.token_invalid`）；
   - 填对 → 进 `/admin`。
5. 弱密码（<8）→ 展示参数错误。
6. 刷新 `/setup`（已认领）→ 跳 `/login`。

> 后端两套集成测试：`apps/api/tests/integration/setup.test.ts`（开放模式）、
> `setup-hardened.test.ts`（令牌模式 + 旁路拦截）。改动后端契约时才需要一起看。

---

## 8. 相关文件速查

```
apps/web/src/
├── app/(auth)/setup/
│   ├── page.tsx              # 门禁 + 取数（Server Component）
│   └── setup-form.tsx        # ★ 你要改的客户端表单
├── lib/actions.ts            # setupAction（写会话 cookie → /admin）
├── components/auth-shell.tsx # 登录外壳（已支持 mode='setup'，可弃用）
└── i18n/messages/*.json      # auth.setup.* / error.setup.* / error.auth.setup_required

packages/sdk/src/
├── client.ts                 # getSetupStatus() / completeSetup()
├── types.ts                  # SetupStatusResponse / CompleteSetupInput
└── schemas.ts                # setupStatusResponseSchema

apps/api/src/                  # 后端真相（一般不用改）
├── auth/install-claim.ts      # 认领逻辑：advisory lock + 令牌校验 + 审计
├── routes/setup.ts            # GET /setup/status、POST /setup
└── config/env.ts              # STACKPANEL_SETUP_MODE / STACKPANEL_SETUP_TOKEN
```

---

## 9. 交接边界

- **本文只覆盖前端**。后端、契约、部署脚本（`scripts/deploy.sh` 生成并打印令牌、
  `install.sh` 同理）、compose、`.env.example`、README、集成测试均已落地。
- 本任务全部改动**尚未提交**；接手时先看清工作树里 setup 相关改动范围
  （`git status` 里 `install-claim.ts`、`routes/setup.ts`、`(auth)/setup/*`、SDK 三处、
  i18n 两处、脚本/compose/env/README 若干），避免把无关 WIP 一起提交。
- 视觉设计由你决定；**契约与安全门禁不可改**。

## 10. 前端实施（2026-10-17）

- `/setup` 使用独立的两步布局：管理员账户（邮箱、密码、确认密码）→ 确认初始化（信息核对、按需填写一次性令牌）。
- 沿用当前主题 token、shadcn Field / InputGroup / Button；无顶部站点导航，无整页大卡片。
- 提供密码显示切换、密码一致性校验、后退保留输入、提交中禁用、错误反馈、步骤标题焦点和响应式排版。
- 中英文文案位于 `auth.setup.wizard.*`，原有 key 保留。
- 原 `/setup` 服务端门禁与 robots 保持；修正 `setupAction` 的成功 redirect 被 catch 吞掉的问题，Cookie 的安全标志和写入逻辑保持原样。实例已认领或向导关闭时跳转登录。
- 用户确认设计后，开发预览入口及模拟提交逻辑已移除，仅保留正式 `/setup` 流程。
- 已使用 Chrome 验证两种预览、校验、密码显示、后退保留、模拟完成和重新预览、390px 移动布局。另用独立 API 响应桩与独立 Next 实例验证真实 server action 的提交、错误令牌、Cookie 写入、进入后台和已认领门禁；未清空或认领当前开发数据库。
