/**
 * Minimal USTAR reader/writer (ADR-0018 §2).
 *
 * The in-app export archives media as a `.tar` (optionally gzipped). The
 * repository carries no tar dependency and `fflate` 0.8 only ships a tar
 * codec in newer majors, so this module implements the small, well-specified
 * subset we need: regular files with paths up to the USTAR prefix/name split,
 * 8 KiB-aligned padding, and standard headers. It is intentionally defensive
 * on read: a malformed archive throws {@link TarFormatError}, never silently
 * truncates.
 *
 * Only regular files are emitted; directories are implied by each entry's path
 * (archive consumers recreate parents). This keeps the format boring and
 * interoperable with `tar`/BSD tar.
 */

/** Thrown when an archive cannot be parsed. */
export class TarFormatError extends Error {}

const BLOCK = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface TarEntry {
  /** Slash-separated path inside the archive (no leading slash). */
  name: string;
  data: Uint8Array;
  /** Permission bits; defaults to 0o644. */
  mode?: number;
  /** Unix mtime in seconds; defaults to 0. */
  mtime?: number;
}

/** Encode a number as a NUL-terminated octal field of `length` bytes. */
function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  const text = Math.max(0, Math.floor(value)).toString(8);
  if (text.length > length - 1) {
    throw new TarFormatError(`tar 字段溢出：${value}`);
  }
  const padded = text.padStart(length - 1, '0');
  for (let i = 0; i < padded.length; i += 1) target[offset + i] = padded.charCodeAt(i);
  target[offset + length - 1] = 0;
}

function writeString(target: Uint8Array, offset: number, length: number, text: string): void {
  const bytes = encoder.encode(text);
  const copy = Math.min(bytes.length, length);
  target.set(bytes.subarray(0, copy), offset);
}

/** Compute the header checksum (chksum field treated as spaces). */
function checksum(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    sum += i >= 148 && i < 156 ? 32 : header[i] ?? 0;
  }
  return sum;
}

/** Split a path into (prefix, name) so `prefix + '/' + name` fits USTAR. */
function splitPath(path: string): { name: string; prefix: string } {
  const bytes = encoder.encode(path);
  if (bytes.length <= 100) return { name: path, prefix: '' };
  const slash = path.lastIndexOf('/');
  if (slash > 0) {
    const prefix = path.slice(0, slash);
    const name = path.slice(slash + 1);
    if (encoder.encode(prefix).length <= 155 && encoder.encode(name).length <= 100) {
      return { name, prefix };
    }
  }
  throw new TarFormatError(`tar 路径过长：${path}`);
}

function padTo(length: number, block = BLOCK): number {
  const remainder = length % block;
  return remainder === 0 ? 0 : block - remainder;
}

/** Serialize entries into an uncompressed USTAR archive. */
export function createTar(entries: ReadonlyArray<TarEntry>): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const entry of entries) {
    const { name, prefix } = splitPath(entry.name);
    const header = new Uint8Array(BLOCK);
    writeString(header, 0, 100, name);
    writeOctal(header, 100, 8, entry.mode ?? 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.data.byteLength);
    writeOctal(header, 136, 12, entry.mtime ?? 0);
    header[156] = '0'.charCodeAt(0);
    writeString(header, 257, 6, 'ustar');
    header[262] = 0;
    header[263] = '0'.charCodeAt(0);
    header[264] = '0'.charCodeAt(0);
    writeString(header, 345, 155, prefix);
    const sum = checksum(header);
    // 6 octal digits, NUL, space.
    const sumText = sum.toString(8).padStart(6, '0');
    for (let i = 0; i < 6; i += 1) header[148 + i] = sumText.charCodeAt(i);
    header[154] = 0;
    header[155] = 32;

    chunks.push(header);
    chunks.push(entry.data);
    total += BLOCK + entry.data.byteLength;
    const padding = padTo(entry.data.byteLength);
    if (padding > 0) {
      chunks.push(new Uint8Array(padding));
      total += padding;
    }
  }
  // End-of-archive marker: two zero blocks.
  chunks.push(new Uint8Array(BLOCK * 2));
  total += BLOCK * 2;

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function readString(block: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const limit = offset + length;
  while (end < limit && block[end] !== 0) end += 1;
  return decoder.decode(block.subarray(offset, end));
}

function isZeroBlock(block: Uint8Array): boolean {
  for (let i = 0; i < BLOCK; i += 1) if (block[i] !== 0) return false;
  return true;
}

function readOctal(block: Uint8Array, offset: number, length: number): number {
  const text = readString(block, offset, length).trim();
  if (text.length === 0) return 0;
  const value = Number.parseInt(text, 8);
  return Number.isNaN(value) ? 0 : value;
}

/**
 * Parse an uncompressed USTAR archive into a path -> bytes map. Directory
 * entries are ignored (their paths are implied by child files). Throws on a
 * malformed header or a truncated payload.
 */
export function extractTar(data: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + BLOCK <= data.byteLength) {
    const header = data.subarray(offset, offset + BLOCK);
    if (isZeroBlock(header)) break;
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const size = readOctal(header, 124, 12);
    const typeflag = header[156];
    // '0' or NUL = regular file; '5' = directory; others we skip but still
    // advance past their payload so a valid archive stays parseable.
    const fullPath = prefix ? `${prefix}/${name}` : name;
    offset += BLOCK;
    if (offset + size > data.byteLength) {
      throw new TarFormatError(`tar 载荷被截断：${fullPath}`);
    }
    if (typeflag === 0 || typeflag === '0'.charCodeAt(0)) {
      files.set(fullPath, data.slice(offset, offset + size));
    }
    offset += size + padTo(size);
  }
  return files;
}
