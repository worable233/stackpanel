# 推广（Referral）插件 · 交接文档

> 接手对象：任何新会话 / 新 Agent。
> 起始 commit：`2dc9d8d feat(wallet): pre-authorize gateway spend so concurrent requests stop sharing one balance`（HEAD）
> 设计定稿：[docs/design/referral-plugin.md](<docs/design/referral-plugin.md>)（348 行，先读它）
> 本文件只讲「已经做到哪、还剩什么、有哪些坑」。

---

## 0. 一句话现状

**后端 + 前端包均已完成并构建通过；四处外部接缝（SDK / store / login / Web）全部落地；端到端联调（§3.3）已完成，过程中发现并修复 2 个真实 bug（§3.4）。** 前端产物已 seed 到 `data/plugins/referral/frontend/`，两个 registry 均已生成 referral 条目。

---

## 1. 需求原话（不可曲解）

- User said (m00001): 「你看看能不能写一个推广插件。作用就是可以让每个用户推广，创建链接，带 ?affid= 这种，通过这个链接注册的账号可以让用户或者推广金额或者其他奖励。类似于这种，你先设计，给我几道选择题问我的想法」
- User said (m00597): 「referral-plugin.md 开始制作。前端也需要使用 shadcn 标准的组件，不能乱写样式。要符合开发规范」

### 两轮选择题（共 15 题）已确认的决策

| 议题 | 结论 |
|---|---|
| 奖励形式 | 账户余额（平台内闭环），单位分，显示 `(amount/100).toFixed(2)` |
| 触发时点 | **可配置三档**：`register`（注册即发）/ `first_order`（默认，首单支付后发）/ `register_frozen`（冻结 N 天后解冻发） |
| 归因规则 | **仅单层**，首次点击固定归因（同浏览器第二次点击不覆盖），30 天 cookie |
| 推广码 | 每用户**多个码**，可分渠道备注；8–10 位随机短码，不暴露 userId、不可枚举 |
| 入口 | `/account` 下「我的推广」页（复用 account-frontend 槽位）+ 一键复制链接按钮 |
| 二维码 | **不做**，只复制链接（不引新依赖） |
| 防刷 | 同 IP 超限、单账号邀请上限、不能邀请自己 |
| 后台 | 必须：看每个推广人的邀请数/奖励额，并可**手动调账**兜底 |
| 前端规范 | 只用 Tailwind + shadcn/@stackpanel/ui，禁自定义 CSS 与内联 style |

---

## 2. 已完成（不要再重做）

### 2.1 后端插件 `packages/plugins/referral/`（8 个源文件，~1058 行，✅ tsc 通过）

```
packages/plugins/referral/
├── package.json          name @stackpanel/plugin-referral, "stackpanel": {"builtin": true}
├── tsconfig.json / tsconfig.build.json
└── src/
    ├── index.ts      (418)  definePlugin：manifest/routes/eventListeners/customModels/onActivate
    ├── data.ts       (133)  三个 defineModel
    ├── codes.ts      (131)  短码生成 + CRUD
    ├── attribution.ts(124)  user.registered 处理 + 归因落库
    ├── rewards.ts    (168)  发奖（wallet.credit）+ 幂等
    ├── config.ts      (35)  referral/config 读写
    ├── errors.ts      (29)  ReferralPluginError + 稳定码映射
    └── context.ts     (20)  bindContext / resetContext / context()
```

**验证命令（必须带本地 tsc 到 PATH，见 §5 坑 1）：**

```bash
cd packages/plugins/referral
./node_modules/.bin/tsc -p tsconfig.json --noEmit          # ✅ 无输出 = 通过
PATH="$PWD/node_modules/.bin:$PATH" node ../../../scripts/build-plugin.mjs   # ✅ 产出 dist/index.js (26.9kb)
node -e "import('./dist/index.js').then(m=>console.log((m.default??m).manifest.id, (m.default??m).routes.length))"
# → referral 7
```

### 2.2 三个自定义模型（`src/data.ts`）

