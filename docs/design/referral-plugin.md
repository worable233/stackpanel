# 推广（Referral）插件 · 设计定稿

> 状态：设计定稿，待评审 → 实施
> 目标读者：实施者（人或 agent）、评审者
> 本文件所有结论均以仓库源码为证据，标注文件与位置。

## 一、目标

每个用户可以推广：生成带 `?affid=` 的专属链接，被邀请人通过该链接注册（并完成约定行为）后，
推广人获得**账户余额**奖励，被邀请人获得**注册送余额**。管理员可在后台查看推广数据并手动调账。

### 非目标（本期不做）

- 多层分销（仅单层，A→B，B 的邀请不给 A）
- 二维码生成
- 提现（奖励只进平台余额，提现沿用钱包既有能力）
- 独立顶级页面路由（只挂 `/account` 与 `/admin` 插件槽位）

## 二、关键决策（两轮选择题汇总）

| 维度 | 决策 | 理由 |
|---|---|---|
| 奖励形态 | 账户余额 / 内部积分 | 复用内核钱包，闭环、可扩展提现 |
| 发奖时点 | **默认「首单支付后发」**，配置可切「注册即发」/「冻结 N 天」 | 用户拍板默认防刷优先 |
| 奖励算法 | 固定金额，全局一个值（每个码可覆盖） | 先跑通；百分比留待二期 |
| 被邀请人福利 | 注册即送余额 | 双向激励，同样走 `wallet.credit`，成本极低 |
| 归因规则 | 仅单层，**首次点击固定归因**，cookie 30 天 | 规则唯一、后台好解释 |
| 归因持久化 | cookie（体验）+ 注册时落库归因行（证据） | 清 cookie 也不丢账，可回溯 |
| 推广码粒度 | 每个用户多个码，分渠道、可命名备注 | 能看出渠道来源 |
| 码形态 | 8–10 位随机短码 | 不暴露用户 id、不可枚举、链接短 |
| 防刷 | 同 IP/设备限一次 + 单账号邀请上限 | 覆盖绝大多数小号，实现成本低 |
| 用户入口 | `/account/referral`「我的推广」 | 复用账户前端插件槽位 |
| 管理端 | 推广数据 + 手动调账 | 异常单可兜底，符合平台审计习惯 |
| 注册钩子 | **改 login 插件**：接收 `affid` + 发布 `user.registered` | 改动最小且不外溢内核 |
| 奖励参数存放 | **自定义模型 `referral/config`** + 后台配置页 | 后端 `PluginContext` 读不到插件设置（见 §4.2） |
| 发奖通道 | **直接调用内核 `ctx.wallet.credit()`**，不经钱包插件转发 | 钱包是内核服务而非插件能力；走插件会丢失事务与简化（见 §4.4） |

## 三、归属链路

```
推广人在 /account/referral 取链接
        https://<site>/?affid=K7F2M9QX
                    │
                    ▼ 落地页捕获
apps/web/src/proxy.ts 读到 affid → Set-Cookie sp_aff（affid + 首次点击时间戳，30 天）
                    │
                    ▼ 注册页读取
/apps/web/src/app/(auth)/register 读 searchParams → 表单 hidden affid
   → apps/web/src/lib/actions.ts registerAction → api.register(email, password, affid)
                    │
                    ▼ 注册请求
packages/plugins/login POST /register（registerSchema 增加可选 affid）
   → auth.registerUser() → 发布新事件 user.registered { userId, email, affid?, ip? }
                    │
                    ▼ 事件订阅
推广插件：写 referral/record 归因行（state=pending）→ 给被邀请人送余额
                    │
                    ▼ 后续
store 发布 order.paid（payload 增加 userId）→ 推广插件按配置触发发奖
   → wallet.credit(inviterId, …)（内核唯一索引保证幂等）
```

## 四、必须先改的三处外部接缝

这三处是本设计能落地的前提，已逐一查证。

### 4.1 login 插件：接收 affid + 发布 `user.registered`

- 证据：`packages/plugins/login/src/index.ts:10-13` 的 `registerSchema` 只有 `email`/`password`，
  zod 默认丢弃未知字段 → 直接传 `affid` 会被静默丢掉。
