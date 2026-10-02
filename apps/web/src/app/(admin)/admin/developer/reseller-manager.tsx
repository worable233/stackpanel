'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { DeveloperSpScope, ResellerView } from '@stackpanel/sdk';
import { DEVELOPER_SP_SCOPES } from '@stackpanel/sdk';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  createResellerAction,
  deleteResellerAction,
  rotateResellerKeyAction,
  updateResellerAction,
  type DeveloperActionResult,
} from '@/lib/developer-actions';
import { useTranslator } from '@/i18n/provider';

function StatusMessage({ state }: { state: DeveloperActionResult | null }) {
  if (!state) return null;
  if (state.ok && state.message) {
    return <span className="text-sm text-muted-foreground">{state.message}</span>;
  }
  if (state.error) {
    return <span className="text-sm text-destructive">{state.error}</span>;
  }
  return null;
}

function scopeLabel(scope: string): string {
  return scope;
}

function ScopeCheckboxes({
  selected,
  onToggle,
  disabled,
}: {
  selected: DeveloperSpScope[];
  onToggle: (scope: DeveloperSpScope) => void;
  disabled?: boolean;
}) {
  const t = useTranslator();
  return (
    <div className="flex flex-col gap-1">
      {DEVELOPER_SP_SCOPES.map((scope) => (
        <label
          key={scope}
          className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-sm hover:bg-muted/50"
        >
          <input
            type="checkbox"
            checked={selected.includes(scope)}
            onChange={() => onToggle(scope)}
            disabled={disabled}
            className="size-4 rounded border-input accent-primary"
          />
          <span className="font-mono text-xs">{scopeLabel(scope)}</span>
        </label>
      ))}
      <p className="px-1 text-xs text-muted-foreground">{t('admin.developer.write.scopesHint')}</p>
    </div>
  );
}

/**
 * One-time reveal of the generated inbound private key. Shown straight after a
 * create / rotate: the platform stores only the public key, so this is the sole
 * chance to hand the secret to the partner.
 */
function KeyReveal({
  privateKey,
  publicKey,
  onClose,
}: {
  privateKey: string;
  publicKey: string;
  onClose: () => void;
}) {
  const t = useTranslator();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(privateKey);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('admin.developer.write.keyTitle')}</DialogTitle>
        <DialogDescription>{t('admin.developer.write.keyDescription')}</DialogDescription>
      </DialogHeader>
      <div className="mt-4 flex flex-col gap-4">
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          {t('admin.developer.write.keyWarning')}
        </p>
        <div className="space-y-1">
          <Label>{t('admin.developer.write.inboundPrivateKey')}</Label>
          <pre className="max-h-40 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap break-all">
            {privateKey}
          </pre>
        </div>
        <div className="space-y-1">
          <Label>{t('admin.developer.detail.publicKey')}</Label>
          <pre className="max-h-40 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap break-all">
            {publicKey}
          </pre>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => void copy()}>
            {copied ? t('admin.developer.write.copied') : t('admin.developer.write.copy')}
          </Button>
          <Button type="button" onClick={onClose}>
            {t('admin.developer.write.done')}
          </Button>
        </DialogFooter>
      </div>
    </>
  );
}

