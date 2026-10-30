# 媒体库（附件控制台）设计与落地记录

> 目标：让站长在后台**跨用户**看到全站附件、预览内容、切换公开可见性、删除无用附件，
> 并在图片管线故障后**重建缩略图**。
>
> 现状：内核侧三条管理端点 + 一个独立的 `media-library` 插件（本仓外：`StackPanel-plugins`）。
> 本文记录契约、落点、授权链与验收方式。

---

## 1. 边界：谁拥有附件，谁拥有控制台

ADR-0014 §2 把附件域（存储键、MIME 嗅探、变体策略、引用完整性）划给内核，ADR-0008 把
运营界面划给插件。控制台属于运营界面，因此：

- **内核**只多出三条端点 + 一个共享构造模块，不新增页面；
- **插件**（`packages/plugins/media-library`，`builtin: false`，隔离执行）不碰 Prisma、
  存储驱动与图片策略，只把请求转发回内核；
- 授权链只有一条：插件路由 `auth: 'admin'` + `permission: 'platform.admin'`，转发时带
  **调用者自己的** session token。控制台能做的事不会超过打开它的管理员。

## 2. 内核新增端点

| 端点 | 说明 |
| --- | --- |
| `GET /media/admin/attachments` | 跨用户列表。查询参数 `page` `pageSize`（≤100）`visibility` `kind` `q` `ownerId`；返回 `{ items, total, page, pageSize }`，`items` 与公开接口同形（含 `variants[]`）。 |
| `GET /media/admin/stats` | 聚合统计：`total` `bytes` `byVisibility{public,private}` `byKind` `variants{pending,ready,failed}`，并附带编码器健康 `encoder{available,error?}`。 |
| `POST /media/admin/variants/rebuild` | 把**终态失败**的变体重排。body `{ attachmentId? }`（省略=全库）；返回 `{ requeued, ids }`。 |
| `POST /media/admin/optimize` | 把存量图片转成 WebP（图形无损/照片有损），只有**变小**才替换原图。body `{ attachmentId? }`（省略=下一批，每次≤50 条）；返回 `{ optimized, skipped, savedBytes, ids }`。详见 §2.3。 |

三条都要 `platform.admin`（`actorFor(request.user).canManage`），匿名 401、非管理员 403。

### 2.1 为什么需要「重建」这条写接口

`failed` 是**终态**：变体队列的恢复清扫只复活 `pending`，解码失败会写入
`status: 'failed'` 并保留 `error`，防止坏文件无限重试烧 CPU。代价是——编码器一旦
长时间不可用（或像 §5 那样解析到错误模块），这期间上传的附件缩略图会**永久**停在
`failed`，即使编码器后来修好了，因为已经没人会再重排它们。

`rebuildFailedVariants()` 就是那个「人按一下」的补偿动作：

- 仓库层 `resetFailedVariants(attachmentId?)` 用一条 jsonb 改写把 `failed → pending`、
  `attempts = 0`、`error = null`，`RETURNING id` 拿到受影响附件；
- 有队列时逐条 `enqueue`，没有队列（单机/测试）时**就地重编码**
  （`storage.get(record.key)` → `generateVariants` → `updateVariants`）；
- 返回 `requeued` 数量，前端据此提示「已重排 N 个附件的变体」。

### 2.2 编码器健康

`/media/admin/stats` 里的 `encoder` 是实时探测（`transform.supports('image/png')`
是否可用、异常文本是什么）。前端在 `available === false` 时挂红色横幅并解释
「缩略图不会生成，原图仍可上传与访问」——否则站长只会看到一堆灰块而不知道原因。

### 2.3 「无损转 WebP」为什么也在内核

浏览器端做不了这件事：存量字节在内核存储里，插件只有 HTTP，`<canvas>` 转码还得先把
原图下到用户机器再传回去——对 20 MiB 的图等于双倍流量，而且没人保证页面一直开着。
所以转码是内核的一等公民，插件只提供「按一下」。

