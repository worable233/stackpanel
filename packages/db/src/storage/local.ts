import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { LocalStorageConfig } from '../config.ts';
import {
  assertSafeStorageKey,
  type PutObjectOptions,
  type StorageDriver,
  type StorageObjectStat,
} from './types.ts';

/**
 * Local-disk storage driver.
 *
 * Development fallback only: multiple replicas do not share a filesystem, so
 * production refuses this driver (see `readInfraConfig`). Objects live under
 * `root`; the public URL is `publicBaseUrl/<key>` served by the API.
 */
export class LocalDiskDriver implements StorageDriver {
  readonly kind = 'local' as const;

  constructor(private readonly config: LocalStorageConfig) {}

  private pathFor(key: string): string {
    assertSafeStorageKey(key);
    const full = resolve(this.config.root, key);
    const rootWithSep = resolve(this.config.root) + sep;
    if (!full.startsWith(rootWithSep)) {
      throw new Error(`非法的 storage key：${key}`);
    }
    return full;
  }

  async put(key: string, data: Uint8Array, _options: PutObjectOptions = {}): Promise<void> {
    const full = this.pathFor(key);
    await mkdir(dirname(full), { recursive: true });
    const tmp = `${full}.${process.pid}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, full);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const full = this.pathFor(key);
    try {
      const buf = await readFile(full);
      // Return a plain Uint8Array (not a Buffer subclass) for driver parity.
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await unlink(this.pathFor(key)).catch(() => undefined);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async stat(key: string): Promise<StorageObjectStat | null> {
    const full = this.pathFor(key);
    try {
      const info = await stat(full);
      if (!info.isFile()) return null;
      return { key, size: info.size, lastModified: info.mtime.toISOString() };
    } catch {
      return null;
    }
  }

  async list(prefix = ''): Promise<StorageObjectStat[]> {
    const base = prefix ? this.pathFor(prefix) : resolve(this.config.root);
    const out: StorageObjectStat[] = [];
    const walk = async (dir: string, keyPrefix: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const childKey = keyPrefix ? `${keyPrefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(join(dir, entry.name), childKey);
        } else if (entry.isFile()) {
          const info = await stat(join(dir, entry.name));
          out.push({
            key: childKey,
            size: info.size,
            lastModified: info.mtime.toISOString(),
          });
        }
      }
    };
    // A prefix that points at a file, not a directory.
    try {
      const info = await stat(base);
      if (info.isFile()) {
        return [{ key: prefix, size: info.size, lastModified: info.mtime.toISOString() }];
      }
    } catch {
      if (prefix) return [];
    }
    await walk(base, prefix);
    return out;
  }

  url(key: string): string {
    const base = this.config.publicBaseUrl.replace(/\/$/, '');
    return `${base}/${key}`;
  }

  /**
   * The local driver has no secret to sign: the API proxies the bytes, so a
   * signed request is the same public path. Present so callers can use the
   * optional method uniformly (ADR-0014 §2).
   */
  async signedUrl(key: string, _expiresInSeconds?: number): Promise<string> {
    assertSafeStorageKey(key);
    return this.url(key);
  }

  /** Remove every object; used by dev tooling and tests. */
  async clear(): Promise<void> {
    await rm(this.config.root, { recursive: true, force: true });
  }
}
