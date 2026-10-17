'use client';

import type { AdminPageComponentProps } from '@stackpanel/sdk';
import {
  Button,
  Input,
  Label,
  PageHeader,
  SectionTitle,
  Select,
  Field,
  FieldGroup,
  FieldDescription,
  FieldError,
} from '@stackpanel/ui';
import { useActionState, useState, type ReactElement } from 'react';
import { Check, LoaderCircle, PlugZap } from 'lucide-react';
import type { AdminConfigData } from './schemas';

type Config = AdminConfigData['config'];
const KIND_OPTIONS = [
  { value: 'env', label: '跟随环境变量' },
  { value: 'local', label: '服务器本地盘' },
  { value: 's3', label: 'S3 兼容存储' },
  { value: 'http', label: '自定义 HTTP 图床' },
];
const httpUrl = (value: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

function ConfigForm({
  config,
  action,
  canTest,
}: {
  config: Config;
  action?: (formData: FormData) => Promise<void>;
  canTest: boolean;
}): ReactElement {
  const [draft, setDraft] = useState({ ...config, accessKeyId: '', secretAccessKey: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [edited, setEdited] = useState(false);
  const [state, save, saving] = useActionState(async (_previous: string, formData: FormData) => {
    if (!action) return '';
    const next: Record<string, string> = {};
    if (draft.kind === 's3') {
      if (!draft.s3Bucket.trim()) next.s3Bucket = '请输入存储桶名称。';
      if (draft.s3Endpoint && !httpUrl(draft.s3Endpoint))
        next.s3Endpoint = '请输入完整的 HTTP 或 HTTPS 地址。';
      if ((draft.accessKeyId || draft.secretAccessKey) && !config.secretsAvailable)
        next.accessKeyId = '服务器尚未配置密钥加密，请先配置 SETTINGS_ENCRYPTION_KEY。';
      if (!config.hasCredentials && (!draft.accessKeyId || !draft.secretAccessKey))
        next.secretAccessKey = '首次配置请填写完整的访问密钥。';
    }
    if (draft.kind === 'http') {
      for (const key of ['httpUploadUrl', 'httpPublicBaseUrl'] as const) {
        if (!httpUrl(draft[key])) next[key] = '请输入完整的 HTTP 或 HTTPS 地址。';
      }
      if (draft.httpDeleteUrlTemplate && !httpUrl(draft.httpDeleteUrlTemplate))
        next.httpDeleteUrlTemplate = '请输入完整的 HTTP 或 HTTPS 地址，可包含 {key}。';
    }
    if (
      draft.publicBaseUrl &&
      !draft.publicBaseUrl.startsWith('/') &&
      !httpUrl(draft.publicBaseUrl)
    )
      next.publicBaseUrl = '请输入 HTTP(S) 地址或以 / 开头的相对路径。';
    setErrors(next);
    if (Object.keys(next).length) return '';
    // Failure redirects are handled by Next and the host. Never catch a redirect as a normal error.
    await action(formData);
    setDraft((value) => ({ ...value, accessKeyId: '', secretAccessKey: '' }));
    setEdited(false);
    setTest(null);
    return '已保存';
  }, '');

  function update<K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setErrors((previous) => ({ ...previous, [key]: '' }));
    setEdited(true);
    setTest(null);
  }
  function text(
    name: keyof typeof draft,
    label: string,
    description?: string,
    placeholder?: string,
    secret = false,
    maxLength = 2048,
  ) {
    const id = `storage-${name}`;
    return (
      <Field data-invalid={!!errors[name]}>
        <Label htmlFor={id}>{label}</Label>
        <Input
          id={id}
          value={String(draft[name])}
          onChange={(event) => update(name, event.target.value as never)}
          type={secret ? 'password' : 'text'}
          autoComplete={secret ? 'new-password' : 'off'}
          placeholder={placeholder}
          maxLength={maxLength}
          aria-invalid={!!errors[name]}
          aria-describedby={
            errors[name] ? `${id}-error` : description ? `${id}-description` : undefined
          }
        />
        {description && <FieldDescription id={`${id}-description`}>{description}</FieldDescription>}
        {errors[name] && <FieldError id={`${id}-error`}>{errors[name]}</FieldError>}
      </Field>
    );
  }
  async function testConnection() {
    setTesting(true);
    setTest(null);
    try {
      const response = await fetch('/api/plugins/storage/admin/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(30000),
      });
      const result = (await response.json()) as { ok?: boolean; error?: string };
      const ok = response.ok && result.ok === true;
      setTest({
        ok,
        message: ok
          ? '连接测试通过'
          : result.error || '连接测试未通过，请检查已保存的配置和服务状态。',
      });
    } catch {
      setTest({ ok: false, message: '连接测试请求失败或超时，请稍后重试。' });
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1 border-b pb-4">
        <SectionTitle>存储</SectionTitle>
        <p className="text-sm text-muted-foreground">管理媒体、品牌和备份文件的存储位置。</p>
      </div>
      <form action={save} className="flex flex-col gap-8">
        {/* Submit all draft fields so switching providers preserves values and blank optional fields can be cleared. */}
        {Object.entries(draft)
          .filter(
            ([key]) =>
              !['hasCredentials', 'secretsAvailable'].includes(key) &&
              (draft.kind === 's3' || !['accessKeyId', 'secretAccessKey'].includes(key)),
          )
          .map(([key, value]) => (
            <input key={key} type="hidden" name={key} value={String(value)} />
          ))}
        <fieldset disabled={saving || testing || !action} className="min-w-0">
          <div className="flex flex-col gap-8">
            <FieldGroup>
              <Field>
                <Label htmlFor="storage-kind">存储后端</Label>
                <Select
                  id="storage-kind"
                  value={draft.kind}
                  onChange={(event) => update('kind', event.target.value as Config['kind'])}
                >
                  {KIND_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
                <FieldDescription>
                  当前已保存：{KIND_OPTIONS.find((item) => item.value === config.kind)?.label}
                  。切换后仅影响新文件，历史文件仍可读取，不会自动迁移。
                </FieldDescription>
              </Field>
              {draft.kind === 'env' && (
                <FieldDescription>
                  使用服务器的 STORAGE_DRIVER
                  等环境变量。本插件不接管存储；保存此选项会清除插件中保存的 S3 密钥。
                </FieldDescription>
              )}
            </FieldGroup>
            {draft.kind === 'local' && (
              <FieldGroup>
                <SectionTitle>本地存储</SectionTitle>
                {text(
                  'localRoot',
                  '存储目录',
                  '留空使用数据目录下的 storage。目录位于运行服务的服务器上。',
                  '/var/lib/stackpanel/storage',
                  false,
                  1024,
                )}
                {text('publicBaseUrl', '公开访问前缀', '用于生成文件的访问地址。', '/storage')}
              </FieldGroup>
            )}
            {draft.kind === 's3' && (
              <>
                <FieldGroup>
                  <SectionTitle>连接配置</SectionTitle>
                  <FieldDescription>
                    支持 AWS S3、MinIO、Cloudflare R2 和兼容 S3 协议的对象存储。
                  </FieldDescription>
                  {text(
                    's3Endpoint',
                    '端点地址',
                    'AWS S3 可留空，其他服务填写其 S3 API 端点。',
                    'https://s3.example.com',
                  )}
                  {text(
                    's3Region',
                    '区域',
                    '填写服务商提供的区域；R2 通常使用 auto。',
                    'us-east-1',
                    false,
                    64,
                  )}
                  {text('s3Bucket', '存储桶', undefined, 'your-bucket', false, 255)}
                  <Field>
                    <Label htmlFor="storage-addressing">寻址方式</Label>
                    <Select
                      id="storage-addressing"
                      value={String(draft.s3ForcePathStyle)}
                      onChange={(event) =>
                        update('s3ForcePathStyle', event.target.value === 'true')
                      }
                    >
                      <option value="true">Path-style（MinIO / 自建网关）</option>
                      <option value="false">Virtual-hosted（AWS / R2）</option>
                    </Select>
                  </Field>
                </FieldGroup>
                <FieldGroup>
                  <SectionTitle>访问密钥</SectionTitle>
                  <FieldDescription>
                    {config.hasCredentials
                      ? '已配置访问密钥，留空保留原值。密钥不会回显。'
                      : '密钥将加密保存，不会在读取配置时返回。'}
                  </FieldDescription>
                  {!config.secretsAvailable && (
                    <FieldError>
                      密钥存储尚未启用，请先在服务器配置 SETTINGS_ENCRYPTION_KEY 后重启服务。
                    </FieldError>
                  )}
                  {text(
                    'accessKeyId',
                    'Access Key ID',
                    undefined,
                    config.hasCredentials ? '已配置，留空保留' : '输入 Access Key ID',
                    true,
                    255,
                  )}
                  {text(
                    'secretAccessKey',
                    'Secret Access Key',
                    undefined,
                    config.hasCredentials ? '已配置，留空保留' : '输入 Secret Access Key',
                    true,
                    255,
                  )}
                </FieldGroup>
                <FieldGroup>
                  <SectionTitle>文件访问</SectionTitle>
                  {text(
                    'publicBaseUrl',
                    '公开访问基址',
                    '可填写 CDN 或自定义域名，留空从端点和存储桶推导。',
                    'https://cdn.example.com',
                  )}
                </FieldGroup>
              </>
            )}
            {draft.kind === 'http' && (
              <>
                <FieldGroup>
                  <SectionTitle>上传与读取</SectionTitle>
                  <FieldDescription>文件经服务器转发至图床，不支持预签名直传。</FieldDescription>
                  {text(
                    'httpUploadUrl',
                    '上传地址',
                    undefined,
                    'https://img.example.com/api/upload',
                  )}
                  {text(
                    'httpPublicBaseUrl',
                    '读取基址',
                    '文件地址为读取基址与对象键的组合。',
                    'https://img.example.com/files',
                  )}
                  <Field>
                    <Label htmlFor="storage-method">上传方式</Label>
                    <Select
                      id="storage-method"
                      value={draft.httpMethod}
                      onChange={(event) =>
                        update('httpMethod', event.target.value as Config['httpMethod'])
                      }
                    >
                      <option value="PUT">PUT · 原始文件内容</option>
                      <option value="POST">POST · 表单上传</option>
                    </Select>
                  </Field>
                  {draft.httpMethod === 'POST' &&
                    text('httpFieldName', '文件字段名', '留空使用 file。', 'file', false, 128)}
                </FieldGroup>
                <FieldGroup>
                  <SectionTitle>请求设置</SectionTitle>
                  <Field>
                    <Label htmlFor="storage-headers">附加请求头</Label>
                    <textarea
                      id="storage-headers"
                      value={draft.httpHeaders}
                      onChange={(event) => update('httpHeaders', event.target.value)}
                      rows={4}
                      maxLength={4096}
                      placeholder={'Authorization: Bearer <token>'}
                      className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <FieldDescription>
                      每行一个请求头，格式为 Header:
                      value。这些内容属于普通配置，请使用权限受限的凭据。
                    </FieldDescription>
                  </Field>
                  {text(
                    'httpDeleteUrlTemplate',
                    '删除地址模板',
                    '可用 {key} 代入对象键。留空向文件读取地址发送 DELETE 请求。',
                    'https://img.example.com/api/delete/{key}',
                  )}
                </FieldGroup>
              </>
            )}
          </div>
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!action || saving || testing}>
            {saving && <LoaderCircle className="animate-spin" data-icon="inline-start" />}
            {saving ? '保存中…' : '保存配置'}
          </Button>
          {!edited && state && (
            <span role="status" className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Check className="size-4" />
              {state}
            </span>
          )}
          {!action && <FieldError>当前无法保存配置，请检查权限或重新登录。</FieldError>}
        </div>
      </form>
      <div className="flex flex-col gap-3 border-t pt-6">
        <SectionTitle>连接测试</SectionTitle>
        <p className="text-sm text-muted-foreground">
          测试已保存的配置。
          {edited ? '当前有未保存的修改，请先保存再测试。' : '测试通过仅表示当前连接可用。'}
        </p>
        <div>
          <Button
            variant="outline"
            type="button"
            onClick={testConnection}
            disabled={!canTest || edited || saving || testing}
          >
            {testing ? (
              <LoaderCircle className="animate-spin" data-icon="inline-start" />
            ) : (
              <PlugZap data-icon="inline-start" />
            )}
            {testing ? '测试中…' : '测试连接'}
          </Button>
        </div>
        {test &&
          (test.ok ? (
            <p role="status" className="text-sm text-muted-foreground">
              {test.message}
            </p>
          ) : (
            <FieldError>{test.message}</FieldError>
          ))}
      </div>
    </section>
  );
}

function StorageAdminPage(props: AdminPageComponentProps): ReactElement {
  const config = (props.data.storageConfig as AdminConfigData | undefined)?.config;
  return (
    <div className="flex w-full flex-col gap-8">
      {!props.embedded && <PageHeader title="存储" />}
      {config ? (
        <ConfigForm
          config={config}
          action={props.actions?.['storage.save-config']}
          canTest={!!props.actions?.['storage.test-connection']}
        />
      ) : (
        <p role="alert" className="text-sm text-muted-foreground">
          存储配置暂时无法加载，请刷新重试。
        </p>
      )}
    </div>
  );
}
export const adminPages = { 'admin/storage': StorageAdminPage } as const;