| kind | 关键字段 | 索引 |
|---|---|---|
| `referral/code` | `ownerId, code, label, state(active\|disabled), rewardAmount(可空覆盖), signupCount` | `code` **unique**、`ownerId`、`state`、`signupCount`(integer，仅为让 `updateWhere` 的 `inc` 可用) |
| `referral/record` | `code, inviterId, inviteeId, inviteeEmail, trigger(快照), inviterState(pending\|paid\|rejected), inviteeState(none\|paid), freezeUntil(ms), rewardAmount, inviteeRewardAmount, registerIp, qualifiedOrderId, qualifiedAt, paidAt` | `inviteeId` **unique**、`inviterId`、`inviterState`、`registerIp`、`freezeUntil`(integer) |
| `referral/config`（单行 `name='default'`） | `enabled, trigger, rewardAmount, inviteeRewardAmount, freezeDays(7), cookieDays(30), maxInvitesPerUser(0), sameIpLimit(1), currency('CNY')` | `enabled`(boolean)，`cacheTtlMs: 10_000` |

> ⚠️ 设计文档 §5 里写了 4 个模型（含 `referral/click`），实际实现砍到 3 个。**以代码为准**。
> ⚠️ `referral/code` **刻意不声明 `cacheTtlMs`**：停用推广码必须立刻生效，归因是写路径。
> ⚠️ 生命周期字段必须叫 `state` 不能叫 `status`（内核 `updateWhere` 把 `status` 特殊映射到内建列）。

### 2.3 后端 7 条路由（`src/index.ts:356-406`）

| 方法 | 路径 | auth | permission |
|---|---|---|---|
| GET | `/referral/me` | user | `store.referral` |
| POST | `/referral/codes` | user | `store.referral` |
| PATCH | `/referral/codes/:id` | user | `store.referral` |
| GET | `/store/admin/referrals` | admin | `store.admin` |
| GET | `/store/admin/referrals/config` | admin | `store.admin` |
| POST | `/store/admin/referrals/config` | admin | `store.admin` |
| POST | `/store/admin/referrals/adjustments` | admin | `store.admin` |

> ⚠️ 设计文档 §7.1 列了 `GET /referral/codes` 与 `GET /store/admin/referrals/records`，**实际未实现**（前者由 `/referral/me` 一并返回 codes；后者由 `/store/admin/referrals` 承担）。前端 finder 只调这 7 条。
> ⚠️ 写配置路由原设计为 `PUT`，实现时改成 **`POST`**：前端 mutation 只能走 `PluginActionDefinition`，其 `method` 枚举只允许 `POST | PATCH | DELETE`（`packages/sdk/src/frontend.ts:421`、`packages/sdk/src/schemas.ts:632`），`PUT` 无法声明成前端 action。改 / 回退时两处（`src/index.ts` 路由表 + 前端 `actions` 声明）必须同时改。

**响应形状（前端 finder 的 zod schema 必须逐字对齐）：**

`GET /referral/me` →
```ts
{
  config: { enabled, trigger, rewardAmount, inviteeRewardAmount, cookieDays, currency },
  codes: [{ id, code, label, state, rewardAmount, signupCount, createdAt }],   // ≤200
  invites: [{ id, code, inviterId, inviteeId, inviteeEmail, trigger,
              inviterState, inviteeState, rewardAmount, inviteeRewardAmount,
              createdAt, paidAt }],                                             // ≤50, createdAt desc
  stats: { totalInvites, paidInvites, earnedAmount, balance }
}
```

`POST /referral/codes` body `{ label?≤40, rewardAmount? int 0..2e9 | null }` → `{ code: <CodeView> }`
`PATCH /referral/codes/:id` body `{ label?, state? 'active'|'disabled', rewardAmount? }` → `{ code: <CodeView> }`
`GET /store/admin/referrals` → `{ total, records: [<RecordView> & {inviterEmail}], inviters: [{inviterId, inviterEmail, paidAmount}], currency }`（固定 page=1, pageSize=200，**无分页入参**）
`GET /store/admin/referrals/config` → `{ config: <完整 ReferralConfig> }`
`POST /store/admin/referrals/config` body = `configInputSchema`（9 个必填字段，见 `src/index.ts:43-53`）→ `{ config }`
`POST /store/admin/referrals/adjustments` body `{ email, amount int -2e9..2e9, note 1..191 }` → `{ ok: true }`

### 2.4 归因与发奖逻辑（已实现，勿改语义）

