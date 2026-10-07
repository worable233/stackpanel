import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { createAdminUser } from '../auth-helpers.ts';
import { definePlugin } from '@stackpanel/sdk';
import { defineModel } from '@stackpanel/sdk';
import { z } from 'zod';

const dbAvailable = await (async () => {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!dbAvailable)('custom models (real DB)', () => {
  let app: FastifyInstance;
  const email = `it_cm_${Date.now()}@example.com`;
  const password = 'test_password_123456';
  let adminToken: string;

  const noteModel = defineModel({
    kind: 'test/note',
    label: '笔记',
    schema: z.object({
      title: z.string().min(1),
      body: z.string().min(1),
    }),
  });

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    // Register a test plugin that declares a custom model, then activate it.
    await app.pluginRuntime.register(
      definePlugin({
        manifest: {
          id: 'cm-test',
          name: 'CM Test',
          version: '0.1.0',
          permissions: ['custom.test/note.read', 'custom.test/note.write'],
        },
        customModels: [noteModel],
      }),
    );
    await app.pluginRuntime.activate('cm-test');

    const admin = await createAdminUser(app, email, password);
    adminToken = admin.token;
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await prisma.user.deleteMany({ where: { email } });
    // `unregister` honours the model's retention policy (default: drop the table).
    await app.pluginRuntime.unregister('cm-test');
    await app.close();
  });

  it('exposes declared models to admins', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/custom/models',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const { models } = res.json() as {
      models: Array<{ kind: string; label: string }>;
    };
    const note = models.find((m) => m.kind === 'test/note');
    expect(note).toBeDefined();
    expect(note?.label).toBe('笔记');
  });

  it('creates and reads a custom resource', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/custom/test/note',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data: { title: '第一条', body: '内容' } },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json() as { id: string; data: { title: string } };
    expect(created.data.title).toBe('第一条');

    const read = await app.inject({
      method: 'GET',
      url: `/custom/test/note/${created.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(read.statusCode).toBe(200);
    expect((read.json() as { data: { body: string } }).data.body).toBe('内容');
  });

  it('rejects invalid payloads with 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/custom/test/note',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data: { title: '' } }, // missing body, empty title
    });
    expect(res.statusCode).toBe(422);
  });

  it('lists resources with pagination', async () => {
    for (let index = 1; index <= 3; index += 1) {
      await app.inject({
        method: 'POST',
        url: '/custom/test/note',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { data: { title: `t${index}`, body: `b${index}` } },
      });
    }
    const res = await app.inject({
      method: 'GET',
      url: '/custom/test/note?page=1&pageSize=2',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: unknown[]; total: number; page: number; pageSize: number };
    expect(body.items.length).toBe(2);
    expect(body.total).toBeGreaterThanOrEqual(4);
    expect(body.page).toBe(1);
  });

  it('updates and deletes a resource', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/custom/test/note',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data: { title: 'update me', body: 'old' } },
    });
    const id = (create.json() as { id: string }).id;
    const update = await app.inject({
      method: 'PATCH',
      url: `/custom/test/note/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data: { title: 'updated', body: 'new' } },
    });
    expect(update.statusCode).toBe(200);
    expect((update.json() as { data: { title: string } }).data.title).toBe('updated');

    const del = await app.inject({
      method: 'DELETE',
      url: `/custom/test/note/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(del.statusCode).toBe(204);
    const read = await app.inject({
      method: 'GET',
      url: `/custom/test/note/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(read.statusCode).toBe(404);
  });

  it('retains rows across an in-place upgrade (retainData)', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/custom/test/note',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data: { title: 'survives upgrade', body: 'keep me' } },
    });
    const id = (create.json() as { id: string }).id;

    // A hot upgrade unregisters with `retainData: true` so the physical table
    // (and its rows) must outlive the swap. Originally `unregister` applied the
    // default `delete` retention here, silently destroying all plugin data on
    // every upgrade.
    await app.pluginRuntime.unregister('cm-test', { retainData: true });
    await app.pluginRuntime.register(
      definePlugin({
        manifest: {
          id: 'cm-test',
          name: 'CM Test',
          version: '0.2.0',
          permissions: ['custom.test/note.read', 'custom.test/note.write'],
        },
        customModels: [noteModel],
      }),
    );
    await app.pluginRuntime.activate('cm-test');

    const read = await app.inject({
      method: 'GET',
      url: `/custom/test/note/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(read.statusCode).toBe(200);
    expect((read.json() as { data: { title: string } }).data.title).toBe('survives upgrade');
  });
});
