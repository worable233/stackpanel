import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDiskDriver } from '@stackpanel/db';
import { AttachmentService, MediaError } from '../../src/media/service.ts';
import type {
  AttachmentRecord,
  AttachmentLibraryStats,
  AttachmentRepository,
  AttachmentVariant,
  AttachmentVisibility,
  CreateAttachmentInput,
} from '../../src/media/attachments.ts';
import type { ImageTransformer, VariantSpec } from '../../src/media/image.ts';
import { optimizeTargetForMime } from '../../src/media/image.ts';

function png(width: number, height: number, fill = 0x00): Uint8Array {
  const out = new Uint8Array(64);
  out.fill(fill, 24);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  out.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(out.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return out;
}

class FakeRepository implements AttachmentRepository {
  readonly rows = new Map<string, AttachmentRecord>();
  async create(input: CreateAttachmentInput): Promise<AttachmentRecord> {
    const row: AttachmentRecord = {
      id: input.id,
      key: input.key,
      filename: input.filename,
      mime: input.mime,
      size: input.size,
      width: input.width ?? null,
      height: input.height ?? null,
      ownerId: input.ownerId ?? null,
      visibility: input.visibility ?? 'private',
      variants: input.variants ?? [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.rows.set(row.id, row);
    return row;
  }
  async findById(id: string): Promise<AttachmentRecord | null> {
    return this.rows.get(id) ?? null;
  }
  async listByOwner(ownerId: string): Promise<AttachmentRecord[]> {
    return [...this.rows.values()].filter((row) => row.ownerId === ownerId);
  }
  async update(
    id: string,
    patch: {
      filename?: string | undefined;
      visibility?: AttachmentVisibility | undefined;
      key?: string | undefined;
      mime?: string | undefined;
      size?: number | undefined;
    },
  ): Promise<AttachmentRecord | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    if (patch.filename !== undefined) row.filename = patch.filename;
    if (patch.visibility !== undefined) row.visibility = patch.visibility;
    if (patch.key !== undefined) row.key = patch.key;
    if (patch.mime !== undefined) row.mime = patch.mime;
    if (patch.size !== undefined) row.size = patch.size;
    return row;
  }
  async updateVariants(id: string, variants: AttachmentVariant[]): Promise<AttachmentRecord | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    row.variants = variants;
    return row;
  }
  async listPendingVariantAttachments(
    limit: number,
    maxAttempts: number,
  ): Promise<AttachmentRecord[]> {
    return [...this.rows.values()]
      .filter((row) =>
        row.variants.some(
          (variant) =>
            (variant.status ?? 'ready') === 'pending' && (variant.attempts ?? 0) < maxAttempts,
        ),
      )
      .slice(0, limit);
  }
  async listForAdmin(): Promise<{ items: AttachmentRecord[]; total: number }> {
    const items = [...this.rows.values()];
    return { items, total: items.length };
  }
  async stats(): Promise<AttachmentLibraryStats> {
    const items = [...this.rows.values()];
    return {
      total: items.length,
      bytes: items.reduce((sum, row) => sum + row.size, 0),
      byVisibility: { public: 0, private: 0 },
      byKind: { image: 0, document: 0, archive: 0, video: 0, audio: 0, text: 0, other: 0 },
      variants: { pending: 0, ready: 0, failed: 0 },
    };
  }
  async resetFailedVariants(): Promise<string[]> {
    return [];
  }
  async listOptimizable(limit: number): Promise<AttachmentRecord[]> {
    return [...this.rows.values()]
      .filter((row) => ['image/png', 'image/jpeg', 'image/gif'].includes(row.mime))
      .slice(0, limit);
  }
  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }
}

const fakeTransformer: ImageTransformer = {
  supports: (mime) => mime.startsWith('image/'),
  transform: async (_input, _mime, spec: VariantSpec) =>
    new TextEncoder().encode(`${spec.name}:${spec.width}x${spec.height}:${spec.format}`),
};

