import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PluginDefinition, PluginDependency, PluginExtensionConsumer } from '@stackpanel/sdk';
import type { PluginPermission, PluginRoleTemplate } from '@stackpanel/sdk';
import { KERNEL_API_VERSION, kernelApiVersionRange } from '@stackpanel/spec';
import { resolveStackPanelDataDir } from '@stackpanel/sdk/paths';
import { unzipSync } from 'fflate';
import semver from 'semver';
import { FrontendError, isAllowedFrontendFile, validateFrontendFiles } from './frontend.ts';
import { env } from '../config/env.ts';
import { SignatureError, verifyPackageSignature } from './signatures.ts';
import { getPrisma } from '../plugins/prisma.ts';
import { loadIsolatedPluginDefinition } from '../plugins/isolated/host.ts';

export { KERNEL_API_VERSION };

/**
 * Current distribution-manifest schema version (CONTRACT-SEC / G3).
 *
 * The packaging manifest (`manifest.json`) evolves independently of the plugin
 * version: fields get added/renamed and old packages must still be understood or
 * rejected with a clear message rather than silently mis-parsed. Packages may
 * declare `schemaVersion`; absent means {@link MIN_SUPPORTED_MANIFEST_SCHEMA_VERSION}
 * (v1, the pre-G3 shape) so every existing package keeps working.
 */
export const MANIFEST_SCHEMA_VERSION = 1;
export const MIN_SUPPORTED_MANIFEST_SCHEMA_VERSION = 1;

/**
 * Built-in plugins shipped with the kernel; seeded into data/plugins at boot.
 *
 * Derived from each plugin package's `stackpanel.builtin` metadata instead of a
 * hard-coded id list, so the kernel knows the *concept* built-in without naming
 * individual business plugins (ADR-0008 D9). Discovery runs once at module load
 * against the monorepo source packages, which are always present because seeding
 * copies built dists out of them.
 */
export const BUILTIN_PLUGIN_IDS: readonly string[] = Object.freeze(discoverBuiltinPluginIds());

/** Reserved ids that third-party uploads may not use. */
const RESERVED_IDS = new Set<string>([...BUILTIN_PLUGIN_IDS, 'kernel', 'default']);

const PLUGIN_ID_PATTERN = /^[a-z0-9_-]{1,64}$/;
const FORBIDDEN_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.jsx']);
const MAX_ENTRY_BYTES = 512 * 1024;
const MAX_ARCHIVE_FILES = 128;
const MAX_ARCHIVE_FILE_BYTES = 1024 * 1024;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;

/** Distribution manifest for a plugin package. */
export interface PluginManifestFile {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  entry?: string;
  export?: string;
  apiVersion?: string;
  /** Distribution-manifest schema version (G3); absent = v1. */
  schemaVersion?: number;
  requires?: Array<string | PluginDependency>;
  provides?: string[];
  consumes?: PluginExtensionConsumer[];
  permissions?: Array<string | PluginPermission>;
  roleTemplates?: PluginRoleTemplate[];
  execution?: 'trusted' | 'isolated';
  /** Interface locales this plugin ships messages for (ADR-0016 §5). */
  locales?: string[];
  /**
   * Whether this package is a kernel built-in. Written by the kernel from the
   * package's `stackpanel.builtin` metadata when seeding; never accepted from an
   * uploaded package (ADR-0008 D9).
   */
  builtin?: boolean;
}

export class PluginError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface PluginFileWrite {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

function pluginsDir(): string {
  return path.join(resolveStackPanelDataDir(), 'plugins');
}

export function pluginPackageDir(id: string): string {
  return path.join(pluginsDir(), id);
}

function pluginEntryPath(id: string, manifest: PluginManifestFile): string {
  return path.join(pluginPackageDir(id), manifest.entry ?? 'dist/index.js');
}

function isSafeEntryName(name: string): boolean {
  if (name.includes('..')) return false;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  return true;
}

/** Whether a plugin package entry is a source file that must never be distributed. */
export function isForbiddenSourceFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  if (FORBIDDEN_SOURCE_EXTENSIONS.has(ext)) return true;
  if (ext === '.map' && name.toLowerCase().includes('.d.ts.map')) return true;
  const base = path.basename(name).toLowerCase();
  return base.startsWith('.git') || base === '.htaccess';
}

