/**
 * Image variant pipeline (ADR-0014 §4).
 *
 * This module is the pure planning half of the pipeline: given an image's
 * intrinsic size it decides which down-scaled variants are worth generating.
 * The byte-producing half is an injected {@link ImageTransformer} so the planner
 * stays dependency-free and unit-testable, and so the actual encoder (e.g. a
 * libvips/`sharp`-backed implementation, or the object-storage service's own
 * transform) can be supplied without touching the policy.
 *
 * Never upscales: a variant is only planned when the original is larger than
 * the target on its longest edge. Variant generation is best-effort and must
 * never block the upload (ADR-0014 §4).
 */
import type { ImageDimensions } from './mime.ts';

export interface VariantSpec {
  /** Segment name used in the object key, e.g. `thumb`. */
  name: string;
  /** Target longest-edge size in pixels. */
  maxEdge: number;
  /** Target width/height after aspect-ratio-preserving down-scale. */
  width: number;
  height: number;
  /** Encoder format for the variant. */
  format: 'webp' | 'jpeg' | 'png';
}

/** Canonical variant ladder, largest last. Tuned for web content images. */
export const IMAGE_VARIANTS: ReadonlyArray<{ name: string; maxEdge: number }> = [
  { name: 'thumb', maxEdge: 256 },
  { name: 'medium', maxEdge: 1024 },
  { name: 'large', maxEdge: 2048 },
];

/** Down-scale `dims` so its longest edge is at most `maxEdge`, keeping ratio. */
export function fitWithin(dims: ImageDimensions, maxEdge: number): ImageDimensions {
  const longest = Math.max(dims.width, dims.height);
  if (longest <= maxEdge || longest === 0) return { ...dims };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(dims.width * scale)),
    height: Math.max(1, Math.round(dims.height * scale)),
  };
}

/**
 * Decide which variants to generate. Returns an empty array when the image is
 * already small enough for every rung.
 */
export function planImageVariants(
  dims: ImageDimensions,
  format: VariantSpec['format'] = 'webp',
): VariantSpec[] {
  const longest = Math.max(dims.width, dims.height);
  return IMAGE_VARIANTS.filter((variant) => longest > variant.maxEdge).map((variant) => ({
    name: variant.name,
    maxEdge: variant.maxEdge,
    format,
    ...fitWithin(dims, variant.maxEdge),
  }));
}

/**
 * Byte-producing step. Implementations encode `input` at `spec.width` x
 * `spec.height` in `spec.format`. Kept as an interface because the concrete
 * encoder is an operational choice (native lib vs. managed service).
 */
export interface ImageTransformer {
  /** Whether this transformer can handle the given source mime type. */
  supports(mime: string): boolean;
  /** Produce one variant; returns null when the source cannot be decoded. */
  transform(input: Uint8Array, mime: string, spec: VariantSpec): Promise<Uint8Array | null>;
}

/**
 * Default transformer when no encoder is wired. It reports it cannot handle any
 * type, so the pipeline records the original only and logs that variants were
 * skipped. This keeps the upload path correct while the encoder is absent.
 */
export const unavailableImageTransformer: ImageTransformer = {
  supports: () => false,
  transform: async () => null,
};

/** Extension used for a variant's encoded format. */
export function extensionForFormat(format: VariantSpec['format']): string {
  return format === 'jpeg' ? 'jpg' : format;
}
