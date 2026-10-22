import type { FinderContext, FrontendPackage } from '@stackpanel/sdk';
import { z } from 'zod';
import { messages } from './i18n.js';

const configSchema = z.object({
  registrationMethods: z.array(z.enum(['email', 'phone'])),
  emailVerificationRequired: z.boolean(),
  emailVerificationSupported: z.boolean().optional(),
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
        input: [
          { name: 'registrationMethods', type: 'string', required: true },
          { name: 'emailVerificationRequired', type: 'boolean', required: true },
        ],
      },
    ],
  },
};

export default frontend;
