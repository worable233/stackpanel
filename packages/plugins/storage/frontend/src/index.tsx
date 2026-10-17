import type { FrontendPackage, FinderProvider } from '@stackpanel/sdk';
import { adminConfigSchema } from './schemas';

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
  finders,
  pages: [],
  pageComponents: {},
  ui: {
    actions: [
      {
        id: 'storage.save-config',
        method: 'POST',
        path: '/storage/admin/config',
        permission: 'storage.admin',
        input: [
          { name: 'kind', type: 'string', required: true, maxLength: 16 },
          { name: 'localRoot', type: 'string', maxLength: 1024 },
          { name: 's3Endpoint', type: 'string', maxLength: 2048 },
          { name: 's3Region', type: 'string', maxLength: 64 },
          { name: 's3Bucket', type: 'string', maxLength: 255 },
          { name: 's3ForcePathStyle', type: 'boolean' },
          { name: 'publicBaseUrl', type: 'string', maxLength: 2048 },
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
        nav: { label: '存储', group: '系统', order: 100 },
        data: [{ finder: 'storage.adminConfig', as: 'storageConfig' }],
      },
    ],
  },
};

export default frontend;