/** Parse and validate an uploaded plugin ZIP; return files to write on success. */
export function parsePluginZip(
  buffer: Buffer,
  signingPublicKey = env.STACKPANEL_SIGNING_PUBLIC_KEY,
): {
  manifest: PluginManifestFile;
  files: Map<string, Uint8Array>;
} {
  let entries: Record<string, Uint8Array>;
  try {
    let fileCount = 0;
    let totalBytes = 0;
    entries = unzipSync(buffer, {
      filter(file) {
        fileCount += 1;
        totalBytes += file.originalSize;
        if (fileCount > MAX_ARCHIVE_FILES) {
          throw new PluginError(422, '插件包文件数量超出限制');
        }
        if (file.originalSize > MAX_ARCHIVE_FILE_BYTES) {
          throw new PluginError(422, `插件包内文件过大：${file.name}`);
        }
        if (totalBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
          throw new PluginError(422, '插件包解压后体积超出限制');
        }
        return true;
      },
    });
  } catch (err) {
    if (err instanceof PluginError) throw err;
    throw new PluginError(400, '无效的 ZIP 压缩包');
  }

  const files = new Map<string, Uint8Array>();
  const frontendFiles = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/') || data.length === 0) continue;
    if (!isSafeEntryName(name)) throw new PluginError(422, `非法的文件名：${name}`);
    if (name.startsWith('frontend/')) {
      if (!isAllowedFrontendFile(name)) {
        throw new PluginError(422, `非法的前端文件：${name}`);
      }
      frontendFiles.set(name, data);
      continue;
    }
    if (isForbiddenSourceFile(name)) {
      throw new PluginError(422, `插件包不允许包含源码文件：${name}`);
    }
    files.set(name, data);
  }

  if (frontendFiles.size > 0) {
    try {
      validateFrontendFiles(frontendFiles);
    } catch (err) {
      if (err instanceof FrontendError) {
        throw new PluginError(err.status, err.message);
      }
      throw err;
    }
    for (const [name, data] of frontendFiles) {
      files.set(name, data);
    }
  }

  const manifestRaw = files.get('manifest.json');
  if (!manifestRaw) throw new PluginError(422, '缺少 manifest.json');
  let manifest: PluginManifestFile;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestRaw)) as PluginManifestFile;
  } catch {
    throw new PluginError(422, 'manifest.json 不是有效的 JSON');
  }
  validateManifest(manifest);

  const entry = manifest.entry ?? 'dist/index.js';
  const entryData = files.get(entry);
  if (!entryData) throw new PluginError(422, `缺少插件入口文件：${entry}`);
  if (entryData.length > MAX_ENTRY_BYTES) throw new PluginError(422, '插件入口文件过大');

  try {
    verifyPackageSignature(files, signingPublicKey);
  } catch (err) {
    if (err instanceof SignatureError) throw new PluginError(422, err.message);
    throw err;
  }

  return { manifest, files };
}