describe('AttachmentService', () => {
  let root: string;
  let storage: LocalDiskDriver;
  let repository: FakeRepository;
  let service: AttachmentService;
  let idCounter: number;

  const owner = { userId: 'user_a', canManage: false };
  const other = { userId: 'user_b', canManage: false };
  const admin = { userId: 'user_admin', canManage: true };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sp-media-'));
    storage = new LocalDiskDriver({ driver: 'local', root, publicBaseUrl: '/storage' });
    repository = new FakeRepository();
    idCounter = 0;
    service = new AttachmentService({
      repository,
      storage,
      transform: fakeTransformer,
      generateId: () => `att_${(idCounter += 1)}`,
      logger: { warn: () => undefined },
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stores bytes, detects the type, and records image dimensions', async () => {
    const data = png(3000, 1500);
    const view = await service.ingest({ data, filename: 'photo.png' }, owner);
    expect(view.mime).toBe('image/png');
    expect(view.width).toBe(3000);
    expect(view.height).toBe(1500);
    expect(view.ownerId).toBe('user_a');
    expect(view.visibility).toBe('private');
    expect(await storage.get(`media/${yearMonth()}/att_1/original.png`)).toEqual(data);
  });

  it('generates variants for a large image and stores their bytes', async () => {
    const view = await service.ingest({ data: png(3000, 1500), filename: 'p.png' }, owner);
    expect(view.variants.map((v) => v.name)).toEqual(['thumb', 'medium', 'large']);
    const thumb = view.variants[0];
    expect(thumb).toMatchObject({ width: 256, height: 128, format: 'webp' });
    const stored = await storage.get(`media/${yearMonth()}/att_1/thumb.webp`);
    expect(new TextDecoder().decode(stored as Uint8Array)).toBe('thumb:256x128:webp');
  });

  it('serves original and variant content through the service', async () => {
    const data = png(3000, 1500, 0x42);
    const view = await service.ingest({ data, filename: 'p.png' }, owner);
    const original = await service.readContent(view.id, owner);
    expect(original?.data).toEqual(data);
    const variant = await service.readContent(view.id, owner, 'thumb');
    expect(new TextDecoder().decode(variant?.data as Uint8Array)).toContain('thumb:');
  });

  it('rejects unsupported and empty uploads', async () => {
    await expect(
      service.ingest(
        { data: new TextEncoder().encode('<html></html>'), filename: 'x.html' },
        owner,
      ),
    ).rejects.toMatchObject({ status: 415, code: 'media.unsupported_type' });
    await expect(
      service.ingest({ data: new Uint8Array(0), filename: 'x' }, owner),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('enforces attachment visibility for reads', async () => {
    const view = await service.ingest({ data: png(10, 10), filename: 'p.png' }, owner);
    await expect(service.get(view.id, other)).rejects.toBeInstanceOf(MediaError);
    expect((await service.get(view.id, admin)).id).toBe(view.id);

    const publicView = await service.ingest(
      { data: png(10, 10), filename: 'p.png', visibility: 'public' },
      owner,
    );
    expect((await service.get(publicView.id, other)).id).toBe(publicView.id);
  });

  it('lists only the actor own attachments unless admin', async () => {
    await service.ingest({ data: png(10, 10), filename: 'a.png' }, owner);
    await service.ingest({ data: png(10, 10), filename: 'b.png' }, other);
    expect((await service.list(owner)).length).toBe(1);
    expect((await service.list(admin, 'user_b')).length).toBe(1);
    await expect(service.list(owner, 'user_b')).rejects.toBeInstanceOf(MediaError);
  });

  it('removes bytes and metadata, but blocks deletion while referenced', async () => {
    const view = await service.ingest({ data: png(3000, 1500), filename: 'p.png' }, owner);
    const originalKey = `media/${yearMonth()}/att_1/original.png`;
    const thumbKey = `media/${yearMonth()}/att_1/thumb.webp`;
    expect(await storage.exists(originalKey)).toBe(true);

    await expect(
      service.remove(view.id, owner, { isReferenced: async () => true }),
    ).rejects.toMatchObject({ status: 409, code: 'media.in_use' });

    await service.remove(view.id, owner, { isReferenced: async () => false });
    expect(await storage.exists(originalKey)).toBe(false);
    expect(await storage.exists(thumbKey)).toBe(false);
    await expect(service.get(view.id, owner)).rejects.toMatchObject({ status: 404 });
  });

  it('sanitizes path-like filenames and hides storage keys behind content URLs', async () => {
    const view = await service.ingest({ data: png(10, 10), filename: '../../etc/passwd' }, owner);
    expect(view.filename).toBe('passwd');
    expect(view.url).toBe(`/media/${view.id}/content`);
    expect(view.variants[0]?.url ?? '').not.toContain('media/');
  });
});

/** Current date shard used by buildMediaKey (mirrors its UTC logic). */
function yearMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * WebP delivery encode (ADR-0014 §4 addendum).
 *
 * The stand-in encoder returns a 13-byte payload so the byte guard ("only keep
 * the WebP when it is strictly smaller than the upload") is exercised rather
 * than bypassed. Real encoder behaviour is covered by the integration suite.
 */
const webpTransformer: ImageTransformer = {
  supports: (mime) => mime.startsWith('image/'),
  transform: async (_input, _mime, spec) =>
    new TextEncoder().encode(`${spec.name}:${spec.width}x${spec.height}:${spec.format}`),
  optimize: async (_input, _mime, target) =>
    new TextEncoder().encode(target.lossless ? 'webp:lossless' : 'webp:lossy'),
};

describe('WebP delivery encode', () => {
  let root: string;
  let storage: LocalDiskDriver;
  let repository: FakeRepository;
  let idCounter = 0;
  const owner = { userId: 'user_a', canManage: false };

  const withEncoder = (options: { optimize?: boolean; transformer?: ImageTransformer } = {}) =>
    new AttachmentService({
      repository,
      storage,
      transform: options.transformer ?? webpTransformer,
      ...(options.optimize === undefined ? {} : { optimize: options.optimize }),
      generateId: () => `att_${(idCounter += 1)}`,
      logger: { warn: () => undefined },
    });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sp-media-webp-'));
    storage = new LocalDiskDriver({ driver: 'local', root, publicBaseUrl: '/storage' });
    repository = new FakeRepository();
    idCounter = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('plans lossless for graphics and quality-82 for photos', () => {
    expect(optimizeTargetForMime('image/png')).toEqual({ lossless: true });
    expect(optimizeTargetForMime('image/gif')).toEqual({ lossless: true });
    expect(optimizeTargetForMime('image/webp')).toEqual({ lossless: true });
    expect(optimizeTargetForMime('image/jpeg')).toEqual({ lossless: false });
    // Vector sources keep their XML: rasterising would drop semantics.
    expect(optimizeTargetForMime('image/svg+xml')).toBeNull();
    expect(optimizeTargetForMime('application/pdf')).toBeNull();
  });

  it('stores the WebP bytes as the original and renames the file', async () => {
    const encoder = withEncoder();
    const view = await encoder.ingest({ data: png(3000, 1500), filename: 'shot.png' }, owner);
    const row = repository.rows.get(view.id);
    expect(row?.mime).toBe('image/webp');
    expect(row?.key).toBe(`media/${yearMonth()}/${view.id}/original.webp`);
    expect(row?.filename).toBe('shot.webp');
    expect(row?.size).toBe('webp:lossless'.length);
    const stored = await storage.get(row?.key ?? '');
    expect(new TextDecoder().decode(stored ?? new Uint8Array())).toBe('webp:lossless');
    // The discarded PNG never reached storage: no orphan, no second copy.
    expect(await storage.get(`media/${yearMonth()}/${view.id}/original.png`)).toBeNull();
  });

  it('keeps the original when the WebP did not get smaller', async () => {
    const inflated: ImageTransformer = {
      ...webpTransformer,
      optimize: async () => new Uint8Array(512),
    };
    const view = await withEncoder({ transformer: inflated }).ingest(
      { data: png(3000, 1500), filename: 'tiny.png' },
      owner,
    );
    expect(repository.rows.get(view.id)?.mime).toBe('image/png');
    expect(await storage.get(`media/${yearMonth()}/${view.id}/original.png`)).not.toBeNull();
  });

  it('honours the composition-root switch', async () => {
    const view = await withEncoder({ optimize: false }).ingest(
      { data: png(3000, 1500), filename: 'raw.png' },
      owner,
    );
    expect(repository.rows.get(view.id)?.mime).toBe('image/png');
  });

  it('converts stored attachments in place and reports the savings', async () => {
    const view = await withEncoder({ optimize: false }).ingest(
      { data: png(3000, 1500), filename: 'old.png' },
      owner,
    );
    // Snapshot the pre-conversion row: the fake repository hands out live rows,
    // so reading it after the batch would show the converted size.
    const beforeSize = repository.rows.get(view.id)?.size ?? 0;
    const beforeKey = repository.rows.get(view.id)?.key ?? '';
    const result = await withEncoder().optimizeLibrary();
    expect(result).toMatchObject({ optimized: 1, skipped: 0 });
    expect(result.savedBytes).toBe(beforeSize - 'webp:lossless'.length);
    const after = repository.rows.get(view.id);
    expect(after?.mime).toBe('image/webp');
    expect(after?.filename).toBe('old.webp');
    // Old object removed, new key holds the encoded bytes.
    expect(await storage.get(beforeKey)).toBeNull();
    const stored = await storage.get(after?.key ?? '');
    expect(new TextDecoder().decode(stored ?? new Uint8Array())).toBe('webp:lossless');
  });

  it('skips rows whose bytes are gone', async () => {
    const view = await withEncoder({ optimize: false }).ingest(
      { data: png(3000, 1500), filename: 'gone.png' },
      owner,
    );
    await storage.delete(repository.rows.get(view.id)?.key ?? '');
    const result = await withEncoder().optimizeLibrary();
    expect(result).toMatchObject({ optimized: 0, skipped: 1 });
    expect(repository.rows.get(view.id)?.mime).toBe('image/png');
  });

  it('targets a single attachment when asked', async () => {
    const convert = withEncoder({ optimize: false });
    const first = await convert.ingest({ data: png(3000, 1500), filename: 'a.png' }, owner);
    const second = await convert.ingest({ data: png(3000, 1500), filename: 'b.png' }, owner);
    const result = await withEncoder().optimizeLibrary(first.id);
    expect(result.ids).toEqual([first.id]);
    expect(repository.rows.get(second.id)?.mime).toBe('image/png');
  });

  it('publishes a revision that moves only when the bytes move', async () => {
    const encoder = withEncoder({ optimize: false });
    const view = await encoder.ingest({ data: png(3000, 1500), filename: 'rev.png' }, owner);
    expect(view.rev).toMatch(/^[0-9a-f]{16}$/);
    // A variant has its own bytes, so its own revision.
    expect(view.variants.every((variant) => variant.rev !== view.rev)).toBe(true);

    // Metadata-only edits keep the bytes where they are: the link's copy is still
    // current, so the revision must not change (otherwise every rename would
    // bust caches that had nothing wrong with them).
    const renamed = await encoder.updateMetadata(view.id, { filename: 'other.png' }, owner);
    expect(renamed.rev).toBe(view.rev);

    // The conversion rewrites the object and its key, so the revision moves —
    // that is what lets an already-published link notice the new content.
    const optimizer = withEncoder();
    const converted = await optimizer.optimizeLibrary(view.id);
    expect(converted.optimized).toBe(1);
    const after = await optimizer.get(view.id, owner);
    expect(after.mime).toBe('image/webp');
    expect(after.rev).not.toBe(view.rev);
    // …while the link itself is untouched: identity is the id, not the bytes.
    expect(after.url).toBe(view.url);
    expect(after.variants.map((variant) => variant.url)).toEqual(
      view.variants.map((variant) => variant.url),
    );
  });
});
