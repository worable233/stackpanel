'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Bell, CircleAlert, LockKeyhole } from 'lucide-react';
import type {
  NotificationPolicyPatch,
  NotificationPolicyView,
  NotificationPreferencesView,
  NotificationTypePolicy,
  NotificationTypePreference,
} from '@stackpanel/sdk';
import type { z } from 'zod';
import { toast } from 'sonner';
import { SectionTitle } from '@stackpanel/ui';
import { useTranslator } from '@/i18n/provider';
import {
  notificationPolicySchema,
  notificationPreferencesSchema,
} from '@/lib/notification-preferences-schema';
import { NOTIFICATION_READ_EVENT } from '@/lib/use-visible-notification-read';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Label, Label as FieldLabel } from '@/components/ui/label';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldSet,
  FieldLegend,
} from '@/components/ui/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';

type View = NotificationPolicyView | NotificationPreferencesView;

/** Serialize writes: each response is a complete view, so overlapping writes could overwrite newer UI. */
function useNotificationSettings<T extends View>(url: string, schema: z.ZodType<T>) {
  const t = useTranslator();
  const [view, setView] = useState<T>();
  const [error, setError] = useState('');
  const [status, setStatus] = useState<'loading' | 'saving' | 'saved' | 'idle'>('loading');
  const controller = useRef<AbortController | null>(null);
  const busy = useRef(false);

  const request = useCallback(
    async (target: string, method = 'GET', body?: unknown) => {
      const response = await fetch(target, {
        method,
        cache: 'no-store',
        signal: AbortSignal.any([
          ...(controller.current ? [controller.current.signal] : []),
          AbortSignal.timeout(15000),
        ]),
        ...(body !== undefined
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
          : {}),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error ?? t('notificationSettings.failed'));
      }
      const result = schema.safeParse(await response.json());
      if (!result.success) throw new Error(t('notificationSettings.unavailable'));
      return result.data;
    },
    [schema, t],
  );

  const load = useCallback(async () => {
    const signal = controller.current?.signal;
    try {
      const result = await request(url);
      if (!signal?.aborted) {
        setView(result);
        setError('');
        setStatus('idle');
      }
    } catch (cause) {
      if (!signal?.aborted) {
        console.error('[notification-settings] load failed', cause);
        setError(t('notificationSettings.unavailable'));
        setStatus('idle');
      }
    }
  }, [request, url, t]);

  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    void request(url)
      .then((result) => {
        if (!abort.signal.aborted) {
          setView(result);
          setStatus('idle');
        }
      })
      .catch((cause) => {
        if (!abort.signal.aborted) {
          console.error('[notification-settings] load failed', cause);
          setError(t('notificationSettings.unavailable'));
          setStatus('idle');
        }
      });
    return () => abort.abort();
  }, [request, url, t]);

  async function save(method: string, body: unknown, target = url) {
    if (busy.current) return false;
    busy.current = true;
    const signal = controller.current?.signal;
    setStatus('saving');
    setError('');
    try {
      const result = await request(target, method, body);
      if (signal?.aborted) return false;
      setView(result);
      setStatus('saved');
      window.dispatchEvent(new Event(NOTIFICATION_READ_EVENT));
      return true;
    } catch (cause) {
      if (!signal?.aborted) {
        console.error('[notification-settings] save failed', cause);
        // One channel only: the toast carries the failure, the panel keeps its
        // previous (valid) state instead of showing a stale inline error too.
        toast.error(t('notificationSettings.failed'));
        setStatus('idle');
      }
      return false;
    } finally {
      busy.current = false;
    }
  }
  return {
    view,
    error,
    status,
    load: () => {
      setStatus('loading');
      setError('');
      return load();
    },
    save,
  };
}