- `attribution.ts`：`findActiveCode` → 拒绝自我推广（`code.ownerId === userId`）→ 已有 record 直接 return（**首次点击固定**）→ `checkRisk`（`maxInvitesPerUser` 数 `inviterState='paid'`、`sameIpLimit` 数 `registerIp`）→ `extensions.create(recordModel, spec, { name: userId, ownerId: inviterId })`（实例名 = 被邀请人 id + `inviteeId` 唯一索引双重保证一人一条）→ `awardInvitee`（**与 trigger 档位无关，注册归因成功即发**）→ 被拒则 return → `trigger==='register'` 才 `awardInviter` → `bumpSignupCount`。全程 try/catch 只记日志。
- `rewards.ts`：`REFERRAL_REFERENCE_TYPE='REFERRAL'`；两个账本 type = `REFERRAL_REWARD` / `REFERRAL_INVITEE_REWARD`；幂等 `referenceId = ${recordId}:inviter` / `${recordId}:invitee`（靠内核 `@@unique([referenceType, referenceId])`）；`settleRecord` 在 `ctx.tx()` 内同时写 record 与 `wallet.credit`（同事务提交/回滚），命中 P2002 只补状态不重复入账。
- 首单：`onOrderPaid` 要求 `record.spec.trigger === 'first_order' && inviterState === 'pending' && config.enabled`，再 `qualifyByOrder`。
- 冻结：`unfreezeSweep` 用 `extensions.page`（limit 100，最多 20 页）扫 `inviterState='pending' && freezeUntil <= now`，跳 `freezeUntil <= 0`，逐条 try/catch。`startUnfreezeSchedule` 用 `jobs.handle` + `jobs.schedule(UNFREEZE_JOB, { everyMs: 3_600_000 })`（ADR-0013 集群只跑一次）。

### 2.5 四处外部接缝（全部落地，✅ `pnpm typecheck` 全绿）

1. **`packages/sdk/src/plugin.ts`**
   - `PlatformEvents` 新增 `'user.registered': { userId, email, affid?: string | null, ip?: string | null }`（`:188`）
   - `'order.paid'` 新增 `userId?: string`
2. **`packages/sdk/src/client.ts:393`** — `register(email, password, affid?: string | null)`，`post('/register', {email, password, ...(affid ? {affid} : {})})`
3. **`packages/plugins/store/src/`** — **6 处** `order.paid` 发布点全补 `userId`（设计文档只列了 4 处）：
   - `orders.ts:230`、`orders.ts:421`、`operations.ts:152`、`renewal.ts:118`、`changes.ts:228`、`changes.ts:262`
4. **`packages/plugins/login/src/index.ts`** — `registerSchema` 加 `affid: z.string().trim().max(64).optional()`（`:18`）；`:142` 在 issueSession + 审计之后 `events.publish('user.registered', {userId, email, affid: affid ?? null, ip: req.ip ?? null})`
5. **Web 侧**
   - `apps/web/src/lib/affiliate.ts`（新建）：`AFFILIATE_COOKIE = process.env.AFFILIATE_COOKIE_NAME ?? 'sp_aff'`、`normalizeAffiliateCode()`（`/^[A-Za-z0-9_-]{1,64}$/`）
   - `apps/web/src/proxy.ts`：读到 `?affid=` 且**尚无 cookie** 时写 `AFFILIATE_COOKIE`，maxAge = `AFFILIATE_COOKIE_DAYS ?? 30` 天；用 `withAffiliate()` 包住全部 5 个 return 分支 + catch
   - `apps/web/src/lib/actions.ts`：`readAffiliateCode(formData)`（先 cookie 后表单字段）；`registerAction` 三参调用；成功后 `store.delete(AFFILIATE_COOKIE)`
   - `apps/web/src/app/(auth)/register/page.tsx`（cookie 优先、query 兜底）+ `register-form.tsx`（渲染 `<input type="hidden" name="affid" />`）

> ⚠️ **已知缺口（设计文档 §12 记为二期）**：`apps/api/src/routes/auth-oauth.ts:187` 的 OAuth 建号路径（`tx.user.create`）**不发布 `user.registered`**，OAuth 注册无法归因。

---

