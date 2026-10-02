import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDiskDriver } from '@stackpanel/db';
import { AttachmentService, MediaError } from '../../src/media/service.ts';
import type {
  AttachmentRecord,
  AttachmentRepository,
  AttachmentVariant,
  AttachmentVisibility,
  CreateAttachmentInput,
} from '../../src/media/attachments.ts';
import type { ImageTransformer, VariantSpec } from '../../src/media/image.ts';

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
    patch: { filename?: string | undefined; visibility?: AttachmentVisibility | undefined },
  ): Promise<AttachmentRecord | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    if (patch.filename !== undefined) row.filename = patch.filename;
    if (patch.visibility !== undefined) row.visibility = patch.visibility;
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
