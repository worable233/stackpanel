import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveStackPanelDataDir } from '@stackpanel/sdk/paths';
import type { MarketPackage } from '@stackpanel/sdk';
import type { PluginManifestFile } from './plugins.ts';
import type { CatalogMarketEntry } from './market-catalog.ts';
import { readFrontendManifest } from './frontend.ts';
import { packageManager } from '../packages/manager.ts';
import { getPrisma } from '../plugins/prisma.ts';
import { env } from '../config/env.ts';
import { verifyPackageSignature } from './signatures.ts';
import {
  localMarketSourcesAllowed,
  localSourcesDisabledReason,
} from '../distribution/runtime-env.ts';

/**
 * 本地市场来源根目录（随内核发布的包）。
 *
 * 解析必须同时兼容两种进程工作目录：
 * - monorepo 开发：`cwd = <repo>/apps/api` → 上两级到仓库根；
 * - 容器/单进程：`cwd = /app`（镜像 WORKDIR）→ 仓库根**就是** `cwd`。
 *
 * 之前只写了 `../..`，在镜像里会解析成 `/packages/plugins`（不存在），导致市场
 * 本地列表恒为空。这里与 `lib/plugins.ts` 的 `resolvePluginsSourceRoot()` 保持同一
 * 套候选顺序，避免两处对「仓库根在哪」得出不同答案。
 */
