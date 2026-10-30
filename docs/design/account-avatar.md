# 账户头像：用媒体域托住，用内容版本号连接

> 状态：已实现（内核 `apps/api/src/routes/auth.ts`、`apps/api/src/auth/avatar.ts`；前端
> `apps/web/src/components/account-settings.tsx`、`backend-shell.tsx`）。

## 1. 目标

用户能给自己上传 / 更换 / 移除头像，头像出现在**账户设置页**和**后台/账户外壳**上；
同一张图不能出现两次，也不能因为一次替换而让图片缓存显示上一张脸。

## 2. 存储：头像就是一条普通媒体附件

没有新的图片上传通道，也没有第二套缩放逻辑：

```
POST /auth/avatar（raw image body）
  → 媒体域 ingest（嗅探 → WebP 全尺寸编码 → 变体阶梯 thumb/medium/large）
  → users.avatarAttachmentId = 新附件 id
  → attachment_references(user, <userId>, field='avatar')
```

- **指针而不是外键**：`users.avatarAttachmentId` 是软指针，附件被删除后头像回落到首字母，
  这正是可接受的状态。加外键会让「删附件」和「删用户」互相阻塞，白耦合两个域。
- **引用是为了保护**：注册 `attachment_references` 之后，媒体控制台的删除命中
  `409 media.in_use`，管理员不会在不知情的情况下把某个人的头像删掉。
- **公开可见**：头像要显示给别人（列表、后台导航），所以附件 `visibility = public`。
  id 不可猜，公开的只有用户主动选的那张图。

## 3. URL：派生，不落库

`/auth/me` 返回的 `avatarUrl` 是**每次现算**的：

```
/media/<id>/content?variant=thumb&v=<rev>     rev = sha256(key : size : mime)[0..16]
```

- 有 `thumb` 变体（源图长边 > 256）时用小图，否则用原图（源图本来就小）；
- `rev` 来自字节，所以**换头像就是换 URL**，浏览器/CDN 不可能拿旧缓存继续显示旧脸；
- 存字符串会立刻过期，所以列里只存附件 id。

## 4. 限制

| 项 | 值 | 理由 |
| --- | --- | --- |
| 类型 | PNG / JPEG / GIF / WebP | 光栅图；SVG 是**主动内容**（内容路由强制下载），明确拒绝，避免存储型 XSS 造型 |
| 大小 | ≤ 5MB | 头像不需要 25MB 的媒体上限；BFF 与内核用同一个数字，两边不会漂移 |
| 鉴权 | 登录用户本人 | 只能改自己的头像；管理别人的头像不在本次范围 |

## 5. 浏览器路径

```
浏览器 ──POST /api/account/avatar──▶ web BFF（会话 cookie → Bearer）──▶ /auth/avatar
浏览器 ──GET  /api/plugins/media/<id>/content?v=…──▶ 内核 /media/<id>/content
```

- 上传必须经过 BFF：浏览器拿不到会话令牌。
- 显示走 `/api/plugins` 这条**唯一内核出站口**。为此在
  `isPublicAssetRequest` 里新增了**一条**公开白名单：`GET /media/<id>/content`
  （带 `att_` id 形状校验）。媒体域的其它路由（列表、元数据、引用、重建）仍在
  认证后的 action-target 校验之内。匿名读公有附件本来就是内核的可见性规则，BFF 只负责
  提供一个浏览器可达的源。

## 6. 顺带修掉的一个真实 bug

`POST /api/agent/attachments` 等路由用 `request.headers.origin !== request.nextUrl.origin`
做同源校验。Next 会把 `nextUrl.origin` 规范成启动时的 host，于是用 `127.0.0.1:3000`
访问、而服务配置为 `localhost:3000` 时，**合法的同源上传被 403**（本次实测到了）。
现改为 `isSameOriginRequest()`（`apps/web/src/lib/request-origin.ts`）：用请求自身的
`Host`（或代理的 `x-forwarded-host` / `x-forwarded-proto`）与 `Origin` 比较，
覆盖别名、LAN、反代域名。agent 两条路由同步改用该实现。

## 7. 替换 / 删除语义

- 替换：先注册新引用 → 更新指针 → 取消旧引用并删除旧附件（**best-effort**：新头像已经生效，
  清理失败不该让用户看到一个无法处理的报错）。
- 删除：清指针 → 取消引用 → 删附件；重复删除幂等返回 `{ avatarUrl: null }`。
- 审计：两者都写 `user_update`，`meta.field = 'avatar'`（复用已翻译的 action，不新增术语）。

## 8. 迁移

`packages/db/prisma/migrations/20261027100000_user_avatar/migration.sql`：仅
`ALTER TABLE "users" ADD COLUMN "avatarAttachmentId" TEXT;`，无回填。

## 9. 列表与详情：批量解析，指针不出门

后台用户列表一页 20 行，如果每行单独查一次附件，就变成 20 次读。所以派生化拆成两个入口：

- `avatarContentUrl(db, id)`：单个（账户载荷、详情）。
- `avatarContentUrls(db, ids)`：**一次** `findMany` 解析整页，返回 `Map<attachmentId, url>`。

payload 里给的是 `avatarUrl`，**不给** `avatarAttachmentId`：指针暴露出去会诱使客户端自己拼
媒体 URL，从而绕过 `rev`（缓存就又开始不听话了）。所以两个用户载荷都过一遍
`stripAvatarAttachmentId()`。

一个容易掉进去的坑：`GET /admin/users` 的响应有 `userListResponseSchema`，Fastify 用它做
**序列化**（fast-json-stringify），**schema 里没声明的字段会被静默丢弃**。所以
`avatarUrl` 必须同时出现在 `lib/openapi.ts`，否则服务端算对了、库里也有值，客户端拿到的
却永远是 `undefined`。SDK 侧 `adminUserSchema` 用 `.optional()` 而不是 `.default(null)`：
滚动升级时旧内核不发这个字段，管理台不该因此解析失败。

`GET /admin/users*` 与开放接口 `/api/v1/users*` 都走同一个 `UserAdminService`，所以字段
一处加上、两处都有。

## 10. 验证

- 内核 `apps/api/tests/integration/avatar.test.ts`（真 DB + 真 sharp + 真存储）：上传 201
  且 `/auth/me` 与返回一致、附件为 `public` + WebP、匿名可读；`attachment_references`
  登记为 `user/avatar`；替换后旧附件 404 且只剩一条；非图片 / SVG / 超限 / 匿名四类拒绝；
  删除后 `avatarUrl` 为 `null` 且重复删除幂等。
- Web：`tests/request-origin.test.ts`（同源守卫的四种情形）、
  `tests/contract04-bff-whitelist.test.ts`（公开媒体内容放行、媒体其它路由不放行）。
- 实测（浏览器）：设置页上传 → 201 → `router.refresh()` 后设置页与外壳同时换图；
  替换旧图后指针与新 `rev` 都变化；DB 侧仅剩一条头像附件与一条引用。
