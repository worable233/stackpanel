import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Contract: the isolated worker's `ctx` must expose the whole `PluginContext`
 * surface.
 *
 * The worker builds its context by hand (`serviceProxy('wallet', [...])` and a
 * few inline objects), and every method name in those lists is a manual
 * transcription of an SDK interface. Nothing checks the transcription, so
 * forgetting one is invisible until a plugin calls it at runtime — inside a
 * forked process, where the stack trace points at the plugin rather than at the
 * missing wiring. That is exactly how `ctx.currency` shipped without any method
 * at all.
 *
 * These tests read the SDK's own type declarations and compare them against the
 * worker, so adding a method to a kernel service fails here instead of in
 * production.
 *
 * Two escape hatches exist, both explicit and narrow:
 *   - `LOCALLY_IMPLEMENTED`: methods the worker runs in-process because a round
 *     trip would change their signature (sync → async). Their behaviour is the
 *     SDK's, not the kernel's.
 *   - `NOT_EXPOSED`: methods deliberately unavailable to isolated plugins,
 *     e.g. ones that hand back a live kernel object.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const workerPath = path.join(repoRoot, 'apps/api/src/plugins/isolated/worker.ts');
const sdkSrc = path.join(repoRoot, 'packages/sdk/src');

/**
 * Methods the worker implements in-process instead of proxying.
 *
 * `CurrencyService.toMinor` / `format` are synchronous in the kernel contract,
 * so proxying them would force every caller to `await` — a breaking change for
 * plugins that format inline while rendering.
 */
const LOCALLY_IMPLEMENTED: Record<string, string[]> = {
  currency: ['toMinor', 'format'],
};

/** Methods that must be absent from the worker, for the stated reason. */
const NOT_EXPOSED: Record<string, Record<string, string>> = {};

/** SDK service interface name → the `ctx` key it is published under. */
const SERVICES: Record<string, string> = {
  AuthService: 'auth',
  CacheService: 'cache',
  CaptchaService: 'captcha',
  CurrencyService: 'currency',
  FxService: 'fx',
  IdentityChallengeService: 'identity',
  MediaReferenceService: 'media',
  NotificationPolicyService: 'notificationPolicy',
  NotificationsService: 'notifications',
  PaymentService: 'payments',
  PluginSecrets: 'secrets',
  StateService: 'state',
  StorageService: 'storage',
  WalletService: 'wallet',
};

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
}

/** Every `.ts` file under `packages/sdk/src`, parsed once. */
function sdkSources(): ts.SourceFile[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of ts.sys.readDirectory(dir, ['.ts'])) files.push(entry);
  };
  walk(sdkSrc);
  return files.map(parse);
}

/**
 * Method names declared by an exported interface.
 *
 * Only **callable** members count. A `readonly mode: 'on' | 'off'` property is a
 * value the kernel hands over, not something the worker must proxy as a call.
 */
function interfaceMethods(sources: ts.SourceFile[], name: string): string[] {
  for (const source of sources) {
    for (const statement of source.statements) {
      if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== name) continue;
      const methods: string[] = [];
      for (const member of statement.members) {
        if (ts.isMethodSignature(member)) {
          if (member.name && ts.isIdentifier(member.name)) methods.push(member.name.text);
          continue;
        }
        if (!ts.isPropertySignature(member)) continue;
        if (!member.name || !ts.isIdentifier(member.name)) continue;
        if (member.type && ts.isFunctionTypeNode(member.type)) methods.push(member.name.text);
      }
      return methods;
    }
  }
  throw new Error(`SDK 里找不到接口 ${name}`);
}

/** String literals of an array expression (`[...]`). */
function stringArray(node: ts.Expression): string[] {
  if (!ts.isArrayLiteralExpression(node)) return [];
  return node.elements.flatMap((element) =>
    ts.isStringLiteralLike(element) ? [element.text] : [],
  );
}

/** A `serviceProxy('name', ['a', 'b'])` call → `{ name, methods }`. */
function serviceProxyCall(node: ts.Expression): { name: string; methods: string[] } | null {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (!ts.isIdentifier(callee) || callee.text !== 'serviceProxy') return null;
  const [serviceName, methods] = node.arguments;
  if (!serviceName || !ts.isStringLiteralLike(serviceName) || !methods) return null;
  return { name: serviceName.text, methods: stringArray(methods) };
}

/**
 * The `ctx` keys the worker actually provides, and how.
 *
 * `proxied` is what goes over IPC and therefore needs a host handler; `local`
 * is everything else (inline objects and in-process implementations).
 */
