import { describe, expect, it } from 'vitest';
import { isPluginError } from '@stackpanel/sdk';
import {
  DEFAULT_LOGIN_CONFIG,
  emailRegistrationOpen,
  emailVerificationEnabled,
  loginConfigSchema,
  registrationOpen,
  verificationUnavailable,
} from '../../../../packages/plugins/login/src/policy.ts';

/**
 * Registration policy is the "can a stranger create an account?" switch, so it
 * is tested here rather than only through the plugin's HTTP surface: these are
 * pure decisions and each one maps to a distinct refusal the UI shows.
 */
describe('registration policy schema', () => {
  it('parses from an absent body with the documented defaults', () => {
    const parsed = loginConfigSchema.parse({});
    expect(parsed).toEqual({ registrationMethods: ['email'], emailVerificationRequired: false });
    expect(parsed).toEqual(DEFAULT_LOGIN_CONFIG);
  });

  it('accepts an empty method list as "registration closed"', () => {
    // The previous `.min(1)` rejected this, which made closing registration
    // impossible from the admin page.
    const parsed = loginConfigSchema.parse({ registrationMethods: [] });
    expect(parsed.registrationMethods).toEqual([]);
    expect(registrationOpen(parsed)).toBe(false);
  });

  it('rejects an unknown registration method', () => {
    expect(loginConfigSchema.safeParse({ registrationMethods: ['telepathy'] }).success).toBe(false);
  });
});

describe('registrationOpen', () => {
  it('is open by default', () => {
    expect(registrationOpen(DEFAULT_LOGIN_CONFIG)).toBe(true);
  });

  it('is closed only when no method is offered', () => {
    expect(registrationOpen({ registrationMethods: [] })).toBe(false);
    expect(registrationOpen({ registrationMethods: ['phone'] })).toBe(true);
  });
});

describe('emailRegistrationOpen', () => {
  it('follows the presence of the email method', () => {
    expect(emailRegistrationOpen({ registrationMethods: ['email'] })).toBe(true);
    expect(emailRegistrationOpen({ registrationMethods: ['email', 'phone'] })).toBe(true);
    expect(emailRegistrationOpen({ registrationMethods: ['phone'] })).toBe(false);
    expect(emailRegistrationOpen({ registrationMethods: [] })).toBe(false);
  });
});

describe('verification availability', () => {
  it('treats a requirement without a delivery channel as unavailable', () => {
    // This is the fail-closed case: the operator asked for verified emails but
    // SMTP is gone. Registration must refuse rather than let accounts in.
    expect(verificationUnavailable({ emailVerificationRequired: true }, false)).toBe(true);
    expect(emailVerificationEnabled({ emailVerificationRequired: true }, false)).toBe(false);
  });

  it('satisfies the requirement when a channel exists', () => {
    expect(verificationUnavailable({ emailVerificationRequired: true }, true)).toBe(false);
    expect(emailVerificationEnabled({ emailVerificationRequired: true }, true)).toBe(true);
  });

  it('never blocks when verification is not requested', () => {
    expect(verificationUnavailable({ emailVerificationRequired: false }, false)).toBe(false);
    expect(emailVerificationEnabled({ emailVerificationRequired: false }, true)).toBe(false);
  });

  it('keeps "closed registration" and "unverifiable" independent', () => {
    // Closed registration refuses first (403); the 503 branch must not shadow it
    // with a "no mail channel" message when nobody may register anyway.
    const closed = loginConfigSchema.parse({ registrationMethods: [] });
    expect(registrationOpen(closed)).toBe(false);
    expect(verificationUnavailable(closed, false)).toBe(false);
  });
});

describe('plugin policy module is importable from the kernel test runner', () => {
  it('does not throw plugin-context errors at import time', () => {
    expect(isPluginError(new Error('plain'))).toBe(false);
  });
});