- 证据：`packages/sdk/src/plugin.ts:178-192` 的 `PlatformEvents` **没有** `user.registered`。
  插件无法「旁听」注册。
- 改法（`packages/plugins/login/src/index.ts`）：

```ts
const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  affid: z.string().max(32).optional(),   // 新增
});
```

  注册成功后发布事件（在 `issueSession` 之后、函数返回之前）：

```ts
pluginCtx.events.publish('user.registered', {
  userId: user.id, email: user.email, affid: parsed.data.affid ?? null, ip: clientIp(req),
});
```

- 事件主题必须同时声明在 `packages/sdk/src/plugin.ts` 的 `PlatformEvents` 中，
  与既有 `order.paid` / `payment.settled` 同级（平台级身份事件归 SDK，不归插件 augmentation）。

### 4.2 奖励参数只能落自定义模型

- 证据：`PluginContext`（`packages/sdk/src/plugin.ts:558-660`）**没有** settings/config 访问器；
  插件设置只有前端包能读（`apps/web/src/lib/account-frontend.ts` 的 `readPluginSettings`）。
- 结论：奖励金额、开关、触发方式一律放 `referral/config` 自定义模型，后台配置页写入。
  放插件设置 UI 会出现「管理员改了但不生效」的两套真相。

### 4.3 `order.paid` 需要带上 `ordererId`

按「首单支付后发」，推广插件必须知道**下单人是谁**才能反查归因行。

- 现有 payload 声明（`packages/sdk/src/plugin.ts:183-189`）：`{ orderId, channelCode?, status?, total?, currency? }` —— 没有下单人。
- 四个发布点，下单人均在作用域内，改动极小：

| 发布点 | 现有 payload | 下单人来源 |
|---|---|---|
| `packages/plugins/store/src/orders.ts:230`（钱包即时支付） | `{ orderId: order.id }` | `order.userId` |
| `packages/plugins/store/src/orders.ts:410`（外部结算回调） | `{ orderId: payment.orderId }` | `payment.userId`（`ResolvedPaymentSettlement.userId`，`packages/sdk/src/plugin.ts:541`） |
| `packages/plugins/store/src/operations.ts:140` | `{ orderId, channelCode }` | `order.userId` |
| `packages/plugins/store/src/renewal.ts:118`（续费） | `{ orderId: order.id }` | `order.userId` |

- 改法：payload 统一增加 `userId`，并在 `PlatformEvents` 的 `order.paid` 类型里声明。
- 兜底：即便漏改某处，推广插件仍可用事件里的 `orderId` 反查订单行；但**下单人未声明则无法反查**，
  所以这处改动是硬要求。

### 4.4 发奖直接调用内核钱包，不经钱包插件

分层真相（已查证）：

- `apps/api/src/plugin-host.ts:99` — `const walletService = new WalletService({ db: getPrisma() })`
- `apps/api/src/plugin-host.ts:111/128/160` — 该实例作为 `wallet` 注入每个插件的 `PluginContext`
- `packages/sdk/src/plugin.ts:579` — `readonly wallet: WalletService`，必选字段

即**钱包是内核服务，不是钱包插件提供的能力**。`store-wallet` 插件同样只调
`context().wallet`（`packages/plugins/store-wallet/src/index.ts`），它拥有的是充值、明细页、
管理端调账这层界面与编排。

因此 referral **不得**绕道钱包插件的 HTTP 路由，理由：

| | 直接 `ctx.wallet.credit()` | 走钱包插件 HTTP |
|---|---|---|
| 调用成本 | 一个方法调用 | 身份、错误码、网络转发 |
| 事务 | 可传 `tx`，与归因落库同事务（`apps/api/src/wallet/wallet-service.ts:352` 的 `tx?` 参数） | 跨进程，只能最终一致 |
| 幂等 | 内核 `@@unique([referenceType, referenceId])`（`packages/db/prisma/schema.prisma:292`） | 同样，但多一层转发 |
| 新增代码 | 0 | 路由 + 服务发现 + 权限 |

