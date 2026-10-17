'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { agentFetch } from '@/components/agent-workspace';
import { agentErrorText } from '@/lib/agent-errors';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { useTranslator } from '@/i18n/provider';

type ConsentInfo = {
  client: { name: string };
  scopes: string[];
  redirectUri: string;
};

/** Current OAuth authorize parameters, read from the browser URL. */
function authorizeParams(): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(window.location.search));
}

/**
 * Human consent screen for the OAuth authorization code flow.
 *
 * The request parameters live in `window.location.search`, which does not exist
 * during SSR, so they are read on the click rather than stored in state from an
 * effect — that keeps the effect free of synchronous `setState` cascades.
 */
export function AgentConsent() {
  const t = useTranslator();
  const [info, setInfo] = useState<ConsentInfo>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    agentFetch<ConsentInfo>(`oauth/authorize?${new URLSearchParams(authorizeParams())}`)
      .then((result) => {
        if (!cancelled) setInfo(result);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(agentErrorText(t, cause, t('agentConsent.failed')));
      });
    return () => {
      cancelled = true;
    };
    // `t` is stable for a given locale; re-running on locale change would refetch
    // and lose the user's in-progress decision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function approve() {
    setBusy(true);
    setError('');
    try {
      const result = await agentFetch<{ redirectUri: string }>(
        'oauth/authorize',
        'POST',
        authorizeParams(),
      );
      window.location.assign(result.redirectUri);
    } catch (cause) {
      setError(agentErrorText(t, cause, t('agentConsent.failed')));
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('agentConsent.title')}</CardTitle>
        <CardDescription>{t('agentConsent.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldError role="alert">{error}</FieldError>
        {info ? (
          <>
            <p>
              {t('agentConsent.client')}
              {info.client.name}
            </p>
            <p>
              {t('agentConsent.redirectUri')}
              {info.redirectUri}
            </p>
            <ul>
              {info.scopes.map((scope) => (
                <li key={scope}>{scope}</li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button disabled={busy} onClick={() => void approve()}>
                {t('agentConsent.approve')}
              </Button>
              <Button variant="outline" render={<Link href="/account/agent" />}>
                {t('agentConsent.deny')}
              </Button>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
