import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import prettier from 'prettier';

const root = process.cwd();
const dataDir = process.env.STACKPANEL_DATA_DIR
  ? path.resolve(process.env.STACKPANEL_DATA_DIR)
  : path.join(root, 'data');
// Resolve esbuild's CLI binary through Node's module resolution instead of a
// fixed workspace path. pnpm hoists the root devDependency to
// `<repo>/node_modules`, so a fresh install has no `apps/api/node_modules/.bin`
// and a hardcoded path would break `pnpm build` (CI, Docker, new clones).
// Resolving from this script's location finds esbuild wherever it is installed.
const esbuildBin = createRequire(import.meta.url).resolve('esbuild/bin/esbuild');
const webLibDir = path.join(root, 'apps', 'web', 'src', 'lib');

const { sourcePackages } = await discoverFrontendPackages();

for (const pkg of sourcePackages) {
  // Surfaced by the web supervisor as live progress ("正在编译 plugins/catalog").
  console.log(`Building frontend ${pkg.kind}/${pkg.id}…`);
  await buildFrontendPackageFromSource(pkg);
}

// The registry is generated from `data/` so the same artifact set is visible to
// any builder, including the worker building on the shared data volume (S7).
// Source packages were just materialized into `data/` above; third-party
// packages already live there.
await generateFrontendRegistry(await discoverRegistryPackages());

async function buildFrontendPackageFromSource(pkg) {
  if (!existsSync(pkg.source)) {
    console.warn(`Skipping missing frontend package: ${pkg.source}`);
    return;
  }
  execFileSync(
    esbuildBin,
    [
      'src/index.tsx',
      '--bundle',
      '--format=esm',
      '--outdir=dist',
      '--platform=node',
      '--target=node22',
      '--jsx=automatic',
      '--sourcemap',
      '--external:react',
      '--external:react/jsx-runtime',
      '--external:next/link',
      '--external:@stackpanel/sdk',
      '--external:@stackpanel/ui',
      '--external:zod',
      '--external:lucide-react',
      '--main-fields=module,main',
    ],
    { cwd: pkg.source, stdio: 'inherit' },
  );
  // Build the client-only admin entry (interactive admin pages) when present.
  if (existsSync(path.join(pkg.source, 'src', 'admin.tsx'))) {
    execFileSync(
      esbuildBin,
      [
        'src/admin.tsx',
        '--bundle',
        '--format=esm',
        '--outdir=dist',
        '--platform=neutral',
        '--target=es2020',
        '--jsx=automatic',
        '--sourcemap',
        '--external:react',
        '--external:react-dom',
        '--external:react/jsx-runtime',
        '--external:next/link',
        '--external:@stackpanel/sdk',
        '--external:@stackpanel/ui',
        '--external:zod',
        '--external:lucide-react',
        '--main-fields=module,main',
      ],
      { cwd: pkg.source, stdio: 'inherit' },
    );
  }

  const distFiles = await listFiles(path.join(pkg.source, 'dist'));
  const entryPath = path.join(pkg.source, 'dist', 'index.js');
  if (!existsSync(entryPath)) {
    throw new Error(`Frontend build did not produce dist/index.js for ${pkg.id}`);
  }
  // Build a probe bundle with `next/link` aliased to a stub so metadata can be
  // extracted through Node's native ESM loader. The probe bundles workspace
  // packages (ui, sdk, lucide-react, zod) so it can run outside Next.js; only
  // react stays external. Resolution happens from the web app's node_modules
  // because that is the runtime environment where the package will render.
  const probeDir = path.join(pkg.source, '.probe');
  await rm(probeDir, { recursive: true, force: true });
  await mkdir(probeDir, { recursive: true });
  const probeLinkStub = path.join(probeDir, 'next-link-stub.mjs');
  await writeFile(
    probeLinkStub,
    'export default function Link(props) { return props.children ?? null; }\n',
  );
  execFileSync(
    esbuildBin,
    [
      path.join(pkg.source, 'src', 'index.tsx'),
      '--bundle',
      '--format=esm',
      `--outdir=${probeDir}`,
      '--platform=node',
      '--target=node22',
      '--jsx=automatic',
      '--sourcemap',
      `--alias:next/link=${probeLinkStub}`,
      '--main-fields=module,main',
    ],
    { cwd: path.join(root, 'apps', 'web'), stdio: 'inherit' },
  );
  const webTarget = path.join(dataDir, pkg.kind, pkg.id);
  await rm(path.join(webTarget, 'frontend'), { recursive: true, force: true });
  await mkdir(path.join(webTarget, 'frontend'), { recursive: true });
  await cp(path.join(pkg.source, 'dist'), path.join(webTarget, 'frontend', 'dist'), {
    recursive: true,
  });
  await writeFile(
    path.join(webTarget, 'frontend', 'package.json'),
    `${JSON.stringify({ type: 'module' }, null, 2)}\n`,
  );
  await cp(probeDir, path.join(webTarget, 'frontend', 'probe'), { recursive: true });
  const moduleUrl = pathToFileURL(path.join(webTarget, 'frontend', 'probe', 'index.js')).href;
  let frontendPackage = null;
  try {
    const mod = await import(moduleUrl);
    frontendPackage = mod.frontend ?? mod.default ?? null;
  } catch {
    // The probe runs through Node's native ESM loader, which cannot resolve
    // CJS-only Next.js internals (e.g. `next/link`). The web build compiles
    // the same artifacts through Turbopack, so metadata falls back to the
    // previous manifest when probing fails.
    try {
      const previous = JSON.parse(await readFile(path.join(pkg.source, 'manifest.json'), 'utf8'));
      frontendPackage = {
        pages: previous.pages ?? [],
        layouts: Object.fromEntries((previous.layouts ?? []).map((name) => [name, () => null])),
        finders: previous.finders ?? {},
        ui: previous.ui ?? {},
        settingsSchema: previous.settingsSchema,
      };
    } catch {
      frontendPackage = null;
    }
  }
  await rm(probeDir, { recursive: true, force: true });
  await rm(path.join(webTarget, 'frontend', 'probe'), { recursive: true, force: true });
  if (!frontendPackage || typeof frontendPackage !== 'object') {
    throw new Error(`Frontend package ${pkg.id} did not export a frontend package`);
  }
  const packageJson = JSON.parse(await readFile(path.join(pkg.source, 'package.json'), 'utf8'));
  const manifest = {
    version: packageJson.version ?? '0.0.0',
    revision: await revisionOf(path.join(pkg.source, 'dist'), distFiles),
    entry: 'frontend/dist/index.js',
    pages: (frontendPackage.pages ?? []).map((page) => ({
      path: page.path,
      component: page.component,
      ...(page.data ? { data: page.data } : {}),
      ...(page.layout ? { layout: page.layout } : {}),
      ...(page.meta ? { meta: page.meta } : {}),
    })),
    layouts: Object.keys(frontendPackage.layouts ?? {}),
    finders: Object.keys(frontendPackage.finders ?? {}),
    adminRoutes: frontendPackage.ui?.adminRoutes ?? [],
    adminActions: frontendPackage.ui?.adminActions ?? [],
    actions: frontendPackage.ui?.actions ?? [],
    accountRoutes: frontendPackage.ui?.accountRoutes ?? [],
    accountWidgets: frontendPackage.ui?.accountWidgets ?? [],
    files: distFiles.map((file) => `frontend/dist/${file}`),
    ...(frontendPackage.settingsSchema ? { settingsSchema: frontendPackage.settingsSchema } : {}),
    ...(Array.isArray(frontendPackage.locales) && frontendPackage.locales.length > 0
      ? { locales: frontendPackage.locales }
      : {}),
    ...(frontendPackage.overrides && Object.keys(frontendPackage.overrides).length > 0
      ? { overrides: frontendPackage.overrides }
      : {}),
  };
  const manifestJson = await prettier.format(JSON.stringify(manifest, null, 2), {
    parser: 'json',
  });
  await writeFile(path.join(pkg.source, 'manifest.json'), manifestJson);
  await writeFile(path.join(webTarget, 'frontend', 'manifest.json'), manifestJson);
  console.log(`Built frontend ${pkg.kind}/${pkg.id} (${manifest.revision})`);
}

