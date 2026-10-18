#!/usr/bin/env node
/**
 * Collects the minimal `node_modules` closure for the kernel artifact.
 *
 * The API bundle already contains every package that *can* be bundled. Only the
 * packages that must be resolved from disk at runtime remain external (native
 * binaries, runtime module patching, engine files). This script walks the
 * dependency graph starting from those externals and copies exactly what they
 * need into the artifact.
 *
 * pnpm keeps one physical copy per `(name, version)` and links it from many
 * places. A naive flattening silently swaps versions when two parents depend on
 * different majors of the same package (`signal-exit@3` vs `@4` differ in their
 * export *shape*, not just version). So the materialized tree preserves Node's
 * resolution semantics:
 *
 * - the first version seen for a name goes to `<out>/node_modules/<name>`;
 * - a parent that needs a *different* version gets
 *   `<out>/node_modules/<parent>/node_modules/<name>`.
 *
 * Usage:
 *   node scripts/release/collect-runtime-deps.mjs --root <dir> --out <dir> \
 *     [--platform linux-x64]
 */

import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** Packages that stay outside the esbuild bundle (must match apps/api/tsup.config.ts). */
export const EXTERNAL_PACKAGES = [
  '@prisma/client',
  'sharp',
  '@opentelemetry/api',
  '@opentelemetry/exporter-trace-otlp-http',
  '@opentelemetry/instrumentation-http',
  '@opentelemetry/resources',
  '@opentelemetry/sdk-node',
  '@opentelemetry/semantic-conventions',
  'prom-client',
  'css-tree',
  '@fastify/swagger-ui',
];

/** Dependencies that are always present and must never be copied. */
const NEVER_COPY = new Set(['pg-native']);

/**
 * Optional platform-specific packages. They are listed in `optionalDependencies`
 * for every platform, so only the ones matching the target OS/arch are real
 * requirements. A missing optional package is not an error.
 */
const PLATFORM_PACKAGE = /^@img\/sharp-(libvips-)?(darwin|linux|linuxmusl|win32|freebsd|webcontainers)-/;

function matchesTargetPlatform(packageName, target) {
  if (!PLATFORM_PACKAGE.test(packageName)) return true;
  if (!target) return true;
  const [os, arch] = target.split('-');
  if (os === 'linux' && packageName.includes('-linuxmusl-')) return false;
  const osMatch = packageName.includes(`-${os}-`) || packageName.includes(`-${os}musl-`);
  const archMatch = packageName.endsWith(`-${arch}`);
  return osMatch && archMatch;
}