/** Validate manifest fields and kernel compatibility. */
export function validateManifest(manifest: PluginManifestFile, allowReserved = false): void {
  if (
    typeof manifest.id !== 'string' ||
    typeof manifest.name !== 'string' ||
    typeof manifest.version !== 'string' ||
    !PLUGIN_ID_PATTERN.test(manifest.id)
  ) {
    throw new PluginError(422, 'manifest.json 必须声明合法的 id/name/version');
  }
  if (!allowReserved && RESERVED_IDS.has(manifest.id)) {
    throw new PluginError(409, `插件 ID 已被保留：${manifest.id}`);
  }
  if (!allowReserved && manifest.builtin === true) {
    throw new PluginError(422, '插件包不得声明 builtin');
  }
  if (!semver.valid(manifest.version)) {
    throw new PluginError(422, `插件版本号无效：${manifest.version}`);
  }
  if (manifest.execution !== undefined && manifest.execution !== 'trusted' && manifest.execution !== 'isolated') {
    throw new PluginError(422, 'execution 必须是 trusted 或 isolated');
  }
  if (!manifest.builtin && manifest.execution === 'trusted' && process.env.NODE_ENV === 'production') {
    throw new PluginError(403, '生产环境第三方插件必须使用 isolated 执行模式');
  }
  validateManifestSchemaVersion(manifest.schemaVersion);
  if (manifest.apiVersion !== undefined) {
    if (!semver.validRange(manifest.apiVersion)) {
      throw new PluginError(422, `apiVersion 范围无效：${manifest.apiVersion}`);
    }
    if (!semver.satisfies(KERNEL_API_VERSION, manifest.apiVersion)) {
      throw new PluginError(
        409,
        `插件要求 apiVersion ${manifest.apiVersion}，当前内核为 ${KERNEL_API_VERSION}`,
      );
    }
  }
  if (manifest.requires !== undefined) {
    validateRequires(manifest);
  }
  if (manifest.provides !== undefined) {
    validateExtensionPointIds('provides', manifest.provides);
  }
  if (manifest.consumes !== undefined) {
    validateConsumes(manifest);
  }
  if (manifest.permissions !== undefined) {
    validatePermissions(manifest.permissions);
  }
  if (manifest.roleTemplates !== undefined) {
    validateRoleTemplates(manifest.roleTemplates);
  }
}

/**
 * Validate a package's declared manifest schema version (G3). Absent means v1
 * (the pre-G3 shape), so packages produced before this change stay installable.
 * A package from a **newer** kernel (schemaVersion > current) may rely on
 * fields this kernel does not understand → refuse rather than mis-parse.
 */
function validateManifestSchemaVersion(version: unknown): void {
  if (version === undefined) return;
  if (!Number.isInteger(version) || (version as number) < 1) {
    throw new PluginError(422, `manifest.json 的 schemaVersion 无效：${String(version)}`);
  }
  if ((version as number) > MANIFEST_SCHEMA_VERSION) {
    throw new PluginError(
      409,
      `插件要求 manifest schemaVersion ${version}，当前内核仅支持 ${MANIFEST_SCHEMA_VERSION}`,
    );
  }
}

function validateRequires(manifest: PluginManifestFile): void {
  if (!Array.isArray(manifest.requires)) {
    throw new PluginError(422, 'requires 必须是插件 ID 数组');
  }
  const seen = new Set<string>();
  for (const rawDependency of manifest.requires) {
    const dependency = typeof rawDependency === 'string' ? { id: rawDependency } : rawDependency;
    if (
      typeof dependency !== 'object' ||
      dependency === null ||
      typeof dependency.id !== 'string' ||
      !PLUGIN_ID_PATTERN.test(dependency.id)
    ) {
      throw new PluginError(422, `依赖插件 ID 无效：${String(rawDependency)}`);
    }
    if (dependency.id === manifest.id) {
      throw new PluginError(422, `插件不能依赖自身：${manifest.id}`);
    }
    if (dependency.range !== undefined) {
      if (typeof dependency.range !== 'string' || !semver.validRange(dependency.range)) {
        throw new PluginError(422, `依赖版本范围无效：${String(dependency.range)}`);
      }
    }
    if (dependency.optional !== undefined && typeof dependency.optional !== 'boolean') {
      throw new PluginError(422, `依赖 ${dependency.id} 的 optional 标记无效`);
    }
    if (seen.has(dependency.id)) {
      throw new PluginError(422, `重复的依赖插件：${dependency.id}`);
    }
    seen.add(dependency.id);
  }
}

function validateExtensionPointIds(field: string, ids: string[]): void {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new PluginError(422, `${field} 必须是非空字符串数组`);
  }
  if (new Set(ids).size !== ids.length) {
    throw new PluginError(422, `${field} 不能包含重复项`);
  }
}