## 3. 完成情况与剩余工作

### 3.1 前端包 `packages/plugins/referral/frontend/`（✅ 已完成）

已产出（构建通过，probe 成功序列化 manifest）：

```
packages/plugins/referral/frontend/
├── package.json          # @stackpanel/plugin-referral-frontend（照抄 store-wallet）
├── manifest.json         # 由 build-frontend.mjs 生成，勿手写
└── src/
    ├── schemas.ts        # 账户页/管理页共用的 zod 响应 schema（= §2.3 响应形状）
    ├── index.tsx         # 服务端：finders + accountPages + adminRoutes + actions
    ├── route-progress.tsx# 'use client'：CopyLinkButton（文件名被构建脚本特判，见 §4）
    └── admin.tsx         # 'use client'：export const adminPages
```

**直接仿写对象：** `packages/plugins/store-wallet/frontend/src/index.tsx`（352 行）与 `admin.tsx`（40 行）。

**前端包必须遵守的硬约束：**

- **只能 import 这些外部包**：`react`、`react/jsx-runtime`、`next/link`、`next/form`、`next/navigation`、`@stackpanel/sdk`、`@stackpanel/ui`、`zod`、`lucide-react` + 自身相对文件（`./xxx`）。**不能 import `apps/web/src/components/ui` 下的 shadcn 组件**（不在 external 列表、无路径别名）。
- **`@stackpanel/ui` 没有 Table / Badge / Tabs / Progress / Separator / Textarea / Alert**。表格要用 Tailwind utility + `Card` 自拼；状态徽标用 `StatusBadge { tone: 'ok'|'warn'|'error'|'neutral' }`。
- **Base UI 无 `asChild`**：链接按钮写 `<Button variant="ghost" render={<Link href="/account" />}>…</Button>`。
- **禁自定义 CSS 与内联 `style`**（`apps/web/AGENTS.md` 硬规则），只用 Tailwind utility class。
- `index.tsx` **不要加 `'use client'`**（否则 finders 也会被当客户端模块）。
- `tsconfig.base.json` 开了 **`exactOptionalPropertyTypes`**：可选属性必须条件展开 `...(x ? {k:x} : {})`。
- 必须 `export const frontend: FrontendPackage = {...}` 和 `export default frontend;`（probe 靠 `mod.frontend ?? mod.default`）。
- 金额单位分：`(amount/100).toFixed(2)`；日期 `new Date(v).toLocaleString('zh-CN')`。

**已声明的内容（`frontend/manifest.json` 可逐字核对）：**

```ts
finders: { 'referral.mine', 'referral.adminList', 'referral.adminConfig' }
// accountRoutes:
{ path: '/referral', component: 'account/referral', permission: 'store.referral',
  nav: { label: '我的推广', group: '推广', order: 20 },
  data: [{ finder: 'referral.mine', as: 'referral' }] }
// adminRoutes:
{ path: '/referrals', component: 'admin/referrals', permission: 'store.admin',
  nav: { label: '推广管理', group: '商店插件' },
  data: [{ finder: 'referral.adminList', as: 'referral' },
         { finder: 'referral.adminConfig', as: 'referralConfig' }] }
// actions（表单 mutation，注意与后端路由 method+path+permission 三者严格一致）：
{ id: 'referral.create-code',    method: 'POST',  path: '/referral/codes',      permission: 'store.referral', input: [{name:'label',type:'string',maxLength:40},{name:'rewardAmount',type:'integer',min:0,max:2e9}] }
{ id: 'referral.toggle-code',    method: 'PATCH', path: '/referral/codes/:id',  permission: 'store.referral', input: [{name:'id',type:'string',required:true,maxLength:191},{name:'state',type:'string',required:true,maxLength:16}] }
{ id: 'referral.save-config',    method: 'POST',  path: '/store/admin/referrals/config', permission: 'store.admin', input: [...9 个必填字段...] }
{ id: 'referral.adjust',         method: 'POST',  path: '/store/admin/referrals/adjustments', permission: 'store.admin', input: [{name:'email',type:'string',required:true,maxLength:191},{name:'amount',type:'integer',required:true,min:-2e9,max:2e9},{name:'note',type:'string',required:true,maxLength:191}] }
// adminActions：留空（本次未用纯组件槽位）
```

