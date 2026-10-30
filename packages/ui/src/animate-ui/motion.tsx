'use client';

/**
 * Animate UI motion primitives bridge.
 *
 * Theme packages are server modules, so every `'use client'` primitive has to
 * cross the host graph as a named client reference. Keep one binding per
 * primitive: namespace objects are not serializable across the RSC boundary.
 */
import { CountingNumber } from '@animate-ui/react/primitives/texts/counting-number';
import { SplittingText } from '@animate-ui/react/primitives/texts/splitting';
import { ShimmeringText } from '@animate-ui/react/primitives/texts/shimmering';
import { RollingText } from '@animate-ui/react/primitives/texts/rolling';
import { Fade, Fades } from '@animate-ui/react/primitives/effects/fade';
import { Slide, Slides } from '@animate-ui/react/primitives/effects/slide';
import { Magnetic } from '@animate-ui/react/primitives/effects/magnetic';
import { Tilt, TiltContent } from '@animate-ui/react/primitives/effects/tilt';
import { MotionGrid, MotionGridCells } from '@animate-ui/react/primitives/motion-grid';
import { Accordion } from '@animate-ui/react/primitives/base-ui/accordion';

export {
  CountingNumber,
  SplittingText,
  ShimmeringText,
  RollingText,
  Fade,
  Fades,
  Slide,
  Slides,
  Magnetic,
  Tilt,
  TiltContent,
  MotionGrid,
  MotionGridCells,
};

export const AccordionRoot = Accordion.Root;
export const AccordionItem = Accordion.Item;
export const AccordionHeader = Accordion.Header;
export const AccordionTrigger = Accordion.Trigger;
export const AccordionPanel = Accordion.Panel;

export type {
  CountingNumberProps,
} from '@animate-ui/react/primitives/texts/counting-number';
export type { SplittingTextProps } from '@animate-ui/react/primitives/texts/splitting';
export type { ShimmeringTextProps } from '@animate-ui/react/primitives/texts/shimmering';
export type { RollingTextProps } from '@animate-ui/react/primitives/texts/rolling';
export type { FadeProps, FadeListProps } from '@animate-ui/react/primitives/effects/fade';
export type { SlideProps, SlideListProps } from '@animate-ui/react/primitives/effects/slide';
export type { MagneticProps } from '@animate-ui/react/primitives/effects/magnetic';
export type { TiltProps, TiltContentProps } from '@animate-ui/react/primitives/effects/tilt';
export type {
  Frame,
  FrameDot,
  Frames,
  MotionGridCellsProps,
  MotionGridProps,
} from '@animate-ui/react/primitives/motion-grid';
export type {
  AccordionPanelProps,
} from '@animate-ui/react/primitives/base-ui/accordion';
