/**
 * 已安装组件状态读取（PLAN-github-distribution-and-updates §4、§7）。
 *
 * 求解完整部署计划需要「当前安装了什么」：内核版本、每个插件/主题的版本、enabled、
 * 权限与 pin。本模块把它从磁盘包指针 + 业务库组装成 {@link InstalledComponent}。**
 * 不**修改任何用户状态；缺失/损坏按未安装处理。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PrismaClient } from '@stackpanel/db';
import type { InstalledComponent } from '@stackpanel/spec';
import { packageDir, type PackageKind } from '../packages/index.ts';
import type { UpdatePolicy } from './policy.ts';

interface PackageManifestFile {
  version?: unknown;
  permissions?: unknown;
}

async function readPackageManifest(
  kind: PackageKind,
  id: string,
): Promise<PackageManifestFile | null> {
  const dir = packageDir(kind, id);
  const file = path.join(dir, kind === 'plugin' ? 'manifest.json' : 'theme.json');
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as PackageManifestFile;
    return parsed;
  } catch {
    return null;
  }
}

/** 读取某组件的已安装版本与权限（磁盘为准）。 */
export async function readInstalledComponent(
  kind: PackageKind,
  id: string,
  enabled: boolean,
  policy: UpdatePolicy,
): Promise<InstalledComponent | null> {
  const manifest = await readPackageManifest(kind, id);
  if (!manifest || typeof manifest.version !== 'string') return null;
  const permissions = Array.isArray(manifest.permissions)
    ? manifest.permissions.filter((p): p is string => typeof p === 'string')
    : [];
  const pinned = policy.pinned[`${kind}/${id}`];
  return {
    kind,
    id,
    version: manifest.version,
    enabled,
    ...(pinned ? { pinnedVersion: pinned } : {}),
    ...(policy.excluded.includes(`${kind}/${id}`) ? { excluded: true } : {}),
    grantedPermissions: permissions,
  };
}

/**
 * 组装全部已安装组件。`kind` 的启用状态来自业务库；若库里没有该行（例如文件存在但未
 * 登记），视为存在但未启用——不静默当作「可更新」。
 */
export async function listInstalledComponents(
  prisma: PrismaClient,
  policy: UpdatePolicy,
): Promise<InstalledComponent[]> {
  const [plugins, themes] = await Promise.all([
    prisma.plugin.findMany({ select: { id: true, enabled: true } }),
    prisma.theme.findMany({ select: { id: true, active: true } }),
  ]);
  const out: InstalledComponent[] = [];
  for (const plugin of plugins) {
    const component = await readInstalledComponent('plugin', plugin.id, plugin.enabled, policy);
    if (component) out.push(component);
  }
  for (const theme of themes) {
    const component = await readInstalledComponent('theme', theme.id, theme.active, policy);
    if (component) out.push(component);
  }
  return out;
}
