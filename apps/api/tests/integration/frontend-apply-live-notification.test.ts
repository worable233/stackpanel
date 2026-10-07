import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { requestFrontendApply } from '../../src/lib/frontend-apply.ts';
import { checkDbAvailable } from '../helpers.ts';

/**
 * End-to-end check that a front-end apply request lands a live notification in
 * the requester's inbox (the `pending` frame the bell shows before the builder
 * starts). Requires PostgreSQL; skipped otherwise.
 */
const dbAvailable = await checkDbAvailable();

describe.skipIf(!dbAvailable)('frontend apply live notification', () => {
  let dataDir: string;
  let userId: string;
  const originalDataDir = process.env['STACKPANEL_DATA_DIR'];

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'sp-live-notify-'));
    process.env['STACKPANEL_DATA_DIR'] = dataDir;
    const prisma = getPrisma();
    const user = await prisma.user.create({
      data: { email: `live-${Date.now()}@example.com`, passwordHash: 'x' },
    });
    userId = user.id;
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env['STACKPANEL_DATA_DIR'];
    else process.env['STACKPANEL_DATA_DIR'] = originalDataDir;
    await getPrisma().notification.deleteMany({ where: { userId } });
    await getPrisma().user.deleteMany({ where: { id: userId } });
    await rm(dataDir, { recursive: true, force: true });
  });

  it('writes one pending activity keyed by frontend-apply', async () => {
    await requestFrontendApply({
      reason: 'plugin.install',
      requestedBy: userId,
      target: 'plugin',
      action: 'install',
      label: '示例插件',
      rebuild: true,
    });

    const rows = await getPrisma().notification.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error('缺少通知');
    expect(row.type).toBe('system.frontend-apply');
    expect(row.status).toBe('active');
    expect(row.dedupeKey).toBe('frontend-apply');
    expect(row.title).toContain('示例插件');
    expect(row.progress ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('re-requesting rewrites the same row instead of appending', async () => {
    const input = {
      reason: 'plugin.install',
      requestedBy: userId,
      target: 'plugin' as const,
      action: 'install' as const,
      label: '示例插件',
      rebuild: true,
    };
    await requestFrontendApply(input);
    await requestFrontendApply(input);
    const rows = await getPrisma().notification.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
  });
});