/** Discover source packages and already-built data packages. */
async function discoverFrontendPackages() {
  const sourcePackages = [];
  const dataPackages = [];
  const sourceIds = new Set();
  const sourceGroups = [
    { kind: 'themes', root: path.join(root, 'packages', 'themes') },
    { kind: 'plugins', root: path.join(root, 'packages', 'plugins') },
  ];
  const dataGroups = [
    { kind: 'themes', root: path.join(dataDir, 'themes') },
    { kind: 'plugins', root: path.join(dataDir, 'plugins') },
  ];
  for (const group of sourceGroups) {
    if (!existsSync(group.root)) continue;
    const entries = await readdir(group.root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const source = path.join(group.root, entry.name, 'frontend');
      if (existsSync(path.join(source, 'src', 'index.tsx'))) {
        sourcePackages.push({ kind: group.kind, id: entry.name, source });
        sourceIds.add(`${group.kind}/${entry.name}`);
      }
    }
  }
  for (const group of dataGroups) {
    if (!existsSync(group.root)) continue;
    const entries = await readdir(group.root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Only treat data-directory packages as third-party when they are not
      // built-in source packages; otherwise the built-in source rebuilds them.
      if (sourceIds.has(`${group.kind}/${entry.name}`)) continue;
      if (existsSync(path.join(group.root, entry.name, 'frontend', 'dist', 'index.js'))) {
        dataPackages.push({ kind: group.kind, id: entry.name, dataDir: group.root });
      }
    }
  }
  const sort = (a, b) => `${a.kind}/${a.id}`.localeCompare(`${b.kind}/${b.id}`);
  return {
    sourcePackages: sourcePackages.sort(sort),
    dataPackages: dataPackages.sort(sort),
  };
}

/**
 * Every frontend package materialized in the data directory, resolved from
 * `data/` itself. Used for registry generation so the artifact set matches the
 * shared volume the worker builds on (S7).
 */