export function CreateResellerDialog() {
  const router = useRouter();
  const t = useTranslator();
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<DeveloperActionResult | null>(null);
  const [open, setOpen] = useState(false);
  const [scopes, setScopes] = useState<DeveloperSpScope[]>([]);
  const [rateLimit, setRateLimit] = useState('240');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [key, setKey] = useState<{ privateKey: string; publicKey: string } | null>(null);

  function toggleScope(scope: DeveloperSpScope) {
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((entry) => entry !== scope) : [...prev, scope],
    );
  }

  function submit(formData: FormData) {
    const name = formData.get('name');
    if (typeof name !== 'string' || !name.trim()) {
      setState({ error: t('action.developerResellerNameRequired') });
      return;
    }
    const rpm = Number(rateLimit);
    if (!Number.isInteger(rpm) || rpm < 0 || rpm > 100_000) {
      setState({ error: t('admin.developer.write.rateLimitInvalid') });
      return;
    }
    setState(null);
    startTransition(async () => {
      const result = await createResellerAction({
        name,
        scopes,
        rateLimitRpm: rpm,
        ...(webhookUrl.trim() ? { webhookUrl: webhookUrl.trim() } : {}),
      });
      setState(result);
      if (result.ok && result.reseller && result.inboundPrivateKey) {
        setKey({ privateKey: result.inboundPrivateKey, publicKey: result.reseller.publicKey });
        router.refresh();
      }
    });
  }

  function reset() {
    setState(null);
    setScopes([]);
    setRateLimit('240');
    setWebhookUrl('');
    setKey(null);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger render={<Button />}>
        {t('admin.developer.write.createTrigger')}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        {key ? (
          <KeyReveal privateKey={key.privateKey} publicKey={key.publicKey} onClose={() => setOpen(false)} />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t('admin.developer.write.createTitle')}</DialogTitle>
              <DialogDescription>{t('admin.developer.write.createDescription')}</DialogDescription>
            </DialogHeader>
            <form action={submit} className="mt-4 flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="reseller-name">{t('admin.developer.write.name')}</Label>
                <Input
                  id="reseller-name"
                  name="name"
                  maxLength={100}
                  required
                  placeholder={t('admin.developer.write.namePlaceholder')}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="reseller-webhook-url">{t('admin.developer.write.webhookUrl')}</Label>
                <Input
                  id="reseller-webhook-url"
                  type="url"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder={t('admin.developer.write.webhookUrlPlaceholder')}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="reseller-rate-limit">{t('admin.developer.write.rateLimit')}</Label>
                <Input
                  id="reseller-rate-limit"
                  type="number"
                  min={0}
                  max={100000}
                  value={rateLimit}
                  onChange={(e) => setRateLimit(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label>{t('admin.developer.write.scopes')}</Label>
                <ScopeCheckboxes selected={scopes} onToggle={toggleScope} disabled={isPending} />
              </div>
              <DialogFooter>
                <Button type="submit" disabled={isPending}>
                  {isPending
                    ? t('admin.developer.write.creating')
                    : t('admin.developer.write.createSubmit')}
                </Button>
                <StatusMessage state={state} />
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditResellerDialog({
  reseller,
  onClose,
}: {
  reseller: ResellerView | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const t = useTranslator();
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<DeveloperActionResult | null>(null);
  const [name, setName] = useState(reseller?.name ?? '');
  const [status, setStatus] = useState<'ACTIVE' | 'DISABLED'>(
    reseller?.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE',
  );
  const [rateLimit, setRateLimit] = useState(String(reseller?.rateLimitRpm ?? 240));
  const [webhookUrl, setWebhookUrl] = useState(reseller?.webhookUrl ?? '');
  const [scopes, setScopes] = useState<DeveloperSpScope[]>(
    () => (reseller?.scopes ?? []).filter((scope): scope is DeveloperSpScope =>
      (DEVELOPER_SP_SCOPES as readonly string[]).includes(scope),
    ),
  );

  function toggleScope(scope: DeveloperSpScope) {
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((entry) => entry !== scope) : [...prev, scope],
    );
  }

  function submit() {
    if (!reseller) return;
    if (!name.trim()) {
      setState({ error: t('action.developerResellerNameRequired') });
      return;
    }
    const rpm = Number(rateLimit);
    if (!Number.isInteger(rpm) || rpm < 0 || rpm > 100_000) {
      setState({ error: t('admin.developer.write.rateLimitInvalid') });
      return;
    }
    setState(null);
    startTransition(async () => {
      const trimmed = webhookUrl.trim();
      const result = await updateResellerAction(reseller.id, {
        name: name.trim(),
        status,
        scopes,
        rateLimitRpm: rpm,
        // 空串表示清空回调地址（显式 null）。
        webhookUrl: trimmed ? trimmed : null,
      });
      setState(result);
      if (result.ok) {
        router.refresh();
        onClose();
      }
    });
  }

  return (
    <Dialog
      open={reseller !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('admin.developer.write.editTitle')}</DialogTitle>
          <DialogDescription>{t('admin.developer.write.editDescription')}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          className="mt-4 flex flex-col gap-4"
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-reseller-name">{t('admin.developer.write.name')}</Label>
            <Input
              id="edit-reseller-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-reseller-status">{t('admin.developer.write.status')}</Label>
            <select
              id="edit-reseller-status"
              value={status}
              onChange={(e) => setStatus(e.target.value === 'DISABLED' ? 'DISABLED' : 'ACTIVE')}
              className="border-input bg-background ring-offset-background focus-visible:ring-ring flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-sm focus-visible:ring-1 focus-visible:outline-none"
            >
              <option value="ACTIVE">{t('admin.developer.resellers.statusActive')}</option>
              <option value="DISABLED">{t('admin.developer.resellers.statusDisabled')}</option>
            </select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-reseller-webhook-url">{t('admin.developer.write.webhookUrl')}</Label>
            <Input
              id="edit-reseller-webhook-url"
              type="url"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder={t('admin.developer.write.webhookUrlPlaceholder')}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-reseller-rate-limit">{t('admin.developer.write.rateLimit')}</Label>
            <Input
              id="edit-reseller-rate-limit"
              type="number"
              min={0}
              max={100000}
              value={rateLimit}
              onChange={(e) => setRateLimit(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label>{t('admin.developer.write.scopes')}</Label>
            <ScopeCheckboxes selected={scopes} onToggle={toggleScope} disabled={isPending} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? t('admin.developer.write.saving') : t('common.save')}
            </Button>
          </DialogFooter>
          <StatusMessage state={state} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RotateKeyDialog({ reseller }: { reseller: ResellerView }) {
  const router = useRouter();
  const t = useTranslator();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<DeveloperActionResult | null>(null);
  const [key, setKey] = useState<{ privateKey: string; publicKey: string } | null>(null);

  function confirm() {
    setState(null);
    startTransition(async () => {
      const result = await rotateResellerKeyAction(reseller.id);
      setState(result);
      if (result.ok && result.reseller && result.inboundPrivateKey) {
        setKey({ privateKey: result.inboundPrivateKey, publicKey: result.reseller.publicKey });
        router.refresh();
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setState(null);
          setKey(null);
        }
      }}
    >
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        {t('admin.developer.write.rowRotate')}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        {key ? (
          <KeyReveal privateKey={key.privateKey} publicKey={key.publicKey} onClose={() => setOpen(false)} />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t('admin.developer.write.rotateTitle')}</DialogTitle>
              <DialogDescription>
                {t('admin.developer.write.rotateDescription', { name: reseller.name })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
                {t('common.cancel')}
              </Button>
              <Button type="button" onClick={() => void confirm()} disabled={isPending}>
                {isPending
                  ? t('admin.developer.write.rotating')
                  : t('admin.developer.write.rotateConfirm')}
              </Button>
            </DialogFooter>
            <StatusMessage state={state} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DeleteResellerDialog({ reseller }: { reseller: ResellerView }) {
  const router = useRouter();
  const t = useTranslator();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<DeveloperActionResult | null>(null);

  function confirm() {
    setState(null);
    startTransition(async () => {
      const result = await deleteResellerAction(reseller.id);
      setState(result);
      if (result.ok) {
        router.refresh();
        setOpen(false);
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setState(null);
      }}
    >
      <DialogTrigger render={<Button variant="destructive" size="sm" />}>
        {t('admin.developer.write.rowDelete')}
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('admin.developer.write.deleteTitle')}</DialogTitle>
          <DialogDescription>
            {t('admin.developer.write.deleteDescription', { name: reseller.name })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void confirm()}
            disabled={isPending}
          >
            {isPending
              ? t('admin.developer.write.deleting')
              : t('admin.developer.write.deleteConfirm')}
          </Button>
        </DialogFooter>
        <StatusMessage state={state} />
      </DialogContent>
    </Dialog>
  );
}

/** 渠道列表行操作：编辑 / 轮换密钥 / 删除。 */
export function ResellerRowActions({ reseller }: { reseller: ResellerView }) {
  const t = useTranslator();
  const [editing, setEditing] = useState(false);

  return (
    <div className="flex items-center justify-end gap-2">
      <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
        {t('admin.developer.write.rowEdit')}
      </Button>
      <RotateKeyDialog reseller={reseller} />
      <DeleteResellerDialog reseller={reseller} />
      <EditResellerDialog
        key={editing ? reseller.id : 'closed'}
        reseller={editing ? reseller : null}
        onClose={() => setEditing(false)}
      />
    </div>
  );
}
