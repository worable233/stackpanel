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
import { messages, t } from './i18n.js';

type Config = AdminConfigData['config'];
/** `value` is the persisted contract; `key` is display copy. */
const KIND_OPTIONS = [
  { value: 'env', key: 'kind.env' },
  { value: 'local', key: 'kind.local' },
  { value: 's3', key: 'kind.s3' },
  { value: 'http', key: 'kind.http' },
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
  tr,
}: {
  config: Config;
  action?: (formData: FormData) => Promise<void>;
  canTest: boolean;
  tr: ReturnType<typeof t>;
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
      if (!draft.s3Bucket.trim()) next.s3Bucket = tr('error.bucketRequired');
      if (draft.s3Endpoint && !httpUrl(draft.s3Endpoint))
        next.s3Endpoint = tr('error.httpUrl');
      if ((draft.accessKeyId || draft.secretAccessKey) && !config.secretsAvailable)
        next.accessKeyId = tr('error.encryptionMissing');
      if (!config.hasCredentials && (!draft.accessKeyId || !draft.secretAccessKey))
        next.secretAccessKey = tr('error.credentialsRequired');
    }
    if (draft.kind === 'http') {
      for (const key of ['httpUploadUrl', 'httpPublicBaseUrl'] as const) {
        if (!httpUrl(draft[key])) next[key] = tr('error.httpUrl');
      }
      if (draft.httpDeleteUrlTemplate && !httpUrl(draft.httpDeleteUrlTemplate))
        next.httpDeleteUrlTemplate = tr('error.httpUrlTemplate');
    }
    if (
      draft.publicBaseUrl &&
      !draft.publicBaseUrl.startsWith('/') &&
      !httpUrl(draft.publicBaseUrl)
    )
      next.publicBaseUrl = tr('error.publicBaseUrl');
    setErrors(next);
    if (Object.keys(next).length) return '';
    // Failure redirects are handled by Next and the host. Never catch a redirect as a normal error.
    await action(formData);
    setDraft((value) => ({ ...value, accessKeyId: '', secretAccessKey: '' }));
    setEdited(false);
    setTest(null);
    return tr('status.saved');
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
        message: ok ? tr('test.ok') : (result.error || tr('test.failed')),
      });
    } catch {
      setTest({ ok: false, message: tr('test.requestFailed') });
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="flex flex-col gap-6">
      <div className="plugin-section flex flex-col gap-1">
        <SectionTitle>{tr('title')}</SectionTitle>
        <p className="text-sm text-muted-foreground">{tr('description')}</p>
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
                <Label htmlFor="storage-kind">{tr('backend.label')}</Label>
                <Select
                  id="storage-kind"
                  value={draft.kind}
                  onChange={(event) => update('kind', event.target.value as Config['kind'])}
                >
                  {KIND_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {tr(option.key)}
                    </option>
                  ))}
                </Select>
                <FieldDescription>
                  {tr('backend.current', {
                    kind: tr(
                      KIND_OPTIONS.find((item) => item.value === config.kind)?.key ?? 'kind.env',
                    ),
                  })}
                </FieldDescription>
              </Field>
              {draft.kind === 'env' && (
                <FieldDescription>{tr('backend.envHint')}</FieldDescription>
              )}
            </FieldGroup>
            {draft.kind === 'local' && (
              <FieldGroup>
                <SectionTitle>{tr('local.title')}</SectionTitle>
                {text(
                  'localRoot',
                  tr('local.root'),
                  tr('local.rootHint'),
                  tr('local.rootPlaceholder'),
                  false,
                  1024,
                )}
                {text(
                  'publicBaseUrl',
                  tr('local.publicBaseUrl'),
                  tr('local.publicBaseUrlHint'),
                  '/storage',
                )}
              </FieldGroup>
            )}
            {draft.kind === 's3' && (
              <>
                <FieldGroup>
                  <SectionTitle>{tr('s3.connectTitle')}</SectionTitle>
                  <FieldDescription>{tr('s3.connectHint')}</FieldDescription>
                  {text(
                    's3Endpoint',
                    tr('s3.endpoint'),
                    tr('s3.endpointHint'),
                    'https://s3.example.com',
                  )}
                  {text(
                    's3Region',
                    tr('s3.region'),
                    tr('s3.regionHint'),
                    'us-east-1',
                    false,
                    64,
                  )}
                  {text(
                    's3Bucket',
                    tr('s3.bucket'),
                    undefined,
                    tr('s3.bucketPlaceholder'),
                    false,
                    255,
                  )}
                  <Field>
                    <Label htmlFor="storage-addressing">{tr('s3.addressing')}</Label>
                    <Select
                      id="storage-addressing"
                      value={String(draft.s3ForcePathStyle)}
                      onChange={(event) =>
                        update('s3ForcePathStyle', event.target.value === 'true')
                      }
                    >
                      <option value="true">{tr('s3.pathStyle')}</option>
                      <option value="false">{tr('s3.virtualHosted')}</option>
                    </Select>
                  </Field>
                </FieldGroup>
                <FieldGroup>
                  <SectionTitle>{tr('s3.keysTitle')}</SectionTitle>
                  <FieldDescription>
                    {config.hasCredentials ? tr('s3.keysConfigured') : tr('s3.keysNew')}
                  </FieldDescription>
                  {!config.secretsAvailable && (
                    <FieldError>{tr('s3.encryptionMissing')}</FieldError>
                  )}
                  {text(
                    'accessKeyId',
                    tr('s3.accessKeyId'),
                    undefined,
                    config.hasCredentials
                      ? tr('s3.accessKeyIdKeep')
                      : tr('s3.accessKeyIdPlaceholder'),
                    true,
                    255,
                  )}
                  {text(
                    'secretAccessKey',
                    tr('s3.secretKey'),
                    undefined,
                    config.hasCredentials
                      ? tr('s3.accessKeyIdKeep')
                      : tr('s3.secretKeyPlaceholder'),
                    true,
                    255,
                  )}
                </FieldGroup>
                <FieldGroup>
                  <SectionTitle>{tr('s3.filesTitle')}</SectionTitle>
                  {text(
                    'publicBaseUrl',
                    tr('s3.publicBaseUrl'),
                    tr('s3.publicBaseUrlHint'),
                    'https://cdn.example.com',
                  )}
                </FieldGroup>
              </>
            )}
            {draft.kind === 'http' && (
              <>
                <FieldGroup>
                  <SectionTitle>{tr('http.uploadTitle')}</SectionTitle>
                  <FieldDescription>{tr('http.uploadHint')}</FieldDescription>
                  {text(
                    'httpUploadUrl',
                    tr('http.uploadUrl'),
                    undefined,
                    'https://img.example.com/api/upload',
                  )}
                  {text(
                    'httpPublicBaseUrl',
                    tr('http.publicBaseUrl'),
                    tr('http.publicBaseUrlHint'),
                    'https://img.example.com/files',
                  )}
                  <Field>
                    <Label htmlFor="storage-method">{tr('http.method')}</Label>
                    <Select
                      id="storage-method"
                      value={draft.httpMethod}
                      onChange={(event) =>
                        update('httpMethod', event.target.value as Config['httpMethod'])
                      }
                    >
                      <option value="PUT">{tr('http.methodPut')}</option>
                      <option value="POST">{tr('http.methodPost')}</option>
                    </Select>
                  </Field>
                  {draft.httpMethod === 'POST' &&
                    text(
                      'httpFieldName',
                      tr('http.fieldName'),
                      tr('http.fieldNameHint'),
                      tr('http.fieldNamePlaceholder'),
                      false,
                      128,
                    )}
                </FieldGroup>
                <FieldGroup>
                  <SectionTitle>{tr('http.requestTitle')}</SectionTitle>
                  <Field>
                    <Label htmlFor="storage-headers">{tr('http.headers')}</Label>
                    <textarea
                      id="storage-headers"
                      value={draft.httpHeaders}
                      onChange={(event) => update('httpHeaders', event.target.value)}
                      rows={4}
                      maxLength={4096}
                      placeholder={'Authorization: Bearer <token>'}
                      className="plugin-input"
                    />
                    <FieldDescription>{tr('http.headersHint')}</FieldDescription>
                  </Field>
                  {text(
                    'httpDeleteUrlTemplate',
                    tr('http.deleteUrl'),
                    tr('http.deleteUrlHint'),
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
            {saving ? tr('save.saving') : tr('save.submit')}
          </Button>
          {!edited && state && (
            <span role="status" className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Check className="size-4" />
              {state}
            </span>
          )}
          {!action && <FieldError>{tr('save.noPermission')}</FieldError>}
        </div>
      </form>
      <div className="plugin-section-top flex flex-col gap-3">
        <SectionTitle>{tr('test.title')}</SectionTitle>
        <p className="text-sm text-muted-foreground">
          {tr('test.description')}
          {edited ? tr('test.dirty') : tr('test.hint')}
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
            {testing ? tr('test.testing') : tr('test.submit')}
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
  const tr = t(props.locale);
  const config = (props.data.storageConfig as AdminConfigData | undefined)?.config;
  return (
    <div className="flex w-full flex-col gap-8">
      {!props.embedded && <PageHeader title={tr('title')} />}
      {config ? (
        <ConfigForm
          config={config}
          action={props.actions?.['storage.save-config']}
          canTest={!!props.actions?.['storage.test-connection']}
          tr={tr}
        />
      ) : (
        <p role="alert" className="text-sm text-muted-foreground">
          {tr('page.unavailable')}
        </p>
      )}
    </div>
  );
}
export const adminPages = { 'admin/storage': StorageAdminPage } as const;
