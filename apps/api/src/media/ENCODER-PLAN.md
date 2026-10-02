# 图片变体编码器接入方案（ADR-0014 §4）

> 状态：**阶段 A 与阶段 B 均已落地**。编码器 `apps/api/src/media/sharp-transformer.ts` 已实现并在
> `routes.ts` 的 `buildService()` 注入；阶段 B 异步化已由 `media/{variants,worker,jobs}.ts` 落地
> （BullMQ 任务 + 失败重试 + 回填清扫，见 §5）。本文档保留为设计记录。

本文档给出「补齐 `ImageTransformer` 真实编码器」的落地方案。当前实现只做**规划**
（`planImageVariants`）与**尽力而为的写盘**，唯一的 `ImageTransformer` 实现是
`unavailableImageTransformer`（`supports()` 恒为 `false`），因此**永远不会产出变体字节**。
这是本域唯一的功能性缺口。规划与策略已稳定，本方案只补「产生字节」这一格，不动其余契约。

## 1. 现状

- 规划：`image.ts` 的 `IMAGE_VARIANTS`（thumb 256 / medium 1024 / large 2048）+
  `planImageVariants`，只下采样、不上采样。
- 写入：`service.ts` 的 `generateVariants()` 逐条调用 `transform.transform(...)`，把结果
  经 `StorageDriver.put` 落到 `media/<yyyy>/<mm>/<id>/<name>.<ext>`，并写进附件
  `variants` 字段；任一变体失败只 `logger.warn`，**不阻断上传**（ADR-0014 §4 的约束）。
- 缺的：一个能解码原图、按 `spec.width x spec.height` 重编码为 `webp`/`jpeg`/`png`
  的实现，以及在 `buildService()` 里把它注入 `transform`。

`ImageTransformer` 的端口签名已经定型，接入是纯加法：

```ts
interface ImageTransformer {
  supports(mime: string): boolean;
  transform(input: Uint8Array, mime: string, spec: VariantSpec): Promise<Uint8Array | null>;
}
```

## 2. 选型

推荐 **`sharp`**（libvips 绑定）：

- 原生实现，prebuilt 二进制通过 `@img/sharp-<platform>` 可选依赖分发，**无需**在安装期
  编译；锁文件已因其它依赖解析出 `@img/sharp-*`，容器内 `pnpm install` 会按构建平台拉齐。
- 支持 PNG/JPEG/GIF/WebP 输入与 `webp/jpeg/png` 输出，覆盖 `planImageVariants` 的全部格式。
- 有 `limitInputPixels`（默认约 0x3FFF×0x3FFF ≈ 2.68 亿像素）可防解压炸弹，可再收紧。

备选：`@napi-rs/image` 或把编码放到对象存储服务的服务端变换。若日后托管对象存储自带
变换，可只替换 `ImageTransformer` 实现，`service.ts` 不动——这正是该端口存在的理由。

## 3. 依赖接入步骤（KERNEL/集成流执行）

1. `apps/api/package.json` 的 `dependencies` 增加 `"sharp": "^0.34.0"`（版本以当时最新稳定为准）。
2. `pnpm install`。确认 `apps/api/node_modules/sharp` 存在且 `@img/sharp-<平台>` 被解析。
3. `apps/api/tsup.config.ts` 的 `external` 数组追加 `'sharp'`（原生模块必须 external，禁止打进
   bundle；与现有 `pg`/`@aws-sdk/*` 同类）。
   注：`ImageTransformer` 实现文件走 `await import('sharp')` 惰性载入，即使某平台缺二进制，
   也只是变体退化，不影响 API 启动。
4. 运行期镜像（`scripts/deploy.sh` 的单镜像）需保证 `sharp` 及其平台可选依赖随
   `node_modules` 一起进入运行镜像；pnpm 的部署产物默认已包含。Linux 目标需含
   `@img/sharp-linux-x64`（glibc）或 `@img/sharp-linuxmusl-x64`（musl）。

## 4. 代码接入

新增 `apps/api/src/media/sharp-transformer.ts`（本域所有权）：

```ts
import type { ImageTransformer, VariantSpec } from './image.ts';

/** 允许解码的最大像素数，防解压炸弹（与 sharp 默认量级一致，可按需收紧）。 */
const MAX_INPUT_PIXELS = 100_000_000;

export function createSharpTransformer(): ImageTransformer {
  return {
    supports: (mime) =>
      mime === 'image/png' ||
      mime === 'image/jpeg' ||
      mime === 'image/gif' ||
      mime === 'image/webp',
    async transform(input, _mime, spec: VariantSpec) {
      const { default: sharp } = await import('sharp');
      try {
        const pipeline = sharp(Buffer.from(input), {
          limitInputPixels: MAX_INPUT_PIXELS,
          failOn: 'error',
        })
          .rotate() // 依 EXIF 摆正，随后丢弃元数据
          .resize(spec.width, spec.height, { fit: 'fill', withoutEnlargement: true });
        const out =
          spec.format === 'jpeg'
            ? await pipeline.jpeg({ quality: 82, mozjpeg: true }).toBuffer()
            : spec.format === 'png'
              ? await pipeline.png({ compressionLevel: 9 }).toBuffer()
              : await pipeline.webp({ quality: 82 }).toBuffer();
        return new Uint8Array(out);
      } catch {
        return null; // 解码失败 → 该变体跳过，绝不抛给上传路径
      }
    },
  };
}
```