| 源类型 | 编码 | 理由 |
| --- | --- | --- |
| `image/png` / `image/gif` / `image/webp` | **无损** WebP（`effort: 4`） | 图形、截图、图标：同像素更小（常见 10–30%）；GIF 保留帧/延迟/循环 |
| `image/jpeg` | 有损 WebP（`quality: 82`） | 已是照片格式，无损只会**变大** |
| 其他（含 SVG） | 不处理 | SVG 是矢量，栅格化会丢语义；文档/视频不做 |

三条硬规则：

1. **字节守卫**：编码结果 `>=` 原文件就**保留原图**。为同样的像素多付流量不叫优化。
2. **先编码、后落盘**：上传路径在第一次 `storage.put` 之前就完成转换，被淘汰的源字节从未
   写入存储，所以不存在「两份原图」。转换后 `key` 变为 `.../original.webp`、`mime` 变为
   `image/webp`、文件名扩展名改写为 `.webp`、`size` 用新字节长度。
3. **无回滚**：WebP 就是此后唯一的原始副本（ADR-0014 §2 的 `original` 语义），备份策略与
   其它附件一致，不做版本堆叠。

批量与幂等：

- 每次请求最多处理 `OPTIMIZE_BATCH_LIMIT = 50` 条（仓库层 `listOptimizable(limit)` 再兜底
  `≤ 500`），避免一按把 CPU 占满；body 可带 `attachmentId` 做单条修复。
- 候选集是 `mime IN ('image/png','image/jpeg','image/gif')`，转换成功后该行**离开**候选集，
  所以重复点击天然幂等：不需要状态列，也不需要数据库迁移。
- 已是 `image/webp` 的行直接跳过：对已经有损的 WebP 再「无损」只会变大。
- 返回 `{ optimized, skipped, savedBytes, ids }`，控制台据此提示「已转换 N 个附件，节省 X」。
  `savedBytes` 只统计**本次**运行（不落库），因为省下的字节本来就能从两次 `size` 相减得到。

回滚开关：`MEDIA_WEBP_OPTIMIZE=false` 同时关掉上传与批量转换，文件保持原格式。

### 2.4 转换之后，旧链接为什么还能用

硬约束：**媒体 URL 只由 id 寻址**（`/media/:id/content`、`/media/:id/content?variant=thumb`），
`key`、扩展名、`mime`、`size` 全是内部状态。所以「原地把原图换成 WebP」不需要改任何已发布的
链接：同一条 URL 转换前后都返回 200，只是背后的字节变了。这条不变量现在被测试钉住
（`media-service.test.ts` 断言转换前后 `url` 与 `variants[].url` 完全不变）。

但「链接不坏」还不够，还得让**缓存**知道手上那份拷贝已经过期。于是给每份字节一个内容版本号：

```
rev = sha256(key : size : mime)[0..16]
```

- 由「重写会改变的那三个字段」推导，不需要新列、不需要额外读存储、不需要迁移；
- 作为**弱**校验器发布（`ETag: W/"<rev>"`）——转换保留的是像素，正是 `W/` 的语义；
- 附件详情/列表里也返回 `rev`（原图与每个变体各一份），客户端可据此自行拼 `?v=<rev>`。

内容路由的缓存策略因此分三档：

| 请求 | `Cache-Control` | 含义 |
| --- | --- | --- |
| 私有附件 | `private, max-age=0, must-revalidate` | 每次带凭据回源；命中时只回 304 |
| 公有 + `?v=<无当前 rev>` | `public, max-age=31536000, immutable` | 永远缓存：字节一变 URL 就变 |
| 公有 + 无 `v` / `v` 过期 | `public, max-age=0, must-revalidate` | 旧链接下次访问即被更正 |

`If-None-Match` 命中原样回 `304`（无正文，比重新 `Buffer` 一次便宜得多）。`v` **永不参与寻址**
——传错、传旧只影响缓存档位，不会 404。