**accountPages 里的组件是服务端组件**，不能有 `useState`/`onClick`；要按钮就写 `<form action={props.actions?.['referral.create-code']}>` + `<input type="hidden">`（store-wallet 的 cancel-topup 就是这个写法）。已如此实现（创建码 / 启停码 / 保存配置 / 调账都是这种表单）。

> ⚠️ **`money` 输入类型不会接受负数/小数**：`coerceField` 对 `type:'money'` 走 `^(0|[1-9]\d*)(\.\d{1,2})?$` 并要求单位为「元」。调账要支持负数，所以用 `type:'integer'`（单位为分）而非 `type:'money'`。
> ⚠️ **写配置用 `POST` 而非 `PUT`**：`PluginActionDefinition.method` 只允许 `POST | PATCH | DELETE`。详见 §2.3 注记。
> ⚠️ **服务端组件里不能 `import` 分出来的 `'use client'` 组件之外的东西**：`CopyLinkButton` 从 `./route-progress.js` 引入（`index.tsx` 顶部 `import { CopyLinkButton } from './route-progress.js';`），构建脚本把它单独打包成客户端模块。

### 3.2 构建（✅ 已执行，改动后需重跑）

```bash
# 1) 后端（会 seed 到 data/plugins/referral/）
cd packages/plugins/referral && PATH="$PWD/node_modules/.bin:$PATH" node ../../../scripts/build-plugin.mjs

# 2) 前端（会重写 apps/web/src/lib/frontend-registry.ts 与 frontend-client-registry.ts）
node scripts/build-frontend.mjs        # 从 repo root
```

`build-frontend.mjs` 会自动：把 `packages/plugins/referral/frontend/src/index.tsx` esbuild 成 `dist/index.js`；`src/admin.tsx` 额外成 `dist/admin.js`、`src/route-progress.tsx` 额外成 `dist/route-progress.js`（均 platform neutral，route-progress 带 `use client` banner）；probe 出 `FrontendPackage` 后序列化 `frontend/manifest.json`；把 dist 拷到 `data/plugins/referral/frontend/dist`；在两个 registry 追加 `plugins/referral` 条目。

**构建后检查（本次已全部通过）：**
- `data/plugins/referral/frontend/manifest.json` 里 `accountRoutes` / `adminRoutes` / `actions`（4 条）`finders`（3 个）都在
- `apps/web/src/lib/frontend-registry.ts` 有 `plugins/referral` 条目
- `apps/web/src/lib/frontend-client-registry.ts` 有 `plugins/referral` 条目
- `dist/index.js` 里 `import { CopyLinkButton } from "./route-progress.js"` 且 `dist/route-progress.js` 首行是 `"use client";`（双写属正常：源码指令 + 构建 banner，与 default 主题产物一致）

### 3.3 联调与测试（✅ 已完成）

**结果：全部通过；过程中发现并修复 2 个真实 bug（下方 §3.4）。**

- 端到端：带 `?affid=XXX` 注册 → `referral/record` 落库 + 被邀请人余额入账；`first_order` 档被邀请人首单支付 → record 转 `paid` + 推广人第二次入账 ✅
- 幂等：同一 record 重复投递 `order.paid` 不重复入账（ledger 计数稳定）✅
- 防刷：同 IP 超限归因标 `rejected`；自邀在代码层拒绝 ✅
- 三档 trigger 各跑一遍：`register`（当日发双份）、`first_order`（下单后发）、`register_frozen`（落 `pending` + `freezeUntil`，解冻扫描后转 `paid`）✅
- 前端：账户页 `/account/referral` 渲染（统计卡 / 奖励规则 / 码列表 / 邀请记录 / 新建码 / 停用启用 / 复制链接）✅；管理页 `/admin/plugin/referral/referrals` 渲染（配置表单 / 推广人汇总 / 归因明细 / 手动调账）✅；钱包明细页正确显示「推广奖励」标签 ✅

### 3.4 联调中发现并修复的 bug（3 个）

