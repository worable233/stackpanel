'use client';
import { useEffect } from 'react';
import Lenis from 'lenis';
export function SmoothDocument() {
  useEffect(() => {
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    let lenis: Lenis | undefined;
    const setup = () => {
      lenis?.destroy();
      lenis = preference.matches
        ? undefined
        : new Lenis({
            autoRaf: true,
            lerp: 0.1,
            duration: 1.2,
            smoothWheel: true,
            anchors: { offset: -90 },
            prevent: (element) =>
              Boolean(element.closest('[role=dialog],header nav,[data-lenis-prevent]')),
          });
    };
    setup();
    preference.addEventListener('change', setup);
    return () => {
      preference.removeEventListener('change', setup);
      lenis?.destroy();
    };
  }, []);
  return null;
}