function workerSurface(file: string): {
  keys: Set<string>;
  proxied: Map<string, string[]>;
  local: Map<string, string[]>;
} {
  const source = parse(file);
  const keys = new Set<string>();
  const proxied = new Map<string, string[]>();
  const local = new Map<string, string[]>();

  const addLocal = (key: string, methods: Iterable<string>): void => {
    local.set(key, [...(local.get(key) ?? []), ...methods]);
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'context' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const property of node.initializer.properties) {
        // `manifest,` — shorthand still publishes the key.
        if (ts.isShorthandPropertyAssignment(property)) {
          keys.add(property.name.text);
          addLocal(property.name.text, []);
          continue;
        }
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
        const key = property.name.text;
        keys.add(key);

        const direct = serviceProxyCall(property.initializer);
        if (direct) {
          proxied.set(key, [...(proxied.get(key) ?? []), ...direct.methods]);
          continue;
        }

        if (ts.isObjectLiteralExpression(property.initializer)) {
          const methods: string[] = [];
          for (const member of property.initializer.properties) {
            // `{ ...serviceProxy('currency', [...]), toMinor }`
            if (ts.isSpreadAssignment(member)) {
              const spread = serviceProxyCall(member.expression);
              if (spread) {
                proxied.set(key, [...(proxied.get(key) ?? []), ...spread.methods]);
                methods.push(...spread.methods);
              }
              continue;
            }
            if (!ts.isPropertyAssignment(member) || !ts.isIdentifier(member.name)) continue;
            methods.push(member.name.text);
          }
          addLocal(key, methods);
          continue;
        }

        // A single function value (`tx`, `effect`) or an imported object.
        addLocal(key, []);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  if (keys.size === 0) throw new Error('worker.ts 里找不到 `const context = {…}`');
  return { keys, proxied, local };
}

/** Service names the host dispatches generically (`<service>.<method>`). */
function hostServiceAllowlist(file: string): Set<string> {
  const source = parse(file);
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    // `['state', 'auth', …].includes(serviceMatch[1])` — the only array of bare
    // service names in the host's capability dispatcher.
    if (ts.isArrayLiteralExpression(node)) {
      const values = stringArray(node);
      if (node.elements.every((element) => ts.isStringLiteralLike(element)) && values.length > 4) {
        for (const value of values) names.add(value);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

const sdk = sdkSources();
const surface = workerSurface(workerPath);

describe('isolated ctx surface', () => {
  it('provides every PluginContext key', () => {
    // Keys the kernel hands isolated plugins, from the SDK's own type.
    const sdkKeys = [
      'manifest',
      'logger',
      'events',
      'extensions',
      'tx',
      'secrets',
      'payments',
      'wallet',
      'fx',
      'currency',
      'auth',
      'notifications',
      'notificationPolicy',
      'identity',
      'captcha',
      'media',
      'storage',
      'state',
      'cache',
      'jobs',
      'effect',
      'provide',
      'getService',
      'requireService',
      'registerExtension',
      'getExtensions',
      'getExtensionsWithOwner',
    ];
    expect([...surface.keys].sort()).toEqual(expect.arrayContaining(sdkKeys.sort()));
  });

  for (const [interfaceName, key] of Object.entries(SERVICES)) {
    it(`exposes every ${interfaceName} method through ctx.${key}`, () => {
      const expected = interfaceMethods(sdk, interfaceName);
      const localOnly = new Set(LOCALLY_IMPLEMENTED[key] ?? []);
      const hidden = NOT_EXPOSED[key] ?? {};

      const provided = new Set([
        ...(surface.proxied.get(key) ?? []),
        ...(surface.local.get(key) ?? []),
      ]);

      const missing = expected.filter((method) => !provided.has(method) && !hidden[method]);
      expect(missing).toEqual([]);

      // A name that no longer exists in the SDK is dead wiring: it silently
      // proxies a call the kernel will answer with "unknown method".
      const stale = [...(surface.proxied.get(key) ?? [])].filter(
        (method) => !expected.includes(method) && !localOnly.has(method),
      );
      expect(stale).toEqual([]);
    });
  }

  it('routes every proxied service through a host handler', () => {
    const allowed = hostServiceAllowlist(
      path.join(repoRoot, 'apps/api/src/plugins/isolated/host.ts'),
    );
    const unreachable = [...surface.proxied.keys()].filter((key) => !allowed.has(key));
    // `cache`/`extensions`/`jobs`/`media`/`storage`/`events`/`services` use
    // dedicated capability handlers rather than the generic `<service>.<method>`
    // dispatcher; they are asserted by the RPC suite instead.
    const generic = unreachable.filter((key) =>
      ['auth', 'secrets', 'payments'].some((name) => name === key),
    );
    expect(generic).toEqual([]);
    expect(allowed.size).toBeGreaterThan(5);
  });

  it('keeps the locally implemented overrides a strict subset of the SDK', () => {
    for (const [key, methods] of Object.entries(LOCALLY_IMPLEMENTED)) {
      const interfaceName = Object.entries(SERVICES).find(([, name]) => name === key)?.[0];
      expect(interfaceName, `LOCALLY_IMPLEMENTED 里的 ${key} 必须对应一个 SDK 服务`).toBeDefined();
      const expected = interfaceMethods(sdk, interfaceName as string);
      for (const method of methods) expect(expected).toContain(method);
    }
  });
});
