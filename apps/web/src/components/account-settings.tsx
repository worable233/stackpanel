'use client';

import { useActionState, useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bot, Palette, ShieldCheck, UserRound, Plug, ArrowUpRight, Bell } from 'lucide-react';
import { SectionTitle } from '@stackpanel/ui';
import type { User } from '@stackpanel/sdk';
import { toast } from '@/components/ui/toast';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { kernelAssetUrl } from '@/lib/kernel-asset-url';
import { SettingsSections, SettingsSelect } from '@/components/settings-sections';
import { useTheme } from '@/components/theme-provider';
import { NotificationPreferencesSettings } from '@/components/notification-settings';
import { useTranslator } from '@/i18n/provider';
import { useLocale } from '@/i18n/provider';
import { localeOptions } from '@/i18n/core';
import { setLocaleAction } from '@/i18n/actions';
import { agentFetch } from '@/components/agent-workspace';
import { changeEmailAction, changePasswordAction } from '@/lib/actions';
import type { CaptchaActionConfig } from '@/lib/captcha';
import { CaptchaField } from '@/components/captcha-field';
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
  captcha = {},
}: {
  user: User;
  emailVerificationRequired: boolean;
  identities: Identity[] | null;
  agentEnabled: boolean;
  apiKeys: React.ReactNode;
  /**
   * Widget config per guarded action. Absent keys mean that action is not
   * guarded, which is the normal case for a deployment without a captcha
   * provider — every dialog then renders exactly as before.
   */
  captcha?: Partial<Record<'change_password' | 'change_email' | 'api_token_create', CaptchaActionConfig>>;
}) {
  const t = useTranslator();
  const sections = [
    {
      id: 'profile',
      title: t('account.settings.sections.profile'),
      Icon: UserRound,
      content: (
        <ProfileSettings
          user={user}
          emailVerificationRequired={emailVerificationRequired}
          captcha={captcha}
        />
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
  captcha,
}: {
  user: User;
  emailVerificationRequired: boolean;
  captcha: Partial<Record<'change_password' | 'change_email', CaptchaActionConfig>>;
}) {
  const t = useTranslator();
  const locale = useLocale();
  const date = (value: string | null) =>
    value ? new Date(value).toLocaleString(locale) : t('account.settings.profile.none');
  return (
    <section className="flex flex-col gap-6">
      <Heading>{t('account.settings.sections.profile')}</Heading>
      <AvatarUpload user={user} />
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
          <FieldLabel htmlFor="settings-user-id">{t('account.settings.profile.accountId')}</FieldLabel>
          <Input id="settings-user-id" value={user.id} readOnly />
          <FieldDescription>{t('account.settings.profile.accountIdHint')}</FieldDescription>
        </Field>
      </FieldGroup>
      <div className="flex flex-col gap-4 border-t pt-5">
        <SectionTitle>{t('account.settings.profile.securityTitle')}</SectionTitle>
        <p className="text-sm text-muted-foreground">{t('account.settings.profile.securityHint')}</p>
        <div className="flex flex-wrap gap-2">
          <ChangeEmailForm
            currentEmail={user.email}
            captcha={captcha.change_email ?? null}
          />
          <ChangePasswordForm captcha={captcha.change_password ?? null} />
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

/**
 * Avatar upload/replace/remove.
 *
 * The picture is posted to the same-origin BFF (`/api/account/avatar`), which
 * forwards the bytes with the cookie's session token. The API stores it as a
 * media attachment, so what comes back is a revisioned `/media/:id/content` URL —
 * re-uploading therefore yields a *different* URL, and no cache keeps showing the
 * previous face.
 */
function AvatarUpload({ user }: { user: User }) {
  const t = useTranslator();
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initial = (user.email.charAt(0) || '?').toUpperCase();

  const errorKey = (code: unknown): string => {
    switch (code) {
      case 'avatarRoute.imageTooLarge':
      case 'media.too_large':
        return 'account.settings.profile.avatarTooLarge';
      case 'avatarRoute.unsupportedImage':
      case 'media.unsupported_type':
        return 'account.settings.profile.avatarUnsupported';
      default:
        return 'account.settings.profile.avatarFailed';
    }
  };

  const send = async (file?: File) => {
    setBusy(true);
    setError(null);
    try {
      const response = file
        ? await fetch('/api/account/avatar', {
            method: 'POST',
            headers: { 'content-type': file.type },
            body: file,
          })
        : await fetch('/api/account/avatar', { method: 'DELETE' });
      const data = (await response.json().catch(() => ({}))) as { code?: string };
      if (!response.ok) {
        setError(t(errorKey(data.code)));
        return;
      }
      toast.success(
        file
          ? t('account.settings.profile.avatarUpdated')
          : t('account.settings.profile.avatarRemoved'),
      );
      router.refresh();
    } catch {
      setError(t('account.settings.profile.avatarFailed'));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
      setBusy(false);
    }
  };

  return (
    <Field data-invalid={Boolean(error)}>
      <FieldLabel>{t('account.settings.profile.avatar')}</FieldLabel>
      <div className="flex items-center gap-4">
        <Avatar size="lg">
          {user.avatarUrl ? <AvatarImage src={kernelAssetUrl(user.avatarUrl)} alt="" /> : null}
          <AvatarFallback className="bg-muted text-sm font-medium text-foreground">
            {initial}
          </AvatarFallback>
        </Avatar>
        <div className="flex flex-wrap gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void send(file);
            }}
          />
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {user.avatarUrl
              ? t('account.settings.profile.avatarChange')
              : t('account.settings.profile.avatarUpload')}
          </Button>
          {user.avatarUrl ? (
            <Button type="button" variant="ghost" disabled={busy} onClick={() => void send()}>
              {t('account.settings.profile.avatarRemove')}
            </Button>
          ) : null}
        </div>
      </div>
      <FieldDescription>{t('account.settings.profile.avatarHint')}</FieldDescription>
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}

function ChangeEmailForm({
  currentEmail,
  captcha,
}: {
  currentEmail: string;
  captcha: CaptchaActionConfig | null;
}) {
  const t = useTranslator();
  const [state, action, pending] = useActionState(changeEmailAction, {});
  const [open, setOpen] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>{t('account.settings.profile.changeEmail')}</Button>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('account.settings.profile.changeEmail')}</DialogTitle><DialogDescription>{t('account.settings.profile.changeEmailHint')}</DialogDescription></DialogHeader>
        <form action={action} className="flex flex-col gap-4">
          <Field><FieldLabel htmlFor="change-email">{t('account.settings.profile.newEmail')}</FieldLabel><Input id="change-email" name="email" type="email" defaultValue={currentEmail} required /></Field>
          <Field><FieldLabel htmlFor="change-email-password">{t('account.settings.profile.currentPassword')}</FieldLabel><Input id="change-email-password" name="currentPassword" type="password" autoComplete="current-password" required /></Field>
          {captchaToken ? <input type="hidden" name="captchaToken" value={captchaToken} /> : null}
          <CaptchaField config={captcha?.clientConfig ?? null} onToken={setCaptchaToken} />
          {state.error && <FieldError>{state.error}</FieldError>}
          {state.ok && <p className="text-sm text-muted-foreground">{t('account.settings.profile.saved')}</p>}
          <DialogFooter><Button type="submit" disabled={pending}>{pending ? t('account.settings.saving') : t('account.settings.profile.save')}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ChangePasswordForm({ captcha }: { captcha: CaptchaActionConfig | null }) {
  const t = useTranslator();
  const [state, action, pending] = useActionState(changePasswordAction, {});
  const [open, setOpen] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>{t('account.settings.profile.changePassword')}</Button>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('account.settings.profile.changePassword')}</DialogTitle><DialogDescription>{t('account.settings.profile.changePasswordHint')}</DialogDescription></DialogHeader>
        <form action={action} className="flex flex-col gap-4">
          <Field><FieldLabel htmlFor="current-password">{t('account.settings.profile.currentPassword')}</FieldLabel><Input id="current-password" name="currentPassword" type="password" autoComplete="current-password" required /></Field>
          <Field><FieldLabel htmlFor="new-password">{t('account.settings.profile.newPassword')}</FieldLabel><Input id="new-password" name="newPassword" type="password" autoComplete="new-password" minLength={8} required /></Field>
          {captchaToken ? <input type="hidden" name="captchaToken" value={captchaToken} /> : null}
          <CaptchaField config={captcha?.clientConfig ?? null} onToken={setCaptchaToken} />
          {state.error && <FieldError>{state.error}</FieldError>}
          {state.ok && <p className="text-sm text-muted-foreground">{t('account.settings.profile.passwordSaved')}</p>}
          <DialogFooter><Button type="submit" disabled={pending}>{pending ? t('account.settings.saving') : t('account.settings.profile.save')}</Button></DialogFooter>
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
      <p role="status" className="text-sm text-muted-foreground">
        {pending
          ? t('account.settings.appearance.switching')
          : t('account.settings.appearance.autosave')}
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
        <p role="status" className="text-sm text-muted-foreground">
          {t('account.settings.agent.loading')}
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
      className="flex flex-col gap-4 pb-6"
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
