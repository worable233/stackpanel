/**
 * E2E global setup.
 *
 * Prerequisites (validated here): a running dev stack (api:3001, web:3000)
 * backed by a reachable MySQL database. Start it with `pnpm pm2:start`.
 *
 * Responsibilities:
 *   1. Create the dedicated E2E admin + user accounts (idempotent upsert).
 *   2. Install the `notice` demo plugin through the upload API if absent, so
 *      frontend/plugin specs are deterministic on any checkout.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createPrismaClient, probeDatabase } from '@stackpanel/db';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  API_BASE_URL,
  CATALOG_CHILD_SLUG,
  CATALOG_CHILD_NAME,
  CATALOG_PLUGIN_ID,
  CATALOG_PRODUCT_NAME,
  CATALOG_ROOT_SLUG,
  CATALOG_ROOT_NAME,
  NOTICE_PLUGIN_ID,
  USER_EMAIL,
  USER_PASSWORD,
  WEB_BASE_URL,
} from './constants';
import { getAdminSessionToken } from './session';

const scrypt = promisify(scryptCb);
const N = 16384;
const r = 8;
const p = 1;

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = (await scrypt(password, salt, 64, { N, r, p })) as Buffer;
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function readRootEnv(): Record<string, string> {
  const envPath = path.join(process.cwd(), '.env');
  const values: Record<string, string> = {};
  try {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    // Missing .env is fine; callers fall back to defaults.
  }
  return values;
}

async function probeHttp(url: string, init?: RequestInit): Promise<void> {
  try {
    await fetch(url, init);
  } catch (err) {
    throw new Error(
      `E2E 需要运行中的服务（${url}），请先启动开发环境：pnpm pm2:start。详情：${(err as Error).message}`,
    );
  }
}

async function ensureUser(
  prisma: Awaited<ReturnType<typeof createPrismaClient>>,
  email: string,
  password: string,
  role: 'ADMIN' | 'USER',
): Promise<void> {
  const passwordHash = await hashPassword(password);
  await prisma.user.upsert({
    where: { email },
    create: { email, passwordHash, role, status: 'ACTIVE' },
    update: { passwordHash, role, status: 'ACTIVE' },
  });
}

async function ensureNoticePlugin(): Promise<void> {
  const root = process.cwd();
  const zipPath = path.join(
    root,
    'packages',
    'plugins',
    NOTICE_PLUGIN_ID,
    'dist-pack',
    `${NOTICE_PLUGIN_ID}-0.1.0.zip`,
  );
  if (!existsSync(zipPath)) {
    execFileSync('pnpm', ['build:frontend'], { cwd: root, stdio: 'inherit' });
    execFileSync('pnpm', ['plugin:pack', NOTICE_PLUGIN_ID], { cwd: root, stdio: 'inherit' });
  }
  const token = await getAdminSessionToken();
  const listResponse = await fetch(`${API_BASE_URL}/admin/plugins`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const list = (await listResponse.json()) as { plugins: Array<{ id: string }> };
  if (list.plugins.some((plugin) => plugin.id === NOTICE_PLUGIN_ID)) return;

  const form = new FormData();
  form.append(
    'file',
    new Blob([readFileSync(zipPath)], { type: 'application/zip' }),
    `${NOTICE_PLUGIN_ID}-0.1.0.zip`,
  );
  const uploadResponse = await fetch(`${API_BASE_URL}/admin/plugins/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  if (!uploadResponse.ok) {
    throw new Error(`notice 插件安装失败：${await uploadResponse.text()}`);
  }
}

/** Upload the catalog plugin if absent, then guarantee it is enabled (idempotent). */
async function ensureCatalogPlugin(): Promise<void> {
  const root = process.cwd();
  const zipPath = path.join(
    root,
    'packages',
    'plugins',
    CATALOG_PLUGIN_ID,
    'dist-pack',
    `${CATALOG_PLUGIN_ID}-0.1.0.zip`,
  );
  if (!existsSync(zipPath)) {
    execFileSync('pnpm', ['build:frontend'], { cwd: root, stdio: 'inherit' });
    execFileSync('pnpm', ['plugin:pack', CATALOG_PLUGIN_ID], { cwd: root, stdio: 'inherit' });
  }
  const token = await getAdminSessionToken();
  const listResponse = await fetch(`${API_BASE_URL}/admin/plugins`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const list = (await listResponse.json()) as {
    plugins: Array<{ id: string; enabled: boolean }>;
  };
  const present = list.plugins.find((plugin) => plugin.id === CATALOG_PLUGIN_ID);
  if (!present) {
    const form = new FormData();
    form.append(
      'file',
      new Blob([readFileSync(zipPath)], { type: 'application/zip' }),
      `${CATALOG_PLUGIN_ID}-0.1.0.zip`,
    );
    const uploadResponse = await fetch(`${API_BASE_URL}/admin/plugins/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    if (!uploadResponse.ok) {
      throw new Error(`catalog 插件安装失败：${await uploadResponse.text()}`);
    }
  } else if (!present.enabled) {
    const enableResponse = await fetch(`${API_BASE_URL}/admin/plugins/${CATALOG_PLUGIN_ID}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    if (!enableResponse.ok) {
      throw new Error(`catalog 插件启用失败：${await enableResponse.text()}`);
    }
  }
}

/** Seed a deterministic category tree + catalogued product for E2E assertions. */
async function seedCatalogData(databaseUrl: string): Promise<void> {
  const token = await getAdminSessionToken();
  const prisma = createPrismaClient(databaseUrl);
  const productIds = (
    await prisma.product.findMany({
      where: { name: CATALOG_PRODUCT_NAME },
      select: { id: true },
    })
  ).map((row) => row.id);
  if (productIds.length > 0) {
    const entries = await prisma.customResource.findMany({ where: { kind: 'catalog/product' } });
    const targets = entries.filter((row) =>
      productIds.includes((row.data as { productId?: string }).productId ?? ''),
    );
    if (targets.length > 0) {
      await prisma.customResource.deleteMany({
        where: { id: { in: targets.map((row) => row.id) } },
      });
    }
  }
  const categoryRows = await prisma.customResource.findMany({
    where: { kind: 'catalog/category' },
  });
  const categoryTargets = categoryRows.filter((row) =>
    [CATALOG_ROOT_SLUG, CATALOG_CHILD_SLUG].includes(
      (row.data as { slug?: string | null }).slug ?? '',
    ),
  );
  if (categoryTargets.length > 0) {
    await prisma.customResource.deleteMany({
      where: { id: { in: categoryTargets.map((row) => row.id) } },
    });
  }
  await prisma.product.deleteMany({ where: { name: CATALOG_PRODUCT_NAME } });
  await prisma.$disconnect();

  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
  const product = await fetch(`${API_BASE_URL}/store/admin/products`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: CATALOG_PRODUCT_NAME,
      price: 5000,
      stock: 9,
      description: 'E2E 目录测试商品',
    }),
  });
  if (!product.ok) {
    throw new Error(`创建目录测试商品失败：${await product.text()}`);
  }
  const productId = (await product.json()) as { product: { id: string } };

  const root = await fetch(`${API_BASE_URL}/catalog/admin/categories`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: CATALOG_ROOT_NAME, slug: CATALOG_ROOT_SLUG, sortOrder: 100 }),
  });
  if (!root.ok) {
    throw new Error(`创建目录根分类失败：${await root.text()}`);
  }
  const rootId = ((await root.json()) as { category: { id: string } }).category.id;

  const child = await fetch(`${API_BASE_URL}/catalog/admin/categories`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: CATALOG_CHILD_NAME, slug: CATALOG_CHILD_SLUG, parentId: rootId }),
  });
  if (!child.ok) {
    throw new Error(`创建目录子分类失败：${await child.text()}`);
  }

  const shelf = await fetch(`${API_BASE_URL}/catalog/admin/products/${productId.product.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ categoryId: rootId, shelfStatus: 'ON', sortOrder: 5 }),
  });
  if (!shelf.ok) {
    throw new Error(`上架目录测试商品失败：${await shelf.text()}`);
  }
}

export default async function globalSetup(): Promise<void> {
  const envValues = readRootEnv();
  const databaseUrl =
    process.env['DATABASE_URL'] ??
    envValues['DATABASE_URL'] ??
    'mysql://stackpanel:stackpanel_dev@127.0.0.1:3306/stackpanel';

  if (!(await probeDatabase(databaseUrl))) {
    throw new Error('E2E 需要可访问的数据库，请先启动 MySQL 并配置 .env 中的 DATABASE_URL。');
  }
  await probeHttp(`${API_BASE_URL}/health`);
  await probeHttp(`${WEB_BASE_URL}/login`);

  const prisma = createPrismaClient(databaseUrl);
  await ensureUser(prisma, ADMIN_EMAIL, ADMIN_PASSWORD, 'ADMIN');
  await ensureUser(prisma, USER_EMAIL, USER_PASSWORD, 'USER');
  await prisma.$disconnect();

  await ensureNoticePlugin();
  await ensureCatalogPlugin();
  await seedCatalogData(databaseUrl);
  console.log(
    `[e2e] setup ok: admin=${ADMIN_EMAIL} notice=${NOTICE_PLUGIN_ID} catalog=${CATALOG_PLUGIN_ID}`,
  );
}
