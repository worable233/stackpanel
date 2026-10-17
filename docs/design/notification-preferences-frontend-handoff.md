# 通知偏好（两级）前端交接文档

> 目的：把「通知偏好」的**前端**部分交接给单独会话继续做。
> 后端逻辑层与契约已端到端落地（内核策略引擎 + 目录扩展点 + 用户/管理员 HTTP 接口）。
> 本文说明**现状、契约、语义、落点建议与验收方式**。

---

## 1. 一句话背景

通知系统有**两级**偏好：

- **用户级**（`/notifications/preferences`）：每位用户为每个「通知类型 × 渠道」决定开/关。
- **管理员级**（`/admin/notifications/policy`）：站长设定每个类型的**全局开关**、**默认渠道**、**是否锁定**（锁定后用户不可改）。

最终是否投递由内核 `NotificationPolicyService` 单点裁决。**目录里没有的类型没有配置项，永远投递、不可关闭**（验证码等一次性事务消息本就不走通知服务，天然不受影响）。

前端要做的只有两块 UI：**账户中心的通知偏好页** + **管理员通知策略页**。字节面（投递、重试、站内过滤）全在后端，前端不碰。

---

## 2. 后端已落地的文件（前端只需读契约）

| 文件 | 作用 |
| --- | --- |
| `apps/api/src/routes/notifications.ts` | 用户级接口：`GET/PATCH /notifications/preferences`、`POST /notifications/preferences/reset` |
| `apps/api/src/routes/admin/notifications.ts` | 管理员接口：`GET/PUT /admin/notifications/policy`（`requireRole('ADMIN')` + 审计 `notifications.policy.update`） |
| `apps/api/src/notifications/policy-service.ts` | 内核两级裁决引擎 `KernelNotificationPolicyService`（目录 + 管理员策略 + 用户覆盖） |
| `apps/api/src/notifications/dispatcher.ts` | 外部渠道投递前的偏好闸门（含**认领后二次判定**，关闭后停止重发） |
| `apps/api/src/notifications/notifications-service.ts` | 站内收件箱读取过滤（列表/未读数按用户关闭项排除） |
| `apps/api/src/notifications/stream-hub.ts` | SSE 实时流排除过滤 |
| `packages/sdk/src/notifications.ts` | **全部契约类型** + `INAPP_CHANNEL_ID` |
| `packages/sdk/src/plugin.ts` | 插件侧：`EXTENSION_POINTS.notificationType`、`ctx.notificationPolicy` |

**契约唯一真相 = `packages/sdk/src/notifications.ts`。** 前端做响应解析时照抄这些类型，不要自己发明字段。

---

## 3. 数据模型与核心语义（必须先理解）

### 3.1 概念

- **通知类型（type）**：写入 `notifications.type` 的字符串，例如 `order.paid`、`service.provisioning`、`security.login`、`agent.*`。
- **渠道（channel）**：
  - `inapp`（常量 `INAPP_CHANNEL_ID`）：**合成渠道**，代表「是否进站内收件箱」（铃铛/列表/SSE）。不是插件渠道。
  - 其它渠道 id 由 `notification.channel` 插件注册（如 `smtp` 邮件）。
- **目录（catalog）**：可配置类型的清单。由**内核内建**（`system.*` / `agent.*`）与**插件声明**（`notification.type` 扩展点）合并而成。
  - 声明新增 `audience?: 'user' | 'admin'`（缺省为 user）：管理通知只进入管理员策略目录，不出现在账户偏好中。管理通配目录的子类型继承管理范围。账户读取、保存、重置与历史覆盖的生效裁决均遵守此边界。
  - 目录条目支持**精确类型**或 **`.*` 前缀通配**（如 `system.plugin.*` 匹配 `system.plugin.enable`），解析时**最具体者胜**。
- **一级：管理员策略**（存于 `Setting` 键 `notifications.policy`）：每个目录键可有 `enabled` / `defaultChannels` / `locked`。
- **二级：用户覆盖**（存于 `NotificationPreference` 表，`userId + type + channelId` 唯一）：仅对**仍可配置**的渠道写入。

### 3.2 裁决顺序（`(user, type, channel)`）—— 前端只需理解、无需实现

