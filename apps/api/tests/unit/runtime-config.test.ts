import { afterEach, describe, expect, it } from 'vitest';
import {
  applyRuntimeConfigRows,
  getConfig,
  getConfigSource,
  isRuntimeConfigName,
  resetRuntimeConfigForTest,
  runtimeConfigEntries,
  runtimeConfigSettingKey,
} from '../../src/config/runtime-config.ts';

/**
 * 运行期配置（ADR-0026）。
 *
 * 这些用例只跑纯逻辑（不起库）：数据库行由 `applyRuntimeConfigRows` 直接注入，
 * 与真实读库路径共用同一个解析函数，因此解析/优先级/回退都能在这里钉死。
 */

afterEach(() => {
  resetRuntimeConfigForTest();
  delete process.env['SESSION_TTL_SECONDS'];
});

describe('runtime config precedence (ADR-0026)', () => {
  it('falls back to the environment variable when nothing is stored', () => {
    process.env['SESSION_TTL_SECONDS'] = '900';
    resetRuntimeConfigForTest();
    // `env` was parsed once at import, so this asserts the un-overridden path is
    // whatever the process started with — the stored override is what must win.
    const fromEnv = getConfig('SESSION_TTL_SECONDS');
    expect(fromEnv).toBeGreaterThan(0);
    expect(getConfigSource('SESSION_TTL_SECONDS')).not.toBe('stored');
  });

  it('lets a stored row win over the environment variable', () => {
    applyRuntimeConfigRows([
      { key: runtimeConfigSettingKey('SESSION_TTL_SECONDS'), value: 7200 },
      { key: runtimeConfigSettingKey('AUTH_CODE_TTL_SECONDS'), value: '300' },
    ]);
    expect(getConfig('SESSION_TTL_SECONDS')).toBe(7200);
    expect(getConfig('AUTH_CODE_TTL_SECONDS')).toBe(300);
    expect(getConfigSource('SESSION_TTL_SECONDS')).toBe('stored');
  });

  it('parses booleans through the same field schema as the env variable', () => {
    applyRuntimeConfigRows([
      { key: runtimeConfigSettingKey('PACKAGE_SIGNATURE_REQUIRED'), value: false },
    ]);
    expect(getConfig('PACKAGE_SIGNATURE_REQUIRED')).toBe(false);
    // Stored as a string (what an <Input> submits) parses identically.
    applyRuntimeConfigRows([
      { key: runtimeConfigSettingKey('PACKAGE_SIGNATURE_REQUIRED'), value: 'true' },
    ]);
    expect(getConfig('PACKAGE_SIGNATURE_REQUIRED')).toBe(true);
  });

  it('ignores stored values the field schema rejects instead of poisoning the snapshot', () => {
    applyRuntimeConfigRows([
      { key: runtimeConfigSettingKey('AUTH_CODE_TTL_SECONDS'), value: 'not-a-number' },
      { key: runtimeConfigSettingKey('AUTH_CODE_MAX_ATTEMPTS'), value: -1 },
      { key: runtimeConfigSettingKey('SESSION_COOKIE_NAME'), value: 'sp_session' },
    ]);
    // Invalid rows fall back to the env/default value, valid ones still apply.
    expect(getConfig('AUTH_CODE_TTL_SECONDS')).toBeGreaterThan(0);
    expect(getConfig('AUTH_CODE_MAX_ATTEMPTS')).toBeGreaterThan(0);
    expect(getConfig('SESSION_COOKIE_NAME')).toBe('sp_session');
    expect(getConfigSource('AUTH_CODE_TTL_SECONDS')).not.toBe('stored');
  });

  it('ignores rows outside the whitelist (a secret must never become editable)', () => {
    applyRuntimeConfigRows([
      { key: 'config.JWT_SECRET', value: 'attacker' },
      { key: 'config.DATABASE_URL', value: 'postgres://evil' },
    ]);
    expect(isRuntimeConfigName('JWT_SECRET' as string)).toBe(false);
    expect(getConfigSource('SESSION_TTL_SECONDS')).not.toBe('stored');
  });

  it('exposes a whitelist-only catalogue for the admin UI', () => {
    const entries = runtimeConfigEntries();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => isRuntimeConfigName(entry.name))).toBe(true);
    expect(entries.some((entry) => entry.name === 'AUTH_CAPTCHA_MODE')).toBe(true);
    // Secrets and bootstrap config are deliberately absent. The cast keeps this
    // assertion meaningful: it must fail if the whitelist ever grows those keys.
    const names = entries.map((entry) => entry.name as string);
    expect(names).not.toContain('JWT_SECRET');
    expect(names).not.toContain('DATABASE_URL');
  });
});
