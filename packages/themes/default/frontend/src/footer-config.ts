import {
  migrateFrontendSettings,
  settingsDefaultsFromSchema,
  type FrontendSettings,
  type FrontendSettingsListItem,
} from '@stackpanel/sdk';
import { settingsSchema } from './settings.js';

export interface FooterLink {
  label: string;
  href: string;
}
export interface FooterGroup {
  title: string;
  links: FooterLink[];
}
export interface FooterSocialLink extends FooterLink {
  icon: string;
}

/** Return no destination for unsafe protocols; never emit script URLs into markup. */
function destination(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const href = value.trim();
  if (/[\u0000-\u0020\\]/.test(href)) return;
  if (/^(\/(?!\/)|#|https?:\/\/|mailto:|tel:)/i.test(href)) return href;
}
function link(row: FrontendSettingsListItem): FooterLink | undefined {
  const href = destination(row.href);
  if (typeof row.label !== 'string' || !row.label.trim() || !href) return;
  return { label: row.label, href };
}

export function resolveFooter(settings?: FrontendSettings): {
  groups: FooterGroup[];
  socialLinks: FooterSocialLink[];
} {
  const footer = {
    ...settingsDefaultsFromSchema(settingsSchema).footer,
    ...migrateFrontendSettings(settingsSchema, settings)?.footer,
  };
  const groups = Array.isArray(footer.groups)
    ? footer.groups.flatMap((row) => {
        if (typeof row.title !== 'string' || !row.title.trim() || !Array.isArray(row.links))
          return [];
        return [
          {
            title: row.title,
            links: row.links.flatMap((item) => {
              const value = link(item);
              return value ? [value] : [];
            }),
          },
        ];
      })
    : [];
  const socialLinks = Array.isArray(footer.socialLinks)
    ? footer.socialLinks.flatMap((row) => {
        const value = link(row);
        return value ? [{ ...value, icon: typeof row.icon === 'string' ? row.icon : 'link' }] : [];
      })
    : [];
  return { groups, socialLinks };
}
