import { describe, expect, it } from 'vitest';
import {
  assertSafeMediaExt,
  assertSafeMediaName,
  buildMediaKey,
  mediaPrefix,
} from '../../src/media/keys.ts';
import { planImageVariants, fitWithin, extensionForFormat } from '../../src/media/image.ts';
import { checkUpload, DEFAULT_MEDIA_POLICY } from '../../src/media/policy.ts';
import type { SniffedMime } from '../../src/media/mime.ts';

const at = new Date('2026-03-09T12:00:00Z');

describe('media keys', () => {
  it('builds a date-sharded key for the original and its variants', () => {
    expect(buildMediaKey('att_1', 'png', at)).toBe('media/2026/03/att_1/original.png');
    expect(buildMediaKey('att_1', 'webp', at, 'thumb')).toBe('media/2026/03/att_1/thumb.webp');
    expect(mediaPrefix('att_1', at)).toBe('media/2026/03/att_1/');
  });

  it('rejects traversal-shaped segments', () => {
    expect(() => buildMediaKey('../x', 'png', at)).toThrow();
    expect(() => buildMediaKey('att_1', '../png', at)).toThrow();
    expect(() => buildMediaKey('att_1', 'png', at, '../thumb')).toThrow();
    expect(() => assertSafeMediaName('Upper')).toThrow();
    expect(() => assertSafeMediaExt('p/n/g')).toThrow();
  });
});

describe('variant planning', () => {
  it('never upscales and keeps aspect ratio', () => {
    expect(planImageVariants({ width: 100, height: 80 })).toEqual([]);
    const specs = planImageVariants({ width: 3000, height: 1500 });
    expect(specs.map((s) => s.name)).toEqual(['thumb', 'medium', 'large']);
    expect(specs[0]).toMatchObject({ width: 256, height: 128, format: 'webp' });
    expect(specs[2]).toMatchObject({ width: 2048, height: 1024 });
  });

  it('only plans rungs smaller than the source', () => {
    const specs = planImageVariants({ width: 800, height: 800 });
    expect(specs.map((s) => s.name)).toEqual(['thumb']);
    expect(specs[0]).toMatchObject({ width: 256, height: 256 });
  });

  it('fits within a max edge', () => {
    expect(fitWithin({ width: 4000, height: 2000 }, 2048)).toEqual({ width: 2048, height: 1024 });
    expect(fitWithin({ width: 100, height: 100 }, 2048)).toEqual({ width: 100, height: 100 });
  });

  it('maps formats to extensions', () => {
    expect(extensionForFormat('webp')).toBe('webp');
    expect(extensionForFormat('jpeg')).toBe('jpg');
    expect(extensionForFormat('png')).toBe('png');
  });
});

describe('upload policy', () => {
  const image: SniffedMime = { mime: 'image/png', ext: 'png', kind: 'image' };
  const video: SniffedMime = { mime: 'video/mp4', ext: 'mp4', kind: 'video' };

  it('accepts an allowed image', () => {
    expect(checkUpload(image, 1024)).toBeNull();
  });

  it('rejects empty, oversized, unknown and disallowed types', () => {
    expect(checkUpload(image, 0)?.code).toBe('media.empty');
    expect(checkUpload(image, DEFAULT_MEDIA_POLICY.maxBytes + 1)?.code).toBe('media.too_large');
    expect(checkUpload(null, 100)?.code).toBe('media.unsupported_type');
    expect(checkUpload(video, 100)?.code).toBe('media.unsupported_type');
  });
});