1. **未声明类型** → 恒为启用（无目录项 = 不可关闭）。
2. **管理员 `enabled:false`** → 该类型所有渠道关闭。
3. **默认渠道** = 管理员 `defaultChannels` ?? 目录 `defaultChannels`；**缺省 = 全部渠道**。
4. **用户覆盖** 仅在渠道**可配置**时生效。
   - 可配置 = `目录 userConfigurable !== false` **且** 管理员 `locked !== true`。

**可配置性对 UI 的意义**：`configurable:false` 的渠道/类型，开关应**只读**（灰显或隐藏），点击不应发请求；即便发了，服务端也会忽略。

### 3.3 「都能关，除了没有配置项的」

- 目录里的类型（含内建 `system.*`、`agent.*` 与插件声明的业务类型）→ **都可关**。
- 目录外的类型 → **不展示、不可关、永远投递**。
- 验证码之类走 `identity`，**根本不进通知表**，与偏好无关。

### 3.4 关键行为

- **站内（`inapp`）关闭不阻断写入**：仍落库，但列表/未读数/SSE 会过滤掉。即「关掉站内 = 收件箱静默，但邮件可能还在」。
- **外部渠道关闭**：`dispatcher` 在投递前判定；若记录已建、用户在重试前才关闭，`deliverOne` 认领后二次判定会**终止记录**（标记 `FAILED`，原因 `接收人已关闭该通知渠道`）。
- **管理员策略 5s TTL 缓存**，写后立即失效；用户覆盖实时读表。
- **失败开放**：策略查询异常时按「投递」处理，绝不因偏好查询失败误拦。

---

## 4. 接口契约（照这个做，别再猜）

> 所有用户级接口需登录（`requireAuth`）；管理员接口需 `ADMIN` 角色。
> Web 侧按现有约定经 BFF（`apps/web/src/app/api/**`）转发，前端组件只调 BFF，不直连内核。

### 4.1 用户级：读取偏好

`GET /notifications/preferences` → `NotificationPreferencesView`

```ts
interface NotificationPreferencesView {
  channels: NotificationChannelInfo[];    // 渠道清单（含 inapp）
  categories: NotificationCategoryInfo[]; // 分组（有序，含中文 label）
  types: NotificationTypePreference[];    // 目录类型 + 该用户解析后的每渠道状态
}

interface NotificationChannelInfo {
  id: string;          // 'inapp' 或插件渠道 id
  name: string;        // 中文名，如 '站内通知' / '邮件'
  inApp: boolean;      // true 仅 inapp
}

interface NotificationCategoryInfo {
  id: string;          // 'system' | 'security' | 'store' | 'support' | 'agent' | 'other'
  label: string;       // 中文名，如 '交易与订阅'
}

interface NotificationTypePreference {
  type: string;                 // 可能是通配条目，如 'system.plugin.*'
  category: string;
  label: string;
  description: string | null;
  configurable: boolean;        // 该类型**任一**渠道是否可被用户修改
  channels: NotificationChannelPreference[];
}

interface NotificationChannelPreference {
  channelId: string;
  enabled: boolean;        // 生效态（管理员策略 × 用户覆盖）
  defaultEnabled: boolean; // 未覆盖时的基准值 = 开关的「重置」目标
  configurable: boolean;   // 该渠道是否允许用户改（否则 UI 只读）
}
```

**渲染建议**：按 `categories` 排序 → `types[].category` 分组 → 每个类型一行，`channels[]` 渲染开关。
- 开关初始值用 `enabled`；
- `configurable === false` 的开关禁用/只读；
- 「恢复默认」把开关拨回 `defaultEnabled`（即清掉该渠道覆盖，见 4.3）。

### 4.2 用户级：写入覆盖

`PATCH /notifications/preferences`，body：

```ts
{ items: { type: string; channelId: string; enabled: boolean }[] }  // 最多 500 项
```

- 返回更新后的 `NotificationPreferencesView`（可直接用于刷新 UI）。
- 服务端**忽略**：未声明类型、非法渠道、管理员已全局关闭的类型、锁定/不可配置的渠道。**不报错**，静默跳过。
- 建议按「用户改动的那一项」增量提交，而不是整表覆盖。

### 4.3 用户级：重置

`POST /notifications/preferences/reset`，body（可空）：

```ts
{ types?: string[] }   // 缺省 / 空数组 = 清空该用户的全部覆盖
```

- 返回更新后的 `NotificationPreferencesView`。
- 用于「恢复默认」或整页重置。

