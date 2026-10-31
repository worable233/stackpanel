import type { FinderContext, FrontendPackage } from '@stackpanel/sdk';
import { z } from 'zod';
import { messages } from './i18n.js';

/**
 * Response shape of `GET /login/admin/config`.
 *
 * Every field is required of the kernel but optional here: a package can meet an
 * older kernel, and zod strips unknown keys, so a field missing from this schema
 * would silently arrive as `undefined` in the settings component (which is how a
 * panel ends up rendering the wrong switch state).
 */
const configSchema = z.object({
  registrationMethods: z.array(z.enum(['email', 'phone'])),
  registrationEnabled: z.boolean().optional(),
  emailVerificationRequired: z.boolean(),
  emailVerificationSupported: z.boolean().optional(),
  emailVerificationBlocked: z.boolean().optional(),
});

const frontend: FrontendPackage = {
  locales: ['zh-CN', 'zh-TW', 'zh-HK', 'en-US'],
  messages,
  finders: {
    'login.config': {
      handler: async (_input: Record<string, unknown>, ctx: FinderContext) =>
        ctx.api.get('/login/admin/config', configSchema),
    },
  },
  ui: {
    adminRoutes: [
      {
        path: '/settings',
        component: 'admin/settings',
        permission: 'platform.admin',
        systemSettings: { labelKey: 'admin.systemSettings', order: 10 },
        data: [{ finder: 'login.config', as: 'config' }],
      },
    ],
    actions: [
      {
        id: 'login.configure',
        // Admin form toasts on success itself.
        silent: true,
        method: 'POST',
        path: '/login/admin/config',
        permission: 'platform.admin',
        // A boolean, not the method list: "allow new accounts" is the only
        // decision an operator (or an agent) actually makes, and phone sign-up
        // has no implementation behind it yet. The route accepts both shapes.
        input: [
          { name: 'registrationEnabled', type: 'boolean', required: true },
          { name: 'emailVerificationRequired', type: 'boolean', required: true },
        ],
      },
    ],
  },
};

export default frontend;
