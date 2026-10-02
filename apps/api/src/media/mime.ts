/**
 * MIME sniffing by magic bytes (ADR-0014 §3).
 *
 * The browser-supplied `Content-Type` on an upload is untrusted, so the kernel
 * never stores a declared type: it detects the real type from the leading bytes
 * and rejects anything outside the allowlist. This is the single gate that
 * keeps an `.svg` labelled `image/png`, or an HTML file labelled `image/jpeg`,
 * from being persisted and later served same-origin.
 */

/** Coarse category used to decide downstream handling (image pipeline etc.). */
export type MediaKind = 'image' | 'document' | 'archive' | 'video' | 'audio' | 'text' | 'other';

export interface SniffedMime {
  /** Detected IANA media type, e.g. `image/png`. */
  mime: string;
  /** Canonical file extension without the dot, e.g. `png`. */
  ext: string;
  kind: MediaKind;
}

const startsWith = (data: Uint8Array, bytes: readonly number[], offset = 0): boolean => {
  if (data.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (data[offset + i] !== bytes[i]) return false;
  }
  return true;
};

const ascii = (data: Uint8Array, start: number, length: number): string =>
  Buffer.from(data.subarray(start, start + length)).toString('latin1');

/**
 * Detect the media type of `data` from its leading bytes. Returns null when the
 * type is not recognised (the caller then rejects the upload).
 */
export function sniffMime(data: Uint8Array): SniffedMime | null {
  if (data.length < 4) return null;

  // --- Images ---------------------------------------------------------------
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: 'image/png', ext: 'png', kind: 'image' };
  }
  if (startsWith(data, [0xff, 0xd8, 0xff])) {
    return { mime: 'image/jpeg', ext: 'jpg', kind: 'image' };
  }
  if (ascii(data, 0, 4) === 'GIF8') {
    return { mime: 'image/gif', ext: 'gif', kind: 'image' };
  }
  if (ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 4) === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp', kind: 'image' };
  }
  if (looksLikeSvg(data)) {
    return { mime: 'image/svg+xml', ext: 'svg', kind: 'image' };
  }

  // --- Documents ------------------------------------------------------------
  if (ascii(data, 0, 5) === '%PDF-') {
    return { mime: 'application/pdf', ext: 'pdf', kind: 'document' };
  }

  // --- Archives -------------------------------------------------------------
  // ZIP local file header; OOXML/ODF also present as zip but we keep the
  // generic container type rather than guessing a sub-format.
  if (startsWith(data, [0x50, 0x4b, 0x03, 0x04])) {
    return { mime: 'application/zip', ext: 'zip', kind: 'archive' };
  }
  if (startsWith(data, [0x1f, 0x8b])) {
    return { mime: 'application/gzip', ext: 'gz', kind: 'archive' };
  }

  // --- Video / audio --------------------------------------------------------
  if (ascii(data, 4, 4) === 'ftyp') {
    return { mime: 'video/mp4', ext: 'mp4', kind: 'video' };
  }
  if (startsWith(data, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { mime: 'video/webm', ext: 'webm', kind: 'video' };
  }
  if (ascii(data, 0, 4) === 'OggS') {
    return { mime: 'audio/ogg', ext: 'ogg', kind: 'audio' };
  }
  if (ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 4) === 'WAVE') {
    return { mime: 'audio/wav', ext: 'wav', kind: 'audio' };
  }
  if (ascii(data, 0, 3) === 'ID3' || startsWith(data, [0xff, 0xfb])) {
    return { mime: 'audio/mpeg', ext: 'mp3', kind: 'audio' };
  }

  return null;
}

/**
 * SVG is XML text, so it has no fixed magic bytes. Accept an optional UTF-8 BOM
 * and leading whitespace, then require an XML declaration or a literal `<svg`
 * root. This intentionally errs toward rejecting: a stray HTML document must not
 * pass as an image.
 */
function looksLikeSvg(data: Uint8Array): boolean {
  let offset = 0;
  if (startsWith(data, [0xef, 0xbb, 0xbf])) offset = 3; // UTF-8 BOM
  const end = Math.min(data.length, offset + 1024);
  while (offset < end && isXmlWhitespace(data[offset] as number)) offset += 1;
  if (offset >= end) return false;
  const head = ascii(data, offset, end - offset);
  if (head.startsWith('<?xml')) return true;
  return /^<svg[\s/>]/i.test(head);
}

function isXmlWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

/** Whether the bytes are valid UTF-8 text (used for the `text/*` allowlist). */
export function isProbablyText(data: Uint8Array): boolean {
  if (data.includes(0x00)) return false;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    decoder.decode(data);
    return true;
  } catch {
    return false;
  }
}

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Read intrinsic pixel dimensions from image headers. Returns null for formats
 * we do not parse (SVG) — there the caller falls back to a viewBox heuristic or
 * leaves the size unset. Only the leading header is read, never a full decode.
 */
export function detectImageDimensions(data: Uint8Array, mime: string): ImageDimensions | null {
  switch (mime) {
    case 'image/png':
      return pngDimensions(data);
    case 'image/jpeg':
      return jpegDimensions(data);
    case 'image/gif':
      return gifDimensions(data);
    case 'image/webp':
      return webpDimensions(data);
    default:
      return null;
  }
}

const view = (data: Uint8Array): DataView =>
  new DataView(data.buffer, data.byteOffset, data.byteLength);

function pngDimensions(data: Uint8Array): ImageDimensions | null {
  // IHDR is always the first chunk: width/height are big-endian uint32 at 16/20.
  if (data.length < 24) return null;
  if (ascii(data, 12, 4) !== 'IHDR') return null;
  const v = view(data);
  return { width: v.getUint32(16, false), height: v.getUint32(20, false) };
}

function gifDimensions(data: Uint8Array): ImageDimensions | null {
  if (data.length < 10) return null;
  const v = view(data);
  return { width: v.getUint16(6, true), height: v.getUint16(8, true) };
}

function jpegDimensions(data: Uint8Array): ImageDimensions | null {
  let offset = 2; // skip SOI (FF D8)
  const v = view(data);
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = data[offset + 1] as number;
    // Standalone markers without a length payload.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = v.getUint16(offset + 2, false);
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: v.getUint16(offset + 5, false),
        width: v.getUint16(offset + 7, false),
      };
    }
    offset += 2 + length;
  }
  return null;
}

function webpDimensions(data: Uint8Array): ImageDimensions | null {
  if (data.length < 30) return null;
  const v = view(data);
  const chunk = ascii(data, 12, 4);
  if (chunk === 'VP8 ') {
    // Lossy: 3-byte frame tag, 3-byte sync code, then 14-bit w/h (LE).
    const width = v.getUint16(26, true) & 0x3fff;
    const height = v.getUint16(28, true) & 0x3fff;
    return { width, height };
  }
  if (chunk === 'VP8L') {
    // Lossless: 14-bit width-1 / height-1 packed into 4 little-endian bytes.
    const bits = v.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    // Extended: 24-bit canvas width-1 / height-1 (LE) after flags+reserved.
    const width = (data[24] as number) + ((data[25] as number) << 8) + ((data[26] as number) << 16);
    const height =
      (data[27] as number) + ((data[28] as number) << 8) + ((data[29] as number) << 16);
    return { width: width + 1, height: height + 1 };
  }
  return null;
}
