'use client';

import { useEffect, useState } from 'react';
import { InlineError, SectionTitle } from '@stackpanel/ui';
import { toast } from 'sonner';
import { agentFetch } from './agent-workspace';
import { agentErrorText } from '@/lib/agent-errors';
import { AgentAdvancedSettings } from './agent-settings-advanced';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Field, FieldDescription, FieldGroup } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { SettingsSelect as AgentSettingSelect } from '@/components/settings-sections';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { formatDateTime, formatNumber } from '@/i18n/core';
import { useLocale, useTranslator } from '@/i18n/provider';

type Model = { baseUrl: string | null; model: string | null; apiKeyConfigured: boolean };
type Retention = {
  policy: { retentionDays: number | null; maxConversationsPerUser: number | null };
  stats: { conversations: number; messages: number };
  lastCleanup: { completedAt: string; deleted: number; mayHaveMore: boolean } | null;
};

export function AgentSettings() {
  const t = useTranslator();
  const locale = useLocale();
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [model, setModel] = useState<Model>({ baseUrl: '', model: '', apiKeyConfigured: false });
  const [secret, setSecret] = useState('');
  const [retention, setRetention] = useState<Retention>();
  const [days, setDays] = useState('0');
  const [cap, setCap] = useState('0');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<'cleanup' | 'model' | null>(null);
  const applyRetention = (value: Retention) => {
    setRetention(value);
    setDays(String(value.policy.retentionDays ?? 0));
    setCap(String(value.policy.maxConversationsPerUser ?? 0));
  };
  async function load() {
    setError('');
    try {
      const [status, config, history] = await Promise.all([
        agentFetch<{ enabled: boolean }>('status'),
        agentFetch<Model>('admin/model'),
        agentFetch<Retention>('admin/retention'),
      ]);
      setEnabled(status.enabled);
      setModel(config);
      applyRetention(history);
      setLoaded(true);
    } catch (cause) {
      setError(
        agentErrorText(t, cause, t('agent.admin.loadFailed')),
      );
    }
  }
  useEffect(() => {
    // `load` awaits the API before any setState, so this is not a synchronous
    // render cascade; the rule fires on "calls a function that setStates".
    void (async () => {
      await load();
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function act(name: string, action: () => Promise<void>) {
    setBusy(name);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(
        agentErrorText(t, cause, t('common.operationFailed')),
      );
    } finally {
      setBusy('');
    }
  }
  const dirty =
    retention &&
    (Number(days) !== (retention.policy.retentionDays ?? 0) ||
      Number(cap) !== (retention.policy.maxConversationsPerUser ?? 0));
  return (
    <section className="flex flex-col gap-8" aria-busy={Boolean(busy)}>
      <div className="flex items-center justify-between gap-4 border-b pb-4">
        <SectionTitle>{t('agent.admin.serviceTitle')}</SectionTitle>
        <Badge variant="secondary">
          {loaded
            ? enabled
              ? t('agent.admin.enabled')
              : t('agent.admin.disabled')
            : t('agent.admin.statusLoading')}
        </Badge>
      </div>
      {error && (
        <InlineError className="flex items-center justify-between gap-3">
          {error}
          {!loaded && (
            <Button variant="outline" onClick={() => void load()}>
              {t('agent.admin.retry')}
            </Button>
          )}
        </InlineError>
      )}
      {loaded && (
        <>
          <FieldGroup>
            <Field>
              <Label htmlFor="agent-enabled">{t('agent.admin.serviceLabel')}</Label>
              <AgentSettingSelect
                id="agent-enabled"
                disabled={Boolean(busy)}
                value={String(enabled)}
                options={[
                  ['false', t('agent.admin.optionOff')],
                  ['true', t('agent.admin.optionOn')],
                ]}
                onChange={(value) =>
                  void act('enabled', async () => {
                    const result = await agentFetch<{ enabled: boolean }>('admin/enabled', 'PUT', {
                      enabled: value === 'true',
                    });
                    setEnabled(result.enabled);
                    toast.success(t('agent.admin.serviceSaved'));
                  })
                }
              />
              <FieldDescription>{t('agent.admin.serviceHint')}</FieldDescription>
            </Field>
          </FieldGroup>
          <Separator />
          <form
            className="flex flex-col gap-6"
            onSubmit={(event) => {
              event.preventDefault();
              void act('model', async () => {
                setModel(
                  await agentFetch<Model>('admin/model', 'PUT', {
                    baseUrl: model.baseUrl,
                    model: model.model,
                    ...(secret ? { apiKey: secret } : {}),
                  }),
                );
                setSecret('');
                toast.success(t('agent.admin.modelSaved'));
              });
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <SectionTitle>{t('agent.admin.modelTitle')}</SectionTitle>
              <Badge variant="outline">
                {model.apiKeyConfigured ? t('agent.admin.keySaved') : t('agent.admin.keyPending')}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">{t('agent.admin.modelHint')}</p>
            <FieldGroup>
              <Field>
                <Label htmlFor="agent-base-url">{t('agent.admin.baseUrlLabel')}</Label>
                <Input
                  id="agent-base-url"
                  type="url"
                  required
                  placeholder="https://api.openai.com/v1"
                  value={model.baseUrl ?? ''}
                  onChange={(event) => setModel({ ...model, baseUrl: event.target.value })}
                />
                <FieldDescription>{t('agent.admin.baseUrlHint')}</FieldDescription>
              </Field>
              <Field>
                <Label htmlFor="agent-model-name">{t('agent.admin.modelNameLabel')}</Label>
                <Input
                  id="agent-model-name"
                  required
                  placeholder={t('agent.admin.modelNamePlaceholder')}
                  maxLength={191}
                  value={model.model ?? ''}
                  onChange={(event) => setModel({ ...model, model: event.target.value })}
                />
              </Field>
              <Field>
                <Label htmlFor="agent-api-key">{t('agent.admin.apiKeyLabel')}</Label>
                <Input
                  id="agent-api-key"
                  type="password"
                  autoComplete="new-password"
                  required={!model.apiKeyConfigured}
                  value={secret}
                  placeholder={
                    model.apiKeyConfigured
                      ? t('agent.admin.apiKeyPlaceholderSaved')
                      : t('agent.admin.apiKeyPlaceholderNew')
                  }
                  onChange={(event) => setSecret(event.target.value)}
                />
                <FieldDescription>{t('agent.admin.apiKeyHint')}</FieldDescription>
              </Field>
            </FieldGroup>
            <div className="flex flex-wrap gap-2">
              <Button disabled={Boolean(busy)}>
                {busy === 'model' ? t('agent.admin.saving') : t('agent.admin.saveModel')}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={Boolean(busy) || (!model.apiKeyConfigured && !model.baseUrl)}
                onClick={() => setConfirm('model')}
              >
                {t('agent.admin.clearConfig')}
              </Button>
            </div>
          </form>
          <Separator />
          <form
            className="flex flex-col gap-6"
            onSubmit={(event) => {
              event.preventDefault();
              void act('retention', async () => {
                applyRetention(
                  await agentFetch<Retention>('admin/retention', 'PUT', {
                    retentionDays: Number(days) || null,
                    maxConversationsPerUser: Number(cap) || null,
                  }),
                );
                toast.success(t('agent.admin.retentionSaved'));
              });
            }}
          >
            <SectionTitle>{t('agent.admin.retentionTitle')}</SectionTitle>
            <dl className="grid grid-cols-2 gap-4 rounded-lg border p-4">
              <div>
                <dt className="text-sm text-muted-foreground">
                  {t('agent.admin.totalConversations')}
                </dt>
                <dd className="mt-1 text-xl font-semibold tabular-nums">
                  {retention ? formatNumber(retention.stats.conversations, locale) : ''}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">{t('agent.admin.totalMessages')}</dt>
                <dd className="mt-1 text-xl font-semibold tabular-nums">
                  {retention ? formatNumber(retention.stats.messages, locale) : ''}
                </dd>
              </div>
            </dl>
            <FieldGroup>
              <Field>
                <Label htmlFor="agent-retention-days">{t('agent.admin.retentionDaysLabel')}</Label>
                <AgentSettingSelect
                  id="agent-retention-days"
                  value={days}
                  onChange={setDays}
                  options={[
                    ['0', t('agent.admin.retentionForever')],
                    ['30', t('agent.admin.daysCount', { count: 30 })],
                    ['90', t('agent.admin.daysCount', { count: 90 })],
                    ['180', t('agent.admin.daysCount', { count: 180 })],
                    ['365', t('agent.admin.yearsOne')],
                  ]}
                />
                <FieldDescription>{t('agent.admin.retentionDaysHint')}</FieldDescription>
              </Field>
              <Field>
                <Label htmlFor="agent-retention-cap">{t('agent.admin.retentionCapLabel')}</Label>
                <AgentSettingSelect
                  id="agent-retention-cap"
                  value={cap}
                  onChange={setCap}
                  options={[
                    ['0', t('agent.admin.capUnlimited')],
                    ['50', t('agent.admin.capCount', { count: 50 })],
                    ['100', t('agent.admin.capCount', { count: 100 })],
                    ['200', t('agent.admin.capCount', { count: 200 })],
                    ['500', t('agent.admin.capCount', { count: 500 })],
                  ]}
                />
                <FieldDescription>{t('agent.admin.retentionCapHint')}</FieldDescription>
              </Field>
            </FieldGroup>
            <div className="flex flex-col gap-2 text-sm text-muted-foreground">
              <p>{t('agent.admin.cleanupPolicy')}</p>
              <p>
                {retention?.lastCleanup
                  ? t('agent.admin.lastCleanup', {
                      date: formatDateTime(new Date(retention.lastCleanup.completedAt), locale),
                      deleted: retention.lastCleanup.deleted,
                      more: retention.lastCleanup.mayHaveMore
                        ? t('agent.admin.lastCleanupMore')
                        : '',
                    })
                  : t('agent.admin.neverCleaned')}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button disabled={Boolean(busy) || !dirty}>
                {busy === 'retention' ? t('agent.admin.saving') : t('agent.admin.saveRetention')}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={
                  Boolean(busy) ||
                  Boolean(dirty) ||
                  (!retention?.policy.retentionDays && !retention?.policy.maxConversationsPerUser)
                }
                onClick={() => setConfirm('cleanup')}
              >
                {t('agent.admin.cleanupNow')}
              </Button>
            </div>
            {dirty && <p className="text-sm text-muted-foreground">{t('agent.admin.saveFirst')}</p>}
          </form>
          <Separator />
          <AgentAdvancedSettings />
        </>
      )}
      <Dialog open={confirm !== null} onOpenChange={(open) => !open && !busy && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm === 'cleanup' ? t('agent.admin.cleanupTitle') : t('agent.admin.clearTitle')}
            </DialogTitle>
            <DialogDescription>
              {confirm === 'cleanup'
                ? t('agent.admin.cleanupDescription')
                : t('agent.admin.clearDescription')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={Boolean(busy)} onClick={() => setConfirm(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={Boolean(busy)}
              onClick={() =>
                void act('confirm', async () => {
                  if (confirm === 'cleanup') {
                    const result = await agentFetch<Retention & { result: { deleted: number } }>(
                      'admin/retention/cleanup',
                      'POST',
                      {},
                    );
                    applyRetention(result);
                    toast.success(t('agent.admin.cleaned', { count: result.result.deleted }));
                  } else {
                    setModel(await agentFetch<Model>('admin/model', 'DELETE'));
                    setSecret('');
                    toast.success(t('agent.admin.cleared'));
                  }
                  setConfirm(null);
                })
              }
            >
              {busy ? t('agent.admin.processing') : t('common.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
