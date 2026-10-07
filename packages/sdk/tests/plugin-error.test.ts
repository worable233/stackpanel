import { describe, expect, it } from 'vitest';
import {
  ExtensionValidationError,
  PluginError,
  isExtensionNotFound,
  isExtensionVersionConflict,
  isPluginError,
} from '../src/index.js';

/**
 * The kernel loads plugin bundles through a cache-busted URL
 * (`file://…/dist/index.js?v=<timestamp>`) and plugin bundles import
 * `@stackpanel/sdk` themselves. Under a dev loader (tsx) that combination can
 * resolve to a *distinct* `PluginError` class object from the kernel's own
 * import, so `instanceof PluginError` returns false for a genuinely branded
 * plugin error. That silently demoted deterministic 4xx (e.g. wrong-password
 * 401) to a generic 500. These tests pin the brand-based guard that fixes it.
 */
describe('isPluginError', () => {
  it('recognises a real PluginError', () => {
    expect(isPluginError(new PluginError('auth.invalid_credentials', 401, '邮箱或密码错误'))).toBe(
      true,
    );
  });

  it('recognises subclasses that inherit the brand', () => {
    expect(isPluginError(new ExtensionValidationError('bad field'))).toBe(true);
  });

  it('rejects plain errors, non-objects, and error-like impostors', () => {
    expect(isPluginError(new Error('boom'))).toBe(false);
    expect(isPluginError(undefined)).toBe(false);
    expect(isPluginError(null)).toBe(false);
    expect(isPluginError('PluginError')).toBe(false);
    expect(isPluginError({ name: 'PluginError', code: 'x', status: 400 })).toBe(false);
  });

  it('recognises a plugin error minted by a *different* copy of the class', () => {
    // Simulate module duplication: a class with the same shape but a distinct
    // identity, carrying the non-enumerable brand on its prototype.
    class DuplicatedPluginError extends Error {
      readonly code = 'auth.invalid_credentials';
      readonly status = 401;
    }
    Object.defineProperty(DuplicatedPluginError.prototype, '__stackpanelPluginError', {
      value: true,
    });
    const foreign = new DuplicatedPluginError('auth.invalid_credentials');

    expect(foreign instanceof PluginError).toBe(false); // the bug: instanceof fails
    expect(isPluginError(foreign)).toBe(true); // the guard: brand succeeds
    expect(isPluginError(foreign) && foreign.status).toBe(401);
  });

  it('narrows extension subclasses across a duplicated class identity', () => {
    class ForeignExtensionNotFound extends Error {
      readonly code = 'extension.not_found';
      readonly status = 404;
    }
    Object.defineProperty(ForeignExtensionNotFound.prototype, '__stackpanelPluginError', {
      value: true,
    });
    Object.defineProperty(ForeignExtensionNotFound.prototype, '__stackpanelSdkError', {
      value: 'ExtensionNotFound',
    });

    const foreign = new ForeignExtensionNotFound();
    expect(isExtensionNotFound(foreign)).toBe(true);
    expect(isExtensionVersionConflict(foreign)).toBe(false);
  });
});
