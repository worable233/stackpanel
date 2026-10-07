import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveStackPanelDataDir } from '@stackpanel/sdk/paths';
import type { MarketPackage } from '@stackpanel/sdk';
import type { PluginManifestFile } from './plugins.ts';
import { readFrontendManifest } from './frontend.ts';
import { getPrisma } from '../plugins/prisma.ts';
import { env } from '../config/env.ts';
import { verifyPackageSignature } from './signatures.ts';

/** Local market sources: the kernel ships official plugins/themes in packages/. */
const PLUGINS_SOURCE = path.resolve(process.cwd(), '..', '..', 'packages', 'plugins');
const THEMES_SOURCE = path.resolve(process.cwd(), '..', '..', 'packages', 'themes');

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

/** Install (or upgrade) a plugin from the market into data/plugins. */
export async function installMarketPlugin(id: string): Promise<{ id: string; version: string }> {
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
  const target = pluginDataDir(id);
  const tmp = path.join(dataDir(), 'plugins', `.market-${id}-${process.pid}`);
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
  await rm(target, { recursive: true, force: true });
  await rename(tmp, target);
  // Sync the plugin record so the admin panel sees the new version.
  const prisma = getPrisma();
  await prisma.plugin.upsert({
    where: { id },
    create: { id, name: source.name, version: source.version, enabled: true },
    update: { name: source.name, version: source.version },
  });
  return { id, version: source.version };
}

/** Install (or upgrade) a theme from the market into data/themes. */
export async function installMarketTheme(id: string): Promise<{ id: string; version: string }> {
  const sources = await listMarketThemes();
  const source = sources.find((t) => t.id === id);
  if (!source) throw new Error(`市场中没有主题：${id}`);
  await verifyMarketPackage(source.sourceDir, 'theme');
  const target = themeDataDir(id);
  const tmp = path.join(dataDir(), 'themes', `.market-${id}-${process.pid}`);
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
  await rm(target, { recursive: true, force: true });
  await rename(tmp, target);
  return { id, version: source.version };
}
