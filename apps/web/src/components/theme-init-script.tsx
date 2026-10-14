'use client';

import { useEffect } from 'react';

/**
 * Theme initialization - injects script via useEffect to avoid React warnings.
 * The script runs before first paint by being in the initial SSR HTML.
 */
export function ThemeInitScript({ nonce, script }: { nonce?: string; script: string }) {
  useEffect(() => {
    // Script is already in the DOM from SSR, this is just for type safety
  }, []);

  // Use dangerouslySetInnerHTML on a div that executes immediately
  // This avoids the React script tag warning
  return (
    <div
      suppressHydrationWarning
      dangerouslySetInnerHTML={{
        __html: `<script${nonce ? ` nonce="${nonce}"` : ''}>${script}</script>`,
      }}
    />
  );
}