`inject`（`packages/sdk/src/plugin.ts:648`）用于 `provide()` 发布的跨插件命名服务，
与内核注入的 `wallet` 字段无关，故 referral 不需要 `inject`；因订阅 store 的 `order.paid`，
manifest 声明 `requires: [{ id: 'store', range: '^0.3.0' }]` 即可（同 store-wallet）。

**顺带补一处对账体验**：钱包明细页的 `type` 标签表只有
`TOP_UP` / `ORDER_PAYMENT` / `ORDER_REFUND` / `ADMIN_ADJUST` / `llm_gateway_usage`
（`packages/plugins/store-wallet/frontend/src/overview.tsx:18-21`），渲染规则是
`entry.note ?? entryLabels[entry.type] ?? '余额变动'`（同文件 `:122`）。我们 credit 时带
`note: '推广奖励 <code>'`，会正确显示；若要更干净，给该表加一行 `referral: '推广奖励'`。

## 五、数据模型（自定义模型，内核自动建表 `ext_referral_*`）

依据 `packages/sdk/src/models.ts:35` 的 `CustomModelDefinition`；索引只支持顶层路径；
状态字段命名为 `state`（`status` 会被 `updateWhere` 特殊映射）。

> ⚠️ **本节已按实际实现（`packages/plugins/referral/src/data.ts`）校正**。原设计列了 4 个模型
> （含 `referral/click`）与若干字段，实际落地为 **3 个模型**，字段以代码为准。

### 5.1 `referral/code` — 推广码

| 字段 | 类型 | 说明 |
|---|---|---|
| `code` | string | 9 位随机短码（排除易混字符），**唯一索引** |
| `ownerId` | string | 推广人 userId，**索引** |
| `label` | string | 渠道备注，默认 `''` |
| `state` | string | `active` / `disabled`，**索引** |
| `rewardAmount` | number \| null | 覆盖全局金额（分），`null` 表示跟随全局 |
| `signupCount` | number | 该码成功注册数；声明成**索引**只为让 `updateWhere` 的 `inc` 原子自增可用 |

索引：`code` 唯一；`ownerId`、`state`、`signupCount`。
刻意**不声明 `cacheTtlMs`**：停用必须立刻生效（归因是写路径）。

### 5.2 `referral/record` — 归因与发奖（核心账本）

| 字段 | 类型 | 说明 |
|---|---|---|
| `code` | string | 命中的码 |
| `inviterId` | string | 推广人 userId，**索引** |
| `inviteeId` | string | 被邀请人 userId，**唯一索引**（一人只被归因一次） |
| `inviteeEmail` | string | 便于后台核对，默认 `''` |
| `trigger` | string | 发奖时点**快照**：`register` / `first_order` / `register_frozen` |
| `inviterState` | string | `pending` / `paid` / `rejected`，**索引** |
| `inviteeState` | string | `none` / `paid` |
| `freezeUntil` | number | 冻结截止（epoch ms），0 表示不等冻结，**索引** |
| `rewardAmount` | number | 实际发放给推广人的额度（分，快照） |
| `inviteeRewardAmount` | number | 被邀请人实发额（分） |
| `registerIp` | string | 注册来源 IP，**索引**（防刷） |
| `qualifiedOrderId` | string \| null | 触发首单奖励的订单 |
| `qualifiedAt` | string \| null | 达标时间 |
| `paidAt` | string \| null | 发奖时间 |

索引：`inviteeId` 唯一（幂等基石）；`inviterId`、`inviterState`、`registerIp`、`freezeUntil`。

### 5.3 点击流水 — **一期未实现**

原设计的 `referral/click` 已砍掉。渠道漏斗分析 / 更强防刷留待二期。

### 5.4 `referral/config` — 奖励配置（单行模型，实例名固定 `default`）

| 字段 | 类型 | 默认 |
|---|---|---|
| `enabled` | boolean | `true` |
| `trigger` | string | **`first_order`**（`register` / `first_order` / `register_frozen`） |
| `rewardAmount` | number | 推广人全局固定金额（分） |
| `inviteeRewardAmount` | number | 被邀请人注册送额（分），0 表示不发 |
| `freezeDays` | number | 冻结天数，仅 `register_frozen` 用 |
| `cookieDays` | number | 归因有效期，默认 `30`（仅前端提示文案用） |
| `maxInvitesPerUser` | number | 单账号邀请上限，0 表示不限 |
| `sameIpLimit` | number | 同 IP 允许的归因数，默认 `1`，0 表示不限 |
| `currency` | string | `CNY` |

