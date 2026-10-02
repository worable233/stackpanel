import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { createSharpTransformer } from '../../src/media/sharp-transformer.ts';
import type { VariantSpec } from '../../src/media/image.ts';

const webpSpec: VariantSpec = {
  name: 'thumb',
  maxEdge: 256,
  width: 64,
  height: 32,
  format: 'webp',
};

async function redPng(width: number, height: number): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buf);
}

describe('createSharpTransformer', () => {
  const transformer = createSharpTransformer();

  it('supports raster image types but never SVG', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      expect(transformer.supports(mime)).toBe(true);
    }
    expect(transformer.supports('image/svg+xml')).toBe(false);
    expect(transformer.supports('application/pdf')).toBe(false);
  });

  it('encodes a real image to a webp variant at the planned size', async () => {
    const input = await redPng(128, 64);
    const out = await transformer.transform(input, 'image/png', webpSpec);
    expect(out).toBeInstanceOf(Uint8Array);
    const meta = await sharp(Buffer.from(out as Uint8Array)).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(64);
    expect(meta.height).toBe(32);
  });

  it('honours the requested format', async () => {
    const input = await redPng(128, 64);
    const jpeg = await transformer.transform(input, 'image/png', {
      ...webpSpec,
      format: 'jpeg',
    });
    expect((await sharp(Buffer.from(jpeg as Uint8Array)).metadata()).format).toBe('jpeg');
    const png = await transformer.transform(input, 'image/png', { ...webpSpec, format: 'png' });
    expect((await sharp(Buffer.from(png as Uint8Array)).metadata()).format).toBe('png');
  });

  it('returns null on undecodable input instead of throwing', async () => {
    const out = await transformer.transform(new Uint8Array([1, 2, 3, 4]), 'image/png', webpSpec);
    expect(out).toBeNull();
  });

  it('degrades to null when the native encoder cannot be loaded', async () => {
    const broken = createSharpTransformer(async () => {
      throw new Error('cannot load sharp');
    });
    const input = await redPng(8, 8);
    await expect(broken.transform(input, 'image/png', webpSpec)).resolves.toBeNull();
  });
});
