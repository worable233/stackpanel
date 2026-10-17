'use client';

import { useEffect, useState } from 'react';
import { SectionTitle } from '@stackpanel/ui';
import { toast } from 'sonner';
import { agentFetch } from './agent-workspace';
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

type Model = { baseUrl: string | null; model: string | null; apiKeyConfigured: boolean };
type Retention = {
  policy: { retentionDays: number | null; maxConversationsPerUser: number | null };
  stats: { conversations: number; messages: number };
  lastCleanup: { completedAt: string; deleted: number; mayHaveMore: boolean } | null;
};

export function AgentSettings() {
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
      setError(cause instanceof Error ? cause.message : '加载失败');
    }
  }
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function act(name: string, action: () => Promise<void>) {
    setBusy(name);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败');
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
        <SectionTitle>Agent</SectionTitle>
        <Badge variant="secondary">{loaded ? (enabled ? '已启用' : '未启用') : '加载中'}</Badge>
      </div>
      {error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 text-sm text-destructive"
        >
          {error}
          {!loaded && (
            <Button variant="outline" onClick={() => void load()}>
              重试
            </Button>
          )}
        </div>
      )}
      {loaded && (
        <>
          <FieldGroup>
            <Field>
              <Label htmlFor="agent-enabled">开放 Agent 服务</Label>
              <AgentSettingSelect
                id="agent-enabled"
                disabled={Boolean(busy)}
                value={String(enabled)}
                options={[
                  ['false', '关闭'],
                  ['true', '开启'],
                ]}
                onChange={(value) =>
                  void act('enabled', async () => {
                    const result = await agentFetch<{ enabled: boolean }>('admin/enabled', 'PUT', {
                      enabled: value === 'true',
                    });
                    setEnabled(result.enabled);
                    toast.success('服务设置已保存');
                  })
                }
              />
              <FieldDescription>
                开启后，用户可在后台调用 Agent。关闭不会删除已有对话；已有记录仍可查看。
              </FieldDescription>
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
                toast.success('模型配置已保存');
              });
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <SectionTitle>模型服务</SectionTitle>
              <Badge variant="outline">{model.apiKeyConfigured ? '密钥已保存' : '待配置'}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              连接 OpenAI
              兼容接口，模型费用由站点承担。安装了模型提供方插件时，会优先使用插件提供的服务。
            </p>
            <FieldGroup>
              <Field>
                <Label htmlFor="agent-base-url">接口地址</Label>
                <Input
                  id="agent-base-url"
                  type="url"
                  required
                  placeholder="https://api.openai.com/v1"
                  value={model.baseUrl ?? ''}
                  onChange={(event) => setModel({ ...model, baseUrl: event.target.value })}
                />
                <FieldDescription>
                  填写服务商提供的公网 HTTPS API 地址，通常以 /v1 结尾。
                </FieldDescription>
              </Field>
              <Field>
                <Label htmlFor="agent-model-name">默认模型</Label>
                <Input
                  id="agent-model-name"
                  required
                  placeholder="填写服务商支持的模型 ID"
                  maxLength={191}
                  value={model.model ?? ''}
                  onChange={(event) => setModel({ ...model, model: event.target.value })}
                />
              </Field>
              <Field>
                <Label htmlFor="agent-api-key">API 密钥</Label>
                <Input
                  id="agent-api-key"
                  type="password"
                  autoComplete="new-password"
                  required={!model.apiKeyConfigured}
                  value={secret}
                  placeholder={
                    model.apiKeyConfigured ? '已保存，留空保留原密钥' : '粘贴服务商提供的 API Key'
                  }
                  onChange={(event) => setSecret(event.target.value)}
                />
                <FieldDescription>密钥加密保存在服务器，不会向用户公开。</FieldDescription>
              </Field>
            </FieldGroup>
            <div className="flex flex-wrap gap-2">
              <Button disabled={Boolean(busy)}>
                {busy === 'model' ? '保存中…' : '保存模型配置'}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={Boolean(busy) || (!model.apiKeyConfigured && !model.baseUrl)}
                onClick={() => setConfirm('model')}
              >
                清除配置
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
                toast.success('保留规则已保存，将在下一次自动清理时应用');
              });
            }}
          >
            <SectionTitle>对话记录</SectionTitle>
            <dl className="grid grid-cols-2 gap-4 rounded-lg border p-4">
              <div>
                <dt className="text-sm text-muted-foreground">对话总数</dt>
                <dd className="mt-1 text-xl font-semibold tabular-nums">
                  {retention?.stats.conversations.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">消息总数</dt>
                <dd className="mt-1 text-xl font-semibold tabular-nums">
                  {retention?.stats.messages.toLocaleString()}
                </dd>
              </div>
            </dl>
            <FieldGroup>
              <Field>
                <Label htmlFor="agent-retention-days">保留时长</Label>
                <AgentSettingSelect
                  id="agent-retention-days"
                  value={days}
                  onChange={setDays}
                  options={[
                    ['0', '永久保留'],
                    ['30', '30 天'],
                    ['90', '90 天'],
                    ['180', '180 天'],
                    ['365', '1 年'],
                  ]}
                />
                <FieldDescription>
                  按最后一次更新计算，超过时长且未再更新的对话将被删除。
                </FieldDescription>
              </Field>
              <Field>
                <Label htmlFor="agent-retention-cap">每位用户的对话上限</Label>
                <AgentSettingSelect
                  id="agent-retention-cap"
                  value={cap}
                  onChange={setCap}
                  options={[
                    ['0', '不限制'],
                    ['50', '50 个'],
                    ['100', '100 个'],
                    ['200', '200 个'],
                    ['500', '500 个'],
                  ]}
                />
                <FieldDescription>超过上限时，优先清理最久未更新的对话。</FieldDescription>
              </Field>
            </FieldGroup>
            <div className="flex flex-col gap-2 text-sm text-muted-foreground">
              <p>
                后台每小时检查一次，每次最多清理 500
                个对话。删除后无法恢复，同时移除其中的消息与图片关联；媒体库中的原文件和任务执行审计不会被删除。
              </p>
              <p>
                {retention?.lastCleanup
                  ? `上次检查：${new Date(retention.lastCleanup.completedAt).toLocaleString()}，清理 ${retention.lastCleanup.deleted} 个对话${retention.lastCleanup.mayHaveMore ? '，剩余记录将在后续批次继续处理' : ''}。`
                  : '尚未执行自动清理。默认永久保留，不会自动删除现有记录。'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button disabled={Boolean(busy) || !dirty}>
                {busy === 'retention' ? '保存中…' : '保存保留规则'}
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
                立即清理
              </Button>
            </div>
            {dirty && (
              <p className="text-sm text-muted-foreground">请先保存规则，再执行立即清理。</p>
            )}
          </form>
          <Separator />
          <AgentAdvancedSettings />
        </>
      )}
      <Dialog open={confirm !== null} onOpenChange={(open) => !open && !busy && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm === 'cleanup' ? '按当前规则清理对话？' : '清除模型配置？'}
            </DialogTitle>
            <DialogDescription>
              {confirm === 'cleanup'
                ? '仅清理已符合保存规则的历史对话，每批最多 500 个。被清理的对话和消息无法恢复。'
                : '接口地址、默认模型和已保存的密钥将被移除。若没有模型提供方插件，Agent 将无法执行新任务。'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={Boolean(busy)} onClick={() => setConfirm(null)}>
              取消
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
                    toast.success(`已清理 ${result.result.deleted} 个对话`);
                  } else {
                    setModel(await agentFetch<Model>('admin/model', 'DELETE'));
                    setSecret('');
                    toast.success('模型配置已清除');
                  }
                  setConfirm(null);
                })
              }
            >
              {busy ? '处理中…' : '确认'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
