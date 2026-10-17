/**
 * 自动更新策略（PLAN-github-distribution-and-updates §4、§9）。
 *
 * 策略决定「哪些组件允许自动更新、渠道、维护窗口、以及是否需要人工授权」。它保存在
 * 设置表（`setting` key `distribution:update-policy`），由更新中心读写。**默认保守**：
 * 不自动更新，只有显式开启才进入自动渠道，且权限增加 / 不可逆迁移 / 降级一律先阻止
 * （交由 §4 求解与人工授权，不静默放行）。
 */

import type { Prisma, PrismaClient } from '@stackpanel/db';
import type { ReleaseChannel } from '@stackpanel/spec';

export const UPDATE_POLICY_SETTING_KEY = 'distribution:update-policy';

/** 维护窗口：允许自动执行的时间段（本地小时，`[start, end)`；跨午夜由调用方处理）。 */
export interface MaintenanceWindow {
  /** 0-23。 */
  startHour: number;
  /** 0-23。 */
  endHour: number;
}

export interface UpdatePolicy {
  /** 是否启用自动更新（默认 false，需管理员显式开启）。 */
  autoUpdate: boolean;
  /** 更新渠道。 */
  channel: ReleaseChannel;
  /** 是否自动更新内核自身（默认 false，风险最高）。 */
  autoUpdateKernel: boolean;
  /** 被排除自动更新的组件键 `${kind}/${id}`。 */
  excluded: string[];
  /** 管理员固定版本的组件：键 → 版本。 */
  pinned: Record<string, string>;
  /** 维护窗口；缺省表示任何时间都可（仅在 autoUpdate 时相关）。 */
  maintenanceWindow?: MaintenanceWindow;
  /** 允许自动更新需要新增权限的包（默认 false：权限增加需人工授权，§4）。 */
  allowPermissionIncrease: boolean;
  /** 允许自动执行不可逆迁移（默认 false，§6）。 */
  allowIrreversibleMigration: boolean;
  updatedAt?: string;
  updatedBy?: string | null;
}

export const DEFAULT_UPDATE_POLICY: UpdatePolicy = Object.freeze({
  autoUpdate: false,
  channel: 'stable',
  autoUpdateKernel: false,
  excluded: [],
  pinned: {},
  allowPermissionIncrease: false,
  allowIrreversibleMigration: false,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 把任意 JSON 归一为合法策略（缺省字段回落到保守默认）。 */
export function normalizeUpdatePolicy(value: unknown): UpdatePolicy {
  if (!isRecord(value)) return { ...DEFAULT_UPDATE_POLICY };
  const excluded = Array.isArray(value['excluded'])
    ? value['excluded'].filter((v): v is string => typeof v === 'string')
    : [];
  const pinned: Record<string, string> = {};
  if (isRecord(value['pinned'])) {
    for (const [key, version] of Object.entries(value['pinned'])) {
      if (typeof version === 'string' && version.length > 0) pinned[key] = version;
    }
  }
  const window = value['maintenanceWindow'];
  const maintenanceWindow =
    isRecord(window) &&
    typeof window['startHour'] === 'number' &&
    typeof window['endHour'] === 'number'
      ? { startHour: window['startHour'], endHour: window['endHour'] }
      : undefined;
  return {
    autoUpdate: value['autoUpdate'] === true,
    channel: value['channel'] === 'beta' ? 'beta' : 'stable',
    autoUpdateKernel: value['autoUpdateKernel'] === true,
    excluded,
    pinned,
    ...(maintenanceWindow ? { maintenanceWindow } : {}),
    allowPermissionIncrease: value['allowPermissionIncrease'] === true,
    allowIrreversibleMigration: value['allowIrreversibleMigration'] === true,
    ...(typeof value['updatedAt'] === 'string' ? { updatedAt: value['updatedAt'] } : {}),
    ...(typeof value['updatedBy'] === 'string' || value['updatedBy'] === null
      ? { updatedBy: value['updatedBy'] as string | null }
      : {}),
  };
}

/** 读取策略（设置表）。无记录时返回保守默认。 */
export async function readUpdatePolicy(prisma: PrismaClient): Promise<UpdatePolicy> {
  const row = await prisma.setting.findUnique({ where: { key: UPDATE_POLICY_SETTING_KEY } });
  return normalizeUpdatePolicy(row?.value);
}

/** 写入策略（校验 → upsert）。 */
export async function saveUpdatePolicy(
  prisma: PrismaClient,
  patch: Partial<UpdatePolicy>,
  updatedBy: string | null,
  now: Date = new Date(),
): Promise<UpdatePolicy> {
  const current = await readUpdatePolicy(prisma);
  const merged = normalizeUpdatePolicy({
    ...current,
    ...patch,
    updatedAt: now.toISOString(),
    updatedBy,
  });
  await prisma.setting.upsert({
    where: { key: UPDATE_POLICY_SETTING_KEY },
    create: {
      key: UPDATE_POLICY_SETTING_KEY,
      value: merged as unknown as Prisma.InputJsonValue,
      updatedBy,
    },
    update: { value: merged as unknown as Prisma.InputJsonValue, updatedBy },
  });
  return merged;
}

/** 判断某组件是否被策略排除自动更新。 */
export function isExcluded(policy: UpdatePolicy, kind: string, id: string): boolean {
  return policy.excluded.includes(`${kind}/${id}`);
}

/** 判断某组件是否被策略固定到具体版本。 */
export function pinnedVersionOf(
  policy: UpdatePolicy,
  kind: string,
  id: string,
): string | undefined {
  return policy.pinned[`${kind}/${id}`];
}

/** 是否在维护窗口内（未配置窗口 = 始终允许）。 */
export function withinMaintenanceWindow(policy: UpdatePolicy, now: Date): boolean {
  const window = policy.maintenanceWindow;
  if (!window) return true;
  const hour = now.getHours();
  if (window.startHour <= window.endHour) {
    return hour >= window.startHour && hour < window.endHour;
  }
  // 跨午夜窗口。
  return hour >= window.startHour || hour < window.endHour;
}
