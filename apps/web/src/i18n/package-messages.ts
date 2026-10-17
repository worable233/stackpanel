/**
 * Package message catalogs (ADR-0016 §5, PLAN-i18n-completion §3 阶段 2).
 *
 * A plugin or theme ships `messages/<locale>.json` next to its frontend source.
 * The build serializes those catalogs into the package manifest; the host then
 * resolves package metadata (nav labels, system-settings labels, settings field
 * labels) through this module.
 *
 * Safety rules (PLAN §3 阶段 2):
 * - Only a bounded amount of data is accepted (keys, depth, value length).
 * - Catalogs are isolated per package: they are **never** merged into the
 *   kernel catalog, so a package key like `nav.label` cannot shadow the
 *   kernel's `nav.*` — it is only ever looked up through that package's own
 *   catalogs. `isPackageMessageKey` remains the guard for hypothetical
 *   merge-based hosts, and is deliberately not applied here: applying it would
 *   silently drop legitimate package copy (a package's own `nav.label`) while
 *   providing no isolation benefit, because there is nothing to collide with.
 */

import { isValidLanguageTag, isValidMessageKey } from './schema';
import { formatMessage } from './core';

/** Upper bounds; a legitimate frontend package is far below these. */
export const MAX_MESSAGE_LOCALES = 16;
export const MAX_MESSAGE_KEYS = 4000;
export const MAX_MESSAGE_LENGTH = 4000;

/** A validated, package-scoped catalog set. */
export interface PackageMessages {
  locales: string[];
  catalogs: Record<string, Record<string, string>>;
}

export interface PackageMessagesIssue {
  packageId: string;
  locale?: string;
  key?: string;
  reason: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate the `messages` block of a package manifest.
 *
 * Returns the usable catalogs plus every rejected entry. Rejections are
 * diagnostics, never a hard failure: a package with one bad key should still
 * contribute the rest of its copy, and the operator needs to see why.
 */
export function readPackageMessages(
  packageId: string,
  raw: unknown,
): { messages: PackageMessages; issues: PackageMessagesIssue[] } {
  const issues: PackageMessagesIssue[] = [];
  const catalogs: Record<string, Record<string, string>> = {};
  if (!isPlainObject(raw)) return { messages: { locales: [], catalogs }, issues };

  const tags = Object.keys(raw);
  for (const tag of tags.slice(0, MAX_MESSAGE_LOCALES)) {
    if (!isValidLanguageTag(tag)) {
      issues.push({ packageId, locale: tag, reason: 'invalid language tag' });
      continue;
    }
    const catalog = raw[tag];
    if (!isPlainObject(catalog)) {
      issues.push({ packageId, locale: tag, reason: 'catalog is not an object' });
      continue;
    }
    const entries = Object.entries(catalog);
    if (entries.length > MAX_MESSAGE_KEYS) {
      issues.push({ packageId, locale: tag, reason: `more than ${MAX_MESSAGE_KEYS} keys` });
      continue;
    }
    const accepted: Record<string, string> = {};
    for (const [key, value] of entries) {
      if (!isValidMessageKey(key)) {
        issues.push({ packageId, locale: tag, key, reason: 'invalid message id' });
        continue;
      }
      if (typeof value !== 'string') {
        issues.push({ packageId, locale: tag, key, reason: 'value is not a string' });
        continue;
      }
      if (value.length > MAX_MESSAGE_LENGTH) {
        issues.push({ packageId, locale: tag, key, reason: 'value too long' });
        continue;
      }
      accepted[key] = value;
    }
    catalogs[tag] = accepted;
  }
  if (tags.length > MAX_MESSAGE_LOCALES) {
    issues.push({ packageId, reason: `more than ${MAX_MESSAGE_LOCALES} locales` });
  }
  return { messages: { locales: Object.keys(catalogs), catalogs }, issues };
}

/**
 * Resolve one package message for the host's locale.
 *
 * Fallback chain (PLAN §3 阶段 2): requested locale → the package's default
 * locale (`DEFAULT_LOCALE`) → the site default → `undefined` so the caller can
 * decide what to show (usually the manifest's literal `label`).
 */
export function packageMessage(
  messages: PackageMessages | undefined,
  locale: string,
  key: string | undefined,
  fallbacks: readonly string[] = [],
): string | undefined {
  if (!messages || !key) return undefined;
  for (const tag of [locale, ...fallbacks]) {
    const template = messages.catalogs[tag]?.[key];
    if (template !== undefined) return formatMessage(template);
  }
  return undefined;
}

/**
 * Resolve a label that may be a message id.
 *
 * `labelKey` wins when it resolves; otherwise the literal `label` the package
 * shipped is used, so a package that only speaks one language still renders.
 */
export function packageLabel(
  messages: PackageMessages | undefined,
  locale: string,
  labelKey: string | undefined,
  label: string | undefined,
  fallbacks: readonly string[] = [],
): string {
  return packageMessage(messages, locale, labelKey, fallbacks) ?? label ?? labelKey ?? '';
}

/**
 * Rewrite a package settings schema into display-ready copy.
 *
 * The admin settings form is a client component, so it cannot receive a
 * translator function across the RSC boundary. Instead the server resolves
 * every `labelKey` / `helpKey` / `placeholderKey` / option `labelKey` against
 * the package's catalog and hands the form a schema whose `label` fields are
 * already localized (ADR-0016 §5).
 */
export function localizeSettingsSchema<T>(
  schema: T,
  messages: PackageMessages | undefined,
  locale: string,
  fallbacks: readonly string[] = [],
): T {
  const tr = (key: string | undefined, literal: string | undefined) =>
    packageLabel(messages, locale, key, literal, fallbacks);

  type AnyRecord = Record<string, unknown>;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value !== 'object' || value === null) return value;
    const record = value as AnyRecord;
    const next: AnyRecord = { ...record };
    if ('label' in record || 'labelKey' in record) {
      next['label'] = tr(
        record['labelKey'] as string | undefined,
        record['label'] as string | undefined,
      );
      delete next['labelKey'];
    }
    if ('help' in record || 'helpKey' in record) {
      next['help'] = tr(
        record['helpKey'] as string | undefined,
        record['help'] as string | undefined,
      );
      delete next['helpKey'];
    }
    if ('placeholderKey' in record) {
      next['placeholder'] = tr(
        record['placeholderKey'] as string | undefined,
        record['placeholder'] as string | undefined,
      );
      delete next['placeholderKey'];
    }
    if (Array.isArray(record['fields'])) next['fields'] = record['fields'].map(walk);
    if (Array.isArray(record['options'])) next['options'] = record['options'].map(walk);
    if (Array.isArray(record['groups'])) next['groups'] = record['groups'].map(walk);
    return next;
  };
  return walk(schema) as T;
}