### 4.4 管理员级：读取策略

`GET /admin/notifications/policy` → `NotificationPolicyView`

```ts
interface NotificationPolicyView {
  channels: NotificationChannelInfo[];
  categories: NotificationCategoryInfo[];
  types: NotificationTypePolicy[];
}

interface NotificationTypePolicy {
  type: string;
  category: string;
  label: string;
  enabled: boolean;             // 全局开关（false = 全渠道关闭）
  defaultChannels: string[];    // 默认渠道（已解析，可能由目录默认补全为全部渠道）
  locked: boolean;              // true = 用户不可覆盖
  userConfigurable: boolean;    // 目录声明及适用范围；管理通知为 false
}
```

### 4.5 管理员级：写入策略

`PUT /admin/notifications/policy`，body：

```ts
interface NotificationPolicyPatch {
  types?: Record<string /* type 或通配键 */, {
    enabled?: boolean;
    defaultChannels?: string[];
    locked?: boolean;
  }>;
}
```

- **局部更新**：仅提交要改的字段；未提交的字段保持原值（**不是**整体替换）。
- `defaultChannels` 会按当前渠道清单过滤非法 id。
- 键可以是精确类型或通配键（如 `system.plugin.*`）；服务端解析到目录键后合并。
- 返回更新后的 `NotificationPolicyView`。
- 会写审计：`action: 'notifications.policy.update'`，`meta: { types: [...] }`。

**管理员 UI 建议**：每个目录类型一行 → `enabled` 全局开关、`defaultChannels` 多选、`locked` 复选框；
`userConfigurable === false` 的类型要提示「已由插件声明为不可配置，用户不可改」，`locked` 复选框可置灰。

---

## 5. 前端落点建议（与现有代码对齐）

现有 Web 侧已有：
- 账户页：`apps/web/src/app/(account)/account/notifications/page.tsx`（当前是收件箱，可新增/并联「偏好」入口）
- 管理员页：`apps/web/src/app/(admin)/admin/notifications/page.tsx`（当前是收件箱，可新增「策略」子页）
- BFF 客户端：`apps/web/src/lib/notifications.ts`（`getBffNotificationClient()` 返回带 session 的 `ApiClient`）
- BFF 代理范例：`apps/web/src/app/api/notifications/route.ts`

**建议新增**（纯前端/ BFF 层，本次未做）：

1. 用户偏好 BFF：
   - `apps/web/src/app/api/notifications/preferences/route.ts`（`GET`、`PATCH`）
   - `apps/web/src/app/api/notifications/preferences/reset/route.ts`（`POST`）
2. 管理员策略 BFF：
   - `apps/web/src/app/api/admin/notifications/policy/route.ts`（`GET`、`PUT`）
3. 页面组件：用户偏好表 + 管理员策略表（可用 shadcn `Switch` / `Checkbox` / `Select` / `Table`）。
4. 若需要类型化调用，可在 `packages/sdk/src/client.ts` 增补 `getNotificationPreferences()` / `updateNotificationPreferences()` / `resetNotificationPreferences()` / `getAdminNotificationPolicy()` / `updateAdminNotificationPolicy()` —— 但这些**契约已定**（见 §4），前端也可先用 `ApiClient` 的通用 `get/patch/post/put`。

> ⚠️ BFF 路由务必把匿名访问映射为 `401`（照 `apps/web/src/app/api/notifications/route.ts` 的 `ApiError` 处理），别落成 500。

---

## 6. 内建/插件已声明的类型（供 UI 预览）

内核内建（`policy-service.ts` 的 `BUILTIN_NOTIFICATION_TYPES`）：
- `system.plugin.*`（插件生命周期）
- `system.theme.*`（主题生命周期）
- `system.frontend-apply`（前端构建进度，默认仅站内）
- `agent.*`（Agent 动态，默认仅站内）

插件声明（`notification.type` 扩展点）：
- store：`order.pending` / `order.paid` / `order.refunded`、`service.provisioning` / `service.provisioned` / `service.provision.failed` / `service.renewed` / `service.expiring` / `service.suspended` / `service.terminated`、`admin.service.provision.failed`
- login：`security.login`、`security.new-device`
- ticket：`ticket.created`、`ticket.replied`、`ticket.status.changed`

（以运行时 `GET` 返回为准；插件可增删。）

---

## 7. 边界与坑