function SettingsPanel({
  title,
  state,
  actions,
  children,
}: {
  title: string;
  state: ReturnType<typeof useNotificationSettings>;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const t = useTranslator();
  return (
    <section
      className="flex flex-col gap-6"
      aria-busy={state.status === 'loading' || state.status === 'saving'}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
        <SectionTitle>{title}</SectionTitle>
        <div className="flex flex-wrap items-center gap-3">
          {' '}
          {state.view && state.view.types.length > 0 && (
            <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
              {state.status === 'saving'
                ? t('notificationSettings.saving')
                : state.status === 'saved'
                  ? t('notificationSettings.saved')
                  : t('notificationSettings.autosave')}
            </p>
          )}
          {actions}
        </div>
      </div>
      {state.error && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{state.error}</AlertDescription>
          {!state.view && (
            <Button
              variant="outline"
              size="sm"
              className="mt-3 w-fit"
              onClick={() => void state.load()}
            >
              {t('notificationSettings.retry')}
            </Button>
          )}
        </Alert>
      )}
      {state.status === 'loading' && !state.view ? (
        <div
          className="flex flex-col gap-6"
          role="status"
          aria-label={t('notificationSettings.loading')}
        >
          {[0, 1, 2].map((key) => (
            <div key={key} className="flex flex-col gap-3">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-12 w-full" />
            </div>
          ))}
        </div>
      ) : state.view?.types.length === 0 ? (
        <Empty className="py-12">
          <EmptyHeader>
            <EmptyMedia>
              <Bell className="size-6 text-muted-foreground opacity-50" />
            </EmptyMedia>
            <EmptyTitle>{t('notificationSettings.empty')}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : state.view ? (
        children
      ) : null}
    </section>
  );
}

/** Keep backend ordering and include types from future categories without hardcoded plugin lists. */
function groups(view: View) {
  const categories = [...view.categories];
  for (const row of view.types) {
    if (!categories.some(({ id }) => id === row.category))
      categories.push({ id: row.category, label: row.category });
  }
  return categories.filter(({ id }) => view.types.some((row) => row.category === id));
}

export function NotificationPreferencesSettings() {
  const t = useTranslator();
  const state = useNotificationSettings(
    '/api/notifications/preferences',
    notificationPreferencesSchema,
  );
  const [confirm, setConfirm] = useState(false);
  const disabled = state.status === 'saving' || state.status === 'loading';
  const view = state.view;
  return (
    <SettingsPanel
      title={t('notificationSettings.preferences')}
      state={state}
      actions={
        view &&
        view.types.some((row) => row.configurable) && (
          <Button variant="outline" size="sm" disabled={disabled} onClick={() => setConfirm(true)}>
            {t('notificationSettings.reset')}
          </Button>
        )
      }
    >
      <p className="text-sm text-muted-foreground">{t('notificationSettings.userHelp')}</p>
      {view &&
        groups(view).map((category) => (
          <section key={category.id} className="flex flex-col gap-4" aria-label={category.label}>
            <SectionTitle>{category.label}</SectionTitle>
            <div className="flex flex-col divide-y">
              {view.types
                .filter((row) => row.category === category.id)
                .map((row) => (
                  <UserPreferenceRow
                    key={row.type}
                    row={row}
                    view={view}
                    disabled={disabled}
                    onChange={(channelId, enabled) =>
                      void state.save('PATCH', { items: [{ type: row.type, channelId, enabled }] })
                    }
                  />
                ))}
            </div>
          </section>
        ))}
      <AlertDialog open={confirm} onOpenChange={(open) => !disabled && setConfirm(open)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('notificationSettings.resetTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('notificationSettings.resetDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disabled}>
              {t('notificationSettings.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={disabled}
              onClick={async () => {
                if (await state.save('POST', {}, '/api/notifications/preferences/reset'))
                  setConfirm(false);
              }}
            >
              {t('notificationSettings.reset')}
            </AlertDialogAction>
          </AlertDialogFooter>
          {state.error && (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </SettingsPanel>
  );
}

function UserPreferenceRow({
  row,
  view,
  disabled,
  onChange,
}: {
  row: NotificationTypePreference;
  view: NotificationPreferencesView;
  disabled: boolean;
  onChange: (id: string, enabled: boolean) => void;
}) {
  const t = useTranslator();
  return (
    <div className="flex flex-col gap-4 py-5 first:pt-0">
      <div className="flex flex-col gap-1">
        <h4 className="text-sm font-medium">{row.label}</h4>
        {row.description && <p className="text-sm text-muted-foreground">{row.description}</p>}
        {!row.configurable && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <LockKeyhole className="size-3" />
            {t('notificationSettings.managed')}
          </p>
        )}
      </div>
      <FieldGroup>
        {row.channels.map((channel) => {
          const name =
            view.channels.find(({ id }) => id === channel.channelId)?.name ?? channel.channelId;
          const id = `notification-${row.type}-${channel.channelId}`;
          const locked = !row.configurable || !channel.configurable;
          return (
            <Field
              key={channel.channelId}
              orientation="horizontal"
              data-disabled={disabled || locked}
            >
              <FieldContent>
                <FieldLabel htmlFor={id}>
                  <span className="sr-only">{row.label} · </span>
                  {name}
                </FieldLabel>
                {locked && row.configurable && (
                  <FieldDescription>{t('notificationSettings.managed')}</FieldDescription>
                )}
              </FieldContent>
              <Switch
                id={id}
                aria-label={`${row.label} · ${name}`}
                checked={channel.enabled}
                disabled={disabled || locked}
                onCheckedChange={(checked) => {
                  if (!locked) onChange(channel.channelId, checked);
                }}
              />
            </Field>
          );
        })}
      </FieldGroup>
    </div>
  );
}

export function NotificationPolicySettings() {
  const t = useTranslator();
  const state = useNotificationSettings(
    '/api/admin/notifications/policy',
    notificationPolicySchema,
  );
  const view = state.view;
  const disabled = state.status === 'saving' || state.status === 'loading';
  function update(type: string, patch: NonNullable<NotificationPolicyPatch['types']>[string]) {
    void state.save('PUT', { types: { [type]: patch } });
  }
  return (
    <SettingsPanel title={t('notificationSettings.policy')} state={state}>
      <p className="text-sm text-muted-foreground">{t('notificationSettings.adminHelp')}</p>
      {view &&
        groups(view).map((category) => (
          <section key={category.id} className="flex flex-col gap-4" aria-label={category.label}>
            <SectionTitle>{category.label}</SectionTitle>
            <div className="flex flex-col divide-y">
              {view.types
                .filter((row) => row.category === category.id)
                .map((row) => (
                  <PolicyRow
                    key={row.type}
                    row={row}
                    view={view}
                    disabled={disabled}
                    update={(patch) => update(row.type, patch)}
                  />
                ))}
            </div>
          </section>
        ))}
    </SettingsPanel>
  );
}

function PolicyRow({
  row,
  view,
  disabled,
  update,
}: {
  row: NotificationTypePolicy;
  view: NotificationPolicyView;
  disabled: boolean;
  update: (patch: NonNullable<NotificationPolicyPatch['types']>[string]) => void;
}) {
  const t = useTranslator();
  const id = `policy-${row.type}`;
  return (
    <div className="flex flex-col gap-5 py-5 first:pt-0">
      <Field orientation="horizontal" data-disabled={disabled}>
        <FieldContent>
          <FieldLabel htmlFor={id}>
            {row.label}
            <span className="sr-only"> · {t('notificationSettings.enabled')}</span>
          </FieldLabel>
          {!row.enabled && (
            <FieldDescription>{t('notificationSettings.globallyDisabled')}</FieldDescription>
          )}
        </FieldContent>
        <Switch
          id={id}
          aria-label={`${row.label} · ${t('notificationSettings.enabled')}`}
          checked={row.enabled}
          disabled={disabled}
          onCheckedChange={(enabled) => update({ enabled })}
        />
      </Field>
      <FieldSet disabled={disabled || !row.enabled}>
        <FieldLegend variant="label">{t('notificationSettings.defaultChannels')}</FieldLegend>
        <div className="flex flex-wrap gap-x-6 gap-y-4">
          {view.channels.map((channel) => (
            <Label key={channel.id} htmlFor={`${id}-${channel.id}`}>
              <Checkbox
                id={`${id}-${channel.id}`}
                aria-labelledby={`${id}-${channel.id}-text`}
                checked={row.defaultChannels.includes(channel.id)}
                disabled={disabled || !row.enabled}
                onCheckedChange={(checked) =>
                  update({
                    defaultChannels: checked
                      ? [...row.defaultChannels, channel.id]
                      : row.defaultChannels.filter((value) => value !== channel.id),
                  })
                }
              />
              <span id={`${id}-${channel.id}-text`}>
                <span className="sr-only">{row.label} · </span>
                {channel.name}
              </span>
            </Label>
          ))}
        </div>
        {row.defaultChannels.length === 0 && (
          <FieldDescription>{t('notificationSettings.noDefaultChannels')}</FieldDescription>
        )}
      </FieldSet>
      <Field
        orientation="horizontal"
        data-disabled={disabled || !row.userConfigurable || !row.enabled}
      >
        <FieldContent>
          <FieldLabel htmlFor={`${id}-locked`}>
            <span className="sr-only">{row.label} · </span>
            {t('notificationSettings.lock')}
          </FieldLabel>
          <FieldDescription>
            {row.userConfigurable
              ? t('notificationSettings.lockHelp')
              : t('notificationSettings.catalogLocked')}
          </FieldDescription>
        </FieldContent>
        <Checkbox
          id={`${id}-locked`}
          aria-label={`${row.label} · ${t('notificationSettings.lock')}`}
          checked={row.locked || !row.userConfigurable}
          disabled={disabled || !row.userConfigurable || !row.enabled}
          onCheckedChange={(locked) => update({ locked })}
        />
      </Field>
    </div>
  );
}
