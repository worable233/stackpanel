import type { FrontendPackage, FinderProvider } from '@stackpanel/sdk';
import { adminConfigSchema } from './schemas';
import { messages } from './i18n.js';

/**
 * 存储插件前端：仅一个管理页。
 *
 * 交互式表单在 `admin.tsx`（客户端组件），此处只声明 finder 与路由元数据。
 * 后端路由前缀 `/storage/...`；`ctx.api.get('/storage/admin/config')` 经 BFF 转发
 * 到内核并带上插件命名空间。
 */
const finders: Record<string, FinderProvider> = {
  'storage.adminConfig': {
    handler: async (_input, ctx) => ctx.api.get('/storage/admin/config', adminConfigSchema),
  },
};

export const frontend: FrontendPackage = {
  locales: ['zh-CN', 'zh-TW', 'zh-HK', 'en-US'],
  messages,
  finders,
  pages: [],
  pageComponents: {},
  ui: {
    actions: [
      {
        id: 'storage.test-connection',
        // The admin form renders the connection result inline.
        silent: true,
        method: 'POST',
        path: '/storage/admin/test',
        permission: 'storage.admin',
      },
      {
        id: 'storage.save-config',
        successFeedback: { messageKey: 'status.saved' },
        method: 'POST',
        path: '/storage/admin/config',
        permission: 'storage.admin',
        input: [
          { name: 'kind', type: 'string', required: true, maxLength: 16 },
          { name: 'localRoot', type: 'string', default: '', maxLength: 1024 },
          { name: 's3Endpoint', type: 'string', default: '', maxLength: 2048 },
          { name: 's3Region', type: 'string', default: '', maxLength: 64 },
          { name: 's3Bucket', type: 'string', default: '', maxLength: 255 },
          { name: 's3ForcePathStyle', type: 'boolean' },
          { name: 'publicBaseUrl', type: 'string', default: '', maxLength: 2048 },
          { name: 'httpUploadUrl', type: 'string', default: '', maxLength: 2048 },
          { name: 'httpPublicBaseUrl', type: 'string', default: '', maxLength: 2048 },
          { name: 'httpMethod', type: 'string', default: '', maxLength: 8 },
          { name: 'httpFieldName', type: 'string', default: '', maxLength: 128 },
          { name: 'httpHeaders', type: 'string', default: '', maxLength: 4096 },
          { name: 'httpDeleteUrlTemplate', type: 'string', default: '', maxLength: 2048 },
          { name: 'accessKeyId', type: 'string', maxLength: 255 },
          { name: 'secretAccessKey', type: 'string', maxLength: 255 },
        ],
      },
    ],
    adminRoutes: [
      {
        path: '/storage',
        component: 'admin/storage',
        permission: 'storage.admin',
        systemSettings: { labelKey: 'admin.systemSettings', order: 100 },
        data: [{ finder: 'storage.adminConfig', as: 'storageConfig' }],
      },
    ],
  },
};

export default frontend;
