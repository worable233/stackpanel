import { z } from 'zod';
import {
  frontendSettingsValueSchema,
  type FrontendSettings,
  type FrontendSettingsSchema,
} from '@stackpanel/sdk';
export const themeSettingsSchema = frontendSettingsValueSchema;
export const themeConfigurationSchema = z.object({
  schema: z.unknown().nullable(),
  settings: themeSettingsSchema,
  defaults: themeSettingsSchema,
  version: z.string(),
  history: z.array(
    z.object({ version: z.string(), savedAt: z.string(), settings: themeSettingsSchema }),
  ),
});
export interface ThemeConfiguration {
  schema: FrontendSettingsSchema;
  settings: FrontendSettings;
  defaults: FrontendSettings;
  version: string;
  history: Array<{ version: string; savedAt: string; settings: FrontendSettings }>;
}
