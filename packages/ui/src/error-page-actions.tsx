'use client';

import { Button } from './button.js';

export interface ErrorPageActionsLabels {
  back: string;
  home: string;
}

/**
 * Default "go back / go home" pair for an error page.
 *
 * Copy comes from the caller: `@stackpanel/ui` does not ship interface
 * translations (ADR-0016 §6).
 */
export function ErrorPageActions({ labels }: { labels: ErrorPageActionsLabels }) {
  return (
    <>
      <Button
        size="lg"
        variant="outline"
        onClick={() => {
          if (window.history.length > 1) window.history.back();
          else window.location.assign('/');
        }}
      >
        {labels.back}
      </Button>
      <Button size="lg" render={<a href="/" />}>
        {labels.home}
      </Button>
    </>
  );
}
