'use client';

import { SectionTitle } from '@stackpanel/ui';
import type { AdminRuntimeConfigEntry } from '@stackpanel/sdk';
import { useActionState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslator } from '@/i18n/provider';
import { saveRuntimeConfigAction } from '@/lib/runtime-config-actions';
import type { SettingsActionState } from '@/lib/settings-actions';

/**
 * 运行期配置（ADR-0026）。
 *
 * 前提：**内核是唯一权威**。这里改的每一项都会写进 `Setting` 表，由所有副本通过
 * Redis 失效广播同步，因此"保存即生效"，不需要重启、也不需要在部署层改 `.env`。
 * 行标题直接显示环境变量名——它是技术标识符，不是待翻译的句子；取值域、默认值与
 * 校验都在内核（`envSchema` 同名字段），界面不重复实现。
 *
 * 插件服务端执行准入不在这里：它由插件清单的 `frontendExecutions` 声明、安装时由
 * 内核裁决（ADR-0024），属于包的可信度问题而不是运行期取值问题。
 */

const GROUP_ORDER = ['auth', 'session', 'media', 'openapi', 'plugins', 'audit', 'agent'] as const;

function sourceLabelKey(source: AdminRuntimeConfigEntry['source']): string {
  return `admin.settings.runtimeConfig.source.${source}`;
}

function RuntimeConfigRow({ entry }: { entry: AdminRuntimeConfigEntry }) {
  const t = useTranslator();
  const [state, action, pending] = useActionState<SettingsActionState, FormData>(
    saveRuntimeConfigAction,
    {},
  );
  // 布尔开关在环境变量里是 "true"/"false" 字符串，用下拉避免用户手打错。
  const isBoolean =
    typeof entry.value === 'boolean' || entry.value === 'true' || entry.value === 'false';
  const current =
    typeof entry.value === 'boolean' ? String(entry.value) : String(entry.value ?? '');

  return (
    <form
      action={action}
      className="flex flex-col gap-2 border-b border-border/60 py-3 last:border-b-0"
    >
      <input type="hidden" name="name" value={entry.name} />
      <div className="flex flex-wrap items-center gap-2">
        <code className="text-xs font-medium">{entry.name}</code>
        <Badge variant={entry.source === 'stored' ? 'default' : 'secondary'}>
          {t(sourceLabelKey(entry.source))}
        </Badge>
        {entry.source === 'stored' ? (
          <span className="text-xs text-muted-foreground">
            {t('admin.settings.runtimeConfig.envValue')}: {String(entry.envValue ?? '—')}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {isBoolean ? (
          <select
            name="value"
            defaultValue={current}
            className="h-9 rounded-md border border-input bg-muted/40 px-2 text-sm"
          >
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : (
          <Input name="value" defaultValue={current} className="h-9 w-full sm:w-64" />
        )}
        <Button type="submit" size="sm" disabled={pending}>
          {t('common.save')}
        </Button>
        {entry.source === 'stored' ? (
          <Button
            type="submit"
            name="op"
            value="clear"
            size="sm"
            variant="outline"
            disabled={pending}
            title={t('admin.settings.runtimeConfig.revertHint')}
          >
            {t('admin.settings.runtimeConfig.revert')}
          </Button>
        ) : null}
        {state.ok && state.message ? (
          <span className="text-xs text-muted-foreground">{state.message}</span>
        ) : null}
        {state.error ? <span className="text-xs text-destructive">{state.error}</span> : null}
      </div>
    </form>
  );
}

export function RuntimeConfigSettings({ entries }: { entries: AdminRuntimeConfigEntry[] }) {
  const t = useTranslator();

  return (
    <>
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <SectionTitle>{t('admin.settings.runtimeConfig.title')}</SectionTitle>
          <p className="text-sm text-muted-foreground">
            {t('admin.settings.runtimeConfig.description')}
          </p>
        </div>
        {GROUP_ORDER.filter((group) => entries.some((entry) => entry.group === group)).map(
          (group) => (
            <div key={group} className="flex flex-col">
              <h3 className="text-sm font-medium">
                {t(`admin.settings.runtimeConfig.group.${group}`)}
              </h3>
              <div className="mt-1 flex flex-col">
                {entries
                  .filter((entry) => entry.group === group)
                  .map((entry) => (
                    <RuntimeConfigRow key={entry.name} entry={entry} />
                  ))}
              </div>
            </div>
          ),
        )}
      </section>
    </>
  );
}
