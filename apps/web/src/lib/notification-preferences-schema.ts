import { z } from 'zod';
import type { NotificationPolicyView, NotificationPreferencesView } from '@stackpanel/sdk';

const channel = z.object({ id: z.string(), name: z.string(), inApp: z.boolean() });
const category = z.object({ id: z.string(), label: z.string() });

export const notificationPreferencesSchema: z.ZodType<NotificationPreferencesView> = z.object({
  channels: z.array(channel),
  categories: z.array(category),
  types: z.array(
    z.object({
      type: z.string(),
      category: z.string(),
      label: z.string(),
      description: z.string().nullable(),
      configurable: z.boolean(),
      channels: z.array(
        z.object({
          channelId: z.string(),
          enabled: z.boolean(),
          defaultEnabled: z.boolean(),
          configurable: z.boolean(),
        }),
      ),
    }),
  ),
});

export const notificationPolicySchema: z.ZodType<NotificationPolicyView> = z.object({
  channels: z.array(channel),
  categories: z.array(category),
  types: z.array(
    z.object({
      type: z.string(),
      category: z.string(),
      label: z.string(),
      enabled: z.boolean(),
      defaultChannels: z.array(z.string()),
      locked: z.boolean(),
      userConfigurable: z.boolean(),
    }),
  ),
});
