import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import prettier from 'prettier';
import { annotateAdapterImportsSource } from './lib/annotate-adapter-imports.mjs';

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

/**
 * Stage 4 M2 — publish-time rewrite of the client bundle's host-ABI imports to the
 * controlled same-origin adapter (`/api/frontend-abi/*`; SPIKE-results §0). Order
 * matters: esbuild `--alias` is a prefix match, so `react/jsx-runtime` and
 * `react-dom` must precede `react`. The ABI slot list mirrors
 * `@stackpanel/spec`'s `HOST_FRONTEND_ABI_SLOTS`.
 */
const HOST_ABI_ADAPTER_ALIASES = [
  '--alias:react/jsx-runtime=/api/frontend-abi/react/jsx-runtime',
  '--alias:react-dom/client=/api/frontend-abi/react-dom',
  '--alias:react-dom=/api/frontend-abi/react-dom',
  '--alias:react=/api/frontend-abi/react',
  '--alias:next/link=/api/frontend-abi/next/link',
  '--alias:next/form=/api/frontend-abi/next/form',
  '--alias:next/navigation=/api/frontend-abi/next/navigation',
  '--alias:@stackpanel/ui=/api/frontend-abi/@stackpanel/ui',
  '--alias:@stackpanel/sdk=/api/frontend-abi/@stackpanel/sdk',
  '--alias:lucide-react=/api/frontend-abi/lucide-react',
  // `sonner` is host ABI so a plugin's `toast` calls reach the host `<Toaster />`.
  // Without the alias the runtime bundle keeps a bare specifier the browser
  // cannot resolve, and a bundled copy would own a second, disconnected store.
  '--alias:sonner=/api/frontend-abi/sonner',
];

const { sourcePackages } = await discoverFrontendPackages();

for (const pkg of sourcePackages) {
  // Surfaced by the web supervisor as live progress ("正在编译 plugins/catalog").
  console.log(`Building frontend ${pkg.kind}/${pkg.id}…`);
  await buildFrontendPackageFromSource(pkg);
}

// Registry generation (stage 5).
//
// Historically the web bundle statically imported every installed frontend
// package through this generated registry, so installing a theme/plugin required
// a `next build` + restart. Stage 5 makes **runtime loading** the default (the
// host dynamic-`import()`s the compiled entry from `data/`), so the registry is
// no longer needed: by default we emit an **empty** registry, which also decouples
// `next build` from whatever packages happen to be installed.
//
// The legacy build-time path is retained behind an explicit opt-out:
// `STACKPANEL_FRONTEND_RUNTIME_LOAD=0 pnpm build:frontend` regenerates the static
// registry (then `next build` bundles them) — the reversible fallback.
const legacyRegistry = process.env.STACKPANEL_FRONTEND_RUNTIME_LOAD === '0';
if (legacyRegistry) {
  await generateFrontendRegistry(await discoverRegistryPackages());
} else {
  await writeEmptyRegistry();
}

