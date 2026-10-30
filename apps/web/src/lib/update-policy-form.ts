/**
 * 更新策略表单的纯解析层（无 React、无 server-only 依赖，可直接单测）。
 *
 * 表单里两个自由文本域（排除清单、固定版本）是唯一容易写错的地方，把它们从组件里
 * 拆出来有两个理由：
 * 1. 解析规则要和内核的匹配规则**逐字对齐**（`kind/id` 键，见
 *    `apps/api/src/updates/policy.ts` 的 `isExcluded` / `pinnedVersionOf`）；
 * 2. 写错了必须当场拒绝，而不是把一行垃圾写进设置表里、等到下次自动更新才发作。
 */

import type { UpdateChannel, UpdatePolicyPatch } from '@stackpanel/sdk';

/** 组件键：`plugin/<id>` 或 `theme/<id>`，与内核 `isExcluded` 的字符串拼接完全一致。 */
const COMPONENT_KEY = /^(?:plugin|theme)\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 版本号：语义化版本的子集（预发布标签允许点号）。 */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** 表单提交的原始值（全部是字符串/布尔，未做任何解释）。 */
export interface UpdatePolicyFormValues {
  autoUpdate: boolean;
  channel: string;
  autoUpdateKernel: boolean;
  /** 是否启用维护窗口；关闭表示「任何时间都可」。 */
  windowEnabled: boolean;
  windowStart: string;
  windowEnd: string;
  /** 每行一个 `kind/id`。 */
  excluded: string;
  /** 每行一个 `kind/id version`。 */
  pinned: string;
  allowPermissionIncrease: boolean;
  allowIrreversibleMigration: boolean;
}

/** 解析失败的字段；由调用方翻译成文案（本模块不产出人类语言）。 */
export type UpdatePolicyField = 'channel' | 'window' | 'excluded' | 'pinned';

export type UpdatePolicyParseResult =
  { ok: true; patch: UpdatePolicyPatch } | { ok: false; field: UpdatePolicyField; detail: string };

/** 把文本域拆成非空行（`#` 开头视为注释，便于管理员写说明）。 */
function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/** 解析排除清单：每行一个 `kind/id`，重复项去重后保持原序。 */
export function parseExcluded(text: string): { value: string[] } | { detail: string } {
  const out: string[] = [];
  for (const line of lines(text)) {
    if (!COMPONENT_KEY.test(line)) return { detail: line };
    if (!out.includes(line)) out.push(line);
  }
  return { value: out };
}

/**
 * 解析固定版本：每行 `kind/id version`（也接受 `kind/id@version`）。
 *
 * 空格与 `@` 两种写法都接受，因为管理员很可能从别处粘过来；但键与版本都必须合法。
 */
export function parsePinned(text: string): { value: Record<string, string> } | { detail: string } {
  const out: Record<string, string> = {};
  for (const line of lines(text)) {
    const at = line.lastIndexOf('@');
    const parts = at > 0 ? [line.slice(0, at), line.slice(at + 1)] : line.split(/\s+/);
    if (parts.length !== 2) return { detail: line };
    const [key, version] = parts as [string, string];
    if (!COMPONENT_KEY.test(key) || !VERSION.test(version)) return { detail: line };
    out[key] = version;
  }
  return { value: out };
}

/** 解析维护窗口的两个小时值（0-23）。 */
export function parseWindow(
  start: string,
  end: string,
): { value: { startHour: number; endHour: number } } | { detail: string } {
  const toHour = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (!/^\d{1,2}$/.test(trimmed)) return null;
    const hour = Number(trimmed);
    return hour >= 0 && hour <= 23 ? hour : null;
  };
  const startHour = toHour(start);
  const endHour = toHour(end);
  if (startHour === null || endHour === null) return { detail: `${start}-${end}` };
  return { value: { startHour, endHour } };
}

/**
 * 表单值 → PUT 请求体。
 *
 * 语义刻意区分「不传」与「传 null」：
 * - 维护窗口关闭 → `maintenanceWindow: null`（清除限制）。没有这一条，一旦设过窗口
 *   就永远关不掉，管理员只能去改数据库。
 * - 其余字段一律全量提交：策略是一次性保存的整份表单，缺字段会让旧值残留。
 */
export function buildUpdatePolicyPatch(values: UpdatePolicyFormValues): UpdatePolicyParseResult {
  if (values.channel !== 'stable' && values.channel !== 'beta') {
    return { ok: false, field: 'channel', detail: String(values.channel) };
  }
  const excluded = parseExcluded(values.excluded);
  if (!('value' in excluded)) return { ok: false, field: 'excluded', detail: excluded.detail };
  const pinned = parsePinned(values.pinned);
  if (!('value' in pinned)) return { ok: false, field: 'pinned', detail: pinned.detail };

  let maintenanceWindow: UpdatePolicyPatch['maintenanceWindow'] = null;
  if (values.windowEnabled) {
    const window = parseWindow(values.windowStart, values.windowEnd);
    if (!('value' in window)) return { ok: false, field: 'window', detail: window.detail };
    maintenanceWindow = window.value;
  }

  return {
    ok: true,
    patch: {
      autoUpdate: values.autoUpdate,
      channel: values.channel as UpdateChannel,
      autoUpdateKernel: values.autoUpdateKernel,
      excluded: excluded.value,
      pinned: pinned.value,
      maintenanceWindow,
      allowPermissionIncrease: values.allowPermissionIncrease,
      allowIrreversibleMigration: values.allowIrreversibleMigration,
    },
  };
}

/** 从 `FormData` 读出原始表单值（checkbox 未勾选时字段缺失 = false）。 */
export function readUpdatePolicyForm(formData: FormData): UpdatePolicyFormValues {
  const flag = (name: string): boolean => {
    const value = formData.get(name);
    return value === 'on' || value === 'true' || value === '1';
  };
  const text = (name: string): string => {
    const value = formData.get(name);
    return typeof value === 'string' ? value : '';
  };
  return {
    autoUpdate: flag('autoUpdate'),
    channel: text('channel') || 'stable',
    autoUpdateKernel: flag('autoUpdateKernel'),
    windowEnabled: flag('windowEnabled'),
    windowStart: text('windowStart'),
    windowEnd: text('windowEnd'),
    excluded: text('excluded'),
    pinned: text('pinned'),
    allowPermissionIncrease: flag('allowPermissionIncrease'),
    allowIrreversibleMigration: flag('allowIrreversibleMigration'),
  };
}