function resolveSourceRoot(kind: 'plugins' | 'themes'): string {
  const cwd = process.cwd();
  for (const candidate of [
    path.join(cwd, 'packages', kind),
    path.join(cwd, '..', '..', 'packages', kind),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return path.join(cwd, '..', '..', 'packages', kind);
}

const PLUGINS_SOURCE = resolveSourceRoot('plugins');
const THEMES_SOURCE = resolveSourceRoot('themes');

/** 本地来源是否可用：容器/生产形态下一律禁用（安全边界，见 runtime-env）。 */
function localSourcesEnabled(): boolean {
  return localMarketSourcesAllowed();
}

function dataDir(): string {
  return resolveStackPanelDataDir();
}

function pluginDataDir(id: string): string {
  return path.join(dataDir(), 'plugins', id);
}

function themeDataDir(id: string): string {
  return path.join(dataDir(), 'themes', id);
}

async function verifyMarketPackage(sourceDir: string, kind: 'plugin' | 'theme'): Promise<void> {
  if (!env.PACKAGE_SIGNATURE_REQUIRED) return;
  const files = new Map<string, Uint8Array>();
  const walk = async (dir: string, prefix = ''): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, name);
      else if (entry.isFile()) files.set(name, await readFile(full));
    }
  };
  await walk(sourceDir);
  try {
    verifyPackageSignature(files, env.STACKPANEL_SIGNING_PUBLIC_KEY);
  } catch (error) {
    throw new Error(
      `市场${kind === 'plugin' ? '插件' : '主题'}签名校验失败：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export interface MarketSourcePackage {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  /** Declared by the package's `stackpanel.builtin` metadata. */
  builtin?: boolean;
  sourceDir: string;
}

async function readPackageJson(dir: string): Promise<{
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  builtin?: boolean;
} | null> {
  try {
    const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as {
      name?: string;
      version?: string;
      description?: string;
      author?: string;
      stackpanel?: { builtin?: boolean };
    };
    return {
      ...(pkg.name ? { name: pkg.name } : {}),
      ...(pkg.version ? { version: pkg.version } : {}),
      ...(pkg.description ? { description: pkg.description } : {}),
      ...(pkg.author ? { author: pkg.author } : {}),
      ...(pkg.stackpanel?.builtin === true ? { builtin: true } : {}),
    };
  } catch {
    return null;
  }
}

async function readPluginManifestFile(dir: string): Promise<PluginManifestFile | null> {
  try {
    return JSON.parse(
      await readFile(path.join(dir, 'manifest.json'), 'utf8'),
    ) as PluginManifestFile;
  } catch {
    return null;
  }
}

/** Discover plugin packages available in the local market. */
export async function listMarketPlugins(): Promise<MarketSourcePackage[]> {
  if (!localSourcesEnabled()) return [];
  if (!existsSync(PLUGINS_SOURCE)) return [];
  const entries = await readdir(PLUGINS_SOURCE, { withFileTypes: true });
  const results: MarketSourcePackage[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sourceDir = path.join(PLUGINS_SOURCE, entry.name);
    const manifest = await readPluginManifestFile(sourceDir);
    const pkg = await readPackageJson(sourceDir);
    if (!manifest && !pkg) continue;
    results.push({
      id: entry.name,
      name: manifest?.name ?? pkg?.name ?? entry.name,
      version: manifest?.version ?? pkg?.version ?? '0.0.0',
      ...(manifest?.description ? { description: manifest.description } : {}),
      ...(manifest?.author ? { author: manifest.author } : {}),
      ...(pkg?.builtin ? { builtin: true } : {}),
      sourceDir,
    });
  }
  return results.sort((a, b) => a.id.localeCompare(b.id));
}

/** Discover theme packages available in the local market. */
export async function listMarketThemes(): Promise<MarketSourcePackage[]> {
  if (!localSourcesEnabled()) return [];
  if (!existsSync(THEMES_SOURCE)) return [];
  const entries = await readdir(THEMES_SOURCE, { withFileTypes: true });
  const results: MarketSourcePackage[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sourceDir = path.join(THEMES_SOURCE, entry.name);
    const theme = JSON.parse(
      await readFile(path.join(sourceDir, 'theme.json'), 'utf8').catch(() => '{}'),
    ) as { name?: string; version?: string; description?: string; author?: string };
    const pkg = await readPackageJson(sourceDir);
    results.push({
      id: entry.name,
      name: theme.name ?? pkg?.name ?? entry.name,
      version: theme.version ?? pkg?.version ?? '0.0.0',
      ...(theme.description ? { description: theme.description } : {}),
      ...(theme.author ? { author: theme.author } : {}),
      sourceDir,
    });
  }
  return results.sort((a, b) => a.id.localeCompare(b.id));
}

/** Build the market view for a plugin/theme package. */
export async function marketPackageView(
  kind: 'plugin' | 'theme',
  source: MarketSourcePackage,
): Promise<MarketPackage> {
  const installedDir = kind === 'plugin' ? pluginDataDir(source.id) : themeDataDir(source.id);
  const installed = existsSync(
    path.join(installedDir, kind === 'plugin' ? 'manifest.json' : 'theme.json'),
  );
  let installedVersion: string | null = null;
  if (installed) {
    if (kind === 'plugin') {
      const manifest = await readPluginManifestFile(installedDir);
      installedVersion = manifest?.version ?? null;
    } else {
      const theme = JSON.parse(
        await readFile(path.join(installedDir, 'theme.json'), 'utf8').catch(() => '{}'),
      ) as { version?: string };
      installedVersion = theme.version ?? null;
    }
  }
  const upgradable = installed && installedVersion !== source.version;
  const frontendManifest = await readFrontendManifest(source.sourceDir);
  return {
    id: source.id,
    name: source.name,
    version: source.version,
    ...(source.description ? { description: source.description } : {}),
    ...(source.author ? { author: source.author } : {}),
    kind,
    installed,
    installedVersion,
    upgradable,
    current: installed && installedVersion === source.version,
    builtin: kind === 'plugin' ? source.builtin === true : source.id === 'default',
    ...(frontendManifest
      ? {
          frontend: {
            available: true,
            pages: frontendManifest.pages.map((page) => ({
              path: page.path,
              component: page.component,
            })),
            finders: frontendManifest.finders,
          },
        }
      : {}),
  };
}

/**
 * 远程目录条目的市场视图（§13-3）。与本地 {@link marketPackageView} 共用同一
 * `MarketPackage` 形状，前端无需为远程来源分叉；`blocks` 非空时该条目不可安装。
 */
export function catalogMarketPackageView(
  entry: CatalogMarketEntry,
  installedVersion: string | null,
): MarketPackage {
  const installed = installedVersion !== null;
  return {
    id: entry.id,
    name: entry.name,
    version: entry.version,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.publisher ? { author: entry.publisher } : {}),
    kind: entry.kind,
    installed,
    installedVersion,
    upgradable: installed && installedVersion !== entry.version,
    current: installed && installedVersion === entry.version,
    builtin: false,
  };
}

/** Install (or upgrade) a plugin from the market into data/plugins. */
export async function installMarketPlugin(id: string): Promise<{ id: string; version: string }> {
  if (!localSourcesEnabled()) throw new Error(localSourcesDisabledReason());
  const sources = await listMarketPlugins();
  const source = sources.find((p) => p.id === id);
  if (!source) throw new Error(`市场中没有插件：${id}`);
  await verifyMarketPackage(source.sourceDir, 'plugin');
  const distDir = path.join(source.sourceDir, 'dist');
  if (!existsSync(distDir)) {
    throw new Error(
      `插件 ${id} 未构建（缺少 dist/），请先运行 pnpm --filter @stackpanel/plugin-${id} build`,
    );
  }
  const parent = path.dirname(pluginDataDir(id)); // data/plugins
  // §7.6：先把完整产物写进暂存目录，再整体切换；不得原地覆盖活动目录。
  const tmp = path.join(parent, `.market-${id}-${process.pid}-${Date.now()}`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  await cp(distDir, path.join(tmp, 'dist'), { recursive: true });
  const frontendSource = path.join(source.sourceDir, 'frontend');
  if (existsSync(frontendSource)) {
    const frontendManifest = path.join(frontendSource, 'manifest.json');
    if (existsSync(frontendManifest)) {
      await mkdir(path.join(tmp, 'frontend'), { recursive: true });
      await writeFile(
        path.join(tmp, 'frontend', 'manifest.json'),
        await readFile(frontendManifest),
      );
    }
    const frontendDist = path.join(frontendSource, 'dist');
    if (existsSync(frontendDist)) {
      await mkdir(path.join(tmp, 'frontend', 'dist'), { recursive: true });
      await cp(frontendDist, path.join(tmp, 'frontend', 'dist'), { recursive: true });
    }
  }
  const manifest = await readPluginManifestFile(source.sourceDir);
  if (manifest) {
    await writeFile(
      path.join(tmp, 'manifest.json'),
      JSON.stringify(
        {
          ...manifest,
          name: source.name,
          version: source.version,
          apiVersion: manifest.apiVersion ?? `>=${source.version}`,
        },
        null,
        2,
      ),
    );
  } else {
    // Some plugins only ship their manifest inside the compiled entry (e.g.
    // hello exports `definePlugin`). Load the dist to extract it.
    const distEntry = path.join(source.sourceDir, 'dist', 'index.js');
    if (existsSync(distEntry)) {
      const mod = (await import(`${pathToFileURL(distEntry).href}?v=${Date.now()}`)) as Record<
        string,
        unknown
      >;
      const definition = (mod['default'] ?? mod[id]) as
        | {
            manifest?: PluginManifestFile;
          }
        | null
        | undefined;
      const embedded = definition?.manifest;
      if (embedded) {
        await writeFile(
          path.join(tmp, 'manifest.json'),
          JSON.stringify(
            {
              ...embedded,
              name: source.name,
              version: source.version,
              apiVersion: embedded.apiVersion ?? `>=${source.version}`,
            },
            null,
            2,
          ),
        );
      }
    }
  }
  const assets = path.join(source.sourceDir, 'assets');
  if (existsSync(assets)) {
    await cp(assets, path.join(tmp, 'assets'), { recursive: true });
  }
  let handle;
  try {
    handle = await packageManager.swapDirectory('plugin', id, tmp);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
  // Sync the plugin record so the admin panel sees the new version.
  const prisma = getPrisma();
  try {
    await prisma.plugin.upsert({
      where: { id },
      create: { id, name: source.name, version: source.version, enabled: true },
      update: { name: source.name, version: source.version },
    });
  } catch (err) {
    // DB 指针未提交：恢复旧目录，避免半切换（§7.6）。
    await handle.rollback();
    throw err;
  }
  await handle.commit();
  return { id, version: source.version };
}

/** Install (or upgrade) a theme from the market into data/themes. */
export async function installMarketTheme(id: string): Promise<{ id: string; version: string }> {
  if (!localSourcesEnabled()) throw new Error(localSourcesDisabledReason());
  const sources = await listMarketThemes();
  const source = sources.find((t) => t.id === id);
  if (!source) throw new Error(`市场中没有主题：${id}`);
  await verifyMarketPackage(source.sourceDir, 'theme');
  const parent = path.dirname(themeDataDir(id)); // data/themes
  // §7.6：先写完整产物到暂存目录，再整体切换；不得原地覆盖活动目录。
  const tmp = path.join(parent, `.market-${id}-${process.pid}-${Date.now()}`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  for (const name of ['theme.json', 'theme.css']) {
    const file = path.join(source.sourceDir, name);
    if (existsSync(file)) {
      await cp(file, path.join(tmp, name));
    }
  }
  const assets = path.join(source.sourceDir, 'assets');
  if (existsSync(assets)) {
    await cp(assets, path.join(tmp, 'assets'), { recursive: true });
  }
  const frontendSource = path.join(source.sourceDir, 'frontend');
  if (existsSync(frontendSource)) {
    const frontendManifest = path.join(frontendSource, 'manifest.json');
    if (existsSync(frontendManifest)) {
      await mkdir(path.join(tmp, 'frontend'), { recursive: true });
      await writeFile(
        path.join(tmp, 'frontend', 'manifest.json'),
        await readFile(frontendManifest),
      );
    }
    const frontendDist = path.join(frontendSource, 'dist');
    if (existsSync(frontendDist)) {
      await mkdir(path.join(tmp, 'frontend', 'dist'), { recursive: true });
      await cp(frontendDist, path.join(tmp, 'frontend', 'dist'), { recursive: true });
    }
  }
  try {
    await packageManager.swapDirectory('theme', id, tmp);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
  return { id, version: source.version };
}