function readPkg(dir) {
  const file = path.join(dir, 'package.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * Resolve a package the same way Node would from `fromDir`.
 * Returns the real (symlink-free) package directory, or null.
 */
function resolvePackage(specifier, fromDir) {
  const require = createRequire(path.join(fromDir, 'noop.js'));

  // Prefer locating the package directory directly. `require.resolve` honours
  // the package `exports` map, and some packages (`prisma`) map the bare
  // specifier to a file that only exists in the published tarball layout — the
  // resolution then throws even though the directory is present.
  let searchPaths = [];
  try {
    searchPaths = require.resolve.paths(specifier) ?? [];
  } catch {
    /* ignore */
  }
  for (const base of searchPaths) {
    const candidate = path.join(base, specifier);
    const pkg = readPkg(candidate);
    if (pkg) return { dir: realpathSync(candidate), pkg };
  }

  // Fallback: resolve the entry file and walk up to the package root.
  try {
    const entry = require.resolve(specifier, { paths: [fromDir] });
    let dir = path.dirname(entry);
    for (let i = 0; i < 12; i += 1) {
      const pkg = readPkg(dir);
      if (pkg && (pkg.name === specifier || pkg.name === specifier.split('/').slice(0, 2).join('/'))) {
        return { dir: realpathSync(dir), pkg };
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Breadth-first walk over runtime dependencies.
 *
 * @returns {{
 *   packages: Map<string, {name: string, dir: string, pkg: object}>,
 *   edges: Map<string, string[]>,
 *   roots: string[],
 * }} `packages` is keyed by `<dir>` (physical identity, so two versions of the
 *    same name stay distinct); `edges` maps a parent dir to the dirs it needs.
 */
export function collectClosure(entries, fromDirs, onMissing, target) {
  const packages = new Map();
  const edges = new Map();
  const roots = [];
  const queue = entries.map((name) => ({ name, from: fromDirs, parent: null }));

  while (queue.length > 0) {
    const { name, from, parent } = queue.shift();
    if (NEVER_COPY.has(name) || !matchesTargetPlatform(name, target)) continue;

    // `from` is a list of directories to try, in order. pnpm does not hoist
    // workspace-only dependencies (e.g. `@prisma/client` lives under
    // `packages/db`), so the caller supplies several search roots.
    let resolved = null;
    for (const dir of from) {
      resolved = resolvePackage(name, dir);
      if (resolved) break;
    }
    if (!resolved) {
      onMissing?.(name, from.join(', '));
      continue;
    }

    const id = resolved.dir;
    if (parent) {
      const list = edges.get(parent) ?? [];
      if (!list.includes(id)) list.push(id);
      edges.set(parent, list);
    } else if (!roots.includes(id)) {
      roots.push(id);
    }

    if (packages.has(id)) continue;
    packages.set(id, { name, dir: id, pkg: resolved.pkg });

    const deps = {
      ...(resolved.pkg.dependencies ?? {}),
      ...(resolved.pkg.optionalDependencies ?? {}),
    };
    for (const dep of Object.keys(deps)) {
      if (NEVER_COPY.has(dep) || !matchesTargetPlatform(dep, target)) continue;
      // Search from the package itself, then fall back to the caller's roots:
      // pnpm may have hoisted a transitive dependency outside this package.
      queue.push({ name: dep, from: [id, ...fromDirs], parent: id });
    }
  }
  return { packages, edges, roots };
}

function copyPackage(source, target) {
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, dereference: true, force: true });
}

/**
 * Materialize the closure into `<out>/node_modules`, preserving per-parent
 * version requirements.
 *
 * @returns {string[]} collision reports (should normally be empty)
 */
export function materializeClosure(closure, outDir) {
  const modulesDir = path.join(outDir, 'node_modules');
  rmSync(modulesDir, { recursive: true, force: true });
  mkdirSync(modulesDir, { recursive: true });

  const { packages, edges, roots } = closure;
  const conflicts = [];

  /** `<scope>/node_modules/<name>` → physical package dir occupying it. */
  const slots = new Map();
  /** Package dir → the scope (package dir or `outDir`) it was placed under. */
  const scopeOf = new Map();

  /**
   * True when Node resolving from `scope` would reach `pkgDir`.
   * Walks the same chain Node does: the scope's own `node_modules`, then the
   * parent scope's, ending at the artifact root.
   */
  function visible(scope, name, pkgDir) {
    let current = scope;
    for (let depth = 0; depth < 16; depth += 1) {
      if (slots.get(path.join(current, 'node_modules', name)) === pkgDir) return true;
      if (current === outDir) return false;
      current = scopeOf.get(current) ?? outDir;
    }
    return false;
  }

  /**
   * @param {string} pkgDir physical package
   * @param {string} ownerScope the requiring package's dir, or `outDir` for roots
   * @param {number} depth guard against pathological graphs
   */
  function place(pkgDir, ownerScope, depth = 0) {
    if (depth > 16) {
      conflicts.push(`嵌套过深：${packages.get(pkgDir)?.name}`);
      return;
    }
    const pkg = packages.get(pkgDir);
    if (!pkg) return;
    if (visible(ownerScope, pkg.name, pkgDir)) return;

    // Prefer a top-level slot (npm-style hoisting) so a dependency shared by
    // many parents is stored once. Fall back to the requiring parent's own
    // `node_modules` when the top slot already holds a different version.
    const topSlot = path.join(modulesDir, pkg.name);
    let slot = topSlot;
    if (slots.has(topSlot) && slots.get(topSlot) !== pkgDir) {
      slot = path.join(ownerScope, 'node_modules', pkg.name);
    }
    if (ownerScope === outDir && slot !== topSlot) {
      conflicts.push(
        `${pkg.name}@${pkg.pkg.version} 无法与顶层的 ${packages.get(slots.get(topSlot))?.pkg.version ?? '?'} 共存`,
      );
      return;
    }

    const occupant = slots.get(slot);
    if (occupant === pkgDir) return;
    if (occupant !== undefined) {
      conflicts.push(
        `${pkg.name}@${pkg.pkg.version} 与 ${packages.get(occupant)?.pkg.version ?? '?'} 在 ${slot} 冲突`,
      );
      return;
    }

    copyPackage(pkg.dir, slot);
    slots.set(slot, pkgDir);
    scopeOf.set(slot, ownerScope);

    for (const child of edges.get(pkgDir) ?? []) {
      place(child, slot, depth + 1);
    }
  }

  for (const root of roots) place(root, outDir);

  // `node_modules/.bin` is not needed at runtime and would point at dev tools.
  rmSync(path.join(modulesDir, '.bin'), { recursive: true, force: true });
  return conflicts;
}

/** Count how many distinct physical versions exist per package name. */
export function versionConflicts(closure) {
  const byName = new Map();
  for (const pkg of closure.packages.values()) {
    const list = byName.get(pkg.name) ?? [];
    list.push(pkg.pkg.version);
    byName.set(pkg.name, list);
  }
  return [...byName.entries()]
    .filter(([, versions]) => new Set(versions).size > 1)
    .map(([name, versions]) => `${name}: ${[...new Set(versions)].join(', ')}`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key.startsWith('--')) {
      args[key.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root ?? process.cwd());
  const out = path.resolve(args.out ?? path.join(root, 'runtime-deps'));
  const target = args.platform;
  const fromDirs = [path.join(root, 'apps/api'), path.join(root, 'packages/db'), root];

  const missing = [];
  const closure = collectClosure(
    EXTERNAL_PACKAGES,
    fromDirs,
    (name, from) => {
      if (name.startsWith('@types/') || PLATFORM_PACKAGE.test(name)) return;
      missing.push({ name, from });
    },
    target,
  );
  if (missing.length > 0) {
    console.error('无法解析的运行期依赖：');
    for (const item of missing) console.error(`  - ${item.name} (from ${item.from})`);
    process.exit(1);
  }

  materializeClosure(closure, out);

  const conflicts = versionConflicts(closure);
  console.log(`已收集 ${closure.packages.size} 个物理包 -> ${out}`);
  if (conflicts.length > 0) {
    console.log('多版本（已按父包嵌套）：');
    for (const line of conflicts) console.log(`  ${line}`);
  }
}