接线（`routes.ts` 的 `buildService()`，两行）：

```ts
import { createSharpTransformer } from './sharp-transformer.ts';
// ...
transform: createSharpTransformer(),
```

`generateVariants()` 已经做了 `kind === 'image' && dims && supports(mime)` 的前置判断与
逐条 try/catch，无需改动即可生效。

## 5. 同步 / 异步

- **阶段 A（同步兜底）**：保持 `service.ts` 现在的**上传内联、尽力而为**。编码在请求
  线程完成，实现最小、语义不变。无队列或 `MEDIA_VARIANTS_ASYNC=false` 时走此路径。
- **阶段 B（默认，异步）**：变体生成移入 BullMQ worker（ADR-0013）：上传只落原图并返回，
  记录 `pending` 变体行并入队 `kernel.media.variants`；worker 用同一 `ImageTransformer` 产出后
  `updateVariants` 置 `ready`。请求延迟与 CPU 解耦、可重试、可观测。
  - `variants.ts`：`planPendingVariants`（纯逻辑，落 `pending` 行 + 载荷）。
  - `worker.ts`：`runVariantJob`（编码、按变体累计 `attempts`、达上限 `VARIANT_ATTEMPT_CAP=3`
    标记 `failed`；返回 `retry` 以触发 BullMQ 退避）与 `processPendingVariants`（回填）。
  - `jobs.ts`：`registerMediaJobs` 注册 `media.variants` 处理器 + `media.variants-backfill`
    定时清扫（60s），由 `plugin-host.ts` 的 `registerKernelJobs()` 在 API 与 worker 共同注册。
  - 读取语义：变体未就绪 `GET /media/:id/content?variant=X` 返回 409
    `media.variant_pending`，失败视为 404。
  - key 确定，重跑幂等；上传入队失败不阻断上传，遗留 `pending` 由清扫收敛。

## 6. 安全与边界

- 解压炸弹：`limitInputPixels` 限制解码像素；上传体积上限另有 `MEDIA_MAX_UPLOAD_BYTES`。
- 元数据：`.rotate()` 后不再 `.withMetadata()`，输出不含 EXIF/GPS。
- 主动内容：`image/svg+xml` **不**交给 sharp（`supports()` 为 false）——SVG 是 XML，可带
  `<script>`；路由已对 SVG 强制 `Content-Disposition: attachment`，不内联渲染，见
  `routes.ts` 的 `isActiveContent`。若日后要支持 SVG 栅格化，应经 `resvg` 类安全栅格器并
  明确只输出位图。
- 失败即跳过：任何 `transform` 返回 `null` 或抛错都只记日志，附件仍可用原图，符合 §4。

## 7. 测试

- 单元：`sharp-transformer.test.ts` 用内联的极小 PNG（真实可解码），断言 `supports()` 的
  类型集合、`transform()` 返回非空且用 `sharp(meta).metadata()` 校验宽高与 `format === 'webp'`；
  再断言损坏字节返回 `null` 而非抛错。
- 集成：现有 `apps/api/tests/integration/media.test.ts` 上传大图后，断言返回的
  `attachment.variants` 非空、`GET /media/:id/content?variant=thumb` 返回 `image/webp`。
  注意当前测试用的是「仅 IHDR 头」的伪 PNG，sharp 无法解码；补一个真实小 PNG fixture。
- 缺二进制退化：模拟 `import('sharp')` 失败，断言上传仍 201、`variants` 为空——守护
  「变体不阻断上传」的契约。
- 阶段 B：`tests/unit/media-variants.test.ts` 覆盖计划/编码/幂等/重试与终态/软失败；
  `tests/integration/media-async.test.ts` 用真实 Redis 队列验证「上传入队 → worker 产出可读 webp」
  与回填查询；`tests/unit/media-service.test.ts` 覆盖异步模式下 `pending` 与 409。

## 8. 回滚

- 设置 `MEDIA_VARIANTS_ASYNC=false` 即回退阶段 A（同步内联编码），无需改代码。
- 移除 `createSharpTransformer()` 注入一行即回到 `unavailableImageTransformer`，上传照常。
- 已落地的历史变体字节可留可清；`variants` 字段为空即视为只有原图，阶段 A/B 行互不冲突。
