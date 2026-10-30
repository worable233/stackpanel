'use client';

import {
  Container,
  Gap,
  Highlight,
  Provider,
  TriggerIcon,
  useSidebar,
} from '@animate-ui/react/primitives/sidebar';

export const SidebarProvider = Provider;
export const SidebarGap = Gap;
export const SidebarContainer = Container;
export const SidebarHighlight = Highlight;
export const SidebarTriggerIcon = TriggerIcon;
export { useSidebar };

export type {
  ContainerProps as SidebarContainerProps,
  GapProps as SidebarGapProps,
  HighlightProps as SidebarHighlightProps,
  ProviderProps as SidebarProviderProps,
  SidebarContextProps,
  TriggerIconProps as SidebarTriggerIconProps,
} from '@animate-ui/react/primitives/sidebar';
