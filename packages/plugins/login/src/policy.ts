import { z } from 'zod';

/**
 * Registration policy decisions, kept free of plugin context so they can be
 * unit-tested directly.
 *
 * The rules here are the ones that decide whether a stranger can create an
 * account, so they must not be entangled with `ctx`: every function takes the
 * facts it needs and returns a decision.
 */

export const registrationMethodSchema = z.enum(['email', 'phone']);

export const loginConfigSchema = z.object({
  /**
   * Which registration methods the deployment offers. An **empty list is valid**
   * and means "registration is closed": operators routinely need that switch
   * (private instances, invite-only launches), and a `.min(1)` here made closing
   * registration impossible — the admin form could only disable its own save
   * button.
   */
  registrationMethods: z.array(registrationMethodSchema).max(2).default(['email']),
  emailVerificationRequired: z.boolean().default(false),
});

/** Stored registration policy. */
export type LoginConfig = z.infer<typeof loginConfigSchema>;

/** First-run default, independent of deployment env. */
export const DEFAULT_LOGIN_CONFIG: LoginConfig = {
  registrationMethods: ['email'],
  emailVerificationRequired: false,
};

/** Whether the deployment accepts new accounts at all (empty list = closed). */
export function registrationOpen(config: { registrationMethods: readonly string[] }): boolean {
  return config.registrationMethods.length > 0;
}

/** Whether the email form of registration is offered. */
export function emailRegistrationOpen(config: { registrationMethods: readonly string[] }): boolean {
  return config.registrationMethods.includes('email');
}

/**
 * "The operator wants verified emails, but nothing can deliver a code."
 *
 * This is the state the previous implementation hid: it reported verification as
 * *off* and let accounts in unverified. Registration refuses instead, so the
 * operator's intent can never silently degrade into an open door.
 */
export function verificationUnavailable(
  config: { emailVerificationRequired: boolean },
  deliveryAvailable: boolean,
): boolean {
  return config.emailVerificationRequired && !deliveryAvailable;
}

/** Effective verification requirement: requested AND deliverable. */
export function emailVerificationEnabled(
  config: { emailVerificationRequired: boolean },
  deliveryAvailable: boolean,
): boolean {
  return config.emailVerificationRequired && deliveryAvailable;
}
