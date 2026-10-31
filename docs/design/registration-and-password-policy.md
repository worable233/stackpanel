# 注册策略与密码强度（实现说明）

状态：已实现（内核 + 登录插件 + Web）
相关：ADR-0012（错误码契约）、ADR-0016（国际化）、ADR-0020/0021（内核不认识厂商）

## 1. 问题

审查发现注册链路有四处「配置能写，行为做不到」的落差：

1. **注册关不掉**。`loginConfigSchema.registrationMethods` 是 `.min(1)`，后台把「邮箱注册」取消勾选后表单只能禁用保存按钮；没有任何「关闭注册」的开关。
2. **邮箱验证会静默降级**。`emailVerificationEnabled()` 把「要求验证但没有发送通道」判定为「不要求验证」，于是卸载 SMTP 之后注册仍然放行未验证账号。
3. **密码只有 `min(8)`**，没有强度/黑名单/与邮箱相似度检查，且注册与登录没有 `max`（改密码有 `max(256)`）。
4. **没有自助找回密码**。`IdentityChallengePurpose` 与 `CaptchaAction` 早已预留 `password_reset`，但没有路由、页面和入口。

另外限流在 BFF 后面退化为全站共享：Web 用服务端 action 调内核，不转发 `X-Forwarded-For`，内核看到的所有访客都是同一个 IP。

## 2. 决策

### D1 注册开关 = `registrationMethods` 允许空数组

空数组语义明确（「不开放自助注册」），不需要再加一个布尔字段，也不会出现「开关开着但没有方式」的中间态。`/register`、`/register/send-code` 在 `[]` 时返回 `auth.registration_closed`（403），`/auth/config` 回 `registrationEnabled: false`，登录页据此隐藏注册入口，注册页直接渲染说明页而不是表单。

### D2 校验策略 fail-closed

`verificationUnavailable(config) = emailVerificationRequired && !deliveryConfigured`。为真时：

- `POST /register`、`POST /register/send-code` 返回 `auth.email_verification_unavailable`（503）；
- `/auth/config` 回 `emailVerificationBlocked: true`，注册页显示「暂时无法注册」；
- 插件激活时 `logger.warn` 一次，让运维在日志里看到漂移；
- 后台设置页对该勾选项显示告警。

理由：运营者勾了「必须验证邮箱」就是表达了「账号必须证明邮箱」，把它降级成「不验证」等于用默认值推翻显式配置——这是安全问题上最不该做的失败方向。反方向（拒绝注册）可以被人看见并修复。

### D3 密码策略放在 SDK，一处定义、三处执行

`packages/sdk/src/password.ts`：`PASSWORD_MIN_LENGTH = 10`、`PASSWORD_MAX_LENGTH = 128`（按 Unicode 码点计，不按字节）、`validatePassword(password, { email })` 返回 `{ ok } | { code }`。

- 内核：`apps/api/src/lib/password-policy.ts#assertPassword` → `PluginError(code, 400)`，注册、改密、管理员创建/重置、Open API、setup 全部走它；
- 插件：登录插件在消费验证码**之前**调用同一函数，弱口令不会烧掉验证码；
- 前端：注册/重置/设置页面用它做本地预检，并把 `code` 翻译成 `error.<code>`，所以提示语与内核完全一致。

规则取 NIST SP 800-63B 的方向：**长度优先、不强制字符组合**、拒绝常见口令（约 170 条 + leet 折叠 + 纯重复/连号）、拒绝与邮箱（或邮箱局部 ≥4 字符）相同/包含。不做「必须含大写+数字+符号」，那只会把用户推向 `Password1!`。

### D4 自助重置走独立身份挑战流

`POST /password/forgot` → `identity.issue({ purpose: 'password_reset' })`，`POST /password/reset` → `identity.consume(...)` → `auth.resetUserPassword(id, password, { emailVerified: true })`。

- 不复用注册验证码，也不进站内通知/SSE/日志（无会话的人看不到站内信）；
- 忘记密码的响应恒为 `{ sent: true }`，不确认邮箱是否存在——注册接口本来就暴露存在性，但把「忘记密码」变成账号探测器没有必要；
- 消费成功即视为证明邮箱控制权，顺带把历史未验证账号修好；
- 重置成功撤销该账号全部会话，并写一条 `security.password.reset` 站内通知（`dedupeKey` 与管理员重置分开），因为它必须能解释「不是你干的就赶紧找管理员」；
- 顺序固定：限流 → 策略校验 → 消费验证码 → 写密码。弱口令不烧码，错码不写库。

### D5 限流维度与 BFF 真实 IP

`allow(scope, kind, identifier, limit)`，key = `<scope>:<ip|user>:<id>`：登录、注册、重置各自独立预算，且 IP 与账号两个维度都计。计数器在 `ctx.state`（Redis），多副本共享。