async function buildFrontendPackageFromSource(pkg) {
  if (!existsSync(pkg.source)) {
    console.warn(`Skipping missing frontend package: ${pkg.source}`);
    return;
  }
  // Packages may opt out of source maps when a single map would exceed the
  // theme upload per-file limit (1 MiB). Opt-in stays the default.
  const packageMeta = JSON.parse(
    await readFile(path.join(pkg.source, 'package.json'), 'utf8'),
  );
  const sourcemapArgs = packageMeta.stackpanel?.sourcemap === false ? [] : ['--sourcemap'];
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
      ...sourcemapArgs,
      '--external:react',
      '--external:react/jsx-runtime',
      '--external:next/link',
      '--external:next/form',
      '--external:next/navigation',
      // Keep this client entry separate from the server-rendered theme bundle.
      '--external:./route-progress.js',
      // Host-absorbed behaviour used by SSR account pages.
      '--external:./auto-submit.js',
      '--external:@stackpanel/sdk',
      '--external:@stackpanel/ui',
      // lucide-react is host ABI (contract 02 §5); zod is bundled by the
      // publisher, so it is intentionally NOT external here. Recharts is
      // likewise bundled for the server entry because it is not a host ABI
      // slot and runtime imports must remain self-contained.
      '--external:lucide-react',
      // `sonner` is host ABI (toast must reach the host <Toaster />); the loader
      // resolves it through the published server ABI as well.
      '--external:sonner',
      '--main-fields=module,main',
    ],
    { cwd: pkg.source, stdio: 'inherit' },
  );
  if (existsSync(path.join(pkg.source, 'src', 'route-progress.tsx'))) {
    execFileSync(
      esbuildBin,
      [
        'src/route-progress.tsx',
        '--bundle',
        '--format=esm',
        '--outdir=dist',
        '--platform=neutral',
        '--target=es2020',
        '--jsx=automatic',
        ...sourcemapArgs,
        '--banner:js="use client";',
        '--external:react',
        '--external:react/jsx-runtime',
        '--external:next/navigation',
      ],
      { cwd: pkg.source, stdio: 'inherit' },
    );
  }
  if (existsSync(path.join(pkg.source, 'src', 'auto-submit.tsx'))) {
    execFileSync(
      esbuildBin,
      [
        'src/auto-submit.tsx',
        '--bundle',
        '--format=esm',
        '--outdir=dist',
        '--platform=neutral',
        '--target=es2020',
        '--jsx=automatic',
        ...sourcemapArgs,
        '--banner:js="use client";',
        '--external:react',
        '--external:react/jsx-runtime',
      ],
      { cwd: pkg.source, stdio: 'inherit' },
    );
  }
  // Build the client-only admin entry (interactive admin pages) when present.
  //
  // Two artifacts are emitted (stage 4 keeps the old path alongside the new one):
  //
  //   dist/admin.js          bare host-ABI specifiers. Consumed by the build-time
  //                          client registry (`frontend-client-registry.ts`), which
  //                          Next bundles. Unchanged default behaviour.
  //   dist/admin.runtime.js  the same bundle with every host-ABI specifier rewritten
  //                          at publish time to the controlled same-origin adapter
  //                          `/api/frontend-abi/*` (SPIKE-results §0). Loaded by the
  //                          M2 runtime container so a plugin's admin page no longer
  //                          requires a `next build`. The browser cannot resolve
  //                          bare specifiers (no import map), hence the rewrite.
  //
  // `--alias:react/jsx-runtime` must precede `--alias:react` (alias is a prefix
  // match); likewise `react-dom` before `react`.
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
        ...sourcemapArgs,
        '--external:react',
        '--external:react-dom',
        '--external:react/jsx-runtime',
        '--external:next/link',
        '--external:next/form',
        '--external:next/navigation',
        '--external:@stackpanel/sdk',
        '--external:@stackpanel/ui',
        // lucide-react is host ABI; zod is bundled (contract 02 §5).
        '--external:lucide-react',
        '--external:recharts',
        '--external:sonner',
        '--main-fields=module,main',
      ],
      { cwd: pkg.source, stdio: 'inherit' },
    );
    execFileSync(
      esbuildBin,
      [
        'src/admin.tsx',
        '--bundle',
        '--format=esm',
        '--outfile=dist/admin.runtime.js',
        '--platform=neutral',
        '--target=es2020',
        '--jsx=automatic',
        ...sourcemapArgs,
        ...HOST_ABI_ADAPTER_ALIASES,
        '--external:/api/frontend-abi/*',
        '--main-fields=module,main',
      ],
      { cwd: pkg.source, stdio: 'inherit' },
    );
    // The adapter's named exports must be driven by what THIS bundle actually
    // imports (the browser's client-React namespace differs from the server's, so
    // the adapter cannot enumerate it server-side). Append `?names=` so the route
    // exports exactly these bindings.
    await annotateAdapterImports(path.join(pkg.source, 'dist', 'admin.runtime.js'));
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
    'export default function Link(props) { return props.children ?? null; }\n' +
      'export function redirect(url) { throw new Error("NEXT_REDIRECT;" + url); }\n' +
      'export function notFound() { throw new Error("NEXT_HTTP_ERROR_FALLBACK;404"); }\n' +
      'export function usePathname() { return "/"; }\n' +
      'export function useSearchParams() { return new URLSearchParams(); }\n',
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
      ...sourcemapArgs,
      `--alias:next/link=${probeLinkStub}`,
      `--alias:next/form=${probeLinkStub}`,
      `--alias:next/navigation=${probeLinkStub}`,
      `--alias:react/jsx-runtime=${path.join(root, 'apps', 'web', 'node_modules', 'react', 'jsx-runtime.js')}`,
      `--alias:react=${path.join(root, 'apps', 'web', 'node_modules', 'react')}`,
      `--alias:@stackpanel/ui=${path.join(root, 'packages', 'ui', 'dist', 'index.js')}`,
      `--alias:lucide-react=${path.join(root, 'apps', 'web', 'node_modules', 'lucide-react')}`,
      `--alias:recharts=${path.join(root, 'apps', 'web', 'node_modules', 'recharts')}`,
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
    // ADR-0016 §5: serialize the package's catalogs next to the manifest so the
    // host can resolve package metadata (nav labels, system-settings labels)
    // without importing the package's module graph. Catalogs are plain JSON,
    // validated by the host before use (size/depth/key shape).
    ...(frontendPackage.messages && Object.keys(frontendPackage.messages).length > 0
      ? { messages: frontendPackage.messages }
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
  const externalPluginGroups = (process.env.STACKPANEL_PLUGIN_SOURCES ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => ({ kind: 'plugins', root: path.resolve(directory) }));
  const sourceGroups = [
    { kind: 'themes', root: path.join(root, 'packages', 'themes') },
    // An optional plugin checkout takes precedence over the matching built-in
    // source, so local plugin development can be rebuilt into the same runtime.
    ...externalPluginGroups,
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
        if (sourceIds.has(`${group.kind}/${entry.name}`)) continue;
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
/**
 * Emit empty registries (stage 5 default). The host loads frontends at runtime,
 * so the generated modules only need to keep their public shape for typecheck and
 * for any residual importer; they bundle nothing, which is what decouples
 * `next build` from the installed package set.
 */
async function writeEmptyRegistry() {
  const registryFile = path.join(webLibDir, 'frontend-registry.ts');
  await writeFile(
    registryFile,
    `import 'server-only';

import type { FrontendPackage } from '@stackpanel/sdk';

/**
 * Stage 5: runtime frontend loading is the default, so no package is statically
 * bundled here. Regenerate a populated registry with
 * \`STACKPANEL_FRONTEND_RUNTIME_LOAD=0 pnpm build:frontend\` (fallback path).
 */
export function getFrontendPackage(_kind: 'themes' | 'plugins', _id: string): FrontendPackage | null {
  void _kind;
  void _id;
  return null;
}

export function listFrontendPackageIds(kind?: 'themes' | 'plugins'): string[] {
  void kind;
  return [];
}
`,
  );

  const clientRegistryFile = path.join(webLibDir, 'frontend-client-registry.ts');
  await writeFile(
    clientRegistryFile,
    `import type { AdminPageComponent } from '@stackpanel/sdk';

/** Stage 5: runtime admin loading is the default; no client pages are statically bundled here. */
export const clientAdminRegistry = new Map<
  string,
  { adminPages: Record<string, AdminPageComponent> }
>();

export function getClientAdminPages(
  _kind: 'themes' | 'plugins',
  _id: string,
): Record<string, AdminPageComponent> | null {
  void _kind;
  void _id;
  return null;
}
`,
  );
  console.log('Wrote empty frontend registries (runtime loading is the default).');
}

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

/**
 * Stage 4 M2 — annotate the host-ABI adapter imports of a compiled client bundle.
 *
 * The rewrite itself lives in `scripts/lib/annotate-adapter-imports.mjs` so it can
 * be unit-tested (see `apps/api/tests/unit/frontend-runtime-bundle.test.ts`)
 * without invoking the whole frontend build.
 *
 * @param {string} file Absolute path to `dist/admin.runtime.js`.
 */
async function annotateAdapterImports(file) {
  if (!existsSync(file)) return;
  const source = await readFile(file, 'utf8');
  const rewritten = annotateAdapterImportsSource(source);
  if (rewritten !== source) await writeFile(file, rewritten);
}

async function revisionOf(rootDir, files) {
  const hash = createHash('sha1');
  for (const file of files) {
    hash.update(file);
    hash.update(await readFile(path.join(rootDir, file)));
  }
  return hash.digest('hex').slice(0, 12);
}
