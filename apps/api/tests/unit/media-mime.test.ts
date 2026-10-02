import { describe, expect, it } from 'vitest';
import { detectImageDimensions, isProbablyText, sniffMime } from '../../src/media/mime.ts';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

function png(width: number, height: number): Uint8Array {
  const out = new Uint8Array(24);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  out.set([0x00, 0x00, 0x00, 0x0d], 8); // IHDR length
  out.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  const view = new DataView(out.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return out;
}

function jpeg(width: number, height: number): Uint8Array {
  return bytes(
    0xff,
    0xd8, // SOI
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08, // SOF0, len=17, precision
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
  );
}

function gif(width: number, height: number): Uint8Array {
  return bytes(
    0x47,
    0x49,
    0x46,
    0x38,
    0x39,
    0x61, // GIF89a
    width & 0xff,
    (width >> 8) & 0xff,
    height & 0xff,
    (height >> 8) & 0xff,
  );
}

function webpVp8x(width: number, height: number): Uint8Array {
  const w = width - 1;
  const h = height - 1;
  return bytes(
    0x52,
    0x49,
    0x46,
    0x46,
    0x00,
    0x00,
    0x00,
    0x00, // RIFF....
    0x57,
    0x45,
    0x42,
    0x50, // WEBP
    0x56,
    0x50,
    0x38,
    0x58, // VP8X
    0x0a,
    0x00,
    0x00,
    0x00, // chunk size
    0x00,
    0x00,
    0x00,
    0x00, // flags + reserved
    w & 0xff,
    (w >> 8) & 0xff,
    (w >> 16) & 0xff,
    h & 0xff,
    (h >> 8) & 0xff,
    (h >> 16) & 0xff,
  );
}

describe('sniffMime', () => {
  it('detects images from magic bytes', () => {
    expect(sniffMime(png(3, 4))?.mime).toBe('image/png');
    expect(sniffMime(jpeg(3, 4))?.mime).toBe('image/jpeg');
    expect(sniffMime(gif(3, 4))?.mime).toBe('image/gif');
    expect(sniffMime(webpVp8x(3, 4))?.mime).toBe('image/webp');
  });

  it('detects documents and archives', () => {
    expect(sniffMime(Buffer.from('%PDF-1.7\n'))?.mime).toBe('application/pdf');
    expect(sniffMime(bytes(0x50, 0x4b, 0x03, 0x04, 0x00))?.mime).toBe('application/zip');
    expect(sniffMime(bytes(0x1f, 0x8b, 0x08, 0x00))?.mime).toBe('application/gzip');
  });

  it('detects video and audio containers', () => {
    expect(sniffMime(Buffer.from('\x00\x00\x00\x18ftypmp42'))?.mime).toBe('video/mp4');
    expect(sniffMime(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x00))?.mime).toBe('video/webm');
    expect(sniffMime(Buffer.from('OggS\x00\x02'))?.mime).toBe('audio/ogg');
    expect(sniffMime(Buffer.from('RIFF\x10\x00\x00\x00WAVE'))?.mime).toBe('audio/wav');
    expect(sniffMime(Buffer.from('ID3\x04\x00'))?.mime).toBe('audio/mpeg');
  });

  it('accepts an XML declaration or <svg> root as SVG, with BOM/whitespace', () => {
    expect(sniffMime(Buffer.from('<?xml version="1.0"?><svg/>'))?.mime).toBe('image/svg+xml');
    expect(sniffMime(Buffer.from('  \n <svg viewBox="0 0 1 1"></svg>'))?.mime).toBe(
      'image/svg+xml',
    );
    expect(sniffMime(Uint8Array.from([0xef, 0xbb, 0xbf, ...Buffer.from('<svg/>')]))?.mime).toBe(
      'image/svg+xml',
    );
  });

  it('rejects an HTML document masquerading as SVG', () => {
    expect(sniffMime(Buffer.from('<html><body>hi</body></html>'))).toBeNull();
  });

  it('rejects unknown bytes', () => {
    expect(sniffMime(bytes(0x00, 0x01, 0x02, 0x03, 0x04))).toBeNull();
    expect(sniffMime(bytes(0x41))).toBeNull();
  });
});

describe('detectImageDimensions', () => {
  it('reads PNG IHDR dimensions', () => {
    expect(detectImageDimensions(png(1920, 1080), 'image/png')).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it('reads JPEG SOF0 dimensions', () => {
    expect(detectImageDimensions(jpeg(800, 600), 'image/jpeg')).toEqual({
      width: 800,
      height: 600,
    });
  });

  it('reads GIF dimensions (little-endian)', () => {
    expect(detectImageDimensions(gif(320, 240), 'image/gif')).toEqual({
      width: 320,
      height: 240,
    });
  });

  it('reads WebP VP8X canvas dimensions', () => {
    expect(detectImageDimensions(webpVp8x(2000, 1200), 'image/webp')).toEqual({
      width: 2000,
      height: 1200,
    });
  });

  it('returns null for SVG (no header dimensions)', () => {
    expect(detectImageDimensions(Buffer.from('<svg/>'), 'image/svg+xml')).toBeNull();
  });

  it('returns null for a truncated header', () => {
    expect(detectImageDimensions(bytes(0x89, 0x50), 'image/png')).toBeNull();
  });
});

describe('isProbablyText', () => {
  it('accepts UTF-8 text and rejects NUL-bearing bytes', () => {
    expect(isProbablyText(Buffer.from('你好，世界'))).toBe(true);
    expect(isProbablyText(bytes(0x00, 0x01))).toBe(false);
    expect(isProbablyText(bytes(0xff, 0xfe, 0xfa))).toBe(false);
  });
});
