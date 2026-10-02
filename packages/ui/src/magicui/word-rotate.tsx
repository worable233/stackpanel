'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, motion, type MotionProps } from 'motion/react';

import { cn } from '../cn.js';

export interface WordRotateProps {
  words: string[];
  duration?: number;
  motionProps?: MotionProps;
  className?: string;
}

/** Official Magic UI `word-rotate` component (vendored), adapted for inline
 * use. The outer wrapper keeps `overflow: visible` so an inline-block's
 * baseline stays the text baseline (instead of its bottom edge), keeping the
 * rotating glyph vertically aligned with the surrounding line. */
export function WordRotate({
  words,
  duration = 2500,
  motionProps = {
    initial: { opacity: 0, y: 14 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -14 },
    transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] },
  },
  className,
}: WordRotateProps) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setIndex((prevIndex) => (prevIndex + 1) % words.length);
    }, duration);

    // Clean up interval on unmount
    return () => clearInterval(interval);
  }, [words, duration]);

  return (
    <span
      className={cn('inline-block whitespace-nowrap align-baseline', className)}
      aria-live="polite"
    >
      <AnimatePresence mode="wait">
        <motion.span key={words[index]} className="inline-block" {...motionProps}>
          {words[index]}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
