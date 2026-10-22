import { beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '@stackpanel/sdk';

const mocks = vi.hoisted(() => ({ submitBootstrap: vi.fn() }));

vi.mock('@/lib/api', () => ({ getApiClient: () => ({ submitBootstrap: mocks.submitBootstrap }) }));

import { submitBootstrapAction } from '@/lib/actions';

/**
 * BOOTSTRAP-R1/R8: the server action maps the API's *stable error codes* to
 * i18n keys. It must never forward a raw driver message — the probe failure
 * class is the only detail the operator sees.
 */

const input = {
  setupToken: 'token-0123456789abcdef',
  idempotencyKey: 'key-0123456789abcdef',
  config: { DATABASE_URL: 'postgresql://u:p@h:5432/db' },
};

beforeEach(() => {
  vi.clearAllMocks();
});

it('returns ok when the API accepts the operation', async () => {
  mocks.submitBootstrap.mockResolvedValue({ operation: { phase: 'queued' } });
  await expect(submitBootstrapAction(input)).resolves.toEqual({ ok: true });
  expect(mocks.submitBootstrap).toHaveBeenCalledWith(input);
});

it.each([
  ['bootstrap.token_invalid', 'auth.setup.provision.errorTokenInvalid'],
  ['bootstrap.not_writable', 'auth.setup.provision.errorNotWritable'],
  ['bootstrap.idempotency_conflict', 'auth.setup.provision.errorConflict'],
  ['bootstrap.invalid_config', 'auth.setup.provision.errorInvalidConfig'],
  ['bootstrap.something_new', 'auth.setup.provision.errorGeneric'],
])('maps %s without leaking the server message', async (code, expected) => {
  mocks.submitBootstrap.mockRejectedValue(
    new ApiError('postgresql://stackpanel:hunter2@db/db failed', {
      status: 409,
      code,
      details: { error: 'postgresql://stackpanel:hunter2@db/db failed', code },
    }),
  );
  const result = await submitBootstrapAction(input);
  expect(result).toEqual({ ok: false, error: expected });
  expect(JSON.stringify(result)).not.toContain('hunter2');
});

it('passes the probe failure class through, but nothing else', async () => {
  mocks.submitBootstrap.mockRejectedValue(
    new ApiError('probe failed', {
      status: 422,
      code: 'bootstrap.probe_failed',
      details: {
        error: 'postgresql://u:p@h/db',
        code: 'bootstrap.probe_failed',
        failure: 'database_permission_denied',
        detail: 'password authentication failed for user "u"',
      },
    }),
  );
  await expect(submitBootstrapAction(input)).resolves.toEqual({
    ok: false,
    error: 'auth.setup.provision.errorProbe',
    failure: 'database_permission_denied',
  });
});

it('distinguishes an unreachable API from a rejected submission', async () => {
  mocks.submitBootstrap.mockRejectedValue(
    new ApiError('网络请求失败', { status: 0, code: 'network' }),
  );
  await expect(submitBootstrapAction(input)).resolves.toEqual({
    ok: false,
    error: 'auth.setup.provision.errorUnreachable',
  });
});