> 说明：单行实例名是 `name = 'default'`（`config.ts` 的 `CONFIG_NAME`），**不是**模型里的 `key` 字段。
> 该模型声明 `cacheTtlMs: 10_000`（配置可容忍短暂陈旧）。

## 六、触发与发奖规则

`trigger` 三种取值，全由配置决定（用户选择「都支持，可选择」，默认 `first_order`）：

- `register`：`user.registered` 到达即发推广人奖励（秒级归因，易刷）
- `first_order`（**默认**）：`user.registered` 只落 `pending` 归因行；
  被邀请人首个 `order.paid` 到达时转 `qualified` 并发奖
- `register_frozen`：注册即记，`pending`，由定时任务在 `freezeDays` 后无异常则解冻发奖

被邀请人奖励与 trigger 无关，注册归因成功即发（走 `inviteeRewardAmount`）。

### 幂等

发奖一律走内核钱包，依赖既有唯一约束天然幂等：

```
packages/db/prisma/schema.prisma model WalletLedgerEntry
  @@unique([referenceType, referenceId])
```

调用形态：

```ts
await ctx.wallet.credit(inviterId, amount, currency, {
  type: 'referral',
  referenceType: 'referral/record',
  referenceId: `${recordId}:inviter`,
  note: `推广奖励 ${code}`,
});
```

`referenceId` 用 `recordId:inviter` / `recordId:invitee` 区分两侧，避免互相顶掉唯一键。
重复投递（事件总线重复消费）只会撞唯一约束，不会重复入账。

### 退款冲正（二期）

`packages/plugins/store/src/refund.ts:85` 已发布 `order.refunded { orderId, amount, userId }`
（但该主题尚未在 `PlatformEvents` 声明）。二期的「首单退款则撤回奖励」订阅此事件，
用 `wallet.adjust` 负数调账。一期先不撤回，登记为已知缺口。

## 七、路由与前端

### 7.1 后端路由（`packages/plugins/referral/src/index.ts`）

权限：新增 `store.referral`（用户级），管理端复用 `store.admin`。

> ⚠️ **本节已按实际实现校正**：落地为 **7 条**路由（原设计 8 条）。写配置由 `PUT` 改为 `POST`
> —— `PluginActionDefinition.method` 只允许 `POST | PATCH | DELETE`，`PUT` 无法声明为前端 action。
> 合并了原 `/referral/codes`（GET）与 `/referral/me`：码列表与概览统一由 `/referral/me` 返回。

| 方法 | 路径 | auth | 权限 | 说明 |
|---|---|---|---|---|
| GET | `/referral/me` | user | `store.referral` | 我的推广概览（码列表 + 邀请数/待发/已发） |
| POST | `/referral/codes` | user | `store.referral` | 新建码（可带 label） |
| PATCH | `/referral/codes/:id` | user | `store.referral` | 改备注 / 启用停用 |
| GET | `/store/admin/referrals` | admin | `store.admin` | 推广人汇总 + 归因明细（分页） |
| GET | `/store/admin/referrals/config` | admin | `store.admin` | 读配置 |
| POST | `/store/admin/referrals/config` | admin | `store.admin` | 写配置（原设计为 PUT） |
| POST | `/store/admin/referrals/adjustments` | admin | `store.admin` | 手动调账（`wallet.adjust` 语义） |

### 7.2 前端包（`packages/plugins/referral/frontend/`）

参照 `packages/plugins/store-wallet/frontend/` 的 `manifest.json` 形态：

- `finders`: `referral.mine`、`referral.adminList`
- `accountRoutes`: `/referral` →「我的推广」，nav group「推广」，`data: [{ finder: 'referral.mine', as: 'referral' }]`
- `adminRoutes`: `/referrals` →「推广管理」，nav group「商店插件」
- `adminActions`: 调账（`POST`，字段 `email`/`amount`/`note`），复用 `wallet.adjust` 语义
- `actions`: 新建码 / 复制链接（链接由前端拼接 `?affid=<code>`）

