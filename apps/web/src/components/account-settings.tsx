'use client';

import { useActionState, useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bot, Palette, ShieldCheck, UserRound, Plug, ArrowUpRight, Bell } from 'lucide-react';
import { InlineNotice, SectionTitle } from '@stackpanel/ui';
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
import { changeEmailAction, changePasswordAction } from '@/lib/actions';
import type { AccountMutationState } from '@/lib/actions';
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
  emailVerificationRequired,
  identities,
  agentEnabled,
  apiKeys,
}: {
  user: User;
  emailVerificationRequired: boolean;
  identities: Identity[] | null;
  agentEnabled: boolean;
  apiKeys: React.ReactNode;
}) {
  const t = useTranslator();
  const sections = [
    {
      id: 'profile',
      title: t('account.settings.sections.profile'),
      Icon: UserRound,
      content: (
        <ProfileSettings user={user} emailVerificationRequired={emailVerificationRequired} />
      ),
    },
    {
      id: 'appearance',
      title: t('account.settings.sections.appearance'),
      Icon: Palette,
      content: <AppearanceSettings />,
    },
    {
      id: 'security',
      title: t('account.settings.sections.access'),
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
      ? [
          {
            id: 'agent',
            title: t('account.settings.sections.agent'),
            Icon: Bot,
            content: <PersonalAgentSettings />,
          },
        ]
      : []),
  ];
  return <SettingsSections sections={sections} label={t('account.settings.label')} />;
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b pb-4">
      <SectionTitle>{children}</SectionTitle>
    </div>
  );
}

function ProfileSettings({
  user,
  emailVerificationRequired,
}: {
  user: User;
  emailVerificationRequired: boolean;
}) {
  const t = useTranslator();
  const locale = useLocale();
  const date = (value: string | null) =>
    value ? new Date(value).toLocaleString(locale) : t('account.settings.profile.none');
  return (
    <section className="flex flex-col gap-6">
      <Heading>{t('account.settings.sections.profile')}</Heading>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="settings-email">
            {t('account.settings.profile.loginEmail')}
          </FieldLabel>
          <Input id="settings-email" value={user.email} readOnly />
          <FieldDescription>
            {emailVerificationRequired
              ? user.emailVerifiedAt
                ? t('account.settings.profile.emailVerified')
                : t('account.settings.profile.emailUnverified')
              : t('account.settings.profile.emailVerificationOff')}
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="settings-user-id">
            {t('account.settings.profile.accountId')}
          </FieldLabel>
          <Input id="settings-user-id" value={user.id} readOnly />
          <FieldDescription>{t('account.settings.profile.accountIdHint')}</FieldDescription>
        </Field>
      </FieldGroup>
      <div className="flex flex-col gap-4 border-t pt-5">
        <SectionTitle>{t('account.settings.profile.securityTitle')}</SectionTitle>
        <p className="text-sm text-muted-foreground">
          {t('account.settings.profile.securityHint')}
        </p>
        <div className="flex flex-wrap gap-2">
          <ChangeEmailForm currentEmail={user.email} />
          <ChangePasswordForm />
        </div>
      </div>
      <dl className="flex flex-col gap-4 text-sm">
        <div className="flex items-center justify-between gap-4">
          <dt className="text-muted-foreground">{t('account.settings.profile.status')}</dt>
          <dd>
            <Badge variant="secondary">
              {user.status === 'ACTIVE'
                ? t('account.settings.profile.statusActive')
                : t('account.settings.profile.statusDisabled')}
            </Badge>
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">{t('account.settings.profile.createdAt')}</dt>
          <dd className="text-right tabular-nums">{date(user.createdAt)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">{t('account.settings.profile.lastLoginAt')}</dt>
          <dd className="text-right tabular-nums">{date(user.lastLoginAt)}</dd>
        </div>
      </dl>
    </section>
  );
}

function ChangeEmailForm({ currentEmail }: { currentEmail: string }) {
  const t = useTranslator();
  const [open, setOpen] = useState(false);
  // 回执走系统通知（toast），失败仍在对话框里内联；不在 effect 里 setState。
  const [state, action, pending] = useActionState<AccountMutationState, FormData>(
    async (previous, formData) => {
      const result = await changeEmailAction(previous, formData);
      if (result.ok) {
        toast.success(t('account.settings.profile.saved'));
        setOpen(false);
      }
      return result;
    },
    {},
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        {t('account.settings.profile.changeEmail')}
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('account.settings.profile.changeEmail')}</DialogTitle>
          <DialogDescription>{t('account.settings.profile.changeEmailHint')}</DialogDescription>
        </DialogHeader>
        <form action={action} className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="change-email">{t('account.settings.profile.newEmail')}</FieldLabel>
            <Input
              id="change-email"
              name="email"
              type="email"
              defaultValue={currentEmail}
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="change-email-password">
              {t('account.settings.profile.currentPassword')}
            </FieldLabel>
            <Input
              id="change-email-password"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
            />
          </Field>
          {state.error && <FieldError>{state.error}</FieldError>}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? t('account.settings.saving') : t('account.settings.profile.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ChangePasswordForm() {
  const t = useTranslator();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<AccountMutationState, FormData>(
    async (previous, formData) => {
      const result = await changePasswordAction(previous, formData);
      if (result.ok) {
        toast.success(t('account.settings.profile.passwordSaved'));
        setOpen(false);
      }
      return result;
    },
    {},
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        {t('account.settings.profile.changePassword')}
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('account.settings.profile.changePassword')}</DialogTitle>
          <DialogDescription>{t('account.settings.profile.changePasswordHint')}</DialogDescription>
        </DialogHeader>
        <form action={action} className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="current-password">
              {t('account.settings.profile.currentPassword')}
            </FieldLabel>
            <Input
              id="current-password"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="new-password">
              {t('account.settings.profile.newPassword')}
            </FieldLabel>
            <Input
              id="new-password"
              name="newPassword"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
            />
          </Field>
          {state.error && <FieldError>{state.error}</FieldError>}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? t('account.settings.saving') : t('account.settings.profile.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AppearanceSettings() {
  const t = useTranslator();
  const { theme, setTheme } = useTheme();
  const locale = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  return (
    <section className="flex flex-col gap-6">
      <Heading>{t('account.settings.sections.appearance')}</Heading>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="settings-theme">{t('account.settings.appearance.theme')}</FieldLabel>
          <SettingsSelect
            id="settings-theme"
            value={theme}
            options={[
              ['system', t('account.settings.appearance.themeSystem')],
              ['light', t('account.settings.appearance.themeLight')],
              ['dark', t('account.settings.appearance.themeDark')],
            ]}
            onChange={(value) => {
              if (value === 'light' || value === 'dark' || value === 'system') setTheme(value);
            }}
          />
          <FieldDescription>{t('account.settings.appearance.themeHint')}</FieldDescription>
        </Field>
        <Field data-invalid={Boolean(error)}>
          <FieldLabel htmlFor="settings-language">
            {t('account.settings.appearance.language')}
          </FieldLabel>
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
                  setError(t('account.settings.appearance.languageSaveFailed'));
                }
              })
            }
          />
          <FieldDescription>{t('account.settings.appearance.languageHint')}</FieldDescription>
          {error && <FieldError>{error}</FieldError>}
        </Field>
      </FieldGroup>
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
  const t = useTranslator();
  return (
    <section className="flex flex-col gap-6">
      <Heading>{t('account.settings.sections.access')}</Heading>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <SectionTitle>{t('account.settings.access.apiKeys')}</SectionTitle>
          <p className="text-sm text-muted-foreground">
            {t('account.settings.access.apiKeysHint')}
          </p>
        </div>
        {apiKeys}
      </div>
      <Separator />
      <SectionTitle>{t('account.settings.access.linkedMethods')}</SectionTitle>
      {identities === null ? (
        <FieldError>{t('account.settings.access.loadFailed')}</FieldError>
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
              <Badge variant="secondary">{t('account.settings.access.bound')}</Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {t('account.settings.access.empty')}
        </p>
      )}
    </section>
  );
}

