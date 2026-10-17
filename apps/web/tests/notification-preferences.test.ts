import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NotificationPolicyView, NotificationPreferencesView } from '@stackpanel/sdk';
const auth = vi.hoisted(() => ({ token: 'test-session' as string | null }));
vi.mock('@/lib/auth', () => ({ getSessionToken: async () => auth.token }));
vi.mock('@/i18n/locale', () => ({ getLocale: async () => 'zh-CN' }));
import { GET, PATCH } from '@/app/api/notifications/preferences/route';
import { POST as reset } from '@/app/api/notifications/preferences/reset/route';
import { GET as getPolicy, PUT } from '@/app/api/admin/notifications/policy/route';
const preferences: NotificationPreferencesView = {
  channels: [{ id: 'inapp', name: '站内通知', inApp: true }],
  categories: [{ id: 'agent', label: 'Agent' }],
  types: [
    {
      type: 'agent.*',
      category: 'agent',
      label: 'Agent 动态',
      description: null,
      configurable: false,
      channels: [{ channelId: 'inapp', enabled: true, defaultEnabled: true, configurable: false }],
    },
  ],
};
const policy: NotificationPolicyView = {
  ...preferences,
  types: [
    {
      type: 'agent.*',
      category: 'agent',
      label: 'Agent 动态',
      enabled: true,
      defaultChannels: [],
      locked: true,
      userConfigurable: true,
    },
  ],
};
const upstream = vi.fn<typeof fetch>();
beforeEach(() => {
  auth.token = 'test-session';
  upstream.mockReset();
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => vi.unstubAllGlobals());
const request = (method: string, body: unknown) =>
  new Request('http://localhost/api/preferences', {
    method,
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
it('reads the runtime catalog, retains locked states, and keeps credentials upstream', async () => {
  upstream.mockResolvedValue(Response.json(preferences));
  const result = await GET();
  expect(await result.json()).toEqual(preferences);
  expect(result.headers.get('cache-control')).toBe('no-store');
  expect(upstream).toHaveBeenCalledWith(
    expect.stringMatching(/\/notifications\/preferences$/),
    expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({ authorization: 'Bearer test-session' }),
    }),
  );
});
it('forwards only the changed channel and returns the server-effective view', async () => {
  upstream.mockResolvedValue(Response.json(preferences));
  const body = { items: [{ type: 'agent.*', channelId: 'inapp', enabled: false }] };
  const result = await PATCH(request('PATCH', body));
  expect(upstream.mock.calls[0]?.[1]).toMatchObject({
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  // The server can ignore a locked channel: do not synthesize an enabled state.
  expect(await result.json()).toEqual(preferences);
});
it('resets via the dedicated endpoint, accepting an empty body', async () => {
  upstream.mockResolvedValue(Response.json(preferences));
  expect((await reset(new Request('http://localhost/api/reset', { method: 'POST' }))).status).toBe(
    200,
  );
  expect(upstream).toHaveBeenCalledWith(
    expect.stringMatching(/\/preferences\/reset$/),
    expect.objectContaining({ method: 'POST', body: '{}' }),
  );
});
it('preserves empty default channels in admin policy', async () => {
  upstream.mockResolvedValue(Response.json(policy));
  expect(await (await getPolicy()).json()).toEqual(policy);
});
it('uses PUT with a partial admin policy patch', async () => {
  upstream.mockResolvedValue(Response.json(policy));
  const body = { types: { 'agent.*': { defaultChannels: [] } } };
  expect((await PUT(request('PUT', body))).status).toBe(200);
  expect(upstream).toHaveBeenCalledWith(
    expect.stringMatching(/\/admin\/notifications\/policy$/),
    expect.objectContaining({ method: 'PUT', body: JSON.stringify(body) }),
  );
});
it.each([
  ['GET preferences', () => GET()],
  ['PATCH preferences', () => PATCH(request('PATCH', {}))],
  ['reset', () => reset(request('POST', {}))],
  ['GET policy', () => getPolicy()],
  ['PUT policy', () => PUT(request('PUT', {}))],
])('returns 401 rather than 500 for anonymous %s', async (_name, call) => {
  auth.token = null;
  expect((await call()).status).toBe(401);
  expect(upstream).not.toHaveBeenCalled();
});
it('preserves upstream 403 for a non-admin', async () => {
  upstream.mockResolvedValue(
    Response.json({ code: 'auth.forbidden', detail: 'Forbidden' }, { status: 403 }),
  );
  expect((await PUT(request('PUT', {}))).status).toBe(403);
});
it('rejects malformed JSON before forwarding', async () => {
  expect(
    (await PATCH(new Request('http://localhost/api/preferences', { method: 'PATCH', body: '{' })))
      .status,
  ).toBe(400);
  expect(upstream).not.toHaveBeenCalled();
});
it('preserves backend validation errors', async () => {
  upstream.mockResolvedValue(Response.json({ error: '请求参数无效' }, { status: 400 }));
  expect((await PATCH(request('PATCH', { items: [] }))).status).toBe(400);
});
it('maps network and invalid response failures to 502 without leaking internals', async () => {
  upstream.mockRejectedValueOnce(new Error('private upstream address'));
  const response = await GET();
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain('private upstream address');
  upstream.mockResolvedValue(Response.json({ types: 'bad catalog' }));
  expect((await GET()).status).toBe(502);
});
