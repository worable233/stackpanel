import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDiskDriver } from '@stackpanel/db';
import {
  type AttachmentRecord,
  type AttachmentRepository,
  type AttachmentVariant,
  type AttachmentVisibility,
  type CreateAttachmentInput,
} from '../../src/media/attachments.ts';
import type { ImageTransformer, VariantSpec } from '../../src/media/image.ts';
import { VARIANT_ATTEMPT_CAP, planPendingVariants } from '../../src/media/variants.ts';
import { countPending, processPendingVariants, runVariantJob } from '../../src/media/worker.ts';
import { AttachmentService } from '../../src/media/service.ts';

/** Minimal valid PNG header with the given intrinsic size. */
function png(width: number, height: number, fill = 0): Uint8Array {
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
          (v) => (v.status ?? 'ready') === 'pending' && (v.attempts ?? 0) < maxAttempts,
        ),
      )
      .slice(0, limit);
  }
  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }
}

const encoder: ImageTransformer = {
  supports: (mime) => mime.startsWith('image/'),
  transform: async (_input, _mime, spec: VariantSpec) =>
    new TextEncoder().encode(`${spec.name}:${spec.width}x${spec.height}:${spec.format}`),
};

const CAP = VARIANT_ATTEMPT_CAP;

describe('planPendingVariants', () => {
  it('plans only down-scale rungs, all pending with deterministic keys', () => {
    const createdAt = new Date('2026-03-04T05:06:07Z');
    const planned = planPendingVariants('att_x', createdAt, { width: 3000, height: 1500 });
    expect(planned.map((v) => v.name)).toEqual(['thumb', 'medium', 'large']);
    expect(planned.every((v) => v.status === 'pending' && v.attempts === 0 && v.size === 0)).toBe(
      true,
    );
    expect(planned[0]?.key).toBe('media/2026/03/att_x/thumb.webp');
    expect(planned[0]).toMatchObject({ width: 256, height: 128, format: 'webp' });
  });

  it('plans nothing when the image already fits every rung', () => {
    expect(planPendingVariants('att_s', new Date(), { width: 200, height: 100 })).toEqual([]);
  });
});

describe('variant worker', () => {
  let root: string;
  let storage: LocalDiskDriver;
  let repository: FakeRepository;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sp-media-variants-'));
    storage = new LocalDiskDriver({ driver: 'local', root, publicBaseUrl: '/storage' });
    repository = new FakeRepository();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seedPending(w: number, h: number): Promise<AttachmentRecord> {
    const bytes = png(w, h);
    const key = 'media/2026/03/att_1/original.png';
    await storage.put(key, bytes, { contentType: 'image/png', public: false });
    return repository.create({
      id: 'att_1',
      key,
      filename: 'p.png',
      mime: 'image/png',
      size: bytes.length,
      width: w,
      height: h,
      variants: planPendingVariants('att_1', new Date('2026-03-04T00:00:00Z'), {
        width: w,
        height: h,
      }),
    });
  }

  const deps = () => ({ repository, storage, transform: encoder, logger: { warn: () => undefined } });

  it('encodes every pending variant and stores its bytes deterministically', async () => {
    await seedPending(3000, 1500);
    const result = await runVariantJob(deps(), { attachmentId: 'att_1', format: 'webp' });
    expect(result).toBe('done');

    const row = await repository.findById('att_1');
    expect(row?.variants.every((v) => v.status === 'ready' && v.size > 0)).toBe(true);
    const bytes = await storage.get('media/2026/03/att_1/thumb.webp');
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe('thumb:256x128:webp');
  });

  it('is idempotent: a second pass over ready variants does nothing', async () => {
    await seedPending(3000, 1500);
    await runVariantJob(deps(), { attachmentId: 'att_1', format: 'webp' });
    const before = (await repository.findById('att_1'))?.variants.map((v) => v.size);
    const result = await runVariantJob(deps(), { attachmentId: 'att_1', format: 'webp' });
    expect(result).toBe('done');
    expect((await repository.findById('att_1'))?.variants.map((v) => v.size)).toEqual(before);
  });

  it('returns retry while a variant can still be attempted, then failed at the cap', async () => {
    await seedPending(3000, 1500);
    const broken: ImageTransformer = { supports: () => true, transform: async () => null };
    const failDeps = { ...deps(), transform: broken };

    for (let attempt = 1; attempt <= VARIANT_ATTEMPT_CAP; attempt += 1) {
      const result = await runVariantJob(failDeps, { attachmentId: 'att_1', format: 'webp' });
      expect(result).toBe(attempt < VARIANT_ATTEMPT_CAP ? 'retry' : 'done');
    }
    const row = await repository.findById('att_1');
    expect(row?.variants.every((v) => v.status === 'failed' && v.attempts === CAP)).toBe(true);
    expect(countPending(row as AttachmentRecord)).toBe(0);
  });

  it('marks a variant failed immediately for an unsupported source type', async () => {
    await seedPending(3000, 1500);
    const unsupported: ImageTransformer = { supports: () => false, transform: async () => null };
    const result = await runVariantJob(
      { ...deps(), transform: unsupported },
      { attachmentId: 'att_1', format: 'webp' },
    );
    expect(result).toBe('done');
    expect((await repository.findById('att_1'))?.variants.every((v) => v.status === 'failed')).toBe(
      true,
    );
  });

  it('is a no-op for a missing attachment', async () => {
    await expect(
      runVariantJob(deps(), { attachmentId: 'missing', format: 'webp' }),
    ).resolves.toBe('done');
  });

  it('backfill sweeps are limited to rows still pending within the cap', async () => {
    await seedPending(3000, 1500);
    expect(await processPendingVariants(deps())).toBe(1);
    // After the first pass everything is ready, so a second sweep finds nothing.
    expect(await processPendingVariants(deps())).toBe(0);
  });
});

