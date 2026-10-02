/**
 * Shared E2E configuration and credentials.
 *
 * The global setup creates these accounts (idempotent upsert) against the dev
 * database, so tests are reproducible on any checkout with a running stack.
 * Override any value with its E2E_* environment variable.
 */
export const ADMIN_EMAIL = process.env['E2E_ADMIN_EMAIL'] ?? 'e2e-admin@stackpanel.test';
export const ADMIN_PASSWORD = process.env['E2E_ADMIN_PASSWORD'] ?? 'E2e-Dev-Pass-2026';
export const USER_EMAIL = process.env['E2E_USER_EMAIL'] ?? 'e2e-user@stackpanel.test';
export const USER_PASSWORD = process.env['E2E_USER_PASSWORD'] ?? 'E2e-Dev-Pass-2026';

export const API_BASE_URL = process.env['E2E_API_URL'] ?? 'http://localhost:3001';
export const WEB_BASE_URL = process.env['E2E_BASE_URL'] ?? 'http://localhost:3000';

export const NOTICE_PLUGIN_ID = 'notice';

/** Catalog demo plugin + deterministic seed data used by catalog.spec.ts. */
export const CATALOG_PLUGIN_ID = 'catalog';
export const CATALOG_ROOT_NAME = 'E2E 技术分类';
export const CATALOG_ROOT_SLUG = 'e2e-catalog-root';
export const CATALOG_CHILD_NAME = 'E2E 子分类';
export const CATALOG_CHILD_SLUG = 'e2e-catalog-child';
export const CATALOG_PRODUCT_NAME = 'E2E-Catalog-VPS';
