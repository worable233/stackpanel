'use client';

import { Check, Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import type { ApiTokenScope, ApiTokenView } from '@stackpanel/sdk';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createApiTokenAction, revokeApiTokenAction } from '@/lib/api-token-actions';
import { useTranslator, useLocale } from '@/i18n/provider';
import { formatDate as formatLocaleDate, type Translator } from '@/i18n/core';
import { cn } from '@/lib/utils';

/** Friendly group labels for the permission-key namespaces, keyed by message. */
const GROUP_KEYS: Record<string, string> = {
  'llm-gateway': 'apiToken.group.llm-gateway',
  store: 'apiToken.group.store',
  'store-wallet': 'apiToken.group.store-wallet',
  'store-product-card': 'apiToken.group.store-product-card',
  catalog: 'apiToken.group.catalog',
  ticket: 'apiToken.group.ticket',
  notice: 'apiToken.group.notice',
  epay: 'apiToken.group.epay',
  platform: 'apiToken.group.platform',
  'zjmf-upstream': 'apiToken.group.zjmf-upstream',
};

/** Friendly per-key labels; falls back to the raw key when unmapped. */
const SCOPE_KEYS: Record<string, string> = {
  'store.view': 'apiToken.scope.store.view',
  'store.buy': 'apiToken.scope.store.buy',
  'store.admin': 'apiToken.scope.store.admin',
  'store.wallet': 'apiToken.scope.store.wallet',
  'ticket.view': 'apiToken.scope.ticket.view',
  'ticket.create': 'apiToken.scope.ticket.create',
  'ticket.admin': 'apiToken.scope.ticket.admin',
  'llm-gateway.use': 'apiToken.scope.llm-gateway.use',
  'llm-gateway.admin': 'apiToken.scope.llm-gateway.admin',
  'platform.admin': 'apiToken.scope.platform.admin',
};

function groupHead(key: string): string {
  return key.split('.')[0] ?? key;
}

function groupLabel(head: string, t: Translator): string {
  const key = GROUP_KEYS[head];
  return key ? t(key) : head;
}

function labelOf(scope: ApiTokenScope, t: Translator): string {
  const key = SCOPE_KEYS[scope.key];
  return key ? t(key) : (scope.name ?? scope.key);
}

