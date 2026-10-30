'use client';

/**
 * Animate UI primitive bridge.
 *
 * The theme runtime is a server module, so it cannot import a `'use client'`
 * package directly. Re-exporting the real Animate UI Base UI primitives here
 * keeps the client references inside the host graph; the runtime ABI then hands
 * them to the theme through `@stackpanel/ui`.
 *
 * Namespace objects cannot cross the RSC boundary (their properties are not
 * client references), so each primitive is exported as its own binding.
 */
import { Tabs } from '@animate-ui/react/primitives/base-ui/tabs';

export const TabsRoot = Tabs.Root;
export const TabsList = Tabs.List;
export const TabsTab = Tabs.Tab;
export const TabsPanel = Tabs.Panel;
export const TabsIndicator = Tabs.Indicator;

export type {
  TabsListProps,
  TabsPanelProps,
  TabsRootProps,
  TabsTabProps,
} from '@animate-ui/react/primitives/base-ui/tabs';