上一个版本是 `public, max-age=86400` 且没有 `ETag`：转换后旧链接最多要用旧图 24 小时，而且中间缓存
没有校验器可依。现在公有链接默认每次回源校验，要长缓存就带上 `v`。

变体不重新生成：它们是从「上传时的原图」编的，无损转换像素相同，有损（JPEG）差异在 quality 82
之内；`rebuild` 仍只用于修复终态 `failed`。

## 3. 单一构造路径：`kernel-service.ts`

`routes.ts` 与新的 `admin-routes.ts` 必须拿到**同一个**服务实例构造逻辑（存储驱动、
编码器、队列、actor 映射、错误映射）。为避免两份工厂漂移，抽出
`apps/api/src/media/kernel-service.ts`：

```ts
buildMediaService()      // 存储 + 编码器 + 队列装配
mediaActorFor(user)      // userId + canManage
optionalMediaActor(req)  // 匿名可读公开附件的 actor
mediaMaxBytes()          // 上传上限（策略 + 环境变量）
mediaVariantQueue()      // 队列或 undefined（单机退化为同步编码）
isMediaAdmin(user)       // platform.admin 判定
attachmentReferences()   // 删除前的引用检查端口
sendMediaError(reply,e)  // MediaError → { error, code }
```

`routes.ts` 以别名导入（`buildMediaService as buildService` 等），处理器不感知拆分。

## 4. 插件侧（`StackPanel-plugins/packages/plugins/media-library`）

```
浏览器 → /api/plugins/media-library/items?…        同源 BFF（web）
      → 插件路由  auth: admin / platform.admin
      → http://API_HOST:API_PORT/media/admin/…     Bearer 调用者 token
```

| 插件路由 | 转发到内核 | 备注 |
| --- | --- | --- |
| `GET /media-library/items` | `/media/admin/attachments` | 透传 page/pageSize/visibility/kind/q/ownerId |
| `GET /media-library/stats` | `/media/admin/stats` | 计数 + 编码器健康 |
| `PATCH /media-library/items/:id` | `/media/<id>` | `{ filename?, visibility }`，至少一个字段 |
| `DELETE /media-library/items/:id` | `/media/<id>` | `409 media.in_use` 原样透传，前端换成人话 |
| `POST /media-library/variants/rebuild` | `/media/admin/variants/rebuild` | `{ attachmentId? }` |
| `POST /media-library/optimize` | `/media/admin/optimize` | `{ attachmentId? }`；控制台按钮「无损转 WebP」，提示本次转换数与节省字节 |
| `GET /media-library/items/:id/content` | `/media/<id>/content` | **raw 流式代理**（`kind: 'raw'`），`?variant=` 透传 |

两条容易踩坑的地方：

1. **缩略图不能直连内核**。浏览器只被放行 `/api/plugins/<id>/*`，所以图片必须由插件用
   `kind: 'raw'` 路由**流式**转发（`header/write/drain/end`，遵守背压），并且只透传
   安全响应头（`content-type` `content-length` `content-disposition` `cache-control`
   `etag` `last-modified` `content-security-policy`）。
2. **管理页不发 finder**。页面是客户端组件，挂载后自己 `fetch` 上面这些同源路由，
   因此不需要数据 finder，也就不触发服务端执行准入（ADR-0024）。代价是首屏多一次往返。

侧边栏分组复用 cms 的 `nav.group` 键（`内容` / `Content` / `內容`）：`backend-navigation.ts`
按**解析后的字符串**分组，所以两个插件落在同一个「内容」组里而不是各建一组。

## 5. 相关修复：`tsx` 运行时把 `sharp` 解析成类型声明

症状：所有变体 `status: 'failed'`、`error` 里是 `编码未产出字节`，但 vitest 全绿。

根因：`apps/api/tsconfig.json` 为绕过 `sharp` 的 `exports` 缺 `types` 条件而写了

