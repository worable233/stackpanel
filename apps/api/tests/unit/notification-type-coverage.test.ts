import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { NotificationTypeDefinition } from '@stackpanel/sdk';
import {
  BUILTIN_NOTIFICATION_TYPES,
  KernelNotificationPolicyService,
} from '../../src/notifications/policy-service.ts';
import { STORE_NOTIFICATION_TYPES } from '../../../../packages/plugins/store/src/notifications.ts';
import { LOGIN_NOTIFICATION_TYPES } from '../../../../packages/plugins/login/src/index.ts';

/**
 * 「发出即声明」守门测试。
 *
 * 目录驱动偏好系统的核心约束：**每一个会真正写进通知表的类型，都必须在某个
 * 目录条目里声明**，否则它在用户设置里不可见、无法关闭。这条约束靠人工评审
 * 很容易漏（新增一个 `notifications.create` 却忘了注册类型），因此这里直接
 * 扫描发出点源码里的类型字面量，与内核内建目录 + 各插件声明做交叉校验。
 *
 * 扫描范围是**本仓库**内核与内置插件；外部插件（ticket/invoice/llm-gateway 等）
 * 在各自仓库里用同样的方式自检。运行时还有 `KernelNotificationsService` 的
 * 开发期告警兜底（见 `guardDeclared`）。
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');

/** 内核里会写通知的文件（新增发出点时应加到这里）。 */
const KERNEL_EMITTERS = [
  'apps/api/src/payments/payments-service.ts',
  'apps/api/src/lib/user-admin.ts',
  'apps/api/src/routes/auth-oauth.ts',
  'apps/api/src/routes/admin/updates.ts',
  'apps/api/src/notifications/lifecycle-notifications.ts',
  'apps/api/src/notifications/agent-notifications.ts',
  'apps/api/src/routes/agent.ts',
  'apps/api/src/agent/background.ts',
];

/** 会写通知的内置插件源码（相对仓库根）。 */
const PLUGIN_EMITTERS = [
  'packages/plugins/store/src/operations.ts',
  'packages/plugins/store/src/orders.ts',
  'packages/plugins/store/src/changes.ts',
  'packages/plugins/store/src/fulfillment.ts',
  'packages/plugins/store/src/expiry.ts',
  'packages/plugins/store/src/refund.ts',
  'packages/plugins/store/src/renewal.ts',
  'packages/plugins/store/src/unpaid-reminder.ts',
  'packages/plugins/store-wallet/src/notifications.ts',
  'packages/plugins/market/src/index.ts',
];

/**
 * 匹配 `type: 'a.b.c'` 形式的字面量。模板字符串（市场插件的
 * `system.${kind}.${action}`）天生落在通配目录里，这里不参与匹配。
 */
function emittedTypes(file: string): string[] {
  const source = readFileSync(join(repoRoot, file), 'utf8');
  const found = new Set<string>();
  for (const match of source.matchAll(/\btype:\s*'([a-z][a-z0-9]*(?:[.-][a-z0-9]+)+)'/g)) {
    if (match[1]) found.add(match[1]);
  }
  return [...found];
}

function declarations(): NotificationTypeDefinition[] {
  return [
    ...BUILTIN_NOTIFICATION_TYPES,
    ...(STORE_NOTIFICATION_TYPES as readonly NotificationTypeDefinition[]),
    ...(LOGIN_NOTIFICATION_TYPES as readonly NotificationTypeDefinition[]),
  ];
}

function policy() {
  return new KernelNotificationPolicyService({
    db: {} as never,
    getChannels: () => [],
    getTypeDefinitions: () => declarations(),
    logger: { warn: () => {} },
  });
}

describe('notification type coverage', () => {
  const declared = declarations();

  it('declares every kernel-emitted type', () => {
    const service = policy();
    const missing: string[] = [];
    for (const file of KERNEL_EMITTERS) {
      for (const type of emittedTypes(file)) {
        if (!service.declares(type)) missing.push(`${type} (${file})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('declares every built-in plugin-emitted type', () => {
    const service = policy();
    const missing: string[] = [];
    for (const file of PLUGIN_EMITTERS) {
      for (const type of emittedTypes(file)) {
        if (!service.declares(type)) missing.push(`${type} (${file})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('never declares the same type twice across sources', () => {
    const seen = new Map<string, number>();
    for (const def of declared) seen.set(def.type, (seen.get(def.type) ?? 0) + 1);
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([type]) => type);
    expect(duplicates).toEqual([]);
  });
});
