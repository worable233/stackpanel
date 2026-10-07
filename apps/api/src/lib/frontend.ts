import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildZodFromSettingsSchema,
  frontendManifestSchema,
  settingsDefaultsFromSchema,
} from '@stackpanel/sdk';
import type {
  FrontendManifest,
  FrontendPageDefinition,
  FrontendSettingsField,
  FrontendSummary,
} from '@stackpanel/sdk';

export const FRONTEND_MANIFEST_FILE = 'frontend/manifest.json';

const MAX_FRONTEND_FILE_BYTES = 1024 * 1024;
const MAX_FRONTEND_ENTRY_BYTES = 512 * 1024;

export class FrontendError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface FrontendPageClaim {
  id: string;
  pages: readonly FrontendPageDefinition[];
}

/** Reject ambiguous user routes contributed by two independently active plugins. */
export function assertNoConflictingFrontendPages(claims: readonly FrontendPageClaim[]): void {
  for (let leftIndex = 0; leftIndex < claims.length; leftIndex += 1) {
    const left = claims[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < claims.length; rightIndex += 1) {
      const right = claims[rightIndex];
      if (!right) continue;
      for (const leftPage of left.pages) {
        for (const rightPage of right.pages) {
          if (pagePatternsOverlap(leftPage.path, rightPage.path)) {
            throw new FrontendError(
              409,
              `前台路由冲突：${left.id}:${leftPage.path} 与 ${right.id}:${rightPage.path}`,
            );
          }
        }
      }
    }
  }
}

/** Whether a ZIP entry belongs to the supported compiled frontend layout. */
export function isAllowedFrontendFile(name: string): boolean {
  if (name === FRONTEND_MANIFEST_FILE) return true;
  if (!name.startsWith('frontend/dist/')) return false;
  const ext = path.extname(name).toLowerCase();
  return ext === '.js' || ext === '.map';
}

