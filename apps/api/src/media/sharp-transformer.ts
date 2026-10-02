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
import type { ImageTransformer, VariantSpec } from './image.ts';

/** Allow at most 100 MP of decoded input to defuse decompression bombs. */
const MAX_INPUT_PIXELS = 100_000_000;

const SUPPORTED_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

type SharpFactory = typeof sharpFactory;
/** Indirect so tests can exercise the "encoder unavailable" degradation. */
export type SharpLoader = () => Promise<SharpFactory>;

const loadSharpFromNode: SharpLoader = () => import('sharp').then((mod) => mod.default);

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
      try {
        const sharp = await loadSharp();
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
  };
}
