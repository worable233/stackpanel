'use client';

import { useEffect, useState } from 'react';
import { SectionTitle } from '@stackpanel/ui';
import { toast } from '@/components/ui/toast';
import { agentFetch } from './agent-workspace';
import { agentErrorText } from '@/lib/agent-errors';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Field, FieldDescription, FieldGroup } from '@/components/ui/field';
import { InputGroup, InputGroupTextarea } from '@/components/ui/input-group';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import type { Translator } from '@/i18n/core';
import { useTranslator } from '@/i18n/provider';

type Config = Record<string, unknown>;
type FieldSpec = {
  key: string;
  label: string;
  help?: string;
  type?: 'number' | 'lines' | 'optionalNumber' | 'optionalText';
  options?: [string, string][];
  min?: number;
  max?: number;
  placeholder?: string;
};
type Definition = {
  key: string;
  title: string;
  description: string;
  defaults: Config;
  fields: FieldSpec[];
  listKey?: string;
  idHelp: string;
};

/** Config definitions, translated at render time so the tab labels follow the locale. */
function definitions(t: Translator): Definition[] {
  const d = (name: string, key: string) => t(`agent.advanced.defs.${name}.${key}`);
  return [
    {
      key: 'profiles',
      title: d('profiles', 'title'),
      description: d('profiles', 'description'),
      idHelp: d('profiles', 'idHelp'),
      defaults: {
        autonomy: 'read',
        maxSteps: 50,
        maxRunSeconds: 600,
        dailySteps: 500,
        budgetMinor: null,
        dailyBudgetMinor: null,
        allowedModels: [],
        approvalNotify: null,
      },
      fields: [
        {
          key: 'autonomy',
          label: d('profiles', 'autonomyLabel'),
          options: [
            ['read', d('profiles', 'autonomyRead')],
            ['propose', d('profiles', 'autonomyPropose')],
            ['act', d('profiles', 'autonomyAct')],
          ],
        },
        {
          key: 'maxSteps',
          label: d('profiles', 'maxSteps'),
          type: 'number',
          min: 1,
          max: 200,
        },
        {
          key: 'maxRunSeconds',
          label: d('profiles', 'maxRunSeconds'),
          type: 'number',
          min: 1,
          max: 3600,
        },
        { key: 'dailySteps', label: d('profiles', 'dailySteps'), type: 'number', min: 1, max: 10000 },
        {
          key: 'budgetMinor',
          label: d('profiles', 'budgetMinor'),
          type: 'optionalNumber',
          min: 1,
          max: 2147483647,
          help: d('profiles', 'budgetMinorHelp'),
        },
        {
          key: 'dailyBudgetMinor',
          label: d('profiles', 'dailyBudgetMinor'),
          type: 'optionalNumber',
          min: 1,
          max: 2147483647,
        },
        {
          key: 'allowedModels',
          label: d('profiles', 'allowedModels'),
          type: 'lines',
          help: d('profiles', 'allowedModelsHelp'),
        },
        {
          key: 'approvalNotify',
          label: d('profiles', 'approvalNotify'),
          type: 'optionalText',
          help: d('profiles', 'approvalNotifyHelp'),
        },
      ],
    },
    {
      key: 'mcp-servers',
      title: d('mcpServers', 'title'),
      listKey: 'servers',
      description: d('mcpServers', 'description'),
      idHelp: d('mcpServers', 'idHelp'),
      defaults: { name: '', url: '', enabled: false, tools: [] },
      fields: [
        { key: 'name', label: d('mcpServers', 'name') },
        {
          key: 'url',
          label: d('mcpServers', 'url'),
          placeholder: d('mcpServers', 'urlPlaceholder'),
          help: d('mcpServers', 'urlHelp'),
        },
        {
          key: 'enabled',
          label: d('mcpServers', 'status'),
          options: [
            ['false', d('mcpServers', 'statusOff')],
            ['true', d('mcpServers', 'statusOn')],
          ],
        },
      ],
    },
    {
      key: 'oauth-clients',
      title: d('oauthClients', 'title'),
      listKey: 'clients',
      description: d('oauthClients', 'description'),
      idHelp: d('oauthClients', 'idHelp'),
      defaults: { name: '', enabled: false, redirectUris: [] },
      fields: [
        { key: 'name', label: d('oauthClients', 'name') },
        {
          key: 'redirectUris',
          label: d('oauthClients', 'redirectUris'),
          type: 'lines',
          help: d('oauthClients', 'redirectUrisHelp'),
        },
        {
          key: 'enabled',
          label: d('oauthClients', 'status'),
          options: [
            ['false', d('oauthClients', 'statusOff')],
            ['true', d('oauthClients', 'statusOn')],
          ],
        },
      ],
    },
    {
      key: 'actions',
      title: d('actions', 'title'),
      listKey: 'actions',
      description: d('actions', 'description'),
      idHelp: d('actions', 'idHelp'),
      defaults: {
        name: '',
        enabled: false,
        image: '',
        argv: [],
        timeoutSeconds: 30,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      fields: [
        { key: 'name', label: d('actions', 'name') },
        {
          key: 'image',
          label: d('actions', 'image'),
          placeholder: d('actions', 'imagePlaceholder'),
          help: d('actions', 'imageHelp'),
        },
        {
          key: 'argv',
          label: d('actions', 'argv'),
          type: 'lines',
          help: d('actions', 'argvHelp'),
        },
        {
          key: 'timeoutSeconds',
          label: d('actions', 'timeoutSeconds'),
          type: 'number',
          min: 1,
          max: 60,
        },
        {
          key: 'enabled',
          label: d('actions', 'status'),
          options: [
            ['false', d('actions', 'statusOff')],
            ['true', d('actions', 'statusOn')],
          ],
        },
      ],
    },
  ];
}

function ConfigField({
  spec,
  value,
  onChange,
  prefix,
}: {
  spec: FieldSpec;
  value: unknown;
  onChange: (value: unknown) => void;
  prefix: string;
}) {
  const id = `agent-${prefix}-${spec.key}`;
  return (
    <Field>
      <Label htmlFor={id}>{spec.label}</Label>
      {spec.options ? (
        <Select
          value={String(value)}
          onValueChange={(next) =>
            next !== null && onChange(typeof value === 'boolean' ? next === 'true' : next)
          }
        >
          <SelectTrigger id={id} className="w-full">
            <SelectValue>{spec.options.find(([key]) => key === String(value))?.[1]}</SelectValue>
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectGroup>
              {spec.options.map(([key, label]) => (
                <SelectItem key={key} value={key}>
                  {label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      ) : spec.type === 'lines' ? (
        <InputGroup>
          <InputGroupTextarea
            id={id}
            rows={3}
            value={Array.isArray(value) ? value.join('\n') : ''}
            onChange={(event) => onChange(event.target.value.split('\n'))}
          />
        </InputGroup>
      ) : (
        <Input
          id={id}
          type={spec.type?.includes('Number') || spec.type === 'number' ? 'number' : 'text'}
          min={spec.min}
          max={spec.max}
          step={spec.type === 'number' || spec.type === 'optionalNumber' ? 1 : undefined}
          required={!spec.type?.startsWith('optional')}
          placeholder={spec.placeholder}
          value={value == null ? '' : String(value)}
          onChange={(event) =>
            onChange(
              event.target.value === ''
                ? spec.type?.startsWith('optional')
                  ? null
                  : ''
                : spec.type === 'number' || spec.type === 'optionalNumber'
                  ? Number(event.target.value)
                  : event.target.value,
            )
          }
        />
      )}
      {spec.help && <FieldDescription>{spec.help}</FieldDescription>}
    </Field>
  );
}

type Tool = {
  name: string;
  description?: string;
  inputSchema: Config;
  readOnly: boolean;
  destructive: boolean;
};
function ConfigForm({ definition: d }: { definition: Definition }) {
  const t = useTranslator();
  const [rows, setRows] = useState<{ id: string; name?: string; config?: Config }[]>([]);
  const [id, setId] = useState('');
  const [config, setConfig] = useState<Config>(d.defaults);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadedId, setLoadedId] = useState('');
  async function refresh() {
    if (!d.listKey) return;
    const list = await agentFetch<Record<string, typeof rows>>(`admin/${d.key}`);
    setRows(list[d.listKey] ?? []);
  }
  useEffect(() => {
    // `refresh` awaits the list before setState (see agent-settings.tsx).
    void (async () => {
      try {
        await refresh();
      } catch (cause) {
        setError(agentErrorText(t, cause, t('common.operationFailed')));
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (cause) {
      setError(agentErrorText(t, cause, t('common.operationFailed')));
    } finally {
      setBusy(false);
    }
  }
  const tools = (config.tools ?? []) as Tool[];
  const cleanConfig = (raw: Config) =>
    Object.fromEntries(
      Object.entries(d.defaults).map(([key, fallback]) => [key, raw[key] ?? fallback]),
    );
  return (
    <form
      className="flex flex-col gap-5 pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        void act(async () => {
          const payload = { ...config };
          for (const field of d.fields.filter((spec) => spec.type === 'lines'))
            payload[field.key] = (config[field.key] as string[])
              .map((value) => value.trim())
              .filter(Boolean);
          await agentFetch(`admin/${d.key}/${encodeURIComponent(id)}`, 'PUT', payload);
          setLoadedId(id);
          await refresh();
          toast.success(t('agent.advanced.saved'));
        });
      }}
    >
      <p className="text-sm text-muted-foreground">{d.description}</p>
      {d.key === 'oauth-clients' && (
        <p className="text-sm text-muted-foreground">{t('agent.advanced.oauthEnvHint')}</p>
      )}
      {rows.length > 0 && (
        <Field>
          <Label htmlFor={`existing-${d.key}`}>{t('agent.advanced.existing')}</Label>
          <Select
            value={loadedId}
            onValueChange={(value) => {
              const row = rows.find((row) => row.id === value);
              if (row) {
                setId(row.id);
                setLoadedId(row.id);
                setConfig(cleanConfig(row.config ?? (row as unknown as Config)));
              }
            }}
          >
            <SelectTrigger id={`existing-${d.key}`} className="w-full">
              <SelectValue>
                {rows.find((row) => row.id === loadedId)?.name ??
                  (loadedId || t('agent.advanced.chooseExisting'))}
              </SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                {rows.map((row) => (
                  <SelectItem key={row.id} value={row.id}>
                    {row.name ?? String(row.config?.name ?? row.id)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      )}
      <FieldGroup>
        <Field>
          <Label htmlFor={`id-${d.key}`}>
            {d.key === 'profiles' ? t('agent.advanced.profileId') : t('agent.advanced.configId')}
          </Label>
          <div className="flex gap-2">
            <Input
              id={`id-${d.key}`}
              required
              value={id}
              onChange={(event) => {
                setId(event.target.value);
                setLoadedId('');
              }}
            />
            {d.key === 'profiles' && (
              <Button
                type="button"
                variant="outline"
                disabled={busy || !id}
                onClick={() =>
                  void act(async () => {
                    const response = await agentFetch<{ policy: Config; configured: boolean }>(
                      `admin/profiles/${encodeURIComponent(id)}`,
                    );
                    setConfig(cleanConfig(response.policy));
                    setLoadedId(id);
                    toast.success(
                      response.configured
                        ? t('agent.advanced.readPolicyHint')
                        : t('agent.advanced.readPolicyFallback'),
                    );
                  })
                }
              >
                {t('agent.advanced.readPolicy')}
              </Button>
            )}
          </div>
          <FieldDescription>{d.idHelp}</FieldDescription>
        </Field>
        {d.fields.map((field) => (
          <ConfigField
            key={field.key}
            prefix={d.key}
            spec={field}
            value={config[field.key]}
            onChange={(value) => setConfig({ ...config, [field.key]: value })}
          />
        ))}
      </FieldGroup>
      {d.key === 'mcp-servers' && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <Label>{t('agent.advanced.reviewedTools', { count: tools.length })}</Label>
            <Button
              variant="outline"
              type="button"
              disabled={busy || !loadedId || !config.enabled}
              onClick={() =>
                void act(async () => {
                  const response = await agentFetch<{ result: { tools?: Tool[] } }>(
                    `admin/mcp-servers/${encodeURIComponent(loadedId)}/discover`,
                    'POST',
                    {},
                  );
                  if (!Array.isArray(response.result.tools))
                    throw new Error(t('agent.advanced.noTools'));
                  setConfig({
                    ...config,
                    tools: response.result.tools.map((tool) => ({
                      name: tool.name,
                      description: tool.description ?? '',
                      inputSchema: tool.inputSchema,
                      readOnly: false,
                      destructive: true,
                    })),
                  });
                  toast.success(t('agent.advanced.discovered'));
                })
              }
            >
              {t('agent.advanced.discoverTools')}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">{t('agent.advanced.discoverHint')}</p>
          {tools.map((tool, index) => (
            <div key={tool.name} className="flex flex-col gap-2 rounded-lg border p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">{tool.name}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setConfig({ ...config, tools: tools.filter((_, i) => i !== index) })
                  }
                >
                  {t('agent.advanced.remove')}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{tool.description}</p>
              <ConfigField
                prefix={`tool-${index}`}
                spec={{
                  key: 'risk',
                  label: t('agent.advanced.toolRisk'),
                  options: [
                    ['read', t('agent.advanced.riskRead')],
                    ['write', t('agent.advanced.riskWrite')],
                    ['danger', t('agent.advanced.riskDanger')],
                  ],
                }}
                value={tool.readOnly ? 'read' : tool.destructive ? 'danger' : 'write'}
                onChange={(value) =>
                  setConfig({
                    ...config,
                    tools: tools.map((item, i) =>
                      i === index
                        ? { ...item, readOnly: value === 'read', destructive: value !== 'write' }
                        : item,
                    ),
                  })
                }
              />
            </div>
          ))}
        </div>
      )}
      {d.key === 'actions' && (
        <p className="text-sm text-muted-foreground">{t('agent.advanced.actionsHint')}</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button disabled={busy || !id}>
          {busy ? t('agent.advanced.saving') : t('agent.advanced.save')}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setId('');
            setLoadedId('');
            setConfig(d.defaults);
            setError('');
          }}
        >
          {t('agent.advanced.newConfig')}
        </Button>
      </div>
    </form>
  );
}

export function AgentAdvancedSettings() {
  const t = useTranslator();
  const specs = definitions(t);
  return (
    <details className="group">
      <summary className="cursor-pointer list-none">
        <div className="flex items-center justify-between gap-3">
          <SectionTitle>{t('agent.advanced.title')}</SectionTitle>
          <Badge variant="outline">{t('agent.advanced.expand')}</Badge>
        </div>
      </summary>
      <div className="pt-5">
        <Tabs defaultValue="profiles">
          <TabsList className="flex h-auto w-full flex-wrap">
            {specs.map((d) => (
              <TabsTrigger key={d.key} value={d.key}>
                {d.title}
              </TabsTrigger>
            ))}
          </TabsList>
          {specs.map((d) => (
            <TabsContent key={d.key} value={d.key}>
              <ConfigForm definition={d} />
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </details>
  );
}
