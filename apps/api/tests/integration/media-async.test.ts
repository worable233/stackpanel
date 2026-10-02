import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { getJobRuntime, initJobs } from '../../src/jobs/index.ts';
import { env } from '../../src/config/env.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createTestUser } from '../auth-helpers.ts';
import { PrismaAttachmentRepository } from '../../src/media/prisma-attachment-repository.ts';
import { planPendingVariants } from '../../src/media/variants.ts';

const dbAvailable = await checkDbAvailable();
/** Stage B needs a real queue; only run when Redis is configured for the suite. */
const redisUrl = process.env.REDIS_URL ?? null;

async function realPng(width: number, height: number): Promise<Buffer> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 120, b: 210 } },
  })
    .png()
    .toBuffer();
  return Buffer.from(buf);
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

describe.skipIf(!dbAvailable || !redisUrl)('media async variants (real DB + Redis queue)', () => {
  let app: FastifyInstance;
  let dataDir = '';
  const suffix = Date.now();
  const ownerEmail = `media_async_${suffix}@example.com`;
  const password = 'IntegrationPass123';
  let token = '';
  let ownerId = '';

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(process.cwd(), '.sp-media-async-'));
    process.env['STACKPANEL_DATA_DIR'] = dataDir;
    // Attach the real BullMQ backend before building the app, so an upload finds
    // a live queue and the worker starts consuming the moment jobs register.
    await initJobs({
      redisUrl: redisUrl as string,
      logger: { info: () => undefined, warn: () => undefined },
    });
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const owner = await createTestUser(app, ownerEmail, password);
    token = owner.token;
    ownerId = owner.userId;
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await prisma.attachment.deleteMany({ where: { ownerId } });
    await prisma.user.deleteMany({ where: { email: ownerEmail } });
    await app.close();
    // Release the BullMQ worker/queue connections attached for this file so the
    // shared process does not keep a consumer on the queue past the suite.
    await getJobRuntime().stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('enqueues the plan and the worker encodes variants to fetchable webp', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/media?filename=big.png',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png' },
      payload: await realPng(3000, 1500),
    });
    expect(res.statusCode).toBe(201);
    const attachment = (
      res.json() as {
        attachment: { id: string; variants: Array<{ name: string; status: string }> };
      }
    ).attachment;
    const id = attachment.id;
    // Upload returns immediately with the plan recorded (status pending or, if
    // the worker already picked it up, ready). Never inline-encoded bytes.
    expect(attachment.variants.map((v) => v.name)).toEqual(['thumb', 'medium', 'large']);
    expect(attachment.variants.every((v) => v.status === 'pending' || v.status === 'ready')).toBe(
      true,
    );

    const ready = await waitFor(async () => {
      const meta = await app.inject({
        method: 'GET',
        url: `/media/${id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      const variants = (meta.json() as { attachment: { variants: Array<{ status: string }> } })
        .attachment.variants;
      return variants.length === 3 && variants.every((v) => v.status === 'ready');
    });
    expect(ready, 'worker did not finish all variants in time').toBe(true);

    const thumb = await app.inject({
      method: 'GET',
      url: `/media/${id}/content?variant=thumb`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers['content-type']).toContain('image/webp');
    const meta = await sharp(thumb.rawPayload).metadata();
    expect(meta.format).toBe('webp');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(256);
  });

  it('finds and repairs a stuck pending row via the repository backfill query', async () => {
    const prisma = getPrisma();
    const repository = new PrismaAttachmentRepository(prisma);
    const id = `att_pending_${suffix}`;
    await repository.create({
      id,
      key: `media/2026/03/${id}/original.png`,
      filename: 'stuck.png',
      mime: 'image/png',
      size: 1,
      width: 3000,
      height: 1500,
      ownerId,
      variants: planPendingVariants(id, new Date('2026-03-04T00:00:00Z'), {
        width: 3000,
        height: 1500,
      }),
    });
    // Only a path that reached the row-planner but never the queue looks like
    // this; the sweep must still find it.
    const pending = await repository.listPendingVariantAttachments(50, 3);
    expect(pending.map((r) => r.id)).toContain(id);

    const current = await repository.findById(id);
    await repository.updateVariants(
      id,
      (current?.variants ?? []).map((v) => ({ ...v, status: 'failed' as const })),
    );
    const after = await repository.listPendingVariantAttachments(50, 3);
    expect(after.map((r) => r.id)).not.toContain(id);

    await repository.delete(id);
  });

  it('exposes the async kill-switch through the env surface', () => {
    expect(typeof env.MEDIA_VARIANTS_ASYNC).toBe('boolean');
  });
});