```jsonc
"paths": { "sharp": ["./node_modules/sharp/lib/index.d.ts"] }
```

`tsx`（开发启动器）会读 `paths` 做运行时解析，于是 `require('sharp')` 加载到的是
**声明文件**，`sharp` 本身不是函数 → `transform()` 抛错 → 变体全失败；而 vitest 走
自己的 bundler 解析链，解析到真实模块，所以测试毫无异常。

修法：**删掉这条 `paths` 映射**（sharp 0.35+ 的 `exports` 已带 `types` 条件，普通解析
既正确又类型安全），并在 `apps/api/tsconfig.json` 里留下注释，明确禁止再为**运行时依赖**
添加 `paths`。同时补一条回归测试 `tests/unit/media-tsx-resolution.test.ts`：在
`apps/api` 下用 `node_modules/.bin/tsx` 跑一个 `.mts` 探针，断言 `typeof mod.default === 'function'`。

## 6. 验证

自动化：

```bash
cd apps/api
node_modules/.bin/tsc --noEmit -p tsconfig.json
../../node_modules/.pnpm/node_modules/.bin/vitest run tests/unit/media-*.test.ts
../../node_modules/.pnpm/node_modules/.bin/vitest run tests/integration/media-admin.test.ts tests/integration/media.test.ts
```

- `tests/integration/media-admin.test.ts`：匿名 401、非管理员 403、跨用户分页与
  `kind`/`q`/`visibility` 过滤、`stats` 与 `encoder.available`、管理员改可见性/删除、
  `rebuild` 让 `requeued === 1` 且状态不再停在 `failed`；真实 sharp 下上传即得
  `image/webp`（且比源 PNG 小），`optimize` 把一条手工造的存量 PNG 行原地转成 WebP、
  删掉旧对象、二次调用 `optimized === 0`，非管理员 403。
- `tests/unit/media-service.test.ts` 的「WebP delivery encode」组：无损/有损目标映射、
  上传落盘即 WebP 且不留下 `original.png`、**字节守卫**（变大就保留原图）、
  `MEDIA_WEBP_OPTIMIZE=false` 关闭转换、批量 `savedBytes` 与旧对象清理、孤立字节与
  已是 WebP 的行计为 `skipped`、单条定向转换；以及**链接不变性**：转换前后 `url` 与
  `variants[].url` 完全相同、`rev` 只在字节移动时才变（改文件名不算）。
- `media-admin.test.ts` 还验证了旧链接的连续性：转换后同一 URL 返 200 且 `Content-Type`
  变 `image/webp`、`ETag` 换新；带旧 `ETag` 的请求得到 200（不命中）、带新 `ETag` 得到 304、
  空正文；`?v=<当前 rev>` 得到 `immutable`，`?v=deadbeef` 仍 200 且回到 `must-revalidate`。
- 插件仓：`pnpm --filter @stackpanel/plugin-media-library test`（桥接路由 + 词条对齐）。

手工（dev）：

1. 内核 `pnpm dev`；插件按插件仓 README 安装，并在后台插件页启用 `media-library`。
2. 打开 **管理后台 → 内容 → 媒体库**（`/admin/plugin/media-library/library`）：
   统计卡、筛选、缩略图网格、预览弹窗、可见性切换、删除确认、重建按钮。
3. 上传一张图（`POST /media`），等变体 `ready` 后刷新页面：缩略图应来自
   `?variant=thumb`；按「无损转 WebP」应提示本次转换数与节省字节（全库已是 WebP 时
   提示「没有需要转换的附件。」）。
4. 把 `encoder` 弄坏（或用一个历史 `failed` 附件）后按「重建失败变体」，
   应看到「已重排 N 个附件的变体」。

已验证的边界：字节缺失的历史附件（存储里没有对应对象）在控制台显示「无预览」占位，
`?variant=thumb` 返回 `404 media.variant_not_found`，原图返回 `404 media.not_found`
——这是内核的正确语义，不是控制台缺陷。