/** Read and validate frontend/manifest.json plus all referenced dist files. */
export function validateFrontendFiles(files: Map<string, Uint8Array>): FrontendManifest {
  const manifestRaw = files.get(FRONTEND_MANIFEST_FILE);
  if (!manifestRaw) throw new FrontendError(422, '缺少 frontend/manifest.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(manifestRaw));
  } catch {
    throw new FrontendError(422, 'frontend/manifest.json 不是有效的 JSON');
  }
  const manifestResult = frontendManifestSchema.safeParse(parsed);
  if (!manifestResult.success) {
    throw new FrontendError(422, 'frontend/manifest.json 无效');
  }
  const manifest = manifestResult.data as unknown as FrontendManifest;
  const pagePaths = new Set<string>();
  const pageComponents = new Set<string>();
  for (const page of manifest.pages) {
    if (page.path !== '*' && !page.path.startsWith('/'))
      throw new FrontendError(422, '前台页面路径必须以 / 开头');
    validatePagePattern(page.path);
    if (pagePaths.has(page.path)) throw new FrontendError(422, `重复的前台页面：${page.path}`);
    pagePaths.add(page.path);
    if (pageComponents.has(page.component)) {
      throw new FrontendError(422, `重复的前台页面组件：${page.component}`);
    }
    pageComponents.add(page.component);
  }
  const layoutIds = new Set<string>();
  for (const layout of manifest.layouts) {
    if (layoutIds.has(layout)) {
      throw new FrontendError(422, `重复的前台布局：${layout}`);
    }
    layoutIds.add(layout);
  }
  for (const page of manifest.pages) {
    if (page.layout && !layoutIds.has(page.layout)) {
      throw new FrontendError(422, `未知的前台布局：${page.layout}`);
    }
  }
  const finderNames = new Set<string>();
  for (const finder of manifest.finders) {
    if (finderNames.has(finder)) throw new FrontendError(422, `重复的前台 Finder：${finder}`);
    finderNames.add(finder);
  }
  const adminRoutePaths = new Set<string>();
  const adminRouteComponents = new Set<string>();
  for (const route of manifest.adminRoutes) {
    if (!route.path.startsWith('/')) {
      throw new FrontendError(422, '插件后台路由路径必须以 / 开头');
    }
    if (adminRoutePaths.has(route.path)) {
      throw new FrontendError(422, `重复的插件后台路由：${route.path}`);
    }
    adminRoutePaths.add(route.path);
    if (adminRouteComponents.has(route.component)) {
      throw new FrontendError(422, `重复的插件后台组件：${route.component}`);
    }
    adminRouteComponents.add(route.component);
  }
  const adminActionIds = new Set<string>();
  const adminActionComponents = new Set<string>();
  for (const action of manifest.adminActions) {
    if (!action.id || adminActionIds.has(action.id)) {
      throw new FrontendError(422, `重复或非法的插件后台操作：${action.id}`);
    }
    adminActionIds.add(action.id);
    if (adminActionComponents.has(action.component)) {
      throw new FrontendError(422, `重复的插件后台操作组件：${action.component}`);
    }
    adminActionComponents.add(action.component);
  }
  const frontendActionIds = new Set<string>();
  for (const action of manifest.actions) {
    if (frontendActionIds.has(action.id)) {
      throw new FrontendError(422, `重复的前台操作：${action.id}`);
    }
    frontendActionIds.add(action.id);
    if (action.path.includes('\\') || action.path.includes('..')) {
      throw new FrontendError(422, `非法的前台操作路径：${action.id}`);
    }
    const fields = new Set<string>();
    for (const field of action.input ?? []) {
      if (fields.has(field.name)) {
        throw new FrontendError(422, `重复的前台操作字段：${action.id}.${field.name}`);
      }
      fields.add(field.name);
    }
  }
  const accountRoutePaths = new Set<string>();
  const accountRouteComponents = new Set<string>();
  for (const route of manifest.accountRoutes) {
    if (!route.path.startsWith('/')) {
      throw new FrontendError(422, '账户路由路径必须以 / 开头');
    }
    if (accountRoutePaths.has(route.path)) {
      throw new FrontendError(422, `重复的账户路由：${route.path}`);
    }
    accountRoutePaths.add(route.path);
    if (accountRouteComponents.has(route.component)) {
      throw new FrontendError(422, `重复的账户路由组件：${route.component}`);
    }
    accountRouteComponents.add(route.component);
  }
  const accountWidgetIds = new Set<string>();
  const accountWidgetComponents = new Set<string>();
  for (const widget of manifest.accountWidgets) {
    if (accountWidgetIds.has(widget.id)) {
      throw new FrontendError(422, `重复的账户组件：${widget.id}`);
    }
    accountWidgetIds.add(widget.id);
    if (accountWidgetComponents.has(widget.component)) {
      throw new FrontendError(422, `重复的账户组件渲染：${widget.component}`);
    }
    accountWidgetComponents.add(widget.component);
  }
  if (!manifest.entry.startsWith('frontend/dist/') || !manifest.entry.endsWith('.js')) {
    throw new FrontendError(422, 'frontend entry 必须是 frontend/dist/ 下的 JS 文件');
  }
  if (!files.has(manifest.entry)) {
    throw new FrontendError(422, `缺少前端入口：${manifest.entry}`);
  }
  const entry = files.get(manifest.entry);
  if (entry && entry.length > MAX_FRONTEND_ENTRY_BYTES) {
    throw new FrontendError(422, '前端入口文件过大');
  }
  for (const file of manifest.files) {
    if (!isAllowedFrontendFile(file) || !files.has(file)) {
      throw new FrontendError(422, `前端文件缺失或无效：${file}`);
    }
    const data = files.get(file);
    if (data && data.length > MAX_FRONTEND_FILE_BYTES) {
      throw new FrontendError(422, `前端文件过大：${file}`);
    }
  }
  if (manifest.settingsSchema) {
    validateSettingsSchema(manifest.settingsSchema);
  }
  return manifest;
}

