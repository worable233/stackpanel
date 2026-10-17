import { beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '@stackpanel/sdk';
const mocks = vi.hoisted(() => ({ completeSetup: vi.fn(), setCookie: vi.fn(), redirect: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: mocks.setCookie }) }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/i18n/locale', () => ({ getLocale: async () => 'zh-CN' }));
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ completeSetup: mocks.completeSetup }) }));
vi.mock('@/lib/api-errors', () => ({ apiErrorMessage: async (error: Error) => error.message }));
import { setupAction } from '@/lib/actions';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.completeSetup.mockResolvedValue({ token: 'setup-session', user: { role: 'ADMIN' } });
  mocks.redirect.mockImplementation((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  });
});
function form(token?: string) {
  const data = new FormData();
  data.set('email', ' owner@example.com ');
  data.set('password', 'ExamplePass123!');
  if (token) data.set('setupToken', token);
  return data;
}
it('writes the existing secure session cookie and allows the successful redirect to propagate', async () => {
  await expect(setupAction({}, form())).rejects.toThrow('REDIRECT:/admin');
  expect(mocks.completeSetup).toHaveBeenCalledWith({
    email: 'owner@example.com',
    password: 'ExamplePass123!',
  });
  expect(mocks.setCookie).toHaveBeenCalledWith(
    expect.any(String),
    'setup-session',
    expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }),
  );
});
it('passes the trimmed one-time token only when supplied', async () => {
  await expect(setupAction({}, form(' token-example '))).rejects.toThrow('REDIRECT:/admin');
  expect(mocks.completeSetup.mock.calls[0]?.[0].setupToken).toBe('token-example');
});
it('returns token errors without creating a session', async () => {
  mocks.completeSetup.mockRejectedValue(
    new ApiError('初始化令牌无效', { status: 401, code: 'setup.token_invalid' }),
  );
  expect(await setupAction({}, form('wrong'))).toEqual({ error: '初始化令牌无效' });
  expect(mocks.setCookie).not.toHaveBeenCalled();
  expect(mocks.redirect).not.toHaveBeenCalled();
});
it.each(['setup.already_completed', 'setup.disabled'])(
  'redirects away when the wizard is no longer available: %s',
  async (code) => {
    mocks.completeSetup.mockRejectedValue(new ApiError('unavailable', { status: 409, code }));
    await expect(setupAction({}, form())).rejects.toThrow('REDIRECT:/login');
    expect(mocks.setCookie).not.toHaveBeenCalled();
  },
);
it('rejects short passwords before contacting the API', async () => {
  const data = form();
  data.set('password', 'short');
  expect(await setupAction({}, data)).toHaveProperty('error');
  expect(mocks.completeSetup).not.toHaveBeenCalled();
});
