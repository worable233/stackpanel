# MEDIA 模块（媒体与存储，ADR-0014）

面向内核的附件域、图片管线、引用索引与富文本安全边界。二进制存储在
`StorageDriver`，PostgreSQL 保存附件元数据、变体状态和 `attachment_references` 引用关系。

## 目录

| 文件                              | 职责                                                          |
| --------------------------------- | ------------------------------------------------------------- |
| `mime.ts`                         | 魔数嗅探（真实类型）+ 图片头部尺寸解析（PNG/JPEG/GIF/WebP）   |
| `policy.ts`                       | 上传白名单与大小上限（默认 25MB，仅 image/document/archive）  |
| `keys.ts`                         | 对象存储 key 方案：`media/<yyyy>/<mm>/<id>/<name>.<ext>`      |
| `image.ts`                        | 变体阶梯规划（thumb/medium/large）+ 可注入 `ImageTransformer` |
| `variants.ts`                     | 阶段 B 计划与重试状态：把变体阶梯落成 `pending` 行 + 任务载荷 |
| `sharp-transformer.ts`            | `sharp` 编码器实现（注入 `routes.ts` 的 `buildService`）      |
| `worker.ts`                       | 阶段 B 编码 worker：`runVariantJob` / `processPendingVariants` |
| `jobs.ts`                         | 阶段 B 内核任务接线：`registerMediaJobs` + 队列装配           |
| `sanitize.ts`                     | 富文本清洗重导出（实现已上收 `@stackpanel/sdk`）              |
| `disposition.ts`                  | RFC 6266/5987 `Content-Disposition`（防响应头注入）           |
| `attachments.ts`                  | 附件域类型 + 仓储端口 + 引用完整性辅助                        |
| `service.ts`                      | `AttachmentService`：入库 / 读取 / 列表 / 改名 / 删除         |
| `prisma-attachment-repository.ts` | 仓储的 Prisma 适配 |
| `references.ts`                   | `attachment_references` 引用索引、查询与删除保护             |
| `routes.ts`                       | HTTP 面：`registerMediaRoutes(app)`                           |

## 图片管线：阶段 A / 阶段 B（ADR-0014 §4）

- **阶段 A（同步兜底）**：上传内联编码，尽力而为。无队列（`initInfra()` 前）或
  `MEDIA_VARIANTS_ASYNC=false` 时走此路径。
- **阶段 B（默认，异步）**：上传只落原图 + 记录 `pending` 变体行并投递任务；worker 用同一
  `ImageTransformer` 编码，成功置 `ready`、超限（3 次）置 `failed`。`GET /media/:id/content?variant=X`
  在 `pending` 时返回 409 `media.variant_pending`，`failed` 视为不存在（404）。
- **收敛**：每个变体累计 `attempts`，达上限终态失败（不再重试）；定时清扫（60s，
  `kernel.media.variants-backfill`）把崩溃遗留的 `pending` 行重新入队。key 确定，重跑幂等。
- 详细设计见 `ENCODER-PLAN.md` §5。

## 内核接线（已落地）

`app.ts` 已注册 `registerMediaRoutes()`；`plugin-host.ts` 的 `registerKernelJobs()` 已在 API
与 worker 的共同注册点接入 `registerMediaJobs`，保证变体任务在任一消费副本可执行。
富文本清洗原语已上收至 `@stackpanel/sdk`（`sanitizeRichText` / `isSafeUrl`），插件在写入前
   调用同实现，不得绕过；本模块 `sanitize.ts` 只是重导出。

## 附件表与引用索引（已落地）

`packages/db/prisma/schema.prisma` 已包含 `Attachment` 模型；迁移
`packages/db/prisma/migrations/20261006000000_attachment_references/` 创建引用索引表，
后续迁移 `20261006010000_attachment_reference_ownership` 增加 owner scope、索引并把附件
外键改为 `ON DELETE RESTRICT`。
附件表结构为：

```prisma
/// 内核附件域（ADR-0014 §2）。二进制在对象存储，元数据在主库。
model Attachment {
  id         String   @id @default(cuid())
  key        String   @unique
  filename   String
  mime       String
  size       Int
  width      Int?
  height     Int?
  ownerId    String?
  visibility String   @default("private")
  variants   Json     @default("[]")
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  @@map("attachments")
  @@index([ownerId, createdAt])
  @@index([createdAt])
}
```

插件通过 SDK 的 `ctx.media` 注册和删除引用；引用表使用 `ON DELETE RESTRICT`，删除检查与数据库约束共同保证并发安全，仍有引用时返回冲突并保留对象和元数据。引用带有插件 owner scope，插件只能移除自己的引用。资源删除时应调用
`ctx.media.unregisterResource(resourceType, resourceId)`。管理员可通过
`GET /media/:id/references` 查看引用。

## HTTP 契约

| 方法   | 路径                          | 鉴权                    | 说明                                        |
| ------ | ----------------------------- | ----------------------- | ------------------------------------------- |
| POST   | `/media`                      | 登录                    | 上传（raw body + `?filename=&visibility=`） |
| GET    | `/media`                      | 登录                    | 列出本人附件（管理员可 `?ownerId=`）        |
| GET    | `/media/:id`                  | 公开附件匿名 / 私有登录 | 附件元数据                                  |
| GET    | `/media/:id/content?variant=` | 同上                    | 附件字节（经 API 代理，鉴权统一）；变体未就绪 409 |
| PATCH  | `/media/:id`                  | 所有者 / 管理员         | 改文件名 / 可见性                           |
| DELETE | `/media/:id`                  | 所有者 / 管理员         | 删除（被内容引用时 409）                    |

上传用 raw body 而非 multipart：内核全局 multipart 限制为 2MB，低于媒体策略；
本模块按内容类型注册了带 `bodyLimit` 的解析器，两者互不打架。

主动内容（`image/svg+xml`、HTML、XHTML 等）一律 `Content-Disposition: attachment`：SVG 是 XML
且可携带 `<script>`，不应在同源页面内联执行。位图与 PDF 仍可内联；API 文档页单独使用
宽松的 Swagger CSP，普通 API 响应使用 `script-src 'self'`。

## 环境变量（已登记 `config/env.ts`）

- `MEDIA_MAX_UPLOAD_BYTES`（默认 25165824）：上传字节上限。
- `MEDIA_VARIANTS_ASYNC`（默认 `true`）：是否启用阶段 B 异步变体；`false` 回退阶段 A 同步编码。

## 边界

- 二进制只经 `StorageDriver`；读取统一走 `/media/:id/content`，不直接暴露对象 key。
- 图片变体**尽力而为**：`routes.ts` 已注入 `sharp` 编码器（`createSharpTransformer`）；
  原生二进制缺失或解码失败时退回「仅原图」并记日志，**不阻断上传**（ADR-0014 §4）。
  阶段 B 异步下失败在 worker 内累计尝试、达上限标记 `failed`，同样不阻断上传。
- 富文本清洗是**写入前**服务端契约；渲染端信任已清洗内容。插件不得绕过。
