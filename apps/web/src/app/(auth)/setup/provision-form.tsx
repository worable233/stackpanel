'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Layers, LoaderCircle, ServerCog } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Field, FieldDescription, FieldError, FieldGroup } from '@/components/ui/field';
import { useTranslator } from '@/i18n/provider';
import { submitBootstrapAction } from '@/lib/actions';
import { Select } from '@stackpanel/ui';

/**
 * Infrastructure bootstrap form (BOOTSTRAP-R1/R8).
 *
 * Two rules shape this component:
 *
 * 1. It never waits on the migration. `POST /setup/provision` returns 202 as
 *    soon as the candidate is queued; the runner performs validation, the
 *    migration and the first normal start. The form therefore polls
 *    `GET /setup/status` and renders the phase.
 * 2. It offers no action that the server would refuse. `canSubmit` is derived
 *    from the phase, so `validating`/`queued`/`migrating`/`starting` show
 *    read-only progress rather than a dead form.
 */
export function ProvisionForm({
  canSubmit,
  failed = false,
  diagnosticsRequired = false,
}: {
  canSubmit: boolean;
  failed?: boolean;
  /**
   * `true` when the runner classified the failure as requiring manual work
   * (unknown non-empty database, failed migration record, …). The form then
   * stops offering the submit button instead of inviting a retry that the
   * server would refuse or that would corrupt an existing schema (R6).
   */
  diagnosticsRequired?: boolean;
}) {
  const t = useTranslator();
  const [token, setToken] = useState('');
  const [databaseUrl, setDatabaseUrl] = useState('');
  const [redisUrl, setRedisUrl] = useState('');
  const [driver, setDriver] = useState<'s3' | 'local'>('s3');
  const [endpoint, setEndpoint] = useState('');
  const [region, setRegion] = useState('us-east-1');
  const [bucket, setBucket] = useState('');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [forcePathStyle, setForcePathStyle] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Stable across re-renders: the idempotency key must identify THIS attempt,
  // so a retried submission is a replay rather than a second operation.
  const idempotencyKey = useRef<string>(crypto.randomUUID());

  // While an operation is in flight the server owns the truth; poll it.
  // A diagnostics-required failure is terminal for this page: reloading cannot
  // change it, so it must not poll forever.
  const polling = !canSubmit && !diagnosticsRequired;
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => {
      // A reload re-runs the server component and re-reads the phase.
      // Avoid client fetch here: the page must work before the API can serve
      // authenticated data, and the server component already holds the state.
      window.location.reload();
    }, 5000);
    return () => clearInterval(timer);
  }, [polling]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFailure(null);

    if (!token.trim()) {
      setError(t('auth.setup.provision.errorToken'));
      return;
    }
    if (!databaseUrl.trim()) {
      setError(t('auth.setup.provision.errorDatabase'));
      return;
    }

    const config: Record<string, string> = {
      DATABASE_URL: databaseUrl.trim(),
      STORAGE_DRIVER: driver,
    };
    if (redisUrl.trim()) config['REDIS_URL'] = redisUrl.trim();
    if (driver === 's3') {
      if (endpoint.trim()) config['STORAGE_S3_ENDPOINT'] = endpoint.trim();
      if (region.trim()) config['STORAGE_S3_REGION'] = region.trim();
      if (bucket.trim()) config['STORAGE_S3_BUCKET'] = bucket.trim();
      if (accessKeyId.trim()) config['STORAGE_S3_ACCESS_KEY_ID'] = accessKeyId.trim();
      if (secretAccessKey) config['STORAGE_S3_SECRET_ACCESS_KEY'] = secretAccessKey;
      config['STORAGE_S3_FORCE_PATH_STYLE'] = forcePathStyle ? 'true' : 'false';
    }

    setPending(true);
    const result = await submitBootstrapAction({
      setupToken: token.trim(),
      idempotencyKey: idempotencyKey.current,
      config,
    });
    setPending(false);

    if (!result.ok) {
      // The action returns a message-catalog key, never a raw server message:
      // that keeps driver errors and DSNs out of the browser entirely.
      setError(t(result.error));
      if (result.failure) setFailure(result.failure);
      return;
    }
    // Queued: reload so the server component renders the next phase.
    window.location.reload();
  }

  return (
    <div className="relative isolate flex min-h-svh w-full flex-col overflow-x-clip">
      <header className="mx-auto flex w-full max-w-5xl items-center gap-2.5 px-6 py-7 font-medium tracking-tight sm:px-10">
        <Layers className="size-7 text-primary" aria-hidden />
        <span>StackPanel</span>
      </header>

      <div className="mx-auto flex w-full max-w-lg flex-1 items-center px-6 py-12">
        <section className="w-full" aria-labelledby="provision-heading">
          <div className="mb-8 flex items-start gap-3">
            <ServerCog className="mt-1 size-6 shrink-0 text-primary" aria-hidden />
            <div>
              <h1 id="provision-heading" className="text-2xl font-medium tracking-tight">
                {canSubmit
                  ? t('auth.setup.provision.title')
                  : diagnosticsRequired
                    ? t('auth.setup.provision.titleBlocked')
                    : t('auth.setup.provision.titleProgress')}
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                {canSubmit
                  ? t('auth.setup.provision.desc')
                  : diagnosticsRequired
                    ? t('auth.setup.provision.descBlocked')
                    : t('auth.setup.provision.descProgress')}
              </p>
            </div>
          </div>

          {failed && (
            <Notice tone="error">
              {t('auth.setup.provision.failed')}
            </Notice>
          )}

          {diagnosticsRequired && (
            <Notice tone="error">{t('auth.setup.provision.diagnosticsRequired')}</Notice>
          )}

          {polling && (
            <div className="mb-6 flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
              {t('auth.setup.provision.progress')}
            </div>
          )}

          <form onSubmit={submit} className="flex flex-col gap-6" aria-busy={pending}>
            <FieldGroup>
              <Field>
                <Label htmlFor="provision-token">{t('auth.setup.provision.token')}</Label>
                <Input
                  id="provision-token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  disabled={!canSubmit || pending}
                  autoComplete="off"
                  spellCheck={false}
                />
                <FieldDescription>
                  {t('auth.setup.provision.tokenHint')}
                </FieldDescription>
              </Field>

              <Field>
                <Label htmlFor="provision-database">{t('auth.setup.provision.database')}</Label>
                <Input
                  id="provision-database"
                  value={databaseUrl}
                  onChange={(e) => setDatabaseUrl(e.target.value)}
                  disabled={!canSubmit || pending}
                  placeholder="postgresql://user:pass@127.0.0.1:5432/stackpanel"
                  spellCheck={false}
                />
                <FieldDescription>
                  {t('auth.setup.provision.databaseHint')}
                </FieldDescription>
              </Field>

              <Field>
                <Label htmlFor="provision-redis">{t('auth.setup.provision.redis')}</Label>
                <Input
                  id="provision-redis"
                  value={redisUrl}
                  onChange={(e) => setRedisUrl(e.target.value)}
                  disabled={!canSubmit || pending}
                  placeholder="redis://127.0.0.1:6379"
                  spellCheck={false}
                />
                <FieldDescription>{t('auth.setup.provision.redisHint')}</FieldDescription>
              </Field>

              <Field>
                <Label htmlFor="provision-driver">{t('auth.setup.provision.storage')}</Label>
                <Select
                  id="provision-driver"
                  className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                  value={driver}
                  onChange={(e) => setDriver(e.target.value as 's3' | 'local')}
                  disabled={!canSubmit || pending}
                >
                  <option value="s3">{t('auth.setup.provision.driverS3')}</option>
                  <option value="local">{t('auth.setup.provision.driverLocal')}</option>
                </Select>
              </Field>

              {driver === 's3' && (
                <>
                  <Field>
                    <Label htmlFor="provision-s3-endpoint">{t('auth.setup.provision.endpoint')}</Label>
                    <Input
                      id="provision-s3-endpoint"
                      value={endpoint}
                      onChange={(e) => setEndpoint(e.target.value)}
                      disabled={!canSubmit || pending}
                      placeholder="https://s3.example.com"
                      spellCheck={false}
                    />
                  </Field>
                  <Field>
                    <Label htmlFor="provision-s3-region">{t('auth.setup.provision.region')}</Label>
                    <Input
                      id="provision-s3-region"
                      value={region}
                      onChange={(e) => setRegion(e.target.value)}
                      disabled={!canSubmit || pending}
                      spellCheck={false}
                    />
                  </Field>
                  <Field>
                    <Label htmlFor="provision-s3-bucket">{t('auth.setup.provision.bucket')}</Label>
                    <Input
                      id="provision-s3-bucket"
                      value={bucket}
                      onChange={(e) => setBucket(e.target.value)}
                      disabled={!canSubmit || pending}
                      spellCheck={false}
                    />
                    <FieldDescription>{t('auth.setup.provision.bucketHint')}</FieldDescription>
                  </Field>
                  <Field>
                    <Label htmlFor="provision-s3-key">{t('auth.setup.provision.accessKey')}</Label>
                    <Input
                      id="provision-s3-key"
                      value={accessKeyId}
                      onChange={(e) => setAccessKeyId(e.target.value)}
                      disabled={!canSubmit || pending}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </Field>
                  <Field>
                    <Label htmlFor="provision-s3-secret">{t('auth.setup.provision.secretKey')}</Label>
                    <Input
                      id="provision-s3-secret"
                      type="password"
                      value={secretAccessKey}
                      onChange={(e) => setSecretAccessKey(e.target.value)}
                      disabled={!canSubmit || pending}
                      autoComplete="off"
                    />
                  </Field>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={forcePathStyle}
                      onChange={(e) => setForcePathStyle(e.target.checked)}
                      disabled={!canSubmit || pending}
                    />
                    {t('auth.setup.provision.forcePathStyle')}
                  </label>
                </>
              )}
            </FieldGroup>

            {error && <FieldError>{error}</FieldError>}
            {failure && (
              <Notice tone="error">
                {t('auth.setup.provision.failurePrefix')}<code>{failure}</code>
              </Notice>
            )}

            {canSubmit && (
              <Button type="submit" disabled={pending}>
                {pending ? t('auth.setup.provision.submitting') : t('auth.setup.provision.submit')}
              </Button>
            )}
          </form>
        </section>
      </div>
    </div>
  );
}

/** Inline notice used for retryable, non-secret errors. */
function Notice({ tone, children }: { tone: 'error' | 'info'; children: React.ReactNode }) {
  const className =
    tone === 'error'
      ? 'rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive'
      : 'rounded-md border px-3 py-2 text-sm text-muted-foreground';
  return <div className={`mb-6 ${className}`}>{children}</div>;
}
