import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The auth forms have to survive three failure modes that are invisible in a
 * screenshot but make the form look broken:
 *
 *  1. React resets an uncontrolled form when its action returns, so a field the
 *     visitor filled *before* pressing "获取验证码" is wiped — and `required` then
 *     vetoes the real submit on a field that is off-screen. Symptom: the register
 *     button does nothing at all.
 *  2. A throttled request that only says "too often" leaves the visitor guessing;
 *     the kernel's `retryAfterSeconds` has to become a countdown.
 *  3. A human-verification token is single-use. After a rejection the widget must
 *     be re-mounted, otherwise it keeps looking solved while every submit fails.
 *
 * Asserted on the source because these are wiring decisions (which prop is bound,
 * which state the effect writes), not renderable output.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string): string => readFileSync(path.join(root, relative), 'utf8');

const registerForm = read('src/app/(auth)/register/register-form.tsx');
const loginForm = read('src/app/(auth)/login/login-form.tsx');
const resetForm = read('src/app/(auth)/forgot-password/reset-password-form.tsx');
const captchaField = read('src/components/captcha-field.tsx');

describe('auth forms resilience', () => {
  it('binds every typed field so an action cannot wipe it', () => {
    for (const [name, source] of [
      ['register', registerForm],
      ['login', loginForm],
      ['reset', resetForm],
    ] as const) {
      expect(source, `${name} form must define controlled values`).toContain('const [values, setValues]');
      for (const input of ["field('email')", "field('password')"]) {
        expect(source, `${name} form must bind ${input}`).toContain(input);
      }
    }
    for (const input of ["field('code')", "field('confirmPassword')"]) {
      expect(registerForm).toContain(input);
      expect(resetForm).toContain(input);
    }
  });

  it('validates the required fields itself because the widget vetoes native validation', () => {
    // The send-code widget's own checkbox stays `required` after its token is
    // spent, so the sign-up submit is `formNoValidate` and the checks move into
    // the handler — with a message next to the button that refused.
    expect(registerForm).toContain('formNoValidate');
    expect(registerForm).toContain('auth.validation.emailRequired');
    expect(registerForm).toContain('auth.validation.codeRequired');
    expect(registerForm).toContain('setFormError');
  });

  it('turns a throttle into a countdown instead of a dead end', () => {
    expect(loginForm).toContain('state.retryAfterSeconds');
    expect(loginForm).toContain('auth.retryIn');
    // The button must be held until the wait elapses, or each click extends it.
    expect(loginForm).toMatch(/disabled=\{pending \|\| wait > 0\}/);
    expect(registerForm).toContain('codeState.retryAfterSeconds');
    expect(registerForm).toContain('auth.register.resendIn');
  });

  it('unlocks the resend button when the kernel says the code is dead', () => {
    for (const code of ['auth.code_expired', 'auth.code_missing', 'auth.code_invalid']) {
      expect(registerForm, `register form must react to ${code}`).toContain(code);
    }
    expect(registerForm).toContain('setCooldown(0)');
  });

  it('re-mounts the widget after a rejected challenge', () => {
    expect(captchaField).toContain('resetSignal');
    expect(loginForm).toContain('resetSignal={captchaReset}');
    expect(registerForm).toContain('resetSignal={sendCodeCaptchaReset}');
    expect(registerForm).toContain('resetSignal={captchaReset}');
    for (const source of [loginForm, registerForm]) {
      expect(source).toContain("'auth.captcha_failed'");
      expect(source).toContain("'auth.captcha_required'");
    }
  });
});