function validateConsumes(manifest: PluginManifestFile): void {
  if (!Array.isArray(manifest.consumes)) {
    throw new PluginError(422, 'consumes 必须是数组');
  }
  const seen = new Set<string>();
  for (const consumer of manifest.consumes) {
    if (
      typeof consumer !== 'object' ||
      consumer === null ||
      typeof consumer.pluginId !== 'string' ||
      !PLUGIN_ID_PATTERN.test(consumer.pluginId) ||
      typeof consumer.extensionPoint !== 'string' ||
      consumer.extensionPoint.length === 0
    ) {
      throw new PluginError(422, 'consumes 条目无效');
    }
    const key = `${consumer.pluginId}:${consumer.extensionPoint}`;
    if (seen.has(key)) throw new PluginError(422, `重复的 consumes 条目：${key}`);
    seen.add(key);
    if (consumer.optional !== undefined && typeof consumer.optional !== 'boolean') {
      throw new PluginError(422, `依赖 ${key} 的 optional 标记无效`);
    }
  }
}

function validatePermissions(permissions: Array<string | PluginPermission>): void {
  if (!Array.isArray(permissions)) {
    throw new PluginError(422, 'permissions 必须是数组');
  }
  const keys: string[] = [];
  for (const permission of permissions) {
    if (typeof permission === 'string') {
      if (permission.length === 0) {
        throw new PluginError(422, 'permissions 条目必须是非空字符串');
      }
      keys.push(permission);
      continue;
    }
    if (
      typeof permission !== 'object' ||
      permission === null ||
      typeof permission.key !== 'string' ||
      permission.key.length === 0
    ) {
      throw new PluginError(422, 'permissions 条目必须是字符串或 { key } 对象');
    }
    if (permission.description !== undefined && typeof permission.description !== 'string') {
      throw new PluginError(422, 'permissions 条目的 description 必须是字符串');
    }
    if (permission.name !== undefined && typeof permission.name !== 'string') {
      throw new PluginError(422, 'permissions 条目的 name 必须是字符串');
    }
    keys.push(permission.key);
  }
  if (new Set(keys).size !== keys.length) {
    throw new PluginError(422, 'permissions 不能包含重复项');
  }
}

function validateRoleTemplates(templates: PluginRoleTemplate[]): void {
  if (!Array.isArray(templates)) {
    throw new PluginError(422, 'roleTemplates 必须是数组');
  }
  for (const template of templates) {
    if (
      typeof template !== 'object' ||
      template === null ||
      (template.role !== 'ADMIN' && template.role !== 'USER') ||
      !Array.isArray(template.permissions) ||
      template.permissions.some((permission) => typeof permission !== 'string')
    ) {
      throw new PluginError(422, 'roleTemplates 条目无效');
    }
    validatePermissions(template.permissions);
  }
}

/** Write validated plugin files to disk and retain the prior package for rollback. */
export async function writePluginFiles(
  id: string,
  files: Map<string, Uint8Array>,
): Promise<PluginFileWrite> {
  const target = pluginPackageDir(id);
  const parent = pluginsDir();
  const tmp = path.join(parent, `.upload-${id}-${randomUUID()}`);
  const backup = path.join(parent, `.backup-${id}-${randomUUID()}`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(parent, { recursive: true });
  await mkdir(path.join(tmp, 'dist'), { recursive: true });
  for (const [name, data] of files.entries()) {
    const dest = path.resolve(tmp, name);
    if (!dest.startsWith(tmp + path.sep)) throw new PluginError(422, `非法的文件名：${name}`);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, data);
  }
  try {
    if (existsSync(target)) await rename(target, backup);
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    if (!existsSync(target) && existsSync(backup)) await rename(backup, target);
    throw err;
  }
  return {
    commit: async () => {
      await rm(backup, { recursive: true, force: true });
    },
    rollback: async () => {
      await rm(target, { recursive: true, force: true });
      if (existsSync(backup)) await rename(backup, target);
    },
  };
}