type ToolServer = { id: string; name: string; credentialConfigured: boolean };

function PersonalAgentSettings() {
  const t = useTranslator();
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
        console.error('[account-settings] agent tools load failed', cause);
        if (active) setError(t('account.settings.agent.loadFailed'));
      });
    return () => {
      active = false;
    };
  }, [retry, t]);
  return (
    <section className="flex flex-col gap-6">
      <Heading>{t('account.settings.sections.agent')}</Heading>
      <div className="flex items-center justify-between gap-4">
        <SectionTitle>{t('account.settings.agent.toolsTitle')}</SectionTitle>
        <Button variant="ghost" size="sm" render={<Link href="/account/agent" />}>
          {t('account.settings.agent.history')}
          <ArrowUpRight data-icon="inline-end" />
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{t('account.settings.agent.toolsHint')}</p>
      {error ? (
        <div className="flex items-center justify-between gap-3">
          <FieldError>{error}</FieldError>
          <Button variant="outline" onClick={() => setRetry((v) => v + 1)}>
            {t('account.settings.agent.retry')}
          </Button>
        </div>
      ) : !servers ? (
        <InlineNotice>{t('account.settings.agent.loading')}</InlineNotice>
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
          <p className="text-sm">{t('account.settings.agent.noTools')}</p>
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
  const t = useTranslator();
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
      toast.success(
        remove ? t('account.settings.agent.removed') : t('account.settings.agent.saved'),
      );
    } catch (cause) {
      console.error('[account-settings] agent tool save failed', cause);
      setError(t('account.settings.agent.saveFailed'));
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
          {server.credentialConfigured
            ? t('account.settings.agent.authorized')
            : t('account.settings.agent.unauthorized')}
        </Badge>
      </div>
      <Field data-invalid={Boolean(error)}>
        <FieldLabel htmlFor={`tool-${server.id}`}>
          {t('account.settings.agent.credential')}
        </FieldLabel>
        <Input
          id={`tool-${server.id}`}
          type="password"
          autoComplete="new-password"
          value={token}
          maxLength={8192}
          required
          disabled={busy}
          placeholder={
            server.credentialConfigured
              ? t('account.settings.agent.credentialReplace')
              : t('account.settings.agent.credentialPlaceholder')
          }
          onChange={(event) => setToken(event.target.value)}
        />
        {error && <FieldError role="alert">{error}</FieldError>}
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !token.trim()}>
          {busy ? t('account.settings.agent.saving') : t('account.settings.agent.save')}
        </Button>
        {server.credentialConfigured && (
          <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirm(true)}>
            {t('account.settings.agent.remove')}
          </Button>
        )}
      </div>
      <Dialog open={confirm} onOpenChange={(open) => !busy && setConfirm(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('account.settings.agent.removeTitle')}</DialogTitle>
            <DialogDescription>
              {t('account.settings.agent.removeDescription', { name: server.name })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirm(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void save(true)}
            >
              {busy ? t('account.settings.agent.saving') : t('account.settings.agent.remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
}
