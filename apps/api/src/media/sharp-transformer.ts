/**
 * `sharp`-backed {@link ImageTransformer} (ADR-0014 §4).
 *
 * The concrete byte-producing half of the image pipeline. The planner in
 * `image.ts` stays dependency-free; this module owns the native encoder and is
 * injected at the composition root (`routes.ts`). `sharp` is loaded lazily so a
 * platform without a prebuilt binary degrades to "original only" instead of
 * breaking API startup, and every failure is turned into `null` so the upload
 * path is never blocked (best-effort contract).
 *
 * `supports()` deliberately excludes `image/svg+xml`: SVG is XML and may carry
 * `<script>`. It is never rasterised here (see `routes.ts` active-content rule).
 */
import type sharpFactory from 'sharp';
import type { ImageTransformer, OptimizeTarget, VariantSpec } from './image.ts';

/** Allow at most 100 MP of decoded input to defuse decompression bombs. */
const MAX_INPUT_PIXELS = 100_000_000;

const SUPPORTED_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

type SharpFactory = typeof sharpFactory;
/** Indirect so tests can exercise the "encoder unavailable" degradation. */
export type SharpLoader = () => Promise<SharpFactory>;

const loadSharpFromNode: SharpLoader = () => import('sharp').then((mod) => mod.default);

/**
 * One-shot latch so a missing/broken encoder is reported exactly once instead
 * of once per image.
 */
let encoderWarningEmitted = false;

function warnEncoderUnavailable(message: string): void {
  if (encoderWarningEmitted) return;
  encoderWarningEmitted = true;
  console.warn(
    `media: 图片变体编码器不可用，变体将全部失败（原因：${message}）。` +
      ' 这通常意味着 sharp 无法加载（原生二进制缺失或运行时解析错误），' +
      ' 原图上传不受影响。',
  );
}

/** Reset the one-shot warning latch (tests only). */
export function resetEncoderWarning(): void {
  encoderWarningEmitted = false;
}

/**
 * Probe whether the native encoder can actually be loaded in this process.
 *
 * Upload-time failures are deliberately swallowed (best-effort contract), which
 * means an unusable encoder is invisible unless someone asks. The media-library
 * admin surface calls this so the operator sees a banner instead of a wall of
 * silently failed thumbnails.
 */
export async function probeSharpEncoder(
  loadSharp: SharpLoader = loadSharpFromNode,
): Promise<{ available: boolean; error?: string }> {
  try {
    const sharp = await loadSharp();
    if (typeof sharp !== 'function') {
      return { available: false, error: 'sharp 模块未导出可调用的工厂函数' };
    }
    return { available: true };
  } catch (error) {
    return { available: false, error: (error as Error).message };
  }
}

/** Build the transformer; `loadSharp` is injectable purely for tests. */
export function createSharpTransformer(
  loadSharp: SharpLoader = loadSharpFromNode,
): ImageTransformer {
  return {
    supports: (mime: string) => SUPPORTED_MIMES.has(mime),

    async transform(
      input: Uint8Array,
      _mime: string,
      spec: VariantSpec,
    ): Promise<Uint8Array | null> {
      let sharp: SharpFactory;
      try {
        sharp = await loadSharp();
      } catch (error) {
        // Loading failed in a way that will not fix itself per-image; report it
        // once and keep serving originals.
        warnEncoderUnavailable((error as Error).message);
        return null;
      }
      try {
        const pipeline = sharp(Buffer.from(input), {
          limitInputPixels: MAX_INPUT_PIXELS,
          failOn: 'error',
        })
          // Normalise EXIF orientation, then drop all metadata (no withMetadata).
          .rotate()
          .resize(spec.width, spec.height, { fit: 'fill', withoutEnlargement: true });

        const encoded =
          spec.format === 'jpeg'
            ? await pipeline.jpeg({ quality: 82 }).toBuffer()
            : spec.format === 'png'
              ? await pipeline.png({ compressionLevel: 9 }).toBuffer()
              : await pipeline.webp({ quality: 82 }).toBuffer();
        return new Uint8Array(encoded);
      } catch {
        // Decode/encode failed or the native binary is absent: skip this
        // variant, keep the original. The caller logs it.
        return null;
      }
    },

    /**
     * Full-size WebP delivery encode (ADR-0014 §4 addendum).
     *
     * No resize: this is a *format* change, not a rendition, so the delivered
     * pixel dimensions stay identical to the upload. GIF goes through the
     * animated pipeline so frames, delays and looping survive; any failure
     * returns null and the caller keeps the original bytes.
     */
    async optimize(
      input: Uint8Array,
      mime: string,
      target: OptimizeTarget,
    ): Promise<Uint8Array | null> {
      let sharp: SharpFactory;
      try {
        sharp = await loadSharp();
      } catch (error) {
        warnEncoderUnavailable((error as Error).message);
        return null;
      }
      try {
        const pipeline = sharp(Buffer.from(input), {
          limitInputPixels: MAX_INPUT_PIXELS,
          failOn: 'error',
          ...(mime === 'image/gif' ? { animated: true } : {}),
        })
          // Normalise EXIF orientation, then drop all metadata (no withMetadata).
          .rotate();
        const encoded = target.lossless
          ? await pipeline.webp({ lossless: true, effort: 4 }).toBuffer()
          : await pipeline.webp({ quality: 82, effort: 4 }).toBuffer();
        return new Uint8Array(encoded);
      } catch {
        // Unsupported source, animated-encode failure or a missing binary: keep
        // the original bytes. The service also rejects any inflation.
        return null;
      }
    },
  };
}