1. **`register` 档位推广人奖励永远发不出（乐观锁冲突被静默吞掉）**
   - 现象：`register` 档归因后 `inviterState` 停在 `pending`，只有被邀请人奖励入账。
   - 根因：`attributeRegistration` 先 `awardInvitee(record)`（把 record 版本 1→2），紧接着用**陈旧的 `record`** 调 `awardInviter`，`extensions.update` 的 `expectedVersion` 不匹配 → `ExtensionVersionConflict` 被外层 try/catch 吞掉。
   - 修复：`packages/plugins/referral/src/rewards.ts` 新增 `latestRecord()`，`awardInviter` / `awardInvitee` 写前各自重读最新版本。

2. **`register_frozen` 档位归因整条失败（int4 溢出）**
   - 现象：`register_frozen` 注册后 record 不落库（静默失败），冻结档完全不工作。
   - 根因：`freezeUntil` 存 epoch ms（≈1.7e12），但索引列声明为 `integer` → PostgreSQL `int4` 上限 2.1e9，插入 `out of range`。
   - 修复：`packages/plugins/referral/src/data.ts` 把 `freezeUntil` 索引列由 `integer` 改为 `number`（double precision），与 store 插件 `expiresAtMs` 同款。
   - 注意：内核迁移器**不支持改列类型**。dev 库已 drop 旧的 `ext_referral_*` 表让内核以新类型重建；生产若已有数据需手工 `ALTER TABLE … ALTER COLUMN f_freezeUntil TYPE double precision`（或 drop 重建，一期尚无生产数据）。

3. **风控拒绝仍发被邀请人奖励（与设计文档 §8 相悖，且留刷单口子）**
   - 现象：`rejected`（同 IP 超限 / 超邀请上限）时归因行虽标 `rejected`，但代码先 `awardInvitee` 再 `return`，被邀请人仍拿到注册奖励 → 同一 IP 反复注册可无限领取被邀请人奖励。
   - 修复：`packages/plugins/referral/src/attribution.ts` 把 `if (rejected) return;` 提到 `awardInvitee` **之前**，两侧均不发奖，只保留记录供后台排查。
   - 回归测试：`packages/plugins/referral/src/referral.test.ts`（新增，8 个用例覆盖上述三个 bug + 三档 trigger + 幂等 + 自邀 + 单码覆盖）。

---

## 4. 复制链接按钮的实现方案（✅ 已按此实现）

插件前端有**三个固定构建入口**，`'use client'` 的交互组件只能走其中两条：

1. `frontend/src/admin.tsx`（额外构建 `dist/admin.js`，写入 client registry）— **只有它导出的 `adminPages` 能在客户端渲染**
2. `frontend/src/route-progress.tsx`（额外构建 `dist/route-progress.js` 并自动加 `--banner:js="use client";`，external 只有 react / react-jsx-runtime / next-navigation）— 这是给**账户页**加交互的既有唯一口子，范例：`packages/themes/default/frontend/src/route-progress.tsx`（被同目录 `index.tsx:36` 以 `import { RouteProgress } from './route-progress.js'` 引入后在服务端页面渲染）

**已实测的硬约束：`scripts/build-frontend.mjs:63-86` 只对文件名恰好是 `route-progress.tsx` 的文件加 `--banner:js="use client";`。** 任何其它文件名（如 `copy-link.tsx`）**不会**拿到 banner——即使首行写了 `'use client'`，esbuild 也会把指令当普通语句处理，产物不是客户端模块。所以：

- **账户页的「复制链接」的唯一可行方案**：把文件命名为 `frontend/src/route-progress.tsx`（首行 `'use client';`），导出 `CopyLinkButton`，用 `navigator.clipboard.writeText(...)`；在 `index.tsx` 里 `import { CopyLinkButton } from './route-progress.js';` 并渲染进账户页。该文件只能用 `react` / `react/jsx-runtime` / `next/navigation` 三个外部包。
  - 若觉得「route-progress」这个名字语义别扭，改 `scripts/build-frontend.mjs` 支持更多客户端入口是更好的长期方案，但**那是改构建链**，超出本次范围。
- **管理页的复制/表单** → 放在 `admin.tsx` 的 `adminPages` 里，可自由用 hooks（该入口不受文件名限制，因为 `build-frontend.mjs:88-110` 直接对 `admin.tsx` 单独构建）。
- **纯服务端可完成的动作**（创建码、启停码、保存配置、调账）**不需要客户端组件**：写成 `<form action={props.actions?.['referral.create-code']}>` + hidden input 即可。

