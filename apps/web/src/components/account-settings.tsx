'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bot, Palette, ShieldCheck, UserRound, Plug, ArrowUpRight, Bell } from 'lucide-react';
import { SectionTitle } from '@stackpanel/ui';
import type { User } from '@stackpanel/sdk';
import { toast } from 'sonner';
import { SettingsSections, SettingsSelect } from '@/components/settings-sections';
import { useTheme } from '@/components/theme-provider';
import { NotificationPreferencesSettings } from '@/components/notification-settings';
import { useTranslator } from '@/i18n/provider';
import { useLocale } from '@/i18n/provider';
import { localeOptions } from '@/i18n/core';
import { setLocaleAction } from '@/i18n/actions';
import { agentFetch } from '@/components/agent-workspace';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, FieldDescription, FieldGroup, FieldError } from '@/components/ui/field';
import { Label as FieldLabel } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

type Identity = {
  id: string;
  providerId: string;
  email: string | null;
  displayName: string | null;
  createdAt: string;
};

export function AccountSettings({
  user,
  identities,
  agentEnabled,
  apiKeys,
}: {
  user: User;
  identities: Identity[] | null;
  agentEnabled: boolean;
  apiKeys: React.ReactNode;
}) {
  const t = useTranslator();
  const sections = [
    { id: 'profile', title: '账户信息', Icon: UserRound, content: <ProfileSettings user={user} /> },
    { id: 'appearance', title: '外观与语言', Icon: Palette, content: <AppearanceSettings /> },
    {
      id: 'security',
      title: '访问凭证',
      Icon: ShieldCheck,
      content: <AccessSettings identities={identities} apiKeys={apiKeys} />,
    },
    {
      id: 'notifications',
      title: t('notificationSettings.preferences'),
      Icon: Bell,
      content: <NotificationPreferencesSettings />,
    },
    ...(agentEnabled
      ? [{ id: 'agent', title: 'Agent', Icon: Bot, content: <PersonalAgentSettings /> }]
      : []),
  ];
  return <SettingsSections sections={sections} label="账户设置" />;
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b pb-4">
      <SectionTitle>{children}</SectionTitle>
    </div>
  );
}

