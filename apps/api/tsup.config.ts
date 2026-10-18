import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'tsup';

/**
 * Packages that must stay outside the bundle because they are resolved from
 * disk at runtime:
 *
 * - `@prisma/client` / `@prisma/adapter-pg`: generated code plus a platform
 *   query-engine binary.
 * - `sharp`: native libvips binding; `.node` files are loaded from disk.
 * - `@opentelemetry/*`: patches module loading at runtime via
 *   `require-in-the-middle`, which stops working once modules are bundled.
 * - `prom-client`: shares module identity with the OTel instrumentation.
 * - `pg-native`: an *optional* dependency of `pg`; esbuild cannot resolve it and
 *   `pg` degrades gracefully without it.
 */
const EXTERNAL_PACKAGES = [
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
  // Reads `./static/*` relative to its own `__dirname`; bundling breaks those
  // asset paths at runtime.
  '@fastify/swagger-ui',
  'pg-native',
];

/**
 * tsup unconditionally marks every `dependencies` entry as external (see
 * `getProductionDeps` in tsup's `runEsbuild`). `skipNodeModulesBundle` does not
 * change that; only `noExternal` wins over it, and it is tested first.
 *
 * For the kernel artifact (ADR-0025) the goal is the opposite of the default:
 * bundle everything that *can* be bundled so the shipped `node_modules` closure
 * stays small. So we compute `noExternal` as "all production dependencies minus
 * the ones that physically cannot be bundled".
 */
function bundledDependencyPatterns(): RegExp[] {
  const pkg = JSON.parse(
    readFileSync(path.join(__dirname, 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> };
  const external = new Set(EXTERNAL_PACKAGES);
  return Object.keys(pkg.dependencies ?? {})
    .filter((name) => !external.has(name))
    .map((name) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|/)`));
}

export default defineConfig({
  entry: ['src/server.ts', 'src/worker.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  /**
   * `pg`, `bullmq` and friends are CommonJS packages that call `require()` for
   * Node builtins at runtime. Once bundled into an ESM output that `require` no
   * longer exists, and esbuild's shim throws "Dynamic require of ... is not
   * supported". Providing a real `require` via `createRequire` keeps them
   * working without marking them external (which would bring back the whole
   * dependency tree).
   */
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  noExternal: bundledDependencyPatterns(),
  external: EXTERNAL_PACKAGES,
});