链接格式：`${window.location.origin}/?affid=${code}`（或用户当前站点根）。

---

## 5. 环境坑（会浪费你时间，先看这里）

1. **`pnpm --filter … build` 会因 `tsc` 不在 PATH 而失败**。`scripts/build-plugin.mjs` 内部 `execSync('tsc …')`，必须把包本地的 `node_modules/.bin` 加到 PATH：
   ```bash
   PATH="$PWD/node_modules/.bin:$PATH" node ../../../scripts/build-plugin.mjs
   ```
2. **`pnpm install` 在 `CI=true` 下会失败**，报的都是**既有环境问题**，与 referral 无关：
   - `packages/spec` 的 tsc 错误：`src/distribution/compatibility.ts(223,42) TS6133 'migrationPathFor' never read`、`(257,32) TS2339 'manifest' 不存在于 never`、`src/distribution/semver.ts(78,21) TS6133 'op' never read`
   - `packages/db` prepare：`EPERM: operation not permitted, utime '…/schema-engine'`
   - 绕过方式：直接在包目录跑 `./node_modules/.bin/tsc -p tsconfig.json --noEmit`
3. **改了 `packages/sdk/src/*` 后必须先 `pnpm --filter @stackpanel/sdk build`**，否则依赖 SDK 的包 typecheck 会报类型不符（它们解析的是 SDK 的 `dist/*.d.ts`）。做 referral 时踩过：store 插件报 6 处 `TS2353: 'userId' does not exist in type`。
4. **`pnpm typecheck`（root）会先跑 `build:frontend`**，若前端 probe 失败会连带失败。
5. **工作区有大量未提交的既有改动**（用户自己在做的 distribution / spike / backend-dashboard 等），**不要 `git stash` 或 `git checkout .`**。本次 referral 相关改动清单：
   - 新增：`packages/plugins/referral/`（含前端 `frontend/`）、`apps/web/src/lib/affiliate.ts`
   - 修改：`packages/sdk/src/{plugin.ts,client.ts}`、`packages/plugins/login/src/index.ts`、`packages/plugins/store/src/{orders.ts,operations.ts,renewal.ts,changes.ts}`（仅 `order.paid` 的 `userId`）、`apps/web/src/{proxy.ts,lib/actions.ts}`、`apps/web/src/app/(auth)/register/{page.tsx,register-form.tsx}`
   - 生成（由 build-frontend.mjs 重写）：`apps/web/src/lib/frontend-registry.ts`、`apps/web/src/lib/frontend-client-registry.ts`、`data/plugins/referral/frontend/*`
6. **插件 dist 必须是真的 bundle**。`tsc` 单独输出的 JS 保留无扩展名的裸相对导入（`'./attribution'`），Node ESM 直接 `Cannot find module`（已实测：`data/plugins/referral/dist/index.js` 在只用 tsc 输出时加载失败）。必须走 `scripts/build-plugin.mjs` 的 esbuild 打包（`packages: 'external'`）。加载方式：`apps/api/src/lib/plugins.ts:672` 用 `pathToFileURL(entry).href + '?v=' + Date.now()` 动态 import。
7. **`data/plugins/referral/` 已被 seed 过**（`dist/` 是旧的 tsc-only 输出、`frontend/` 为空）。重新跑 `build-plugin.mjs` 后需重启 API（`seedBuiltinPlugins` 在启动时按 dist 目录 hash 决定是否重新拷贝）。

---

## 6. 关键内核契约速查