function validatePagePattern(pattern: string): void {
  const segments = pattern.split('/').filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    if ((segment === '*' || segment === '**') && index !== segments.length - 1) {
      throw new FrontendError(422, '通配符必须是路径的最后一段');
    }
  }
}

function pagePatternsOverlap(left: string, right: string): boolean {
  const leftSegments = left.split('/').filter(Boolean);
  const rightSegments = right.split('/').filter(Boolean);
  let index = 0;
  while (true) {
    const leftSegment = leftSegments[index];
    const rightSegment = rightSegments[index];
    if (leftSegment === undefined || rightSegment === undefined) {
      if (leftSegment === undefined && rightSegment === undefined) return true;
      const remainder = leftSegment ?? rightSegment;
      return remainder === '*' || remainder === '**';
    }
    if (leftSegment === '*' || leftSegment === '**') return true;
    if (rightSegment === '*' || rightSegment === '**') return true;
    if (
      !leftSegment.startsWith(':') &&
      !rightSegment.startsWith(':') &&
      leftSegment !== rightSegment
    ) {
      return false;
    }
    index += 1;
  }
}

/** Read a package's frontend manifest, or null when the package has none. */
export async function readFrontendManifest(packageDir: string): Promise<FrontendManifest | null> {
  try {
    const raw = await readFile(path.join(packageDir, FRONTEND_MANIFEST_FILE), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const result = frontendManifestSchema.safeParse(parsed);
    return result.success ? (result.data as unknown as FrontendManifest) : null;
  } catch {
    return null;
  }
}

/** Convert a frontend manifest to the summary used by admin list endpoints. */
export function frontendSummary(manifest: FrontendManifest | null): FrontendSummary {
  if (!manifest) {
    return {
      available: false,
      pages: [],
      finders: [],
      adminRoutes: [],
      adminActions: [],
      actions: [],
      accountRoutes: [],
      accountWidgets: [],
      revision: null,
      settingsSchema: null,
      locales: [],
    };
  }
  return {
    available: true,
    pages: manifest.pages,
    finders: manifest.finders,
    adminRoutes: manifest.adminRoutes,
    adminActions: manifest.adminActions,
    actions: manifest.actions,
    accountRoutes: manifest.accountRoutes,
    accountWidgets: manifest.accountWidgets,
    revision: manifest.revision,
    settingsSchema: manifest.settingsSchema ?? null,
    locales: manifest.locales ?? [],
  };
}

/** Validate that a settings schema is self-consistent and buildable. */
function validateSettingsSchema(schema: FrontendManifest['settingsSchema']): void {
  if (!schema) return;
  const groups = new Set<string>();
  for (const group of schema.groups) {
    if (groups.has(group.id)) throw new FrontendError(422, `重复的设置分组：${group.id}`);
    groups.add(group.id);
    validateSettingsFields(group.fields, group.id);
  }
  const zod = buildZodFromSettingsSchema(schema);
  const defaults = settingsDefaultsFromSchema(schema);
  if (!zod.safeParse(defaults).success) {
    throw new FrontendError(422, '设置 schema 的默认值无效');
  }
}

function validateSettingsFields(fields: FrontendSettingsField[], scope: string): void {
  const names = new Set<string>();
  for (const field of fields) {
    if (names.has(field.name)) {
      throw new FrontendError(422, `重复的设置字段：${scope}.${field.name}`);
    }
    names.add(field.name);
    if (field.type === 'select' || field.type === 'radio') {
      if (field.options.length === 0) {
        throw new FrontendError(422, `设置字段需要提供选项：${field.name}`);
      }
    }
    if (field.type === 'list') {
      if (field.fields.length === 0) {
        throw new FrontendError(422, `列表字段需要提供子字段：${field.name}`);
      }
      validateSettingsFields(field.fields, `${scope}.${field.name}`);
    }
  }
}