Web 侧 `apps/web/src/lib/api.ts` 增加 `upstreamFetch`：把来访请求的 `X-Forwarded-For`（或 `X-Real-IP`）转发给内核，不覆盖调用方已设置的头，`next/headers` 不可用时静默跳过。内核 `API_TRUST_PROXY` 未配置时默认 `loopback`——同机 BFF/代理可信，公网来源不可伪造。

`LOGIN_RATE_LIMIT_MAX` / `REGISTER_RATE_LIMIT_MAX` 已写入 `.env.example` 与两个 compose 文件。

### D6 协议字段向后兼容

`AuthConfigResponse` 新增 `registrationEnabled`、`passwordResetSupported`、`emailVerificationBlocked`，zod 全部带默认值（`true` / `false` / `false`），因此旧前端配新内核、新前端配旧内核都能解析。

## 3. 行为矩阵

| 后台配置      | 可用发送通道 | `/register`                               | 注册页       | `/auth/config`                     |
| ------------- | ------------ | ----------------------------------------- | ------------ | ---------------------------------- |
| 关闭注册      | 任意         | 403 `auth.registration_closed`            | 说明页       | `registrationEnabled: false`       |
| 开放 + 不验证 | 任意         | 创建账号                                  | 表单         | `emailVerificationRequired: false` |
| 开放 + 验证   | 有           | 要求验证码                                | 表单含验证码 | `emailVerificationRequired: true`  |
| 开放 + 验证   | 无           | 503 `auth.email_verification_unavailable` | 说明页       | `emailVerificationBlocked: true`   |

## 4. 接口与错误码

| 路径                       | 说明                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /register`           | 关闭/阻塞检查 → 限流 → 人机验证 → 密码策略 → 验证码 → 建号                                                                                 |
| `POST /register/send-code` | 同上（不含密码策略），校验关闭/阻塞后再发码                                                                                                |
| `POST /password/forgot`    | 限流 → 人机验证 → 通道检查 → 发码（恒返回 202）                                                                                            |
| `POST /password/reset`     | 限流 → 密码策略 → 消费验证码 → 重置并撤销会话                                                                                              |
| `GET /auth/config`         | `registrationEnabled` / `emailVerificationRequired` / `emailVerificationSupported` / `emailVerificationBlocked` / `passwordResetSupported` |

新增错误码（7 种语言目录均已补齐）：`password.too_short`、`password.too_long`、`password.too_common`、`password.matches_identity`、`auth.registration_closed`、`auth.email_verification_unavailable`、`auth.password_reset_unavailable`、`auth.user_not_found`。

新增审计动作：`auth.password.changed`、`auth.password.reset`、`auth.password.reset_requested`。

## 5. 测试

- `packages/sdk/tests/password.test.ts`：11 例，含码点计数（CJK 长口令）、常见口令、leet、连号、邮箱相似。
- `apps/api/tests/unit/password-policy.test.ts`：`assertPassword` 的码/状态契约。
- `apps/api/tests/unit/login-registration-policy.test.ts`：`packages/plugins/login/src/policy.ts` 的纯决策（空数组＝关闭、fail-closed、两状态互不遮蔽）。放在内核测试目录是因为 `pnpm -r test` 只跑有 test 脚本的包，插件包目前没有 vitest 依赖。
- `apps/api/tests/integration/registration-policy.test.ts`：真实数据库 + 真实插件运行时下跑完 5 个场景——关闭注册（403）、fail-closed（503）、弱口令不烧验证码、自助重置全流程（旧会话失效、旧密码 401、新密码 200）、未知邮箱请求恒 202。
- `apps/api/tests/integration/register-verification.test.ts`：既有注册邮箱验证用例在新策略下仍然全绿。
- `apps/web/tests/error-code-coverage.test.ts` / `i18n-catalog.test.ts`：新错误码在 7 个语言目录都有条目。

## 6. 未做（明确的下一步）

1. **插件市场里的 SMTP / captcha 插件后台数据契约**用的是内核不认的 `data: [{ fetch: { path } }]`，需改为 `[{ finder: '<plugin>.config', as: 'status' }]` 并在前端导出 `finders`，否则设置页永远空白。属于插件仓（`StackPanel-plugins`）的独立改动。
2. 邀请码 / 邮箱白名单：当前只有「全开 / 全关」。
3. ToS/隐私勾选与注册审计留痕字段。
4. 密码策略可配置化（长度、是否启用黑名单）。当前是代码常量，改配置需要发版。
5. 登录插件仍无端到端集成测试（只有上述纯函数测试）；`packages/plugins/login` 尚未接入 vitest。
