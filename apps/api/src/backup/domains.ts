/**
 * Selective-export domains (ADR-0018 §7, gap C4).
 *
 * The archive's `includes` field names which logical domains an export carries.
 * Each domain maps to a set of kernel tables; a selective export keeps the
 * schema of the whole database (so referential integrity survives) but omits
 * the *data* of every table outside the selected domains. That is what
 * `pg_dump --exclude-table-data` is for — the exclusion is by table, not by
 * row, so no partial-domain joins are possible.
 *
 * Table names are the Prisma `@@map` names (unqualified, `public` schema).
 * Extension tables (`ext_*`) belong to the `content` domain and are matched by
 * pattern so a newly declared model is covered without editing this file.
 */

/** Logical export domains. `secrets` is handled separately (ADR-0018 §6). */
export type ExportDomain =
  | 'content'
  | 'media'
  | 'orders'
  | 'users'
  | 'wallet'
  | 'settings';

/** Stable, ordered list — also drives the admin UI checkboxes and CLI flags. */
export const EXPORT_DOMAINS: readonly ExportDomain[] = [
  'content',
  'media',
  'orders',
  'users',
  'wallet',
  'settings',
] as const;

/** The `content` domain owns every Extension (`ext_*`) physical table. */
export const EXTENSION_TABLE_PATTERN = 'ext_*';

/**
 * Domain → kernel tables. `secrets` is intentionally absent: secret rows are
 * only ever included explicitly via `secretsIncluded` (ADR-0018 §6).
 */
const TABLES_BY_DOMAIN: Record<ExportDomain, readonly string[]> = {
  // Business-domain data (store/ticket/gateway/zjmf) lives in `ext_*`
  // (Extension engine), which the `content` domain covers by pattern; only
  // kernel tables remain listed here.
  content: ['extension_schema'],
  media: ['attachments'],
  orders: ['payments'],
  users: [
    'users',
    'user_identities',
    'permission_groups',
    'permissions',
    'user_groups',
    'group_permissions',
    'api_tokens',
    'api_token_usage',
    'notifications',
    'audit_logs',
  ],
  wallet: ['wallet_accounts', 'wallet_ledger_entries', 'fx_rates'],
  settings: [
    'settings',
    'sales_channels',
    'payment_methods',
    'plugins',
    'themes',
    'outbox_events',
  ],
};

export function isExportDomain(value: unknown): value is ExportDomain {
  return typeof value === 'string' && (EXPORT_DOMAINS as readonly string[]).includes(value);
}

/** Keep only recognised domains, de-duplicated, in canonical order. */
export function normalizeDomains(input: readonly unknown[] | undefined): ExportDomain[] {
  if (!input || input.length === 0) return [...EXPORT_DOMAINS];
  const wanted = new Set(input.filter(isExportDomain));
  return EXPORT_DOMAINS.filter((domain) => wanted.has(domain));
}

/** All kernel tables that belong to at least one domain. */
export function allDomainTables(): string[] {
  const tables = new Set<string>();
  for (const list of Object.values(TABLES_BY_DOMAIN)) {
    for (const table of list) tables.add(table);
  }
  return [...tables].sort();
}

/**
 * Tables whose *data* must be skipped so the archive carries only the selected
 * domains. `secrets` data is excluded unless `includeSecrets` is set.
 */
export function excludeTableDataFor(
  domains: readonly ExportDomain[],
  includeSecrets: boolean,
): string[] {
  const selected = new Set<ExportDomain>(domains);
  const keepTables = new Set<string>();
  for (const domain of domains) {
    for (const table of TABLES_BY_DOMAIN[domain]) keepTables.add(table);
  }
  const excluded = allDomainTables().filter((table) => !keepTables.has(table));
  // Extension (`ext_*`) tables belong to the `content` domain; drop their data
  // when `content` is not selected (their schema is still dumped).
  if (!selected.has('content')) excluded.push(EXTENSION_TABLE_PATTERN);
  if (!includeSecrets) excluded.push('secrets');
  return excluded.sort();
}

/** Whether the object store should be packed for this selection. */
export function includesObjectStore(domains: readonly ExportDomain[]): boolean {
  return domains.includes('media');
}