export async function removePluginFiles(id: string): Promise<void> {
  await rm(pluginPackageDir(id), { recursive: true, force: true });
}

/** Locate the packages/plugins root regardless of the process working directory. */
function resolvePluginsSourceRoot(): string {
  const cwd = process.cwd();
  for (const candidate of [
    path.join(cwd, 'packages', 'plugins'),
    path.join(cwd, '..', '..', 'packages', 'plugins'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return path.join(cwd, 'packages', 'plugins');
}

/**
 * Discover built-in plugin ids from package metadata: a plugin opts in with
 * `"stackpanel": { "builtin": true }` in its package.json. Using package
 * metadata (never uploaded, unlike a plugin ZIP's manifest) keeps the flag
 * spoof-proof while removing the kernel's hard-coded business id list.
 */
function discoverBuiltinPluginIds(): string[] {
  const root = resolvePluginsSourceRoot();
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const pkgPath = path.join(root, name, 'package.json');
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        stackpanel?: { builtin?: boolean };
      };
      if (pkg.stackpanel?.builtin === true) ids.push(name);
    } catch {
      // Invalid package.json: not a distributable plugin package.
    }
  }
  return ids.sort();
}

/** Resolve packages/plugins/<id> regardless of the process working directory. */
function resolvePluginSourceRoot(id: string): string {
  const cwd = process.cwd();
  for (const candidate of [
    path.join(cwd, 'packages', 'plugins', id),
    path.join(cwd, '..', '..', 'packages', 'plugins', id),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return path.join(cwd, 'packages', 'plugins', id);
}

/** Human-friendly display name for a plugin package name. */
export function friendlyPluginName(packageName: string): string {
  return packageName.replace(/^@[^/]+\//, '').replace(/-/g, ' ');
}

/** Seed the built-in plugins (built dist + manifest) into data/plugins at boot. */
export async function seedBuiltinPlugins(): Promise<void> {
  const prisma = getPrisma();
  for (const id of BUILTIN_PLUGIN_IDS) {
    try {
      const meta = await seedBuiltinPlugin(id);
      if (!meta) continue;
      // Sync the plugin record so built-ins are visible and enabled out of the
      // box on a fresh database (e.g. after the SQLite migration reset). Keep
      // an existing `enabled` state untouched (update omits it).
      await prisma.plugin.upsert({
        where: { id },
        create: { id, name: meta.name, version: meta.version, enabled: true },
        update: { name: meta.name, version: meta.version },
      });
    } catch {
      // Plugin not built in this checkout; skip gracefully.
    }
  }
}

async function seedBuiltinPlugin(id: string): Promise<{ name: string; version: string } | null> {
  const source = resolvePluginSourceRoot(id);
  const distDir = path.join(source, 'dist');
  const distEntry = path.join(distDir, 'index.js');
  if (!existsSync(distEntry)) return null;
  const sourceMetadata = await readBuiltinPluginMetadata(id, distEntry);
  const pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8')) as {
    name?: string;
    version?: string;
    description?: string;
  };
  const version = pkg.version ?? '0.0.0';
  const name = sourceMetadata.name ?? friendlyPluginName(pkg.name ?? id);
  const target = pluginPackageDir(id);
  const frontendSource = path.join(source, 'frontend');
  const existing = await readPluginManifestOrNull(id);
  const sourceDistRevision = await directoryRevision(distDir);
  const targetDistRevision = await directoryRevision(path.join(target, 'dist'));
  const sourceFrontendManifest = await readFile(path.join(frontendSource, 'manifest.json')).catch(
    () => null,
  );
  const targetFrontendManifest = await readFile(
    path.join(target, 'frontend', 'manifest.json'),
  ).catch(() => null);
  if (
    existing &&
    existing.version === version &&
    existing.builtin === true &&
    sourceDistRevision !== null &&
    sourceDistRevision === targetDistRevision &&
    existsSync(path.join(target, 'dist', 'index.js')) &&
    (sourceFrontendManifest === null ||
      targetFrontendManifest?.toString() === sourceFrontendManifest.toString())
  ) {
    return { name, version }; // already seeded at the same version
  }
  const manifest: PluginManifestFile = {
    ...sourceMetadata,
    id,
    name,
    version,
    builtin: true,
    ...(pkg.description ? { description: pkg.description } : {}),
    apiVersion: kernelApiVersionRange(),
  };
  // Build into a temp dir then rename the whole directory, so concurrent
  // readers (parallel test workers) never observe a partial plugin package.
  const tmp = path.join(pluginsDir(), `.seed-${id}-${process.pid}`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  await cp(distDir, path.join(tmp, 'dist'), { recursive: true });
  if (existsSync(frontendSource)) {
    const frontendTarget = path.join(tmp, 'frontend');
    await mkdir(frontendTarget, { recursive: true });
    const frontendManifest = path.join(frontendSource, 'manifest.json');
    if (existsSync(frontendManifest)) {
      await writeFile(path.join(frontendTarget, 'manifest.json'), await readFile(frontendManifest));
    }
    const frontendDist = path.join(frontendSource, 'dist');
    if (existsSync(frontendDist)) {
      await cp(frontendDist, path.join(frontendTarget, 'dist'), { recursive: true });
    }
  }
  await writeFile(path.join(tmp, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2)));
  const assets = path.join(source, 'assets');
  if (existsSync(assets)) {
    await cp(assets, path.join(tmp, 'assets'), { recursive: true });
  }
  await rm(target, { recursive: true, force: true });
  await rename(tmp, target);
  return { name, version };
}

/** Stable SHA-256 over a directory's file names and contents, or null. */
async function directoryRevision(dir: string): Promise<string | null> {
  const entries = await readdir(dir, { recursive: true }).catch(() => null);
  if (!entries) return null;
  const hash = createHash('sha256');
  for (const entry of entries.sort()) {
    const full = path.join(dir, entry);
    const entryStat = await stat(full);
    if (!entryStat.isFile()) continue;
    hash.update(entry);
    hash.update(await readFile(full));
  }
  return hash.digest('hex');
}

/** Read RBAC/dependency metadata from a built-in plugin's compiled manifest. */
async function readBuiltinPluginMetadata(
  id: string,
  dist: string,
): Promise<
  Pick<PluginManifestFile, 'requires' | 'provides' | 'consumes' | 'permissions' | 'roleTemplates'> &
    Partial<Pick<PluginManifestFile, 'name' | 'description' | 'locales'>>
> {
  const mod = (await import(`${pathToFileURL(dist).href}?v=${Date.now()}`)) as Record<
    string,
    unknown
  >;
  const definition = (mod['default'] ?? mod[id]) as
    { manifest?: Partial<PluginManifestFile> } | null | undefined;
  const manifest = definition?.manifest;
  if (!manifest) return {};
  return {
    ...(manifest.name ? { name: manifest.name } : {}),
    ...(manifest.description ? { description: manifest.description } : {}),
    ...(manifest.requires ? { requires: manifest.requires } : {}),
    ...(manifest.provides ? { provides: manifest.provides } : {}),
    ...(manifest.consumes ? { consumes: manifest.consumes } : {}),
    ...(manifest.permissions ? { permissions: manifest.permissions } : {}),
    ...(manifest.roleTemplates ? { roleTemplates: manifest.roleTemplates } : {}),
    ...(manifest.locales ? { locales: manifest.locales } : {}),
  };
}

/** Read a plugin manifest returning null when the package is absent/invalid. */
async function readPluginManifestOrNull(id: string): Promise<PluginManifestFile | null> {
  try {
    const raw = await readFile(path.join(pluginPackageDir(id), 'manifest.json'), 'utf8');
    return JSON.parse(raw) as PluginManifestFile;
  } catch {
    return null;
  }
}

/** Load a plugin definition from an installed package (with cache busting). */
export async function loadPluginDefinition(id: string): Promise<PluginDefinition> {
  const manifest = await readPluginManifest(id, true);
  const entry = pluginEntryPath(id, manifest);
  const entryData = await readFile(entry).catch(() => null);
  if (!entryData) throw new PluginError(422, `缺少插件入口文件：${id}`);
  // Existing local development plugins predate the execution field. Keep them
  // usable during development; production always takes the isolated path.
  const execution = manifest.execution ?? (process.env.NODE_ENV === 'production' ? 'isolated' : 'trusted');
  if (!manifest.builtin && execution !== 'trusted') {
    return loadIsolatedPluginDefinition(id, entry, { ...manifest, execution });
  }
  const url = `${pathToFileURL(entry).href}?v=${Date.now()}`;
  const mod = (await import(url)) as Record<string, unknown>;
  const exportName = manifest.export ?? 'default';
  const candidate = exportName === 'default' ? mod['default'] : mod[exportName];
  const definition = validateLoadedDefinition(candidate, manifest);
  return {
    ...definition,
    manifest: {
      ...definition.manifest,
      ...(manifest.requires ? { requires: manifest.requires } : {}),
      ...(manifest.provides ? { provides: manifest.provides } : {}),
      ...(manifest.consumes ? { consumes: manifest.consumes } : {}),
      ...(manifest.permissions ? { permissions: manifest.permissions } : {}),
      ...(manifest.roleTemplates ? { roleTemplates: manifest.roleTemplates } : {}),
      ...(manifest.locales ? { locales: manifest.locales } : {}),
      ...(manifest.builtin ? { builtin: true } : {}),
      ...(execution ? { execution } : {}),
    },
  };
}

async function readPluginManifest(id: string, allowReserved = false): Promise<PluginManifestFile> {
  try {
    const raw = await readFile(path.join(pluginPackageDir(id), 'manifest.json'), 'utf8');
    const manifest = JSON.parse(raw) as PluginManifestFile;
    validateManifest(manifest, allowReserved);
    return manifest;
  } catch (err) {
    if (err instanceof PluginError) throw err;
    throw new PluginError(422, `插件 manifest 无效：${id}`);
  }
}

/** Structural validation of a dynamically imported plugin definition. */
function validateLoadedDefinition(
  candidate: unknown,
  manifest: PluginManifestFile,
): PluginDefinition {
  if (candidate === null || typeof candidate !== 'object') {
    throw new PluginError(422, `插件 ${manifest.id} 未导出定义`);
  }
  const def = candidate as Partial<PluginDefinition>;
  if (
    def.manifest === null ||
    typeof def.manifest !== 'object' ||
    (def.manifest as { id?: unknown }).id !== manifest.id ||
    typeof (def.manifest as { name?: unknown }).name !== 'string'
  ) {
    throw new PluginError(422, `插件 ${manifest.id} 的 manifest 不一致`);
  }
  if (def.routes !== undefined && !Array.isArray(def.routes)) {
    throw new PluginError(422, `插件 ${manifest.id} 的路由列表无效`);
  }
  return def as PluginDefinition;
}

/** Scan data/plugins for installed packages and load their definitions. */
export async function scanPlugins(): Promise<PluginDefinition[]> {
  let ids: string[];
  try {
    ids = await readdir(pluginsDir());
  } catch {
    return [];
  }
  const definitions: PluginDefinition[] = [];
  for (const id of ids) {
    // `.seed-*` are transient build directories written by seedBuiltinPlugin.
    // A crashed worker can leave one behind; skipping them avoids loading a
    // half-written package as a duplicate of a real plugin.
    if (id.startsWith('.')) continue;
    if (!existsSync(path.join(pluginPackageDir(id), 'manifest.json'))) continue;
    try {
      definitions.push(await loadPluginDefinition(id));
    } catch (err) {
      console.warn(`[plugins] Skipping invalid plugin ${id}:`, (err as Error).message);
    }
  }
  return definitions;
}

export { pluginsDir };
