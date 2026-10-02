/** Shared OpenAPI JSON Schema fragments for API documentation. */

export const errorResponseSchema = {
  type: 'object',
  properties: { error: { type: 'string' } },
} as const;

export const userGroupSchema = {
  type: 'object',
  required: ['id', 'name'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
  },
} as const;

export const userResponseSchema = {
  type: 'object',
  required: ['id', 'email', 'status', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string' },
    email: { type: 'string' },
    groups: { type: 'array', items: userGroupSchema },
    status: { type: 'string', enum: ['ACTIVE', 'DISABLED'] },
    lastLoginAt: { type: 'string', nullable: true },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

export const loginResponseSchema = {
  type: 'object',
  required: ['token', 'user'],
  properties: {
    token: { type: 'string' },
    user: userResponseSchema,
  },
} as const;

export const userListResponseSchema = {
  type: 'object',
  required: ['users', 'total', 'page', 'pageSize'],
  properties: {
    users: { type: 'array', items: userResponseSchema },
    total: { type: 'number' },
    page: { type: 'number' },
    pageSize: { type: 'number' },
  },
} as const;

export const healthResponseSchema = {
  type: 'object',
  required: ['status', 'version', 'apiVersion', 'uptime', 'timestamp'],
  properties: {
    status: { type: 'string' },
    version: { type: 'string' },
    apiVersion: { type: 'string' },
    uptime: { type: 'number' },
    timestamp: { type: 'string' },
  },
} as const;