export function ApiTokenManager({
  tokens,
  scopes,
  prefix,
}: {
  tokens: ApiTokenView[];
  scopes: ApiTokenScope[];
  prefix: string;
}) {
  const router = useRouter();
  const t = useTranslator();
  const locale = useLocale();
  const [pending, startTransition] = useTransition();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  /** Plaintext returned once after creation. */
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiTokenView | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<string, ApiTokenScope[]>();
    for (const scope of scopes) {
      const head = groupHead(scope.key);
      const list = map.get(head) ?? [];
      list.push(scope);
      map.set(head, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b, locale));
  }, [scopes, locale]);

  const lastUsed = (value: string | null) =>
    value
      ? formatLocaleDate(new Date(value), locale, { dateStyle: 'medium', timeStyle: 'short' })
      : t('apiToken.never');

  const resetCreate = () => {
    setName('');
    setSelected(new Set());
    setError(null);
  };

  const toggleScope = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleGroup = (keys: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };

  const submitCreate = () => {
    setError(null);
    startTransition(async () => {
      const result = await createApiTokenAction({ name, scopes: [...selected] });
      if (result.error) {
        setError(result.error);
        return;
      }
      setCreateOpen(false);
      resetCreate();
      setCopied(false);
      setIssued(result.token ?? null);
      router.refresh();
    });
  };

  const submitRevoke = () => {
    if (!revokeTarget) return;
    const id = revokeTarget.id;
    startTransition(async () => {
      const result = await revokeApiTokenAction(id);
      if (result.error) {
        setError(result.error);
        return;
      }
      setRevokeTarget(null);
      router.refresh();
    });
  };

  const copyIssued = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      <div className="flex justify-end">
        <Button onClick={() => setCreateOpen(true)} disabled={scopes.length === 0}>
          <Plus className="size-4" />
          {t('apiToken.new')}
        </Button>
      </div>

      {tokens.length === 0 ? (
        <div className="rounded-lg border py-16 text-center text-sm text-muted-foreground">
          {t('apiToken.empty')}
        </div>
      ) : (
        <ul className="divide-y rounded-lg border bg-card">
          {tokens.map((token) => (
            <li key={token.id} className="flex flex-wrap items-start gap-3 p-4">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <KeyRound className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium">{token.name}</p>
                  <span
                    className={cn(
                      'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                      token.status === 'ACTIVE'
                        ? 'bg-primary/10 text-primary'
                        : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {token.status === 'ACTIVE' ? t('apiToken.statusActive') : t('apiToken.statusDisabled')}
                  </span>
                </div>
                <p className="mt-1 font-mono text-xs text-muted-foreground">{token.keyPrefix}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {token.scopes.length > 0
                    ? t('apiToken.scopeCount', { count: token.scopes.length })
                    : t('apiToken.noScopes')}
                  {' · '}
                  {t('apiToken.lastUsed', { time: lastUsed(token.lastUsedAt) })}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRevokeTarget(token)}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="size-4" />
                  {t('apiToken.revoke')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {error && !createOpen && !revokeTarget ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : null}

      {/* Create dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) resetCreate();
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('apiToken.createTitle')}</DialogTitle>
            <DialogDescription>{t('apiToken.createDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="api-token-name">{t('apiToken.name')}</Label>
              <Input
                id="api-token-name"
                value={name}
                maxLength={60}
                placeholder={t('apiToken.namePlaceholder')}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">{t('apiToken.scopes')}</p>
              <p className="text-xs text-muted-foreground">{t('apiToken.scopesHint')}</p>
              <div className="max-h-72 space-y-3 overflow-y-auto rounded-lg border p-3">
                {grouped.map(([head, items]) => {
                  const keys = items.map((item) => item.key);
                  const allOn = keys.every((key) => selected.has(key));
                  return (
                    <div key={head} className="space-y-2">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-semibold text-muted-foreground">
                          {groupLabel(head, t)}
                        </p>
                        <button
                          type="button"
                          className="text-xs text-primary hover:underline"
                          onClick={() => toggleGroup(keys, !allOn)}
                        >
                          {allOn ? t('apiToken.clearGroup') : t('apiToken.selectAll')}
                        </button>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {items.map((scope) => (
                          <label
                            key={scope.key}
                            className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-0.5 text-sm"
                          >
                            <input
                              type="checkbox"
                              className="mt-0.5 size-4 shrink-0 accent-primary"
                              checked={selected.has(scope.key)}
                              onChange={() => toggleScope(scope.key)}
                            />
                            <span className="min-w-0">
                              <span className="block">{labelOf(scope, t)}</span>
                              <span className="block font-mono text-[11px] text-muted-foreground">
                                {scope.key}
                              </span>
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={pending}>
              {t('apiToken.cancel')}
            </Button>
            <Button onClick={submitCreate} disabled={pending || !name.trim()}>
              {pending ? t('apiToken.creating') : t('apiToken.createSubmit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* One-time plaintext dialog */}
      <Dialog open={issued !== null} onOpenChange={(open) => !open && setIssued(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('apiToken.issuedTitle')}</DialogTitle>
            <DialogDescription>{t('apiToken.issuedDescription')}</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Input readOnly value={issued ?? ''} className="font-mono text-xs" />
            <Button variant="outline" onClick={() => void copyIssued()} className="shrink-0">
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? t('apiToken.copied') : t('apiToken.copy')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('apiToken.usageHint', { prefix })}
          </p>
          <DialogFooter>
            <Button onClick={() => setIssued(null)}>{t('apiToken.saved')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke confirmation */}
      <Dialog open={revokeTarget !== null} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('apiToken.revokeTitle')}</DialogTitle>
            <DialogDescription>
              {t('apiToken.revokeDescription', { name: revokeTarget?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeTarget(null)} disabled={pending}>
              {t('apiToken.cancel')}
            </Button>
            <Button variant="destructive" onClick={submitRevoke} disabled={pending}>
              {pending ? t('apiToken.revoking') : t('apiToken.revokeConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
