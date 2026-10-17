'use client';

import { useEffect, useState } from 'react';
import { SectionTitle } from '@stackpanel/ui';
import { toast } from 'sonner';
import { agentFetch } from './agent-workspace';
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
const definitions: Definition[] = [
  {
    key: 'profiles',
    title: '执行策略',
    description:
      '为某个 API 密钥设置执行上限。这些限制不会增加密钥原本没有的权限；高风险操作仍需确认。',
    idHelp: '在 API 密钥管理中复制密钥 ID（tokenId），不是密钥内容。',
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
        label: '允许的操作方式',
        options: [
          ['read', '只读，写入需确认'],
          ['propose', '提出操作，由用户确认'],
          ['act', '自动执行普通操作'],
        ],
      },
      { key: 'maxSteps', label: '单次任务最多步骤', type: 'number', min: 1, max: 200 },
      { key: 'maxRunSeconds', label: '单次任务最长时间（秒）', type: 'number', min: 1, max: 3600 },
      { key: 'dailySteps', label: '每日最多步骤', type: 'number', min: 1, max: 10000 },
      {
        key: 'budgetMinor',
        label: '单次费用上限（最小货币单位）',
        type: 'optionalNumber',
        min: 1,
        max: 2147483647,
        help: '留空不设金额上限。模型提供方必须支持计价，否则设定金额限制后任务会被拒绝。',
      },
      {
        key: 'dailyBudgetMinor',
        label: '每日费用上限（最小货币单位）',
        type: 'optionalNumber',
        min: 1,
        max: 2147483647,
      },
      {
        key: 'allowedModels',
        label: '允许使用的模型',
        type: 'lines',
        help: '每行一个模型 ID，留空允许所有可用模型。',
      },
      {
        key: 'approvalNotify',
        label: '额外审批通知接收人 ID',
        type: 'optionalText',
        help: '可选。用户本人仍会收到通知。',
      },
    ],
  },
  {
    key: 'mcp-servers',
    title: '外部工具',
    listKey: 'servers',
    description:
      '连接 MCP 服务，为 Agent 提供额外工具。先保存服务，再读取远端工具并审核；用户需获得对应权限并配置个人凭证。',
    idHelp: '使用小写字母开头的英文标识，例如 cloud-tools；保存后请勿修改标识。',
    defaults: { name: '', url: '', enabled: false, tools: [] },
    fields: [
      { key: 'name', label: '服务名称' },
      {
        key: 'url',
        label: 'MCP 地址',
        placeholder: 'https://example.com/mcp',
        help: '仅支持可解析的公网 HTTPS 地址。',
      },
      {
        key: 'enabled',
        label: '服务状态',
        options: [
          ['false', '停用'],
          ['true', '启用'],
        ],
      },
    ],
  },
  {
    key: 'oauth-clients',
    title: '应用授权',
    listKey: 'clients',
    description:
      '登记可以通过 OAuth 连接本站 MCP 的应用。只接受已登记的完整回调地址，停用应用会撤销已签发的令牌。',
    idHelp: '填写应用约定的 client_id，仅限英文、数字、下划线和连字符。',
    defaults: { name: '', enabled: false, redirectUris: [] },
    fields: [
      { key: 'name', label: '应用名称' },
      {
        key: 'redirectUris',
        label: '授权回调地址',
        type: 'lines',
        help: '每行一个完整 HTTPS 地址。本地调试可使用 localhost 或回环 HTTP 地址。',
      },
      {
        key: 'enabled',
        label: '应用状态',
        options: [
          ['false', '停用'],
          ['true', '启用'],
        ],
      },
    ],
  },
  {
    key: 'actions',
    title: '脚本动作',
    listKey: 'actions',
    description:
      '运行预先审核的 Docker 脚本。需要服务器已安装 Docker 并拉取固定摘要镜像；动作禁网、以非 root 用户运行，每次调用均需用户确认。',
    idHelp: '使用小写字母开头的英文标识，例如 check-service；权限项为 agent.action.标识。',
    defaults: {
      name: '',
      enabled: false,
      image: '',
      argv: [],
      timeoutSeconds: 30,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    fields: [
      { key: 'name', label: '动作名称' },
      {
        key: 'image',
        label: '镜像（固定摘要）',
        placeholder: 'registry/image@sha256:…',
        help: '使用完整的 sha256 摘要，不能使用 latest 等可变标签。',
      },
      {
        key: 'argv',
        label: '执行程序与参数',
        type: 'lines',
        help: '第一行填写程序路径，之后每行一个参数，不支持 shell 命令拼接。输入数据由标准输入传入。',
      },
      { key: 'timeoutSeconds', label: '超时时间（秒）', type: 'number', min: 1, max: 60 },
      {
        key: 'enabled',
        label: '动作状态',
        options: [
          ['false', '停用'],
          ['true', '启用'],
        ],
      },
    ],
  },
];

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
    void refresh().catch((cause: Error) => setError(cause.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败');
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
          toast.success('配置已保存');
        });
      }}
    >
      <p className="text-sm text-muted-foreground">{d.description}</p>
      {d.key === 'oauth-clients' && (
        <p className="text-sm text-muted-foreground">
          部署前需设置 AGENT_PUBLIC_ORIGIN（API 公开地址）和 AGENT_WEB_ORIGIN（网站地址）。
        </p>
      )}
      {rows.length > 0 && (
        <Field>
          <Label htmlFor={`existing-${d.key}`}>已有配置</Label>
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
                {rows.find((row) => row.id === loadedId)?.name ?? (loadedId || '选择配置进行编辑')}
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
          <Label htmlFor={`id-${d.key}`}>{d.key === 'profiles' ? 'API 密钥 ID' : '配置标识'}</Label>
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
                      response.configured ? '已读取当前策略' : '该密钥尚未设置策略，已载入默认值',
                    );
                  })
                }
              >
                读取策略
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
            <Label>已审核工具（{tools.length}）</Label>
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
                  if (!Array.isArray(response.result.tools)) throw new Error('远端未返回工具列表');
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
                  toast.success('已读取工具，请审核操作方式后保存');
                })
              }
            >
              读取远端工具
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            先启用并保存服务，使用当前管理员的服务凭证读取工具。新工具默认按高风险写入处理，保存前请逐一核对。
          </p>
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
                  移除
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{tool.description}</p>
              <ConfigField
                prefix={`tool-${index}`}
                spec={{
                  key: 'risk',
                  label: '操作方式',
                  options: [
                    ['read', '只读'],
                    ['write', '普通写入'],
                    ['danger', '高风险写入'],
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
        <p className="text-sm text-muted-foreground">
          新动作默认不接收参数；已有动作会保留其已审核的参数定义。此处修改名称、运行方式或限额不会重写参数定义。
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button disabled={busy || !id}>{busy ? '处理中…' : '保存配置'}</Button>
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
          新建配置
        </Button>
      </div>
    </form>
  );
}

export function AgentAdvancedSettings() {
  return (
    <details className="group">
      <summary className="cursor-pointer list-none">
        <div className="flex items-center justify-between gap-3">
          <SectionTitle>高级设置</SectionTitle>
          <Badge variant="outline">展开</Badge>
        </div>
      </summary>
      <div className="pt-5">
        <Tabs defaultValue="profiles">
          <TabsList className="flex h-auto w-full flex-wrap">
            {definitions.map((d) => (
              <TabsTrigger key={d.key} value={d.key}>
                {d.title}
              </TabsTrigger>
            ))}
          </TabsList>
          {definitions.map((d) => (
            <TabsContent key={d.key} value={d.key}>
              <ConfigForm definition={d} />
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </details>
  );
}