| 需要什么 | 怎么写 | 出处 |
|---|---|---|
| 发余额奖励 | `ctx.wallet.credit(userId, amountMinor, currency, {type, referenceType, referenceId, note}, tx?)` | `packages/sdk/src/wallet.ts`；实现在 `apps/api/src/wallet/wallet-service.ts:353-382` |
| 同事务写数据+发钱 | `ctx.tx(async (tx) => { tx.extensions.update(...); tx.wallet.credit(...) })`（**禁止嵌套**） | `apps/api/src/plugins/runtime.ts:744-782` |
| 幂等 | 账本唯一约束 `@@unique([referenceType, referenceId])` | `packages/db/prisma/schema.prisma:292` |
| 订阅事件 | `PluginDefinition.eventListeners: [{topic, handler}]`（自动随停用注销） | `apps/api/src/plugins/runtime.ts:517-524` |
| 事件订阅者注意 | `publish` **同步广播、不 await handler 的 Promise**，listener 抛错只被 `console.error` 吞掉 ⇒ handler 必须自己 catch 全部异常 | `apps/api/src/plugins/events.ts:31-36` |
| 原子自增计数 | `extensions.updateWhere(model, where, { field: { inc: 1 } })`，**字段必须是已声明的索引字段** | `apps/api/src/extensions/client.ts:657-745` |
| 自定义模型索引 | `indexes: [{ fields: ['x'], unique?, types: { x: 'string'\|'integer'\|'number'\|'boolean' } }]`，只支持顶层字段 | `packages/sdk/src/models.ts:35-77` |
| 定时任务 | `ctx.jobs.handle(name, fn)` + `ctx.jobs.schedule(name, { everyMs })` | `packages/sdk/src/jobs.ts`，ADR-0013 |
| 前端 mutation | 只走 `executePluginAction`：action 的 `method+path+permission` 必须与后端声明路由**三者完全一致**，否则报 `action.pluginInvalidDeclaration` | `apps/web/src/lib/frontend-plugin-action-executor.ts` |
| 插件路由路径 | **插件 id 不是路径前缀**，路由挂在声明的绝对路径上 | `apps/web/src/app/api/plugins/[...path]/route.ts` 头注释 |
| 前端 action 只允许 POST/PATCH/DELETE | `PluginActionDefinition.method` 枚举；`PUT` 声明不了 | `packages/sdk/src/frontend.ts:421`、`packages/sdk/src/schemas.ts:632` |
| `money` 字段不接受负数 | `coerceField` 走 `^(0\|[1-9]\d*)(\.\d{1,2})?$`，单位「元」；要负数用 `integer`（分） | `apps/web/src/lib/frontend-plugin-action-executor.ts:155-168` |
| 内置插件发现 | 各插件 `package.json` 的 `"stackpanel": {"builtin": true}` | `apps/api/src/lib/plugins.ts:41-43`，ADR-0008 D9 |

---

## 7. 未决 / 风险（设计文档 §12 同步）

| 项 | 状态 |
|---|---|
| 退款冲正 | **一期缺口**。首单退款后奖励不撤回。`order.refunded` 已在 `packages/plugins/store/src/refund.ts:85` 发布，但**未在 `PlatformEvents` 声明** |
| 百分比奖励 | 一期只做固定金额。`config.rewardAmount` / `code.rewardAmount` 结构可扩展 |
| 多币种 | 固定配置值 `currency='CNY'`，与订单结算币种可能不一致 |
| 同设备识别 | 只用 IP，同 IP 多设备识别不了 |
| OAuth 注册归因 | **缺口**：`apps/api/src/routes/auth-oauth.ts:187` 不发布 `user.registered` |
| 后端读不到插件设置 | 内核级限制（`PluginContext` 无 settings 访问器），已用 `referral/config` 自定义模型绕开 |
| 设计文档 vs 代码不一致 | **已修正**：`referral-plugin.md` §5 已改为 3 个模型、§7.1 已改为 7 条路由（写配置为 POST 非 PUT），与代码对齐 |

---

## 8. 上手顺序建议

1. 读 [docs/design/referral-plugin.md](<docs/design/referral-plugin.md>) §5–§7 + 本文件 §2–§4
2. 读 `packages/plugins/store-wallet/frontend/src/index.tsx` 与 `admin.tsx`（仿写模板）
3. 读 `packages/plugins/referral/src/index.ts` 的 `toCodeView` / `toRecordView` / 7 条路由（对齐视图字段）
4. 后端与前端包**均已完成并构建通过**，端到端联调（§3.3）也已完成
5. 若需再跑：起 `pnpm dev`，按 §3.3 逐项验证（dev 库若做过清表需先 `prisma migrate deploy` 补齐 `users.emailVerifiedAt` 等迁移）
6. （可选）补 `order.refunded` 二期、修正设计文档与代码的不一致处
