'use client';

import { Check, Copy, KeyRound, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
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
import {
  createApiTokenAction,
  revokeApiTokenAction,
  updateApiTokenAction,
} from '@/lib/api-token-actions';
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
  /** Plaintext returned once after creation. */
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiTokenView | null>(null);
  /** 创建时可选登记的 Ed25519 公钥；非空则该密钥的请求必须带签名。 */
  const [publicKey, setPublicKey] = useState('');
  const [signingTarget, setSigningTarget] = useState<ApiTokenView | null>(null);
  const [signingKey, setSigningKey] = useState('');

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
    setPublicKey('');
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
    startTransition(async () => {
      const result = await createApiTokenAction({
        name,
        scopes: [...selected],
        ...(publicKey.trim().length > 0 ? { publicKey: publicKey.trim() } : {}),
      });
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setCreateOpen(false);
      resetCreate();
      setCopied(false);
      setIssued(result.token ?? null);
      router.refresh();
    });
  };

  const openSigning = (token: ApiTokenView) => {
    setSigningTarget(token);
    setSigningKey(token.publicKey ?? '');
  };

  /**
   * 空值 = 清除公钥（退回只凭 Bearer）。这是凭证所有者的显式决定，不做成
   * 隐藏的「自动降级」。
   */
  const submitSigning = (override?: string) => {
    if (!signingTarget) return;
    const target = signingTarget.id;
    // `override` 存在的理由：停用按钮要立刻以空值提交，不能依赖 setState 后的读取
    // （React 批处理会让这里读到的仍是旧值 —— 那会把公钥又存回去）。
    const value = (override ?? signingKey).trim();
    startTransition(async () => {
      const result = await updateApiTokenAction(target, {
        publicKey: value.length > 0 ? value : null,
      });
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setSigningTarget(null);
      toast.success(
        t(value.length > 0 ? 'action.apiTokenSigningSaved' : 'action.apiTokenSigningCleared'),
      );
      router.refresh();
    });
  };

  const submitRevoke = () => {
    if (!revokeTarget) return;
    const id = revokeTarget.id;
    startTransition(async () => {
      const result = await revokeApiTokenAction(id);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setRevokeTarget(null);
      toast.success(t('action.apiTokenRevoked'));
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
                    {token.status === 'ACTIVE'
                      ? t('apiToken.statusActive')
                      : t('apiToken.statusDisabled')}
                  </span>
                  {token.signingEnabled ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                      <ShieldCheck className="size-3" />
                      {t('apiToken.signingBadge')}
                    </span>
                  ) : null}
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
                <Button variant="ghost" size="sm" onClick={() => openSigning(token)}>
                  <ShieldCheck className="size-4" />
                  {t('apiToken.signing')}
                </Button>
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
            <div className="space-y-1.5">
              <Label htmlFor="api-token-public-key">
                {t('apiToken.publicKey')}
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  {t('apiToken.optional')}
                </span>
              </Label>
              <textarea
                id="api-token-public-key"
                value={publicKey}
                rows={3}
                spellCheck={false}
                placeholder={t('apiToken.publicKeyPlaceholder')}
                onChange={(event) => setPublicKey(event.target.value)}
                className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none focus-visible:border-ring"
              />
              <p className="text-xs text-muted-foreground">{t('apiToken.publicKeyHint')}</p>
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
          <p className="text-xs text-muted-foreground">{t('apiToken.usageHint', { prefix })}</p>
          <DialogFooter>
            <Button onClick={() => setIssued(null)}>{t('apiToken.saved')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Request signing (Ed25519) */}
      <Dialog
        open={signingTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSigningTarget(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('apiToken.signingTitle')}</DialogTitle>
            <DialogDescription>{t('apiToken.signingDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="api-token-signing-key">{t('apiToken.publicKey')}</Label>
            <textarea
              id="api-token-signing-key"
              value={signingKey}
              rows={5}
              spellCheck={false}
              placeholder={t('apiToken.publicKeyPlaceholder')}
              onChange={(event) => setSigningKey(event.target.value)}
              className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none focus-visible:border-ring"
            />
            <p className="text-xs text-muted-foreground">{t('apiToken.signingHint')}</p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setSigningTarget(null);
              }}
              disabled={pending}
            >
              {t('apiToken.cancel')}
            </Button>
            {signingTarget?.signingEnabled ? (
              <Button variant="destructive" onClick={() => submitSigning('')} disabled={pending}>
                {t('apiToken.signingDisable')}
              </Button>
            ) : null}
            <Button onClick={() => submitSigning()} disabled={pending}>
              {pending ? t('apiToken.saving') : t('apiToken.save')}
            </Button>
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