async function discoverRegistryPackages() {
  const packages = [];
  for (const group of [
    { kind: 'themes', root: path.join(dataDir, 'themes') },
    { kind: 'plugins', root: path.join(dataDir, 'plugins') },
  ]) {
    if (!existsSync(group.root)) continue;
    const entries = await readdir(group.root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (existsSync(path.join(group.root, entry.name, 'frontend', 'dist', 'index.js'))) {
        packages.push({ kind: group.kind, id: entry.name, dataDir: group.root });
      }
    }
  }
  return packages.sort((a, b) => `${a.kind}/${a.id}`.localeCompare(`${b.kind}/${b.id}`));
}

/**
 * Generate a static registry of every installed frontend package. Next.js
 * bundles all imports at build time so every package shares the same React
 * instance and the same set of external libraries.
 */
async function generateFrontendRegistry(packages) {
  const registryFile = path.join(webLibDir, 'frontend-registry.ts');
  const imports = [];
  const entries = [];
  let index = 0;
  for (const pkg of packages) {
    const modulePath = pkg.dataDir
      ? path.join(pkg.dataDir, pkg.id, 'frontend', 'dist', 'index.js')
      : path.join(dataDir, pkg.kind, pkg.id, 'frontend', 'dist', 'index.js');
    if (!existsSync(modulePath)) {
      console.warn(`Skipping frontend registry entry for missing artifact: ${modulePath}`);
      continue;
    }
    const relativePath = path.relative(webLibDir, modulePath).split(path.sep).join('/');
    const variable = `mod${index}`;
    imports.push(`import * as ${variable} from '${relativePath}';`);
    entries.push(
      `  ['${pkg.kind}/${pkg.id}', packageOf(${variable} as unknown as Record<string, unknown>)],`,
    );
    index += 1;
  }
  const registryContent = `import 'server-only';

import type { FrontendPackage } from '@stackpanel/sdk';
${imports.join('\n')}

function packageOf(mod: Record<string, unknown>): FrontendPackage {
  return ((mod as { default?: FrontendPackage }).default ?? mod) as FrontendPackage;
}

const frontendRegistry = new Map<string, FrontendPackage>([
${entries.join('\n')}
]);

export function getFrontendPackage(kind: 'themes' | 'plugins', id: string): FrontendPackage | null {
  return frontendRegistry.get(\`\${kind}/\${id}\`) ?? null;
}

export function listFrontendPackageIds(kind?: 'themes' | 'plugins'): string[] {
  return Array.from(frontendRegistry.keys())
    .filter((key) => !kind || key.startsWith(\`\${kind}/\`))
    .map((key) => key.split('/')[1] ?? '');
}
`;
  await writeFile(registryFile, registryContent);
  console.log(`Generated frontend registry at ${registryFile} (${entries.length} entries)`);

  // Client-only admin registry: interactive admin page components. Only
  // generated when a package ships a `dist/admin.js` (built from `src/admin.tsx`).
  const clientRegistryFile = path.join(webLibDir, 'frontend-client-registry.ts');
  const clientImports = [];
  const clientEntries = [];
  let clientIndex = 0;
  for (const pkg of packages) {
    const modulePath = pkg.dataDir
      ? path.join(pkg.dataDir, pkg.id, 'frontend', 'dist', 'admin.js')
      : path.join(dataDir, pkg.kind, pkg.id, 'frontend', 'dist', 'admin.js');
    if (!existsSync(modulePath)) continue;
    const relativePath = path.relative(webLibDir, modulePath).split(path.sep).join('/');
    const variable = `admin${clientIndex}`;
    clientImports.push(`import * as ${variable} from '${relativePath}';`);
    clientEntries.push(`  ['${pkg.kind}/${pkg.id}', ${variable}],`);
    clientIndex += 1;
  }
  const clientRegistryContent = `import type { AdminPageComponent } from '@stackpanel/sdk';
${clientImports.join('\n')}

/** Plugin admin page components resolved on the client for interactive pages. */
export const clientAdminRegistry = new Map<
  string,
  { adminPages: Record<string, AdminPageComponent> }
>([
${clientEntries.join('\n')}
]);

export function getClientAdminPages(
  kind: 'themes' | 'plugins',
  id: string,
): Record<string, AdminPageComponent> | null {
  return clientAdminRegistry.get(\`\${kind}/\${id}\`)?.adminPages ?? null;
}
`;
  await writeFile(clientRegistryFile, clientRegistryContent);
  console.log(
    `Generated frontend client registry at ${clientRegistryFile} (${clientIndex} entries)`,
  );
}

async function listFiles(dir) {
  const result = [];
  for (const entry of await readdir(dir, { recursive: true })) {
    const full = path.join(dir, entry);
    if ((await stat(full)).isFile()) result.push(entry);
  }
  return result.sort();
}

async function revisionOf(rootDir, files) {
  const hash = createHash('sha1');
  for (const file of files) {
    hash.update(file);
    hash.update(await readFile(path.join(rootDir, file)));
  }
  return hash.digest('hex').slice(0, 12);
}