强制约束（`apps/web/AGENTS.md`）：仅 Tailwind + shadcn/ui，禁止自定义 CSS 与内联 `style`；
Base UI 无 `asChild`，按钮做链接用 `<Button render={<Link href="..." />} />`。
写代码前必须先读 `apps/web/node_modules/next/dist/docs/` 相关指南。

## 八、防刷

1. **同 IP 限一次**：`user.registered` 携带 `ip`，与 `referral/config.sameIpLimit` 比对，
   超限则归因行标 `rejected`，不发奖（记录保留供后台排查）。
2. **单账号邀请上限**：`maxInvitesPerUser`，超限不再接受新归因。
3. **自己邀请自己**：`inviterId === inviteeId` 直接拒绝。
4. **首次点击固定归因**：`referral/record.inviteeId` 唯一索引保证不会被二次覆盖。
5. 登录插件已有的注册限流（`packages/plugins/login/src/index.ts:106-111`，默认 5 次/分钟）
   继续生效，不重复造。

## 九、后台任务

- `register_frozen` 模式：`ctx.jobs.schedule` 周期扫描 `pending` 且超 `freezeDays` 的
  `referral/record`，解冻发奖（集群只跑一次，ADR-0013）。
- `cookieDays` 之外的过期点击清理（可选，一期不做）。

## 十、需要产出的文件

```
packages/plugins/referral/
├── package.json                     # stackpanel.builtin = true
├── tsconfig.json / tsconfig.build.json
├── src/
│   ├── index.ts                     # definePlugin：manifest/routes/eventListeners/customModels
│   ├── context.ts                   # bindContext / context / resetContext（仿 store-wallet）
│   ├── data.ts                      # 3 个 defineModel（code / record / config）
│   ├── codes.ts                     # 码生成（随机短码）+ CRUD
│   ├── attribution.ts               # user.registered 处理 + 归因落库
│   ├── rewards.ts                   # order.paid 处理 + wallet.credit
│   ├── config.ts                    # referral/config 读写与默认值
│   └── errors.ts
└── frontend/
    ├── package.json / manifest.json
    └── src/index.tsx                # account + admin 组件、finders、actions
```

以及三处外部改动：

- `packages/plugins/login/src/index.ts`（affid 字段 + 发布事件）
- `packages/sdk/src/plugin.ts`（声明 `user.registered`，`order.paid` 增加 `userId`）
- `packages/plugins/store/src/{orders,operations,renewal}.ts`（四处 payload 补 `userId`）
- `apps/web/src/proxy.ts`（捕获 `?affid=` 写 cookie）
- `apps/web/src/lib/actions.ts` + register 页面/表单（透传 affid）
- `packages/sdk/src/client.ts`（`register(email, password, affid?)`）

## 十一、实施顺序（建议）

1. SDK 事件声明 + store 四处 payload 补 `userId`（不改行为，可独立验收）
2. login 插件 affid 入参与 `user.registered` 发布
3. Web 侧：proxy cookie + 注册表单透传 + `api.register` 三参
4. referral 后端插件：模型 → 归因 → 发奖
5. referral 前端包：账户页 + 管理页
6. 配置页与调账兜底
7. （二期）退款冲正、点击流水、百分比奖励

## 十二、未决与风险

| 项 | 说明 | 建议 |
|---|---|---|
| 退款冲正 | 首单退款后奖励不撤回，一期为已知缺口 | 二期订阅 `order.refunded` |
| 百分比奖励 | 已确认一期只做固定金额 | 配置项预留 `trigger`/`rewardAmount` 结构可扩展 |
| `order.refunded` 未声明类型 | 该事件已在发布但不在 `PlatformEvents` | 二期补声明 |
| 多币种 | 奖励币种固定配置值，与订单结算币种可能不同 | 一期固定 `CNY`，多币种留待需求 |
| 同设备识别 | 只用 IP，无法识别同 IP 多设备 | 接受，严格模式再加设备指纹 |
| 插件设置可读性 | 后端读不到插件设置是内核级限制 | 已绕开（配置入模型）；若长期需要，另开 ADR |