- **不要**把目录外的类型画进 UI；它们没有配置项。
- **站内关 ≠ 全关**：`inapp` 与外部渠道相互独立，UI 文案要讲清。
- **`configurable:false` 只读**：别让用户点了没反应。
- **重置用 reset 接口**，别用「把所有开关 PATCH 回默认」代替（后者会写一堆等价覆盖）。
- **`defaultChannels` 为空数组** = 无默认渠道（不是「全部」）；`null` 才表示全部。目录里缺省才是全部渠道。
- **管理员 `enabled:false` 时**，该类型对用户即「全局关闭」，用户侧开关只读关闭，历史个人覆盖不能重新启用。
- **管理通知隔离**：插件/主题生命周期、前端构建、管理员登录、管理员开通失败以及新工单待处理均声明为管理范围；个人账户设置不返回这些项目。
- 策略有 5s 缓存：管理员改完立刻生效（写后失效），但**别的副本**最多 5s 才看到。

---

## 8. 验收清单

- [ ] 用户偏好页：分组、类型、渠道开关渲染与 `GET` 一致；未声明类型不出现。
- [ ] 改动开关 → `PATCH` 命中 → 返回视图刷新；刷新页面状态保持。
- [ ] `configurable:false` 的开关只读。
- [ ] 「恢复默认」→ `reset`（或按渠道写回 `defaultEnabled`）→ 状态回到基准。
- [ ] 关闭 `inapp` 后：站内列表/未读数/铃铛不再显示该类型；**其它渠道不受影响**。
- [ ] 关闭某外部渠道后：该渠道不再投递；重试中的记录被终止。
- [ ] 管理员策略页：全局开关/默认渠道/锁定三类编辑均生效；非管理员访问返回 403。
- [ ] 管理员写策略产生审计 `notifications.policy.update`。
- [ ] 匿名访问 BFF 返回 401（非 500）。

---

## 9. 后端已验证（供前端放心对接）

- 单元：`apps/api/tests/unit/notification-policy.test.ts`（11 例）
- 集成：`apps/api/tests/integration/notification-policy.test.ts`（4 例，真实 DB，含唯一索引 + 级联删除）
- 分发器：`apps/api/tests/unit/notification-dispatcher.test.ts`、`apps/api/tests/integration/notification-dispatcher*.test.ts`
- 站内：`apps/api/tests/notifications.test.ts`、stream-hub、lifecycle（21 例）
- 插件：store 52、SDK 87

## 10. 前端实施

- 用户入口：`/account/settings#notifications`，设置分区「通知偏好」。
- 管理员入口：`/admin/settings#notifications`，设置分区「通知策略」。
- 共用现有设置导航、SectionTitle 和 shadcn 控件；不新增顶级菜单或独立页面。
- 通知目录、分组与渠道均从接口读取；用户仅增量保存一个渠道，管理员仅保存本次改动的字段。
- 开关自动保存，以服务端返回的生效状态刷新界面；保存期间禁用编辑，避免完整响应互相覆盖。
- 只读项显示管理提示；恢复默认有确认步骤并调用 reset 接口。支持加载、错误重试和空目录。
- 新增三个 BFF 路由：用户偏好、偏好重置、管理员策略；保留 401/403/400 等状态，响应不缓存。
- `notification-settings.tsx` 提供两种设置组件；`notification-preferences-schema.ts` 校验契约；中英文文案已补齐。
- SDK 增加通用 `put` 方法，供管理员策略更新使用。

---

_后端逻辑层实现完成于本轮；如需契约变更，改 `packages/sdk/src/notifications.ts` 并同步 `policy-service.ts` / 两个 route 文件。_


## 11. 实施验证

- 策略引擎单元测试 17 项、Web BFF 与文案测试 22 项通过。
- 用临时普通用户验证真实 BFF 与数据库：用户目录排除管理类型、单渠道修改持久化、越权类型不写入、恢复默认清除覆盖、策略接口返回 403、匿名请求返回 401。测试用户已删除。
- Chrome 验证真实登录页面的深浅色与移动端布局；受控多渠道数据验证只读、保存失败保留状态、恢复默认确认以及管理员三类编辑。无浏览器脚本错误。
- Web 类型检查与 API 源码类型检查通过。API 全量类型检查存在与本变更无关的 `tests/unit/user-detail.test.ts` 既有类型错误。
