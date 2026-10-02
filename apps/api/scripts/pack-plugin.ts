import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { KERNEL_API_VERSION } from '@stackpanel/spec';
import {
  friendlyPluginName,
  isForbiddenSourceFile,
  MANIFEST_SCHEMA_VERSION,
} from '../src/lib/plugins.ts';

/**
 * Package a workspace plugin into a distributable ZIP (manifest.json + dist).
 * Usage: pnpm plugin:pack <name>   (name is the packages/plugins/<name> dir)
 */
async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: pnpm plugin:pack <name>');
    process.exit(1);
  }
  const root = path.resolve(process.cwd(), '..', '..');
  const pluginDir = path.join(root, 'packages', 'plugins', name);
  const pkg = JSON.parse(await readFile(path.join(pluginDir, 'package.json'), 'utf8')) as {
    name?: string;
    version?: string;
    description?: string;
  };
  const version = pkg.version ?? '0.0.0';
  // 契约版本单一来源为 @stackpanel/spec；env 仅作本地临时覆盖。
  const apiVersionRange = `>=${process.env['KERNEL_API_VERSION'] ?? KERNEL_API_VERSION}`;

  execSync(`pnpm --filter @stackpanel/plugin-${name} build`, { stdio: 'inherit', cwd: root });

  const files: Record<string, Uint8Array> = {};
  const distDir = path.join(pluginDir, 'dist');
  const distEntry = path.join(distDir, 'index.js');
  const mod = await import(`${pathToFileURL(distEntry).href}?v=${Date.now()}`);
  const definition = mod.default ?? mod[name];
  const pluginManifest = definition?.manifest ?? {};
  files['manifest.json'] = strToU8(
    JSON.stringify({
      id: name,
      name: pluginManifest.name ?? friendlyPluginName(pkg.name ?? name),
      version,
      ...(pkg.description ? { description: pkg.description } : {}),
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      apiVersion: apiVersionRange,
      ...(pluginManifest.requires ? { requires: pluginManifest.requires } : {}),
      ...(pluginManifest.provides ? { provides: pluginManifest.provides } : {}),
      ...(pluginManifest.consumes ? { consumes: pluginManifest.consumes } : {}),
      ...(pluginManifest.permissions ? { permissions: pluginManifest.permissions } : {}),
      ...(pluginManifest.roleTemplates ? { roleTemplates: pluginManifest.roleTemplates } : {}),
    }),
  );
  await addDirectory(files, distDir, 'dist', (entry) => !isForbiddenSourceFile(entry));
  try {
    await addDirectory(files, path.join(pluginDir, 'assets'), 'assets');
  } catch {
    // No assets directory; fine.
  }
  const frontendDir = path.join(pluginDir, 'frontend');
  if (existsSync(frontendDir)) {
    const frontendManifest = path.join(frontendDir, 'manifest.json');
    if (existsSync(frontendManifest)) {
      files['frontend/manifest.json'] = new Uint8Array(await readFile(frontendManifest));
    }
    await addDirectory(files, path.join(frontendDir, 'dist'), 'frontend/dist', (entry) => {
      const ext = path.extname(entry).toLowerCase();
      return ext === '.js' || ext === '.map';
    });
  }

  const outDir = path.join(pluginDir, 'dist-pack');
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${name}-${version}.zip`);
  await writeFile(outPath, Buffer.from(zipSync(files)));
  console.log(`Packed ${name}-${version}.zip -> packages/plugins/${name}/dist-pack/`);
}

async function addDirectory(
  files: Record<string, Uint8Array>,
  root: string,
  prefix: string,
  include: (entry: string) => boolean = () => true,
): Promise<void> {
  for (const entry of await readdir(root, { recursive: true })) {
    if (!include(entry)) continue;
    const full = path.join(root, entry);
    if ((await stat(full)).isDirectory()) continue;
    files[`${prefix}/${entry}`] = new Uint8Array(await readFile(full));
  }
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