function ProfileSettings({ user }: { user: User }) {
  const locale = useLocale();
  const date = (value: string | null) =>
    value ? new Date(value).toLocaleString(locale) : '暂无记录';
  return (
    <section className="flex flex-col gap-6">
      <Heading>账户信息</Heading>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="settings-email">登录邮箱</FieldLabel>
          <Input id="settings-email" value={user.email} readOnly />
          <FieldDescription>
            {user.emailVerifiedAt ? '邮箱已验证。' : '邮箱尚未验证。'}
            如需更换登录邮箱，请联系管理员。
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="settings-user-id">账户 ID</FieldLabel>
          <Input id="settings-user-id" value={user.id} readOnly />
          <FieldDescription>联系支持人员时，可提供此 ID 协助定位账户。</FieldDescription>
        </Field>
      </FieldGroup>
      <dl className="flex flex-col gap-4 text-sm">
        <div className="flex items-center justify-between gap-4">
          <dt className="text-muted-foreground">账户状态</dt>
          <dd>
            <Badge variant="secondary">{user.status === 'ACTIVE' ? '正常' : '已停用'}</Badge>
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">注册时间</dt>
          <dd className="text-right tabular-nums">{date(user.createdAt)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">最近登录</dt>
          <dd className="text-right tabular-nums">{date(user.lastLoginAt)}</dd>
        </div>
      </dl>
    </section>
  );
}

function AppearanceSettings() {
  const { theme, setTheme } = useTheme();
  const locale = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  return (
    <section className="flex flex-col gap-6">
      <Heading>外观与语言</Heading>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="settings-theme">界面主题</FieldLabel>
          <SettingsSelect
            id="settings-theme"
            value={theme}
            options={[
              ['system', '跟随系统'],
              ['light', '浅色'],
              ['dark', '深色'],
            ]}
            onChange={(value) => {
              if (value === 'light' || value === 'dark' || value === 'system') setTheme(value);
            }}
          />
          <FieldDescription>立即应用，保存在当前浏览器中。</FieldDescription>
        </Field>
        <Field data-invalid={Boolean(error)}>
          <FieldLabel htmlFor="settings-language">显示语言</FieldLabel>
          <SettingsSelect
            id="settings-language"
            value={locale}
            disabled={pending}
            options={localeOptions().map(({ value, label }) => [value, label])}
            onChange={(value) =>
              startTransition(async () => {
                setError('');
                try {
                  await setLocaleAction(value);
                  document.documentElement.lang = value;
                  router.refresh();
                } catch {
                  setError('语言设置未保存，请重试。');
                }
              })
            }
          />
          <FieldDescription>切换本站支持的界面语言，保存在当前浏览器中。</FieldDescription>
          {error && <FieldError>{error}</FieldError>}
        </Field>
      </FieldGroup>
      <p role="status" className="text-sm text-muted-foreground">
        {pending ? '正在切换语言…' : '更改自动保存，无需再次提交。'}
      </p>
    </section>
  );
}

function AccessSettings({
  identities,
  apiKeys,
}: {
  identities: Identity[] | null;
  apiKeys: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-6">
      <Heading>访问凭证</Heading>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <SectionTitle>API 密钥</SectionTitle>
          <p className="text-sm text-muted-foreground">
            管理应用和 Agent 使用的权限密钥，可按用途创建或撤销。
          </p>
        </div>
        {apiKeys}
      </div>
      <Separator />
      <SectionTitle>已绑定的登录方式</SectionTitle>
      {identities === null ? (
        <FieldError>暂时无法读取登录方式，请刷新后重试。</FieldError>
      ) : identities.length ? (
        <ul className="flex flex-col divide-y">
          {identities.map((identity) => (
            <li
              key={identity.id}
              className="flex items-center justify-between gap-4 py-4 first:pt-0"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <p className="truncate text-sm font-medium">
                  {identity.displayName ?? identity.providerId}
                </p>
                <p className="truncate text-sm text-muted-foreground">
                  {identity.email ?? identity.providerId}
                </p>
              </div>
              <Badge variant="secondary">已绑定</Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-8 text-center text-sm text-muted-foreground">暂无绑定</p>
      )}
    </section>
  );
}

type ToolServer = { id: string; name: string; credentialConfigured: boolean };

function PersonalAgentSettings() {
  const [servers, setServers] = useState<ToolServer[]>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    void agentFetch<{ servers: ToolServer[] }>('mcp-servers')
      .then((result) => {
        if (active) {
          setServers(result.servers);
          setError('');
        }
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : '加载失败');
      });
    return () => {
      active = false;
    };
  }, [retry]);
  return (
    <section className="flex flex-col gap-6">
      <Heading>Agent</Heading>
      <div className="flex items-center justify-between gap-4">
        <SectionTitle>工具授权</SectionTitle>
        <Button variant="ghost" size="sm" render={<Link href="/account/agent" />}>
          任务记录
          <ArrowUpRight data-icon="inline-end" />
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        为可用的外部工具配置个人访问凭证。凭证加密保存在服务器中，保存后不会回显。
      </p>
      {error ? (
        <div className="flex items-center justify-between gap-3">
          <FieldError>{error}</FieldError>
          <Button variant="outline" onClick={() => setRetry((v) => v + 1)}>
            重试
          </Button>
        </div>
      ) : !servers ? (
        <p role="status" className="text-sm text-muted-foreground">
          加载中…
        </p>
      ) : servers.length ? (
        <div className="flex flex-col gap-6">
          {servers.map((server) => (
            <ToolCredential
              key={server.id}
              server={server}
              onChange={(configured) =>
                setServers((rows) =>
                  rows?.map((row) =>
                    row.id === server.id ? { ...row, credentialConfigured: configured } : row,
                  ),
                )
              }
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
          <Plug className="size-6 opacity-50" />
          <p className="text-sm">暂无可用工具</p>
        </div>
      )}
    </section>
  );
}

function ToolCredential({
  server,
  onChange,
}: {
  server: ToolServer;
  onChange: (configured: boolean) => void;
}) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  async function save(remove = false) {
    setBusy(true);
    setError('');
    try {
      await agentFetch(
        `mcp-servers/${server.id}/credential`,
        remove ? 'DELETE' : 'PUT',
        remove ? undefined : { token },
      );
      setToken('');
      onChange(!remove);
      setConfirm(false);
      toast.success(remove ? '授权已移除' : '凭证已保存');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="flex flex-col gap-4 border-b pb-6 last:border-0"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{server.name}</h3>
        <Badge variant={server.credentialConfigured ? 'secondary' : 'outline'}>
          {server.credentialConfigured ? '已授权' : '未授权'}
        </Badge>
      </div>
      <Field data-invalid={Boolean(error)}>
        <FieldLabel htmlFor={`tool-${server.id}`}>访问凭证</FieldLabel>
        <Input
          id={`tool-${server.id}`}
          type="password"
          autoComplete="new-password"
          value={token}
          maxLength={8192}
          required
          disabled={busy}
          placeholder={
            server.credentialConfigured ? '输入新凭证以替换现有凭证' : '填写该服务的访问令牌'
          }
          onChange={(event) => setToken(event.target.value)}
        />
        {error && <FieldError role="alert">{error}</FieldError>}
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !token.trim()}>{busy ? '处理中…' : '保存凭证'}</Button>
        {server.credentialConfigured && (
          <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirm(true)}>
            移除授权
          </Button>
        )}
      </div>
      <Dialog open={confirm} onOpenChange={(open) => !busy && setConfirm(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>移除工具授权？</DialogTitle>
            <DialogDescription>
              将删除 {server.name} 的个人凭证。重新保存凭证后才能继续使用此工具。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirm(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void save(true)}
            >
              {busy ? '处理中…' : '移除授权'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
}