describe('AttachmentService async mode', () => {
  let root: string;
  let storage: LocalDiskDriver;
  let repository: FakeRepository;
  const owner = { userId: 'user_a', canManage: false };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sp-media-svc-async-'));
    storage = new LocalDiskDriver({ driver: 'local', root, publicBaseUrl: '/storage' });
    repository = new FakeRepository();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('records pending variants and enqueues one job instead of encoding inline', async () => {
    const enqueued: unknown[] = [];
    let idCounter = 0;
    const service = new AttachmentService({
      repository,
      storage,
      transform: encoder,
      generateId: () => `att_${(idCounter += 1)}`,
      queue: { enqueue: async (payload) => void enqueued.push(payload) },
      logger: { warn: () => undefined },
    });

    const view = await service.ingest({ data: png(3000, 1500), filename: 'p.png' }, owner);
    expect(view.variants.map((v) => v.status)).toEqual(['pending', 'pending', 'pending']);
    expect(enqueued).toEqual([{ attachmentId: 'att_1', format: 'webp' }]);
  });

  it('serves 409 for a pending variant and 200 once the worker stored it', async () => {
    const service = new AttachmentService({
      repository,
      storage,
      transform: encoder,
      generateId: () => 'att_1',
      queue: { enqueue: async () => undefined },
      logger: { warn: () => undefined },
    });
    const view = await service.ingest({ data: png(3000, 1500), filename: 'p.png' }, owner);

    await expect(service.readContent(view.id, owner, 'thumb')).rejects.toMatchObject({
      status: 409,
      code: 'media.variant_pending',
    });

    await runVariantJob(
      { repository, storage, transform: encoder, logger: { warn: () => undefined } },
      { attachmentId: view.id, format: 'webp' },
    );
    const content = await service.readContent(view.id, owner, 'thumb');
    expect(new TextDecoder().decode(content?.data as Uint8Array)).toBe('thumb:256x128:webp');
  });

  it('still succeeds when the enqueue fails: rows stay pending for the sweep', async () => {
    const service = new AttachmentService({
      repository,
      storage,
      transform: encoder,
      generateId: () => 'att_1',
      queue: {
        enqueue: async () => {
          throw new Error('queue down');
        },
      },
      logger: { warn: () => undefined },
    });
    const view = await service.ingest({ data: png(3000, 1500), filename: 'p.png' }, owner);
    expect(view.variants.every((v) => v.status === 'pending')).toBe(true);
    const pending = await repository.listPendingVariantAttachments(10, CAP);
    expect(pending.map((r) => r.id)).toEqual(['att_1']);
  });
});
